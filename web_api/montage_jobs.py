"""Durable, cancellable native-tool jobs with fresh project-local outputs."""
from __future__ import annotations

import json
import os
import secrets
import signal
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from web_api.media_pipeline import _probe_media, _sha256
from web_api.montage_composition import resolve_project, safe_destination
from web_api.montage_registry import NativeToolRequest, ROOT, preflight_tool, redact
from web_api.native_progress import read_progress

TERMINAL = {'completed', 'failed', 'cancelled', 'interrupted'}
ACTIVE = {'queued', 'running', 'cancelling'}


def now():
    return datetime.now(timezone.utc).isoformat()


def save_json(path: Path, data: dict):
    if path.is_symlink() or path.parent.is_symlink():
        raise ValueError('运行记录不能是符号链接')
    # The temporary replacement belongs to this new run, never to user media.
    temp = path.with_name(path.name + '.' + secrets.token_hex(4) + '.tmp')
    temp.write_text(json.dumps(redact(data), ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
    os.replace(temp, path)


def new_run(project: Path, family: str):
    directory = safe_destination(project, 'analysis/montage/' + family)
    directory.mkdir(parents=True, exist_ok=True)
    run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S') + '-' + secrets.token_hex(6)
    run = directory / run_id
    run.mkdir(exist_ok=False)
    return run_id, run


def result_files(project: Path, directory: Path):
    records = []
    for path in sorted(directory.rglob('*')):
        if path.is_symlink():
            raise ValueError('原生工具生成了不受支持的符号链接')
        if not path.is_file() or not path.stat().st_size:
            continue
        if not path.resolve().is_relative_to(directory.resolve()):
            raise ValueError('输出逃离本次运行目录')
        suffix = path.suffix.lower()
        record = {'path': path.relative_to(project).as_posix(), 'bytes': path.stat().st_size, 'sha256': _sha256(path)}
        if suffix in {'.mp4', '.mov', '.webm', '.mkv', '.wav', '.mp3', '.m4a', '.ogg', '.flac'}:
            probe = _probe_media(path)
            record['probe'] = probe
            record['kind'] = 'video' if probe and probe.get('video') else 'audio'
            record['playable'] = bool(probe and (probe.get('video') or probe.get('audio')))
        elif suffix in {'.png', '.jpg', '.jpeg', '.webp'}:
            record['kind'] = 'image'
        else:
            record['kind'] = 'file'
        records.append(record)
    return records


class MontageJobs:
    def __init__(self, project_root: Path):
        self.root = Path(project_root)
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='montage-native')
        self.lock = threading.RLock()
        self.processes = {}
        self.cancelled = set()
        self.owned = set()

    def _run_dir(self, project_id, job_id):
        if not isinstance(job_id, str) or not __import__('re').fullmatch(r'\d{8}T\d{6}-[0-9a-f]{12}', job_id):
            raise ValueError('任务编号无效')
        project = resolve_project(self.root, project_id)
        run = safe_destination(project, f'analysis/montage/tools/{job_id}')
        if not run.is_dir() or run.is_symlink(): raise FileNotFoundError('任务不存在')
        return project, run

    def get(self, project_id, job_id):
        # The file snapshot and ownership must be read together. Otherwise a
        # finishing worker can release ownership between the two reads and a
        # still-running snapshot is incorrectly displayed as a service restart.
        with self.lock:
            _, run = self._run_dir(project_id, job_id)
            path = run / 'job.json'
            if path.is_symlink(): raise ValueError('任务记录不可读取')
            data = json.loads(path.read_text(encoding='utf-8'))
            if data.get('status') in ACTIVE and (project_id, job_id) not in self.owned:
                # A service restart never resubmits a potentially billable action.
                data.update(status='interrupted', message='工作台曾重启；原产物已保留，请检查后新建任务。')
            process = self.processes.get((project_id, job_id))
            if process is not None and (project_id, job_id) in self.owned:
                progress = read_progress(run, data.get('tool'), process.pid)
                if progress: data['progress'] = progress
            return data

    def list(self, project_id):
        project = resolve_project(self.root, project_id)
        directory = safe_destination(project, 'analysis/montage/tools')
        rows = []
        if directory.is_dir():
            for run in sorted(directory.iterdir(), reverse=True)[:100]:
                try:
                    row = self.get(project_id, run.name)
                    rows.append({k: v for k, v in row.items() if k != 'inputs'})
                except (ValueError, OSError):
                    continue
        return {'jobs': rows}

    def submit(self, request: NativeToolRequest):
        plan = preflight_tool(request, self.root)
        if not plan.get('can_execute') or not request.confirm:
            return {**plan, 'status': plan['status'] if not plan.get('can_execute') else 'confirmation_required'}
        with self.lock:
            if len(self.owned) >= 8:
                raise ValueError('已有 8 个制作任务，请等待或取消后再提交')
            project = resolve_project(self.root, request.project_id)
            job_id, run = new_run(project, 'tools')
            row = {'job_id': job_id, 'project_id': request.project_id, 'tool': request.tool,
                   'status': 'queued', 'created_at': now(), 'message': '等待本机制作',
                   'effects': plan['effects'], 'outputs': [], 'estimated_cost_usd': plan['estimated_cost_usd']}
            row['source_path'] = request.inputs.get('input_path')
            row['provider_tool'] = plan.get('provider_tool')
            save_json(run / 'job.json', row)
            save_json(run / 'request.json', request.model_dump())
            self.owned.add((request.project_id, job_id))
            self.pool.submit(self._execute, request, project, run, row)
            return row

    def cancel(self, project_id, job_id):
        with self.lock:
            row = self.get(project_id, job_id)
            if row['status'] in TERMINAL: return row
            if (project_id, job_id) not in self.owned:
                return row
            self.cancelled.add((project_id, job_id))
            process = self.processes.get((project_id, job_id))
            if process and process.poll() is None:
                self._stop(process)
            _, run = self._run_dir(project_id, job_id)
            row.update(status='cancelling', message='正在停止本次制作；已有产物会保留。')
            save_json(run / 'job.json', row)
            return row

    @staticmethod
    def _stop(process):
        """Escalate only this owned process group, including its child renderer."""
        try: os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError: return
        def finish():
            if process.poll() is None:
                try: os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError: pass
        timer = threading.Timer(5, finish)
        timer.daemon = True
        timer.start()

    def _execute(self, request, project, run, row):
        key = (request.project_id, row['job_id'])
        process = None
        started = time.monotonic()
        try:
            with self.lock:
                if key in self.cancelled:
                    row.update(status='cancelled', message='已取消，未开始运行工具。')
                    return
                row.update(status='running', started_at=now(), message='正在运行原生 ' + request.tool)
                save_json(run / 'job.json', row)
                env = os.environ.copy()
                env['PYTHONPATH'] = str(ROOT)
                process = subprocess.Popen([sys.executable, '-m', 'web_api.montage_worker'], cwd=ROOT,
                                           stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                           text=True, encoding='utf-8', env=env, start_new_session=True)
                self.processes[key] = process
            packet = {'request': request.model_dump(), 'project': str(project), 'run': str(run)}
            try:
                stdout, _stderr = process.communicate(json.dumps(packet, ensure_ascii=False), timeout=request.timeout_seconds)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGTERM)
                try: process.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.communicate()
                raise ValueError('制作超时；已停止本次子进程，保留全部中间产物。')
            if key in self.cancelled:
                row.update(status='cancelled', message='已停止本次制作；取消不撤销已提交的第三方任务或费用。')
            elif process.returncode:
                raise ValueError('原生工具进程未正常结束；已有文件已保留。')
            else:
                result = json.loads(stdout)
                row.update(result)
                if row.get('status') == 'completed':
                    # A provider's success flag must not hide missing outputs.
                    prefix = run.relative_to(project).as_posix() + '/'
                    for artifact in (row.get('native_result') or {}).get('artifacts', []):
                        if isinstance(artifact, str) and artifact.startswith(prefix):
                            path = safe_destination(project, artifact)
                            if not path.exists() or (path.is_file() and not path.stat().st_size):
                                raise ValueError('工具返回成功，但所列产物不存在或为空：' + artifact)
        except Exception as exc:
            row.update(status='failed', message='本次制作未完成。', error=redact(str(exc))[:600])
        finally:
            try:
                if process is not None:
                    progress = read_progress(run, request.tool, process.pid)
                    if progress: row['progress'] = progress
                try:
                    row['outputs'] = result_files(project, run / 'outputs') if (run / 'outputs').exists() else []
                except Exception as exc:
                    # Artifact validation is part of completion. Persist its
                    # failure before releasing ownership, rather than leaving
                    # a stale running row that looks like a service restart.
                    row.update(status='failed', message='产物检查未通过，文件已保留。',
                               error=redact(str(exc))[:600], outputs=[])
                if row.get('status') == 'completed' and any(f.get('playable') is False for f in row['outputs']):
                    row.update(status='failed', message='工具返回成功，但媒体不能解码；产物保留以便检查。')
                row.update(finished_at=now(), elapsed_seconds=round(time.monotonic() - started, 2))
                save_json(run / 'job.json', row)
            finally:
                with self.lock:
                    self.owned.discard(key)
                    self.processes.pop(key, None)
                    self.cancelled.discard(key)

    def shutdown(self):
        with self.lock:
            self.cancelled.update(self.owned)
            for key, process in list(self.processes.items()):
                self.cancelled.add(key)
                if process.poll() is None:
                    self._stop(process)
        self.pool.shutdown(wait=False, cancel_futures=False)
