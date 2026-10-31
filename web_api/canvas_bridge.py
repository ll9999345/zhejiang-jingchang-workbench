"""Local project handoff to the existing Jingchang canvas, without cloud calls.

The canvas owns editing, execution and credentials. This bridge only copies
explicitly selected local media and appends source-versioned nodes through its
revision-checked API. Optional editable shots are appended once per source
scene; it never rewrites either project's existing shots.
"""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import time
from urllib.parse import quote, urlencode, urlsplit
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

WORKBENCH_ROOT = Path(__file__).resolve().parents[1]
BUNDLED_CANVAS_ROOT = WORKBENCH_ROOT / 'apps' / 'jingchang'
CANVAS_ROOT = BUNDLED_CANVAS_ROOT if (BUNDLED_CANVAS_ROOT / 'server.mjs').is_file() else WORKBENCH_ROOT.parent / '镜场Agent'
CANVAS_PORT = int(os.environ.get('JINGCHANG_PORT', '4768'))
if not 1024 <= CANVAS_PORT <= 65535:
    raise ValueError('镜场端口必须在 1024–65535 范围内')
ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')
CANVAS_ID = re.compile(r'^[A-Za-z0-9_-]{1,100}$')
MEDIA = {'.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
         '.webp':'image/webp', '.gif':'image/gif', '.avif':'image/avif', '.bmp':'image/bmp',
         '.mp4':'video/mp4', '.m4v':'video/mp4', '.mov':'video/quicktime', '.webm':'video/webm', '.mkv':'video/x-matroska',
         '.ogv':'video/ogg', '.avi':'video/x-msvideo',
         '.wav':'audio/wav', '.mp3':'audio/mpeg', '.m4a':'audio/mp4', '.ogg':'audio/ogg',
         '.flac':'audio/flac', '.aac':'audio/aac'}
MAX_MEDIA = 4_000_000_000
MAX_SCENES = 200


class BridgeError(ValueError):
    def __init__(self, message, status=422):
        super().__init__(message)
        self.status = status


def stamp():
    return datetime.now(timezone.utc).isoformat()


