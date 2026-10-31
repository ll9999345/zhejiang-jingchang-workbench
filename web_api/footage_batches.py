"""Durable sequential batches over the existing, bounded footage job worker.

Preflight never writes or performs network requests. Each row retains its own
project, source and network confirmation; this does not batch cloud extensions.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import re
import threading
import time
import uuid

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from web_api.footage_pipeline import FootageJobs, FootageRequest, TERMINAL, local_path, now, project_path, read_json, write_json

BATCH_ID = re.compile(r'^batch-[a-f0-9]{24}$')
BATCH_TERMINAL = {'completed', 'partial', 'failed', 'cancelled', 'interrupted'}


class BatchRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    requests: list[dict] = Field(min_length=1, max_length=100)
    request_id: str = Field(default='', max_length=100, pattern=r'^[A-Za-z0-9._-]*$')
    confirm: bool = False


class FootageBatches:
    def __init__(self, jobs: FootageJobs, *, executor=None):
        self.jobs = jobs
        self.root = jobs.root
        self.executor = executor or ThreadPoolExecutor(max_workers=1, thread_name_prefix='footage-batch')
        self.lock = threading.RLock()
        self.active: dict[str, threading.Event] = {}

    def directory(self, project_id, batch_id):
        if not BATCH_ID.fullmatch(batch_id):
            raise ValueError('批次编号无效')
        return local_path(project_path(self.root, project_id), f'artifacts/footage_batches/{batch_id}', exists=False)

    def preflight(self, body: BatchRequest):
        if len(json.dumps(body.requests, ensure_ascii=False).encode('utf-8')) > 1024 * 1024:
            raise ValueError('批量清单最多 1 MiB')
        items = []
        for index, raw in enumerate(body.requests):
            row = {'index': index, 'ready': False, 'errors': [], 'network_required': False}
            try:
                request = FootageRequest.model_validate(raw)
                row.update(project_id=request.project_id, topic=request.topic)
                text_only = request.stop_at in ('script', 'terms')
                materials = not text_only and (request.action == 'collect' or request.stop_at in ('materials', 'video'))
                narration = not text_only and request.action != 'collect' and request.stop_at != 'materials'
                row['network_required'] = ((materials and request.action != 'render' and request.material_mode != 'local')
                                           or (narration and request.options.narration == 'edge'))
                # Validation calls only local configuration, paths and planning.
                plan = self.jobs.validate_request(request)
                row.update(ready=True, topic=plan['topic'], network_required=plan['network_required'], plan=plan)
            except ValidationError as exc:
                fields = sorted({'.'.join(map(str, err['loc'])) for err in exc.errors(include_input=False)})
                row['errors'] = ['字段无效或不支持：' + '、'.join(fields)]
            except ValueError as exc:
                # Messages are issued by our closed schemas and path validators;
                # replace messages containing raw field values with fixed guidance.
                message = str(exc)
                safe = ('请确认联网', '只生成旁白', '请选择已导入', '生成字幕需要', '当前方案没有', '一次初剪最长')
                row['errors'] = [message if message.startswith(safe) else '请核对项目、素材路径、阶段、旁白和联网确认；该条尚不能执行。']
            except OSError:
                # Avoid echoing arbitrary input, paths or credential-like fields.
                row['errors'] = ['请核对项目、素材路径、阶段、旁白和联网确认；该条尚不能执行。']
            items.append(row)
        return {'ready': all(row['ready'] for row in items), 'items': items,
                'errors': [] if all(row['ready'] for row in items) else ['部分条目未通过；没有提交任何任务。'],
                'network_used': False, 'project_id': items[0].get('project_id', '')}

    def get(self, project_id, batch_id):
        with self.lock:
            path = self.directory(project_id, batch_id) / 'batch.json'
            data = read_json(path)
            if not data:
                raise ValueError('当前项目中没有该批次')
            if data['status'] not in BATCH_TERMINAL and batch_id not in self.active:
                data.update(status='interrupted', updated_at=now(),
                            message='服务重启，批次已停止；已有任务与产物保留，不会自动继续或重试。')
                write_json(path, data)
            return data

    def list(self, project_id):
        base = project_path(self.root, project_id) / 'artifacts/footage_batches'
        paths = sorted(base.glob('batch-*/batch.json'), key=lambda p: p.stat().st_mtime, reverse=True)
        return [self.get(project_id, path.parent.name) for path in paths[:100]]

    def update(self, project_id, batch_id, **values):
        with self.lock:
            path = self.directory(project_id, batch_id) / 'batch.json'
            data = read_json(path)
            data.update(values, updated_at=now())
            write_json(path, data)
            return data

    def submit(self, body: BatchRequest):
        check = self.preflight(body)
        if not check['ready']:
            raise ValueError('批量清单未全部通过预检；没有提交任务')
        if not body.confirm:
            raise ValueError('请确认逐条执行本批次清单')
        owner = check['project_id']
        payload = body.model_dump()
        fingerprint = hashlib.sha256(json.dumps(dict(payload, request_id=''), sort_keys=True).encode()).hexdigest()
        with self.lock:
            for previous in self.list(owner):
                if body.request_id and previous.get('request_id') == body.request_id:
                    if previous['fingerprint'] != fingerprint:
                        raise ValueError('同一批次请求编号对应内容已改变')
                    return previous
                if previous['fingerprint'] == fingerprint and previous['status'] not in BATCH_TERMINAL:
                    return previous
            if len(self.active) >= 4:
                raise ValueError('批量队列已满，请等待已有批次完成')
            batch_id = 'batch-' + uuid.uuid4().hex[:24]
            directory = self.directory(owner, batch_id)
            directory.mkdir(parents=True, exist_ok=False)
            event = threading.Event()
            self.active[batch_id] = event
            data = {'batch_id': batch_id, 'project_id': owner, 'status': 'queued', 'progress': 0,
                    'message': '已排队，将逐条执行；刷新不会重新提交。', 'created_at': now(), 'updated_at': now(),
                    'request_id': body.request_id, 'fingerprint': fingerprint, 'requests': body.requests,
                    'items': [dict(index=i, project_id=r['project_id'], topic=check['items'][i]['topic'], status='pending')
                              for i, r in enumerate(body.requests)]}
            write_json(directory / 'batch.json', data)
            self.executor.submit(self._run, owner, batch_id, event)
            return data

    def cancel(self, project_id, batch_id):
        with self.lock:
            data = self.get(project_id, batch_id)
            event = self.active.get(batch_id)
            if not event or data['status'] in BATCH_TERMINAL:
                return data
            event.set()
            for row in data['items']:
                if row.get('job_id') and row['status'] not in TERMINAL:
                    self.jobs.cancel(row['project_id'], row['job_id'])
            return self.update(project_id, batch_id, cancel_requested=True, message='正在停止本批次；未开始条目不会提交，已有产物保留。')

    def _run(self, owner, batch_id, event):
        try:
            data = self.get(owner, batch_id)
            items = data['items']
            self.update(owner, batch_id, status='running')
            for index, raw in enumerate(data['requests']):
                if event.is_set():
                    break
                # Each batch row has stable idempotency even when imported IDs repeat.
                request = FootageRequest.model_validate(dict(raw, request_id=f'{batch_id}-{index}'))
                try:
                    # Keep cancellation and task admission atomic relative to cancel().
                    with self.lock:
                        if event.is_set():
                            break
                        job = self.jobs.submit(request)
                        items[index].update(job_id=job['job_id'], status=job['status'])
                        self.update(owner, batch_id, items=items, message=f'正在执行第 {index+1}/{len(items)} 条')
                    while job['status'] not in TERMINAL:
                        if event.wait(.25):
                            self.jobs.cancel(request.project_id, job['job_id'])
                            break
                        job = self.jobs.get(request.project_id, job['job_id'])
                    items[index].update(status=job['status'], outputs=job.get('outputs', []), message=job.get('message', ''))
                except (ValueError, OSError):
                    items[index].update(status='failed', message='本条未完成，请进入对应项目查看素材和运行环境。')
                self.update(owner, batch_id, items=items, progress=int(100*(index+1)/len(items)))
            if event.is_set():
                for row in items:
                    if row['status'] not in TERMINAL:
                        row.update(status='cancelled', message='批次已停止，不再提交')
                status, message = 'cancelled', '批次已停止；已有产物保留。'
            else:
                status = 'completed' if all(r['status'] in ('completed', 'stage_completed', 'awaiting_review') for r in items) else 'partial'
                message = '批次已完成，请逐条复核产物。' if status == 'completed' else '批次执行结束；部分条目需补素材或修复，请查看逐条回执。'
            self.update(owner, batch_id, status=status, message=message, items=items, progress=100)
        except Exception:
            self.update(owner, batch_id, status='failed', message='批次处理中断；保留已有任务，请核对回执后手动继续。')
        finally:
            with self.lock:
                self.active.pop(batch_id, None)