def digest_file(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def media_type(file):
    """Some accepted model images are JPEG bytes saved under a .png name.
    Preserve their bytes/name and send the actual image MIME to the canvas.
    """
    fallback = MEDIA[file.suffix.lower()]
    if not fallback.startswith('image/'):
        return fallback
    with file.open('rb') as stream:
        header = stream.read(64)
    if header.startswith(b'\xff\xd8\xff'):
        return 'image/jpeg'
    if header.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'image/png'
    if header[:6] in {b'GIF87a', b'GIF89a'}:
        return 'image/gif'
    if header[:4] == b'RIFF' and header[8:12] == b'WEBP':
        return 'image/webp'
    if header[:2] == b'BM':
        return 'image/bmp'
    if header[4:8] == b'ftyp' and (b'avif' in header or b'avis' in header):
        return 'image/avif'
    raise BridgeError('素材的实际图片格式无法识别，未修改原文件')


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    pending = path.with_name(path.name + '.pending-' + uuid.uuid4().hex)
    with pending.open('x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(pending, path)


class CanvasBridge:
    def __init__(self, project_root, *, runtime=None, engine_root=CANVAS_ROOT, port=CANVAS_PORT):
        self.root = Path(project_root).resolve()
        self.runtime = Path(runtime or self.root.parent / '.runtime' / 'canvas-bridge')
        self.engine_root = Path(engine_root).resolve()
        self.port = port
        self._media_session = None

    def project(self, project_id):
        if not ID.fullmatch(project_id):
            raise BridgeError('作品编号无效')
        path = self.root / project_id
        if path.is_symlink() or path.resolve().parent != self.root or not (path / 'project.json').is_file():
            raise BridgeError('请先选择一个已保存的作品', 404)
        return path

    @contextmanager
    def lock(self, name):
        self.runtime.mkdir(parents=True, exist_ok=True)
        with (self.runtime / (name + '.lock')).open('a') as stream:
            # A second tab should receive a useful retryable answer, not hang.
            try:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise BridgeError('同一作品正在交换资料，请稍后刷新', 409) from None
            try:
                yield
            finally:
                fcntl.flock(stream, fcntl.LOCK_UN)

    def rpc(self, method, route, body=None, *, file=None, media_type=None, timeout=30):
        """Fixed loopback transport; ignores proxy settings and never redirects."""
        if route != '/api/health' and self._media_session is None:
            self.rpc('GET', '/api/health')
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=timeout)
        try:
            headers = ({'X-Jingchang-Media-Session': self._media_session}
                       if self._media_session is not None else {})
            if file:
                size = file.stat().st_size
                headers.update({'Content-Type': media_type, 'Content-Length': str(size),
                                'X-Jingchang-File-Size': str(size)})
                conn.putrequest(method, route)
                for key, value in headers.items():
                    conn.putheader(key, value)
                conn.endheaders()
                with file.open('rb') as stream:
                    for block in iter(lambda: stream.read(1024 * 1024), b''):
                        conn.send(block)
            else:
                encoded = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
                if encoded is not None:
                    headers['Content-Type'] = 'application/json'
                conn.request(method, route, encoded, headers)
            response = conn.getresponse()
            raw = response.read(20 * 1024 * 1024 + 1)
            if len(raw) > 20 * 1024 * 1024:
                raise BridgeError('画布数据超过当前交换容量', 413)
            try:
                data = json.loads(raw)
            except (ValueError, UnicodeError):
                raise BridgeError('该端口没有返回可识别的画布数据', 503) from None
            if response.status >= 400:
                message = data.get('error') or data.get('message') or '画布操作未完成'
                raise BridgeError(str(message)[:300], response.status)
            if not 200 <= response.status < 300:
                raise BridgeError('画布服务返回了意外跳转', 503)
            if route == '/api/health' and self._media_session is None:
                if not isinstance(data, dict):
                    raise BridgeError('镜场健康检查格式无效', 503)
                session = data.get('nativeMediaSession')
                enabled = data.get('capabilities', {}).get('smartGroupStoredMedia') is True
                if session is not None and (not isinstance(session, dict) or
                        session.get('version') != 1 or
                        type(session.get('storedMedia')) is not bool or
                        session['storedMedia'] != enabled):
                    raise BridgeError('镜场素材规则版本不一致，未交换资料', 409)
                self._media_session = '1;smart=' + ('1' if enabled else '0')
            return data
        except (OSError, http.client.HTTPException):
            raise BridgeError('画布连接中断；请刷新核对原记录，不会自动重交生成任务', 503) from None
        finally:
            conn.close()

    def status(self):
        installed = (self.engine_root / 'server.mjs').is_file()
        try:
            # Native health also reads the local assistant configuration via a
            # Python helper. A cold helper can exceed two seconds on this Mac;
            # that is not evidence that the actual canvas has disconnected.
            health = self.rpc('GET', '/api/health', timeout=8)
            ready = isinstance(health, dict) and health.get('ok') is True and bool(health.get('version'))
        except BridgeError:
            health, ready = {}, False
        return {'installed': installed, 'ready': ready, 'version': health.get('version') if ready else None,
                'url': f'http://127.0.0.1:{self.port}/', 'agent_configured': bool(health.get('agentConfigured')),
                'message': '画布已连接' if ready else '画布未启动；可在此启动已有本机服务'}

    def require_engine(self):
        if not self.status()['ready']:
            raise BridgeError('请先启动本机画布', 503)

    def start(self):
        with self.lock('engine-start'):
            if self.status()['ready']:
                return self.status()
            with socket.socket() as sock:
                sock.settimeout(.4)
                if sock.connect_ex(('127.0.0.1', self.port)) == 0:
                    raise BridgeError('画布端口正被其他服务占用，已有服务未被关闭', 409)
            node = shutil.which('node')
            if not node or not (self.engine_root / 'server.mjs').is_file():
                raise BridgeError('缺少现有画布或 Node.js；未安装或替换任何软件', 503)
            log = self.runtime / ('engine-' + uuid.uuid4().hex + '.log')
            env = {**os.environ, 'PORT': str(self.port)}
            # Never move a previously configured canvas to another data directory.
            env.pop('JINGCHANG_DATA_DIR', None)
            with log.open('xb') as output:
                process = subprocess.Popen([node, 'server.mjs'], cwd=self.engine_root, env=env,
                                           stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
            atomic_json(self.runtime / 'engine-start.json', {'pid': process.pid, 'started_at': stamp(), 'port': self.port})
            for _ in range(32):
                if self.status()['ready']:
                    return self.status()
                if process.poll() is not None:
                    break
                time.sleep(.25)
            raise BridgeError('已发起启动，但尚未连接；启动记录保留，请刷新状态', 503)

    def link_path(self, project_id, cut_id='', cut_version=1):
        self.project(project_id)
        if cut_id:
            from web_api.footage_canvas import CUT_ID
            if not CUT_ID.fullmatch(cut_id) or cut_version not in range(1, 6):
                raise BridgeError('初剪版本编号无效')
            return self.runtime / 'links' / 'footage' / project_id / cut_id / f'version-{cut_version}.json'
        return self.runtime / 'links' / (project_id + '.json')

    def read_link(self, project_id, cut_id='', cut_version=1):
        path = self.link_path(project_id, cut_id, cut_version)
        if not path.exists():
            return None
        try:
            link = json.loads(path.read_text())
            if link.get('project_id') != project_id:
                raise ValueError()
            if cut_id and (link.get('cut_id'), link.get('cut_version')) != (cut_id, cut_version):
                raise ValueError()
            if link.get('canvas_project_id') and not CANVAS_ID.fullmatch(link['canvas_project_id']):
                raise ValueError()
            return link
        except (ValueError, OSError):
            raise BridgeError('画布关联记录无法核对，未创建新工程或覆盖已有记录', 409) from None

    def link_public(self, link):
        if not link or not link.get('canvas_project_id'):
            return None
        cid = link['canvas_project_id']
        return {'canvas_project_id': cid, 'url': f'http://127.0.0.1:{self.port}/?project={quote(cid)}&view=canvas'}

    def open(self, project_id, cut_id='', cut_version=1):
        self.require_engine()
        with self.lock(project_id):
            return self.link_public(self.ensure_link(project_id, cut_id, cut_version))

    def ensure_link(self, project_id, cut_id='', cut_version=1):
        link = self.read_link(project_id, cut_id, cut_version)
        if link and link.get('canvas_project_id'):
            self.rpc('GET', '/api/projects/' + link['canvas_project_id'])
            return link
        # This unique name also recovers an accepted creation whose HTTP reply
        # or local pointer was lost. A reservation is durable before POST.
        if not link:
            title = self.inventory(project_id, cut_id, cut_version)['title'][:55]
            link = {'project_id': project_id, 'name': title + ' · 文旅画布 ' + uuid.uuid4().hex[:12],
                    'created_at': stamp(), 'state': 'reserved', 'imports': {}}
            if cut_id:
                link.update(cut_id=cut_id, cut_version=cut_version)
            atomic_json(self.link_path(project_id, cut_id, cut_version), link)
        found = [p for p in self.rpc('GET', '/api/projects') if p.get('name') == link['name']]
        if len(found) > 1:
            raise BridgeError('发现重复关联候选，请人工核对，未覆盖任何工程', 409)
        if found:
            canvas = found[0]
        elif link.get('state') == 'creating':
            raise BridgeError('上次创建的结果尚未确认，未再次创建，请刷新核对', 409)
        else:
            link['state'] = 'creating'
            atomic_json(self.link_path(project_id, cut_id, cut_version), link)
            canvas = self.rpc('POST', '/api/projects', {'name': link['name']})
        if not CANVAS_ID.fullmatch(str(canvas.get('id', ''))):
            raise BridgeError('画布未返回有效工程编号', 503)
        link.update(canvas_project_id=canvas['id'], state='ready')
        # Initialize only an untouched, newly created native project. Existing
        # canvas settings always win after the first edit.
        full = self.rpc('GET', '/api/projects/' + canvas['id'])
        if full.get('revision') == 0:
            data, _ = self.source_data(project_id, cut_id, cut_version)
            ratio = data['scenes'].get('metadata', {}).get('aspect_ratio')
            if ratio in {'16:9', '9:16', '1:1', '4:3'} and full['settings']['ratio'] != ratio:
                full['settings']['ratio'] = ratio
                self.rpc('PUT', '/api/projects/' + canvas['id'], full)
        atomic_json(self.link_path(project_id, cut_id, cut_version), link)
        return link

    def source_data(self, project_id, cut_id='', cut_version=1):
        project = self.project(project_id)
        if cut_id:
            from web_api.footage_canvas import read_canvas_cut
            try:
                return read_canvas_cut(project, project_id, cut_id, cut_version)
            except (ValueError, OSError) as error:
                raise BridgeError(str(error) or '初剪记录无法核对，请重新导出当前选片') from None
        data, fingerprints = {}, []
        for key, relative in [('project', 'project.json'), ('script', 'artifacts/script.json'),
                              ('scenes', 'artifacts/scene_plan.json'),
                              ('asset_manifest', 'artifacts/asset_manifest.json'),
                              ('image_manifest', 'artifacts/image_manifest.json')]:
            file = project / relative
            if not file.exists():
                data[key] = {}
                continue
            if file.is_symlink() or file.stat().st_size > 2 * 1024 * 1024:
                raise BridgeError('作品资料过大或不是普通文件')
            raw = file.read_bytes()
            try:
                data[key] = json.loads(raw)
                if not isinstance(data[key], dict):
                    raise ValueError()
            except ValueError:
                raise BridgeError('作品脚本或分镜不是有效 JSON') from None
            fingerprints.append(hashlib.sha256(raw).hexdigest())
        return data, hashlib.sha256('|'.join(fingerprints).encode()).hexdigest()

    def scene_specs(self, data, *, dialogue=True):
        """Keep the actual ordered scene lengths, including numeric scene id 0.
        Reject broken plans before copying rather than truncating/clamping them.
        """
        scenes = data['scenes'].get('scenes', [])
        if not isinstance(scenes, list) or len(scenes) > MAX_SCENES:
            raise BridgeError(f'一次可带入最多 {MAX_SCENES} 个分镜，请先整理分镜计划')
        sections = data['script'].get('sections', [])
        sections = [s for s in sections if isinstance(s, dict)] if isinstance(sections, list) else []
        specs, keys = [], set()
        for index, scene in enumerate(scenes):
            if not isinstance(scene, dict):
                raise BridgeError('分镜计划包含无法识别的镜头')
            key = str(scene['id']) if scene.get('id') is not None else str(index)
            if key in keys:
                raise BridgeError('分镜编号重复，请先核对镜头')
            keys.add(key)
            start, end = scene.get('start_seconds'), scene.get('end_seconds')
            if any(isinstance(n, bool) or not isinstance(n, (int, float)) or not math.isfinite(n) for n in (start, end) if n is not None):
                raise BridgeError('分镜起止时间无效，请先核对镜头')
            if start is not None and end is not None:
                duration = end - start
            else:
                duration = scene.get('duration_seconds', scene.get('duration', 5))
            if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or not 0 < duration <= 600:
                raise BridgeError('分镜时长须大于 0 且不超过 600 秒')
            section_id = scene.get('script_section_id')
            section = next((s for s in sections if section_id is not None and str(s.get('id')) == str(section_id)), None)
            if section is None and start is not None and end is not None:
                for s in sections:
                    a, b = s.get('start_seconds'), s.get('end_seconds')
                    if all(isinstance(n, (int, float)) and not isinstance(n, bool) and math.isfinite(n) for n in (a, b)) and a < end and b > start:
                        section = s
                        break
            words = str(scene.get('narration') or (section or {}).get('text') or '') if dialogue else ''
            if len(words) > 4000:
                raise BridgeError('每个剪辑镜头的字幕最多 4000 字，请先拆分旁白')
            specs.append({'key': key, 'scene': scene, 'duration': duration, 'dialogue': words})
        return specs

    def shot_media(self, data, key, selected):
        """Only bind explicitly selected files. Prefer recorded scene bindings;
        ambiguous filename candidates stay unassigned for the user to choose.
        """
        bindings = data['asset_manifest'].get('assets', [])
        bindings = [a for a in bindings if isinstance(a, dict) and str(a.get('scene_id')) == key] if isinstance(bindings, list) else []
        images = data['image_manifest'].get('images', [])
        images = [a for a in images if isinstance(a, dict) and str(a.get('shot_id')) == key] if isinstance(images, list) else []
        def recorded(entries, kinds):
            for entry in reversed(entries):
                item = selected.get(entry['path']) if isinstance(entry.get('path'), str) else None
                if item and item['asset']['type'].split('/')[0] in kinds and (not entry.get('sha256') or entry['sha256'] == item['sha256']):
                    return item['asset']['id']
            return None
        visual = recorded(bindings, {'image', 'video'})
        if not visual:
            # A stale recorded hash must not be silently bypassed by a name match.
            recorded_paths = {a['path'] for a in bindings + images if isinstance(a.get('path'), str)}
            candidates = [v['asset'] for path, v in selected.items() if Path(path).stem == key and path not in recorded_paths]
            videos = [a for a in candidates if a['type'].startswith('video/')]
            pictures = [a for a in candidates if a['type'].startswith('image/')]
            if len(videos) == 1:
                visual = videos[0]['id']
            elif not videos:
                # A separately selected shot video should take precedence over
                # its storyboard still when no authoritative asset binding exists.
                visual = recorded(images, {'image'})
                if not visual and len(pictures) == 1:
                    visual = pictures[0]['id']
        voice = recorded([a for a in bindings if a.get('type') in {'audio', 'narration'}], {'audio'})
        return visual, voice

    def media_file(self, project_id, relative):
        project = self.project(project_id)
        path = Path(relative)
        if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] not in {'assets', 'renders', 'exports', 'analysis', 'artifacts'}:
            raise BridgeError('只能交换当前作品中的素材')
        if path.parts[0] == 'artifacts' and not re.fullmatch(r'artifacts/footage_jobs/footage-[a-f0-9]{24}/(?:narration|voice-[1-9][0-9]*)\.wav', relative):
            raise BridgeError('只能交换真实素材任务的已保存旁白，不读取其他项目资料')
        if path.parts[0] == 'analysis' and path.parts[:2] != ('analysis', 'montage'):
            raise BridgeError('只能交换当前作品的媒体产物')
        target = project / path
        if target.is_symlink() or not target.is_file() or not target.resolve().is_relative_to(project):
            raise BridgeError('素材已移动或路径越出当前作品')
        if target.suffix.lower() not in MEDIA or not 0 < target.stat().st_size <= MAX_MEDIA:
            raise BridgeError('素材格式不支持或超过本机交换的 4 GB 上限')
        return target

    def file_token(self, file, relative):
        st = file.stat()
        return hashlib.sha256(f'{relative}|{st.st_size}|{st.st_mtime_ns}|{st.st_ctime_ns}'.encode()).hexdigest()

    def inventory(self, project_id, cut_id='', cut_version=1):
        project = self.project(project_id)
        data, revision = self.source_data(project_id, cut_id, cut_version)
        media, capped, skipped = [], False, 0
        cut = data.get('footage_cut')
        for folder in ([] if cut else ['assets', 'renders', 'exports', 'analysis/montage']):
            base = project / folder
            if not base.is_dir() or base.is_symlink():
                continue
            for file in sorted(base.rglob('*')):
                if file.suffix.lower() not in MEDIA or not file.is_file():
                    continue
                relative = file.relative_to(project).as_posix()
                try:
                    file = self.media_file(project_id, relative)
                    actual_type = media_type(file)
                except (BridgeError, OSError):
                    skipped += 1
                    continue
                if len(media) >= 500:
                    capped = True
                    break
                media.append({'path': relative, 'name': file.name, 'size': file.stat().st_size,
                              'type': actual_type, 'token': self.file_token(file, relative)})
            if capped:
                break
        script = data['script']
        scenes = data['scenes'].get('scenes', [])
        if cut:
            for relative in cut['media_paths']:
                file = self.media_file(project_id, relative)
                media.append({'path': relative, 'name': file.name, 'size': file.stat().st_size,
                              'type': media_type(file), 'token': self.file_token(file, relative)})
        return {'project_id': project_id, 'title': data['project'].get('title') or script.get('title') or project_id,
                'source_revision': revision, 'has_script': bool(script), 'scene_count': len(scenes),
                'media': media, 'media_capped': capped, 'media_skipped': skipped,
                'cut': {'id': cut_id, 'version': cut_version, 'warnings': cut['warnings']} if cut else None,
                'link': self.link_public(self.read_link(project_id, cut_id, cut_version))}

    def import_media(self, project_id, cid, item):
        file = self.media_file(project_id, item.path)
        if self.file_token(file, item.path) != item.token:
            raise BridgeError('所选素材已变化，请重新读取后选择', 409)
        sha = digest_file(file)
        actual_type = media_type(file)
        request_id = str(uuid.uuid5(uuid.NAMESPACE_URL, cid + ':' + item.path + ':' + sha + ':' + actual_type))
        route = '/api/asset-imports/' + request_id + '?' + urlencode({'projectId': cid})
        try:
            record = self.rpc('GET', route)
        except BridgeError as error:
            if error.status != 404:
                raise
            record = None
        if record:
            if record.get('status') != 'completed':
                raise BridgeError('该素材的上次接收未完成；保留原记录，请核对画布素材库', 409)
            asset = record['asset']
        else:
            query = urlencode({'projectId': cid, 'requestId': request_id, 'name': file.name})
            asset = self.rpc('POST', '/api/assets/stream?' + query, file=file,
                             media_type=actual_type, timeout=120)
        if asset.get('sha256') != sha or asset.get('size') != file.stat().st_size:
            raise BridgeError('接收副本与原素材校验不一致；未加入画布', 409)
        if self.file_token(file, item.path) != item.token:
            raise BridgeError('复制期间原素材已变化；未加入画布，请刷新核对', 409)
        return asset, sha

    def push(self, body):
        self.require_engine()
        with self.lock(body.project_id):
            data, revision = self.source_data(body.project_id, body.cut_id, body.cut_version)
            if revision != body.source_revision:
                raise BridgeError('作品脚本或分镜已更新，请重新读取', 409)
            if not body.include_script and not body.include_scenes and not body.include_timeline and not body.files:
                raise BridgeError('请至少选择一项资料')
            specs = self.scene_specs(data, dialogue=body.include_script) if body.include_scenes or body.include_timeline else []
            if len({item.path for item in body.files}) != len(body.files):
                raise BridgeError('同一份素材只能选择一次')
            # Validate every selection before creating a project or copying.
            for item in body.files:
                file = self.media_file(body.project_id, item.path)
                if self.file_token(file, item.path) != item.token:
                    raise BridgeError('所选素材已变化，请重新读取', 409)
            link = self.ensure_link(body.project_id, body.cut_id, body.cut_version)
            cid = link['canvas_project_id']
            additions, assets, selected, shots = [], [], {}, []
            def node(key, kind, title, text='', asset=None, params=None):
                node_id = str(uuid.uuid5(uuid.NAMESPACE_URL, cid + ':' + key))
                additions.append({'id': node_id, 'type': kind, 'title': title[:120], 'text': text[:200000],
                                  'assetId': asset['id'] if asset else None, 'x': 0, 'y': 0,
                                  'params': params or {}})
                return node_id
            script_id = None
            if body.include_script and data['script']:
                script = data['script']
                text = '\n\n'.join(str(s.get('text', '')) for s in script.get('sections', []) if isinstance(s, dict))
                text = text or str(script.get('narration') or script.get('text') or '')
                script_id = node('script:' + hashlib.sha256(text.encode()).hexdigest(), 'script',
                                 script.get('title') or '作品脚本', text)
            scene_ids, edges = {}, []
            if body.include_scenes:
                for spec in specs:
                    scene, key = spec['scene'], spec['key']
                    text = '\n'.join(str(scene.get(k) or '') for k in ['description','movement','framing','shot_intent']).strip()
                    nid = node('scene:' + key + ':' + hashlib.sha256(text.encode()).hexdigest(), 'text',
                               '分镜 ' + key, text, params={'duration': spec['duration']})
                    scene_ids[key] = nid
                    if script_id:
                        edges.append((script_id, nid))
            for item in body.files:
                asset, sha = self.import_media(body.project_id, cid, item)
                assets.append(asset)
                selected[item.path] = {'asset': asset, 'sha256': sha}
                kind = asset['type'].split('/')[0]
                nid = node('media:' + item.path + ':' + sha, kind, asset['name'], asset=asset)
                # Bind shot-1 images/videos to their imported storyboard note.
                key = Path(item.path).stem
                if key in scene_ids:
                    edges.append((scene_ids[key], nid))
            if body.include_timeline:
                for spec in specs:
                    key, scene = spec['key'], spec['scene']
                    visual, voice = self.shot_media(data, key, selected)
                    edit = {'fit': 'contain', 'endMode': 'hold'}
                    cut = data.get('footage_cut')
                    if cut:
                        options = cut['options']
                        voice = (selected.get(cut['audio_path']) or {}).get('asset', {}).get('id')
                        edit = {'fit': 'cover' if options['fit'] == 'crop' else 'contain',
                                'sourceStart': scene['source_start'], 'sourceEnd': scene.get('source_end'),
                                'endMode': 'loop' if scene['repeat_to_fill'] else 'hold',
                                'sourceAudio': 'keep' if options['source_volume'] else 'mute',
                                'sourceVolume': options['source_volume'], 'voiceStart': scene['start_seconds'],
                                'voiceVolume': options['narration_volume'],
                                'subtitleCues': scene.get('subtitle_cues') if body.include_script else None}
                    shots.append({'id': str(uuid.uuid5(uuid.NAMESPACE_URL, cid + ':workbench-shot:' + body.project_id + ':' + key)),
                                  'title': str(scene.get('title') or '分镜 ' + key)[:120],
                                  'description': '\n'.join(str(scene.get(k) or '') for k in ['description', 'movement', 'framing', 'shot_intent']).strip(),
                                  'duration': spec['duration'], 'dialogue': spec['dialogue'],
                                  'assetId': visual, 'audioId': voice,
                                  'edit': edit,
                                  'workbenchSource': {'version': 1, 'projectId': body.project_id, 'sceneId': key, 'revision': revision}})
            if self.source_data(body.project_id, body.cut_id, body.cut_version)[1] != revision:
                raise BridgeError('复制期间分镜或素材清单已变化；已接收副本保留，请重新读取', 409)
            # CAS retries only rebase local appends, never rerun uploads/generation.
            for attempt in range(3):
                canvas = self.rpc('GET', '/api/projects/' + cid)
                known = {n['id'] for n in canvas['nodes']}
                fresh = [n.copy() for n in additions if n['id'] not in known]
                x = max((n['x'] for n in canvas['nodes']), default=-240) + 480
                for index, entry in enumerate(fresh):
                    entry['x'] = x + (index % 3) * 370
                    entry['y'] = 100 + (index // 3) * 330
                canvas['nodes'].extend(fresh)
                known_assets = {a['id'] for a in canvas['assets']}
                canvas['assets'].extend(a for a in assets if a['id'] not in known_assets)
                known_shots = {s['id'] for s in canvas['shots']}
                fresh_shots = [s.copy() for s in shots if s['id'] not in known_shots]
                settings_changed = False
                cut = data.get('footage_cut')
                # Initialize the new cut's editable settings exactly once.
                # An already edited timeline/music track always wins on repeat.
                if cut and fresh_shots and not canvas['shots']:
                    options = cut['options']
                    canvas['settings']['fps'] = options['fps']
                    if not canvas['settings'].get('edit'):
                        subtitles = options['subtitles']
                        music_asset = (selected.get(cut['bgm_path']) or {}).get('asset')
                        from web_api.footage_render import _target_dimensions
                        _, source_height = _target_dimensions(options['aspect_ratio'], options['resolution'])
                        canvas_height = {'16:9': 720, '9:16': 1280, '1:1': 720}[options['aspect_ratio']]
                        scale = canvas_height / source_height
                        canvas['settings']['edit'] = {
                            'burnSubtitles': subtitles['enabled'] and body.include_script,
                            'transition': {'mode': options['transition'], 'seconds': options['transition_seconds']},
                            'duckMusic': options['duck_bgm'],
                            'subtitle': {'font': subtitles['font'], 'fontSize': round(subtitles['font_size'] * scale),
                                         'color': subtitles['color'], 'outlineColor': subtitles['outline_color'],
                                         'position': subtitles['position'], 'outline': subtitles['outline_width'] * scale,
                                         'bottom': max(12, subtitles['font_size'] * 1.25) * scale,
                                         'backgroundOpacity': .45 if subtitles['background'] else 0},
                            'music': [{'id': str(uuid.uuid5(uuid.NAMESPACE_URL, cid + ':cut-music')),
                                       'assetId': music_asset['id'], 'start': 0, 'sourceStart': 0,
                                       'duration': cut['duration'], 'volume': options['bgm_volume'],
                                       'fadeOut': min(1.0, cut['duration']),
                                       'loop': True}] if music_asset else []}
                        settings_changed = True
                canvas['shots'].extend(fresh_shots)
                unassigned = sum(not s.get('assetId') for s in fresh_shots)
                receipt = {'added_nodes': len(fresh), 'media_count': len(assets), 'added_shots': len(fresh_shots),
                           'preserved_shots': len(shots) - len(fresh_shots), 'unassigned_shots': unassigned}
                known_edges = {e['id'] for e in canvas['edges']}
                added_edges = 0
                for source, target in edges:
                    eid = str(uuid.uuid5(uuid.NAMESPACE_URL, cid + source + target))
                    if eid not in known_edges:
                        canvas['edges'].append({'id': eid, 'source': source, 'target': target})
                        added_edges += 1
                if not fresh and not fresh_shots and not added_edges and not settings_changed and not any(a['id'] not in known_assets for a in assets):
                    return {**self.link_public(link), **receipt, 'message': '资料已在画布中，无需重复添加；已有剪辑镜头保留原编辑'}
                if len(canvas['nodes']) > 1500 or len(canvas['shots']) > 2000:
                    raise BridgeError('画布节点或剪辑镜头超过容量；已接收素材仍保存在画布素材库', 409)
                try:
                    self.rpc('PUT', '/api/projects/' + cid, canvas)
                    message = f'已带入 {len(fresh)} 个节点、{len(assets)} 份素材'
                    if body.include_timeline:
                        message += f'；新增 {len(fresh_shots)} 个剪辑镜头'
                        if unassigned:
                            message += f'，其中 {unassigned} 个待选画面，请在「分镜」里选择素材'
                        if receipt['preserved_shots']:
                            message += f'；已有 {receipt["preserved_shots"]} 个镜头保留原编辑'
                    return {**self.link_public(link), **receipt, 'warnings': cut['warnings'] if cut else [], 'message': message}
                except BridgeError as error:
                    if error.status != 409 or attempt == 2:
                        raise

    def outputs(self, project_id, cut_id='', cut_version=1):
        self.require_engine()
        link = self.read_link(project_id, cut_id, cut_version)
        if not link or not link.get('canvas_project_id'):
            return {'assets': [], 'link': None}
        cid = link['canvas_project_id']
        canvas = self.rpc('GET', '/api/projects/' + cid)
        return {'assets': [{'id': a['id'], 'name': a['name'], 'type': a['type'], 'size': a.get('size'),
                            'url': f'http://127.0.0.1:{self.port}/media/{quote(a["id"])}'}
                           for a in canvas['assets'] if a['type'].split(';')[0] in MEDIA.values()],
                'link': self.link_public(link)}

    def pull(self, body):
        self.require_engine()
        with self.lock(body.project_id):
            project = self.project(body.project_id)
            link = self.read_link(body.project_id, body.cut_id, body.cut_version)
            if not link or not link.get('canvas_project_id'):
                raise BridgeError('当前作品尚未打开画布')
            cid = link['canvas_project_id']
            canvas = self.rpc('GET', '/api/projects/' + cid)
            members = {a['id']: a for a in canvas['assets']}
            for aid in body.asset_ids:
                if aid not in members or not CANVAS_ID.fullmatch(aid):
                    raise BridgeError('所选素材不属于当前作品的画布', 403)
                if members[aid]['type'].split(';')[0] not in MEDIA.values():
                    raise BridgeError('只能取回图片、视频和音频')
                if not 0 < int(members[aid].get('size') or 0) <= MAX_MEDIA:
                    raise BridgeError('素材大小无效或超过 4 GB')
            if len(set(body.asset_ids)) != len(body.asset_ids):
                raise BridgeError('同一份素材只能取回一次')
            manifest_file = project / 'artifacts' / 'canvas_manifest.json'
            manifest = json.loads(manifest_file.read_text()) if manifest_file.exists() else {'version': 1, 'project_id': body.project_id, 'assets': []}
            received = []
            for aid in body.asset_ids:
                asset = members[aid]
                directory = project / 'assets' / 'canvas' / cid
                if not directory.resolve().is_relative_to(project):
                    raise BridgeError('回填目录越出当前作品')
                directory.mkdir(parents=True, exist_ok=True)
                previous = next((a for a in manifest['assets'] if a['canvas_asset_id'] == aid), None)
                if previous:
                    file = self.media_file(body.project_id, previous['path'])
                    if file.stat().st_size == asset['size'] and digest_file(file) == previous['sha256'] and (not asset.get('sha256') or asset['sha256'] == previous['sha256']):
                        received.append(previous)
                        continue
                    raise BridgeError('已回填副本被修改，保留现有文件，请另选产物', 409)
                suffix = next(ext for ext, typ in MEDIA.items() if typ == asset['type'].split(';')[0])
                pending = directory / (aid + '.received-' + uuid.uuid4().hex + '.part')
                conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=120)
                try:
                    conn.request('GET', '/media/' + quote(aid))
                    response = conn.getresponse()
                    if response.status != 200 or int(response.getheader('Content-Length', '0')) != asset['size']:
                        raise BridgeError('画布原文件大小无法核对；未回填')
                    sha, size = hashlib.sha256(), 0
                    with pending.open('xb') as stream:
                        for block in iter(lambda: response.read(1024 * 1024), b''):
                            size += len(block)
                            if size > asset['size']:
                                raise BridgeError('接收文件超过原文件大小')
                            sha.update(block)
                            stream.write(block)
                        stream.flush()
                        os.fsync(stream.fileno())
                    if size != asset['size'] or (asset.get('sha256') and asset['sha256'] != sha.hexdigest()):
                        raise BridgeError('画布文件校验不一致；收到的部分文件保留，未作为成果')
                    target = directory / (aid + '-' + sha.hexdigest()[:12] + suffix)
                    if target.exists():
                        if digest_file(target) != sha.hexdigest():
                            raise BridgeError('回填文件名冲突，未覆盖原件', 409)
                    else:
                        # Exclusive hard link: no sole copy can be overwritten.
                        os.link(pending, target)
                    item = {'canvas_asset_id': aid, 'canvas_project_id': cid, 'name': asset['name'],
                            'path': target.relative_to(project).as_posix(), 'sha256': sha.hexdigest(),
                            'size_bytes': size, 'type': asset['type'], 'received_at': stamp()}
                    manifest['assets'].append(item)
                    # Persist each completed file for crash/partial-batch recovery.
                    atomic_json(manifest_file, manifest)
                    received.append(item)
                except (OSError, http.client.HTTPException):
                    raise BridgeError('回填连接中断，已完成副本及部分文件保留，请刷新原记录', 503) from None
                finally:
                    conn.close()
            from backlot.server import notify_project_changed
            notify_project_changed(body.project_id)
            return {'assets': received, 'message': f'已取回 {len(received)} 份素材，可在后期制作中选用',
                    'return_url': '/model?' + urlencode({'project': body.project_id, 'workspace': 'edit'})}


class Closed(BaseModel):
    model_config = ConfigDict(extra='forbid')


class OpenRequest(Closed):
    project_id: str = Field(min_length=1, max_length=128)
    cut_id: str = Field(default='', pattern=r'^(?:footage-[a-f0-9]{24})?$')
    cut_version: int = Field(default=1, ge=1, le=5)
    confirm: bool = False


class FileSelection(Closed):
    path: str = Field(min_length=1, max_length=500)
    token: str = Field(pattern=r'^[a-f0-9]{64}$')


class PushRequest(OpenRequest):
    source_revision: str = Field(pattern=r'^[a-f0-9]{64}$')
    include_script: bool = True
    include_scenes: bool = True
    include_timeline: bool = False
    files: list[FileSelection] = Field(default_factory=list, max_length=64)


class PullRequest(OpenRequest):
    asset_ids: list[str] = Field(min_length=1, max_length=64)


class StartRequest(Closed):
    confirm: bool = False


def create_canvas_router(project_root, **options):
    bridge = CanvasBridge(project_root, **options)

    async def local_only(request: Request):
        if request.method != 'GET':
            origin = request.headers.get('origin')
            if request.headers.get('sec-fetch-site') == 'cross-site' or (origin and urlsplit(origin).netloc != request.headers.get('host')):
                raise HTTPException(403, '仅允许从本机工作台交换资料')

    router = APIRouter(prefix='/model-api/canvas', dependencies=[Depends(local_only)])

    async def call(fn, *args):
        try:
            return await asyncio.to_thread(fn, *args)
        except BridgeError as error:
            raise HTTPException(error.status, str(error)) from None

    def consent(body):
        if not body.confirm:
            raise HTTPException(422, '请明确确认本机资料交换；不会调用模型或上传云端')

    @router.get('/status')
    async def status():
        return await call(bridge.status)

    @router.post('/start')
    async def start(body: StartRequest):
        consent(body)
        return await call(bridge.start)

    @router.get('/projects/{project_id}')
    async def inventory(project_id: str, cut_id: str = '', cut_version: int = 1):
        return await call(bridge.inventory, project_id, cut_id, cut_version)

    @router.post('/open')
    async def open_canvas(body: OpenRequest):
        consent(body)
        return await call(bridge.open, body.project_id, body.cut_id, body.cut_version)

    @router.post('/push')
    async def push(body: PushRequest):
        consent(body)
        return await call(bridge.push, body)

    @router.get('/projects/{project_id}/outputs')
    async def outputs(project_id: str, cut_id: str = '', cut_version: int = 1):
        return await call(bridge.outputs, project_id, cut_id, cut_version)

    @router.post('/pull')
    async def pull(body: PullRequest):
        consent(body)
        return await call(bridge.pull, body)

    return router
