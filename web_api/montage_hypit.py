"""Approval-bound director access to the pinned, official Hypit runtime.

Authoring is local file work. Executing even a Check or Plan loads project code
and is a separate caller-owned approval boundary. This module never accepts CLI
fragments, Runtime configuration, credentials, provisioning or paid approval.
An adapter job stopping is not proof that official Build work stopped.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import threading
import time
from typing import Any, Callable, Mapping
import uuid

from web_api.hypit_runtime import BUILD_ID_RE, HYPIT_ROOT, HYPIT_VERSION, TERMINAL, HypitRuntime


AUTHOR_SUFFIXES = frozenset({'.svml', '.svs', '.svrun', '.js', '.ts', '.tsx', '.css', '.svg', '.md', '.json'})
IMAGE_SUFFIXES = frozenset({'.png', '.jpg', '.jpeg', '.webp', '.gif'})
AV_SUFFIXES = frozenset({'.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.ogv', '.ts', '.wav', '.mp3', '.m4a', '.ogg', '.flac'})
MEDIA_SUFFIXES = IMAGE_SUFFIXES | AV_SUFFIXES
MAX_AUTHOR_BYTES = 512 * 1024
MAX_AUTHOR_TOTAL = 8 * 1024 * 1024
MAX_AUTHOR_FILES = 256
MAX_MEDIA_BYTES = 512 * 1024 * 1024
MAX_MEDIA_TOTAL = 2 * 1024 * 1024 * 1024
MAX_MEDIA_FILES = 128
PROFILE_TEMPLATE = HYPIT_ROOT / 'examples' / 'semantic-composition' / 'hypit.runtime.json'
STANDARD_MAC_CHROME = Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
RESERVED_ROOTS = frozenset({'.hypit', 'assets', 'exports', 'artifacts', 'node_modules'})
CONFIG_NAMES = frozenset({
    'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'tsconfig.json',
    'jsconfig.json', 'hypit.runtime.json', 'pnpm-lock.yaml', 'yarn.lock',
})
SENSITIVE_NAME = re.compile(r'(?:credential|secret|password|token|api[-_]?key|runtime[.-]?profile)', re.I)
COMPONENT_NAME = re.compile(r'^@openmontage/([a-z][a-z0-9-]{0,63})$')
OUTPUT_SUFFIXES = {
    'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
    'video/ogg': '.ogv', 'video/mp2t': '.ts',
    'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav',
    'audio/mp4': '.m4a', 'audio/ogg': '.ogg', 'audio/flac': '.flac',
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
    'application/json': '.json', 'text/plain': '.txt',
}
_LOCKS: dict[str, threading.RLock] = {}
_LOCKS_GUARD = threading.Lock()


def _chrome_selection() -> dict:
    """Select an existing executable from administrator/host configuration only."""
    configured = os.environ.get('OPENMONTAGE_HYPIT_CHROME_PATH', '')
    candidates: list[tuple[str, Path]] = []
    configured_valid = None

    def executable(path: Path) -> bool:
        try:
            return path.is_absolute() and path.is_file() and os.access(path, os.X_OK)
        except OSError:
            return False

    if configured:
        configured_path = Path(configured).expanduser()
        configured_valid = executable(configured_path)
        candidates.append(('environment', configured_path))
    candidates.append(('standard_macos', STANDARD_MAC_CHROME))
    if sys.platform.startswith('linux'):
        for command in ('google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'):
            found = shutil.which(command)
            if found:
                candidates.append(('host_path', Path(found)))
    for source, path in candidates:
        if executable(path):
            return {'state': 'selected', 'source': source, 'chrome_path': str(path),
                    'configured_path_valid': configured_valid, 'execution_verified': False,
                    'message': '服务端选用本机现存可执行 Chrome；官方 Plan 与渲染仍需独立验证。'}
    return {'state': 'managed_default', 'source': None, 'chrome_path': None,
            'configured_path_valid': configured_valid, 'execution_verified': False,
            'message': '未找到可执行的本机 Chrome；保留固定 Profile 的默认浏览器，由官方 Plan 核对准备条件。'}


def hypit_capabilities() -> dict:
    """Static checkout/tool availability; no CLI, directory creation or install."""
    launcher = HYPIT_ROOT / 'bin' / 'hypit.mjs'
    available = bool(launcher.is_file() and shutil.which('node') and (HYPIT_ROOT / 'node_modules').is_dir())
    return {'available': available, 'status': 'ready' if available else 'needs_setup',
            'version': HYPIT_VERSION, 'execution_scope': 'local_only',
            'browser': _chrome_selection(),
            'runtime_execution_verified': False,
            'message': '仅核对 pinned Hypit、Node 与现存依赖；官方 Worker、复刻素材、模型账号和成片尚未验证。'}


def _sha256(path: Path, *, limit: int) -> tuple[int, str]:
    """Read regular files without following a replaced final symlink."""
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    descriptor = os.open(path, flags)
    with os.fdopen(descriptor, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise ValueError('Hypit 文件不是普通文件或超过大小上限')
        total = 0
        digest = hashlib.sha256()
        while chunk := stream.read(1024 * 1024):
            total += len(chunk)
            if total > limit:
                raise ValueError('Hypit 文件超过大小上限')
            digest.update(chunk)
        return total, digest.hexdigest()


class HypitDirectorBridge:
    """One isolated author workspace and one job manager per director session.

    ``workspace_root`` and every returned output path are relative to ``project``.
    Write paths and Check/Plan/Build source paths are relative to that workspace.
    ``execute`` must be called only after the director's human approval gate.
    The factory is injectable for protocol tests; production uses HypitRuntime.
    """

    def __init__(self, project: Path, run: Path, runtime_factory: Callable[..., Any] = HypitRuntime):
        self.project = Path(project).absolute()
        self.run = Path(run).absolute()
        if '..' in self.project.parts or '..' in self.run.parts:
            raise ValueError('Hypit project/session 不能使用越界路径')
        if self.project.is_symlink() or not self.project.is_dir():
            raise ValueError('Hypit 当前项目必须是现存普通目录')
        if not self.run.is_relative_to(self.project) or self.run == self.project:
            raise ValueError('Hypit session 必须位于当前项目内')
        self._assert_path(self.run)
        if not self.run.is_dir():
            raise ValueError('Hypit session 目录不存在')
        self.workspace = self.run / 'hypit-workspace'
        self.workspace_root = self.workspace.relative_to(self.project).as_posix()
        self.ledger_path = self.run / 'hypit-bridge.json'
        self.versions = self.run / 'hypit-versions'
        self.runtime_factory = runtime_factory
        self._runtime_instance: Any | None = None
        with _LOCKS_GUARD:
            self.lock = _LOCKS.setdefault(str(self.run), threading.RLock())

    def _assert_path(self, path: Path) -> Path:
        """Reject all symlink components below the project, including internal ones."""
        if '..' in path.parts or not path.is_relative_to(self.project):
            raise ValueError('Hypit 路径不能离开当前项目')
        current = self.project
        for piece in path.relative_to(self.project).parts:
            current = current / piece
            if current.is_symlink():
                raise ValueError('Hypit 不接受符号链接路径')
            if current.exists() and not current.is_dir() and current != path:
                raise ValueError('Hypit 路径中间项必须是目录')
        return path

    @staticmethod
    def _relative(raw: Any) -> Path:
        if not isinstance(raw, str) or not raw or raw != raw.strip() or '\\' in raw or '\x00' in raw:
            raise ValueError('Hypit 文件必须使用普通相对路径')
        value = Path(raw)
        if value.is_absolute() or any(part in {'.', '..'} or part.startswith('.') for part in raw.split('/')):
            raise ValueError('Hypit 不接受绝对、越界或隐藏文件路径')
        if any(not part for part in raw.split('/')):
            raise ValueError('Hypit 相对路径不能为空')
        return value

    def _author_path(self, raw: Any, *, suffixes: frozenset[str] = AUTHOR_SUFFIXES) -> Path:
        value = self._relative(raw)
        if value.parts[0].lower() in RESERVED_ROOTS or any(
            part.lower() in CONFIG_NAMES or SENSITIVE_NAME.search(part) for part in value.parts
        ) or value.suffix.lower() not in suffixes:
            raise ValueError('Hypit 仅允许创作文件；不能修改 Runtime Profile、凭据或执行配置')
        return self._assert_path(self.workspace / value)

    def _runtime(self):
        if self._runtime_instance is None:
            self._runtime_instance = self.runtime_factory(project_root=self.run)
        return self._runtime_instance

    def close(self, *, wait: bool = False):
        """Release adapter executor; this does not cancel official Build work."""
        if self._runtime_instance is not None:
            self._runtime_instance.close(wait=wait)

    shutdown = close

    def _ledger(self) -> dict:
        self._assert_path(self.ledger_path)
        if not self.ledger_path.exists():
            return {'format': 'openmontage.hypit-director@1', 'builds': {}, 'imports': []}
        if self.ledger_path.stat().st_size > MAX_AUTHOR_TOTAL:
            raise ValueError('Hypit session 记录超过大小上限')
        data = json.loads(self.ledger_path.read_text(encoding='utf-8'))
        if not isinstance(data, dict) or data.get('format') != 'openmontage.hypit-director@1':
            raise ValueError('Hypit session 记录格式无效')
        if not isinstance(data.get('builds'), dict) or not isinstance(data.get('imports'), list):
            raise ValueError('Hypit session 记录格式无效')
        if not isinstance(data.get('components', {}), dict) or not isinstance(data.get('authored_files', {}), dict):
            raise ValueError('Hypit session 作者/组件记录格式无效')
        return data

    def _save_ledger(self, data: dict):
        self._assert_path(self.ledger_path)
        temporary = self.ledger_path.with_name('hypit-bridge-' + uuid.uuid4().hex + '.tmp')
        with temporary.open('x', encoding='utf-8') as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2, allow_nan=False)
        os.replace(temporary, self.ledger_path)

    def _profile_bytes(self) -> bytes:
        # The fixed pinned reference contains only media.local/hyperframes.local.
        if PROFILE_TEMPLATE.is_symlink() or not PROFILE_TEMPLATE.is_file():
            raise ValueError('固定 Hypit 本地 Runtime Profile 模板不可用')
        if PROFILE_TEMPLATE.stat().st_size > MAX_AUTHOR_BYTES:
            raise ValueError('固定 Hypit 本地 Runtime Profile 模板超过大小上限')
        payload = PROFILE_TEMPLATE.read_bytes()
        profile = json.loads(payload)
        if profile.get('format') != 'hypit.runtime-local@1' or profile.get('dataRoot') != '.hypit/runtimes/local':
            raise ValueError('固定 Hypit 本地 Runtime Profile 模板不符合预期')
        endpoints = profile.get('endpoints', {})
        allowed = {'media.local': '@hypit/provider-media-local', 'hyperframes.local': '@hypit/provider-hyperframes-local'}
        if not isinstance(endpoints, dict) or not endpoints or any(
            name not in allowed or not isinstance(row, dict) or row.get('use') != allowed[name]
            for name, row in endpoints.items()
        ):
            raise ValueError('固定 Hypit Profile 不能包含外部 Provider')
        # Only this server-owned configuration selects the browser. Upstream
        # deliberately ignores environment hints as execution inputs. Preserve
        # a trusted template's explicit browser configuration (including fixtures).
        hyperframes = endpoints.get('hyperframes.local')
        if isinstance(hyperframes, dict):
            config = hyperframes.get('config', {})
            if not isinstance(config, dict):
                raise ValueError('固定 Hypit 本地 HyperFrames 配置格式无效')
            browser = _chrome_selection()
            if browser['chrome_path'] and not any(key in config for key in ('chromePath', 'browserVersion', 'browserDownloadBaseUrl')):
                hyperframes['config'] = {**config, 'chromePath': browser['chrome_path']}
                return (json.dumps(profile, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
        return payload

    def _ensure_workspace(self):
        self._assert_path(self.workspace)
        if self.workspace.exists():
            self._validate_profile()
            return
        payload = self._profile_bytes()
        self.workspace.mkdir(exist_ok=False)
        with (self.workspace / 'hypit.runtime.json').open('xb') as stream:
            stream.write(payload)
        (self.workspace / '.hypit').mkdir()
        with (self.workspace / '.hypit' / 'runtime').open('x', encoding='utf-8') as stream:
            stream.write('hypit.runtime.json\n')
        self._save_ledger(self._ledger())

    def _validate_profile(self):
        self._assert_path(self.workspace)
        profile = self._assert_path(self.workspace / 'hypit.runtime.json')
        marker = self._assert_path(self.workspace / '.hypit' / 'runtime')
        self._assert_path(self.workspace / '.hypit' / 'runtimes' / 'local')
        if not profile.is_file() or not marker.is_file():
            raise ValueError('Hypit 固定本地 Profile 或选择标记缺失')
        if profile.stat().st_size > MAX_AUTHOR_BYTES or profile.read_bytes() != self._profile_bytes():
            raise ValueError('Hypit 固定 Runtime Profile 已改变；审批失效')
        if marker.stat().st_size > 128 or marker.read_text(encoding='utf-8') != 'hypit.runtime.json\n':
            raise ValueError('Hypit Runtime 选择标记已改变；审批失效')

    def _envelope(self, **values) -> dict:
        return {'engine': 'hypit', 'workspace_root': self.workspace_root,
                'build_id': None, 'outputs': [], 'delivery_verified': False, **values}

    def status(self) -> dict:
        """Read metadata only: never creates a workspace or starts official CLI."""
        with self.lock:
            self._assert_path(self.workspace)
            exists = self.workspace.is_dir()
            if exists:
                self._validate_profile()
            native = self._runtime().status(self.workspace if exists else self.run)
            checkout = native.get('checkout', {})
            ready = bool(checkout.get('exists') and checkout.get('node_available') and checkout.get('dependencies_installed'))
            ledger = self._ledger()
            unfinished = [row for row in ledger['builds'].values() if row.get('execution_state') != 'terminal']
            fingerprint = self.fingerprint() if exists else None
            files = []
            if exists:
                for path in self._author_files() + [self.workspace / 'hypit.runtime.json']:
                    size, digest = _sha256(path, limit=MAX_AUTHOR_BYTES)
                    files.append({'path': path.relative_to(self.project).as_posix(), 'kind': 'file',
                                  'bytes': size, 'sha256': digest})
            last_plan = ledger.get('last_plan')
            if not isinstance(last_plan, dict) or last_plan.get('fingerprint') != fingerprint:
                last_plan = None
            browser = _chrome_selection()
            if exists:
                profile_config = json.loads((self.workspace / 'hypit.runtime.json').read_bytes())
                selected_path = profile_config.get('endpoints', {}).get('hyperframes.local', {}).get('config', {}).get('chromePath')
                if selected_path != browser['chrome_path']:
                    browser = {**browser, 'chrome_path': selected_path,
                               'source': 'profile_template' if selected_path else None,
                               'state': 'selected' if selected_path else 'managed_default'}
            return self._envelope(status='ready' if ready else 'needs_setup', ready=ready,
                author_workspace_exists=exists, runtime_execution_verified=False,
                browser=browser,
                files=files, fingerprint=fingerprint, last_plan=last_plan,
                components=list(ledger.get('components', {}).values()),
                supported_authoring_operations=['write', 'import_media', 'register_component'],
                plan=last_plan.get('plan') if last_plan else None,
                supported_operations=['check', 'plan', 'build', 'inspect', 'get'],
                external_builds='blocked', unfinished_builds=unfinished,
                unresolved_submission=ledger.get('unresolved_submission'), native_status=native,
                message='仅核对 pinned Hypit、Node 与依赖的本地可用性；不代表复刻、模型账号、Runtime Worker 或成片已就绪。')

    def write(self, path: str, content: str) -> dict:
        if not isinstance(content, str):
            raise ValueError('Hypit 创作正文必须是 UTF-8 文本')
        payload = content.encode('utf-8')
        if len(payload) > MAX_AUTHOR_BYTES:
            raise ValueError('Hypit 单个创作文件超过大小上限')
        with self.lock:
            destination = self._author_path(path)
            self._ensure_workspace()
            previous = None
            if destination.exists():
                if not destination.is_file():
                    raise ValueError('Hypit 创作目标必须是普通文件')
                _sha256(destination, limit=MAX_AUTHOR_BYTES)
                version = self._assert_path(self.versions / (uuid.uuid4().hex + destination.suffix))
                version.parent.mkdir(parents=True, exist_ok=True)
                self._copy_new(destination, version, limit=MAX_AUTHOR_BYTES)
                previous = version.relative_to(self.project).as_posix()
            current = self._author_files()
            count = len(current) + (0 if destination in current else 1)
            total = sum(item.stat().st_size for item in current if item != destination) + len(payload)
            if count > MAX_AUTHOR_FILES or total > MAX_AUTHOR_TOTAL:
                raise ValueError('Hypit 创作工程超过文件数量或总大小上限')
            destination.parent.mkdir(parents=True, exist_ok=True)
            self._assert_path(destination)
            temporary = destination.with_name(destination.name + '-' + uuid.uuid4().hex + '.tmp')
            with temporary.open('xb') as stream:
                stream.write(payload)
            os.replace(temporary, destination)
            ledger = self._ledger()
            ledger.setdefault('authored_files', {})[destination.relative_to(self.workspace).as_posix()] = {
                'bytes': len(payload), 'sha256': hashlib.sha256(payload).hexdigest()}
            self._save_ledger(ledger)
            return self._envelope(status='written', path=destination.relative_to(self.project).as_posix(),
                author_path=destination.relative_to(self.workspace).as_posix(), previous_version=previous,
                fingerprint=self.fingerprint(), message='已写入本 session 的 Hypit 创作工程；未执行 Hypit。')

    def _component_spec(self, name: str, activation: str, entry: str | None, ledger: dict) -> tuple[Path, bytes, dict]:
        match = COMPONENT_NAME.fullmatch(name) if isinstance(name, str) else None
        if not match:
            raise ValueError('Hypit 组件名称仅允许 @openmontage/<小写 slug>，不能覆盖 @hypit 或其他命名空间')
        root = self._assert_path(self.workspace / 'packages' / match[1])
        references = {}
        for label, raw in [('activation', activation), ('entry', entry)]:
            if raw is None and label == 'entry':
                continue
            relative = self._relative(raw)
            target = self._author_path((root / relative).relative_to(self.workspace).as_posix(),
                                       suffixes=frozenset({'.js', '.ts'}))
            if not target.is_file():
                raise ValueError('Hypit 注册入口必须已由 write 写入包内现存 .js/.ts 文件')
            receipt = ledger.get('authored_files', {}).get(target.relative_to(self.workspace).as_posix())
            size, digest = _sha256(target, limit=MAX_AUTHOR_BYTES)
            if not isinstance(receipt, dict) or receipt.get('bytes') != size or receipt.get('sha256') != digest:
                raise ValueError('Hypit 注册入口必须匹配本 session 的 write 记录；请通过 write 写入当前代码')
            references[label] = relative.as_posix()
        metadata = {'name': name, 'version': '0.0.0', 'private': True, 'type': 'module',
                    'hypit': {'activation': './' + references['activation']}}
        if 'entry' in references:
            metadata['exports'] = {'.': './' + references['entry']}
        payload = (json.dumps(metadata, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
        summary = {'name': name, 'activation': references['activation'], 'entry': references.get('entry'),
                   'package_root': root.relative_to(self.project).as_posix(),
                   'metadata_path': (root / 'package.json').relative_to(self.project).as_posix()}
        return root / 'package.json', payload, summary

    def _registered_metadata(self) -> dict[Path, dict]:
        ledger = self._ledger()
        result = {}
        for name, record in ledger.get('components', {}).items():
            if not isinstance(record, dict) or record.get('name') != name:
                raise ValueError('Hypit 已登记组件格式无效')
            target, payload, summary = self._component_spec(name, record.get('activation'), record.get('entry'), ledger)
            self._assert_path(target)
            if not target.is_file() or target.stat().st_size > MAX_AUTHOR_BYTES or target.read_bytes() != payload:
                raise ValueError('Hypit 服务端组件配置已改变或缺失；不能执行未经登记的 package.json')
            if record != summary:
                raise ValueError('Hypit 已登记组件路径与本 session 不一致')
            result[target] = summary
        return result

    def register_component(self, name: str, activation: str, entry: str | None = None) -> dict:
        """Create fixed package metadata; this authors files without executing code.

        Paths are relative to ``packages/<slug>``. Activation/export entries must
        already have matching write receipts. No caller-supplied package.json,
        scripts, dependencies, installation, or shadowing of @hypit is accepted.
        """
        with self.lock:
            ledger = self._ledger()
            destination, payload, summary = self._component_spec(name, activation, entry, ledger)
            self._validate_profile()
            current = self._author_files()
            total = sum(path.stat().st_size for path in current if path != destination) + len(payload)
            count = len(current) + (0 if destination in current else 1)
            if count > MAX_AUTHOR_FILES or total > MAX_AUTHOR_TOTAL:
                raise ValueError('Hypit 组件注册超过创作文件数量或总大小上限')
            previous = None
            if destination.exists():
                if name not in ledger.get('components', {}):
                    raise ValueError('Hypit 注册不能覆盖未经本服务登记的既有 package.json')
                version = self._assert_path(self.versions / (uuid.uuid4().hex + '.json'))
                version.parent.mkdir(parents=True, exist_ok=True)
                self._copy_new(destination, version, limit=MAX_AUTHOR_BYTES)
                previous = version.relative_to(self.project).as_posix()
            temporary = destination.with_name('package-' + uuid.uuid4().hex + '.tmp')
            with temporary.open('xb') as stream:
                stream.write(payload)
            self._assert_path(destination)
            os.replace(temporary, destination)
            ledger.setdefault('components', {})[name] = summary
            self._save_ledger(ledger)
            return self._envelope(status='component_registered', component=summary,
                path=summary['metadata_path'], author_path=destination.relative_to(self.workspace).as_posix(),
                previous_version=previous, fingerprint=self.fingerprint(),
                message='已登记包内组件并生成固定 ESM package metadata；未加载代码、运行 Hypit、编译或安装依赖。')

    def _copy_new(self, source: Path, target: Path, *, limit: int):
        self._assert_path(source)
        self._assert_path(target)
        descriptor = os.open(source, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
        with os.fdopen(descriptor, 'rb') as origin, target.open('xb') as destination:
            if not stat.S_ISREG(os.fstat(origin.fileno()).st_mode):
                raise ValueError('Hypit 只能复制普通文件')
            total = 0
            while chunk := origin.read(1024 * 1024):
                total += len(chunk)
                if total > limit:
                    raise ValueError('Hypit 素材超过大小上限；保留已写入的副本供检查')
                destination.write(chunk)

    def _media_record(self, path: Path) -> dict:
        self._assert_path(path)
        size, digest = _sha256(path, limit=MAX_MEDIA_BYTES)
        suffix = path.suffix.lower()
        record = {'path': path.relative_to(self.project).as_posix(), 'bytes': size,
                  'sha256': digest, 'kind': 'file', 'playable': False}
        if not size:
            raise ValueError('Hypit 不接受空产物或空素材')
        if suffix in AV_SUFFIXES:
            from web_api.media_pipeline import _probe_media
            probe = _probe_media(path)
            record.update(probe=probe, kind='video' if probe and probe.get('video')
                          else 'audio' if probe and probe.get('audio') else 'file',
                          playable=bool(probe and (probe.get('video') or probe.get('audio'))))
        elif suffix in IMAGE_SUFFIXES:
            from PIL import Image
            try:
                with Image.open(path) as image:
                    image.verify()
                record.update(kind='image', playable=True)
            except Exception:
                record.update(kind='image', playable=False)
        return record

    def import_media(self, source_path: str) -> dict:
        with self.lock:
            value = self._relative(source_path)
            source = self._assert_path(self.project / value)
            if source.suffix.lower() not in MEDIA_SUFFIXES or not source.is_file():
                raise ValueError('Hypit import 仅接受当前项目现存媒体')
            if source.is_relative_to(self.workspace) or source.is_relative_to(self.versions):
                raise ValueError('Hypit import 不重复导入本 session 自己的文件')
            record = self._media_record(source)
            if not record['playable']:
                raise ValueError('Hypit import 素材未通过媒体探测')
            ledger = self._ledger()
            if len(ledger['imports']) >= MAX_MEDIA_FILES or sum(row['bytes'] for row in ledger['imports']) + record['bytes'] > MAX_MEDIA_TOTAL:
                raise ValueError('Hypit 素材超过数量或总大小上限')
            self._ensure_workspace()
            target = self._assert_path(self.workspace / 'assets' / (uuid.uuid4().hex + source.suffix.lower()))
            target.parent.mkdir(exist_ok=True)
            self._copy_new(source, target, limit=MAX_MEDIA_BYTES)
            copied = self._media_record(target)
            if copied['sha256'] != record['sha256'] or copied['bytes'] != record['bytes']:
                raise ValueError('Hypit 素材在导入期间发生变化；未登记副本')
            ledger['imports'].append({**copied, 'source_path': source_path})
            self._save_ledger(ledger)
            return self._envelope(status='imported', outputs=[copied],
                author_path=target.relative_to(self.workspace).as_posix(), fingerprint=self.fingerprint(),
                message='已复制当前项目真实素材到服务器分配的新路径；未执行 Hypit。')

    def _author_files(self) -> list[Path]:
        result = []
        registered = self._registered_metadata()
        for directory, subdirs, files in os.walk(self.workspace, followlinks=False):
            parent = Path(directory)
            for name in subdirs + files:
                self._assert_path(parent / name)
            if parent == self.workspace:
                subdirs[:] = [name for name in subdirs if name not in RESERVED_ROOTS]
            for name in files:
                if parent == self.workspace and name == 'hypit.runtime.json':
                    continue
                candidate = parent / name
                if candidate not in registered:
                    self._author_path(candidate.relative_to(self.workspace).as_posix())
                result.append(candidate)
                if len(result) > MAX_AUTHOR_FILES:
                    raise ValueError('Hypit 创作文件数量超过上限')
        return sorted(result)

    def fingerprint(self) -> str:
        """Hash all authored files, immutable Profile/selection and imported bytes."""
        with self.lock:
            self._validate_profile()
            entries = []
            total = 0
            for path in self._author_files() + [self.workspace / 'hypit.runtime.json', self.workspace / '.hypit' / 'runtime']:
                size, digest = _sha256(path, limit=MAX_AUTHOR_BYTES)
                total += size
                if total > MAX_AUTHOR_TOTAL:
                    raise ValueError('Hypit 创作总大小超过上限')
                entries.append((path.relative_to(self.workspace).as_posix(), size, digest))
            media_total = 0
            assets = self._assert_path(self.workspace / 'assets')
            if assets.exists():
                for path in sorted(assets.rglob('*')):
                    self._assert_path(path)
                    if not path.is_file():
                        raise ValueError('Hypit 素材目录只能包含服务器分配的普通文件')
                    if path.suffix.lower() not in MEDIA_SUFFIXES:
                        raise ValueError('Hypit 素材后缀不受支持')
                    size, digest = _sha256(path, limit=MAX_MEDIA_BYTES)
                    media_total += size
                    entries.append((path.relative_to(self.workspace).as_posix(), size, digest))
                if len(list(assets.iterdir())) > MAX_MEDIA_FILES or media_total > MAX_MEDIA_TOTAL:
                    raise ValueError('Hypit 素材超过数量或总大小上限')
            encoded = json.dumps(sorted(entries), ensure_ascii=False, separators=(',', ':')).encode('utf-8')
            return hashlib.sha256(encoded).hexdigest()

    def _verify_fingerprint(self, expected: str):
        if not isinstance(expected, str) or not re.fullmatch(r'[a-f0-9]{64}', expected) or self.fingerprint() != expected:
            raise ValueError('Hypit 创作文件或素材已改变；原审批失效，需要重新核对')

    def _arguments(self, arguments: Mapping[str, Any]) -> tuple[str, dict]:
        if not isinstance(arguments, Mapping):
            raise ValueError('Hypit 执行参数必须是对象')
        args = dict(arguments)
        if set(args) - {'operation', 'name', 'source', 'run', 'build_id', 'output'}:
            raise ValueError('Hypit 执行参数不接受 CLI、Profile、付费授权或其他选项')
        operation = args.pop('operation', None)
        # name is an operation alias for action dispatchers; it is never argv.
        name = args.pop('name', None)
        if operation is None:
            operation = name
        elif name is not None and name != operation:
            raise ValueError('Hypit operation 与 name 不一致')
        allowed = {'check': {'source'}, 'plan': {'run'}, 'build': {'run'},
                   'inspect': {'build_id'}, 'get': {'build_id', 'output'}}
        if operation not in allowed or set(args) != allowed[operation]:
            raise ValueError('Hypit 仅接受 check/plan/build/inspect/get 及其必要参数')
        if operation in {'check', 'plan', 'build'}:
            key = 'source' if operation == 'check' else 'run'
            suffixes = frozenset({'.svml', '.svs', '.svrun'}) if key == 'source' else frozenset({'.svrun'})
            target = self._author_path(args[key], suffixes=suffixes)
            if not target.is_file():
                raise ValueError('Hypit 创作输入文件不存在')
        else:
            build_id = args['build_id']
            if not isinstance(build_id, str) or not BUILD_ID_RE.fullmatch(build_id) or build_id not in self._ledger()['builds']:
                raise ValueError('Hypit Build ID 必须来自本 session 的真实记录')
            if operation == 'get':
                output = args['output']
                if not isinstance(output, str) or not output or len(output) > 200 or any(ch in output for ch in '\x00\r\n'):
                    raise ValueError('Hypit 官方输出名无效')
        return operation, args

    @staticmethod
    def _notify(callback, data):
        if callback is not None:
            callback(data)

    def _job(self, operation: str, args: dict, cancel_event, on_job, *, honor_cancel=True) -> dict:
        runtime = self._runtime()
        submitted = runtime.submit(operation, self.workspace, **args)
        job_id = submitted['job_id']
        self._notify(on_job, self._envelope(**{**submitted, 'build_id': args.get('build_id')}))
        cancellation_sent = False
        deadline = time.monotonic() + float(runtime.settings.command_timeout_seconds) + 5
        last_status = None
        while True:
            if honor_cancel and cancel_event is not None and cancel_event.is_set() and not cancellation_sent:
                runtime.cancel(self.workspace, job_id=job_id)
                cancellation_sent = True
            result = runtime.get(self.workspace, job_id)
            if result.get('status') != last_status:
                _, official_build = self._official_state(result.get('parsed'))
                update = self._envelope(**{**result,
                    'build_id': official_build['id'] if official_build else args.get('build_id'),
                    'native_result': result.get('parsed')})
                if operation == 'build' and (result.get('cancelled') or result.get('timed_out')) and not (
                    official_build and official_build.get('work', {}).get('outcome') == 'cancelled'
                ):
                    update.update(status='interrupted', official_cancellation='unknown',
                                  message='Build adapter 观察已停止；官方 Build 是否取消尚未知。')
                self._notify(on_job, update)
                last_status = result.get('status')
            if result.get('status') in TERMINAL:
                return result
            if time.monotonic() >= deadline:
                runtime.cancel(self.workspace, job_id=job_id)
                return {**result, 'status': 'interrupted', 'observer_stopped': True,
                        'command_succeeded': False, 'message': '停止等待 adapter 任务；官方 Build 是否终止尚未知。'}
            time.sleep(0.03)

    @staticmethod
    def _official_state(parsed: Any, build_id: str | None = None) -> tuple[str, dict | None]:
        if not isinstance(parsed, Mapping) or parsed.get('format') not in {
            'hypit.cli-build@1', 'hypit.cli-status@1', 'hypit.cli-inspect@1', 'hypit.cli-cancel@1'
        }:
            return 'unknown', None
        build = parsed.get('build')
        if not isinstance(build, dict) or not isinstance(build.get('id'), str) or not BUILD_ID_RE.fullmatch(build['id']):
            return 'unknown', None
        if build_id is not None and build['id'] != build_id:
            raise ValueError('Hypit 官方 Build ID 与本次记录不一致')
        if parsed.get('format') == 'hypit.cli-inspect@1':
            outcome = build.get('outcome')
            return ('terminal' if outcome in {'complete', 'failed', 'cancelled'} else 'active'), build
        work = build.get('work', {})
        result = build.get('result', {})
        if not isinstance(work, Mapping) or not isinstance(result, Mapping):
            return 'unknown', build
        if work.get('state') == 'done' and work.get('outcome') in {'complete', 'failed', 'cancelled'}:
            return 'terminal', build
        if work.get('state') in {'submitting', 'working'}:
            return 'active', build
        return 'unknown', build

    def _record_build(self, parsed: Any, *, job_id=None, build_id=None) -> tuple[str, dict | None]:
        state, build = self._official_state(parsed, build_id)
        if build is None:
            return state, None
        ledger = self._ledger()
        old = ledger['builds'].get(build['id'], {})
        old.update(build_id=build['id'], execution_state=state, native_build=build)
        if parsed.get('format') == 'hypit.cli-build@1' and job_id:
            submitted = ledger.get('unresolved_submission', {})
            if submitted.get('fingerprint'):
                old['fingerprint'] = submitted['fingerprint']
        if job_id:
            old['adapter_job_id'] = job_id
        if parsed.get('format') == 'hypit.cli-inspect@1' and isinstance(build.get('outputs'), list):
            old['outputs'] = {row['name']: row for row in build['outputs']
                if isinstance(row, dict) and isinstance(row.get('name'), str)}
        ledger['builds'][build['id']] = old
        # Inspecting an older known Build cannot resolve a newer submission
        # whose receipt was lost. Only this new Build's official receipt can.
        if parsed.get('format') == 'hypit.cli-build@1' and job_id:
            ledger.pop('unresolved_submission', None)
        self._save_ledger(ledger)
        return state, build

    def _cancel_build(self, build_id, on_job) -> dict:
        if not build_id:
            return {'official_cancellation': 'unknown', 'message': '已停止观察；未取得官方 Build ID，无法确认或请求取消官方 Build。'}
        cancelled = self._job('cancel', {'build_id': build_id}, None, on_job, honor_cancel=False)
        parsed = cancelled.get('parsed')
        state, build = self._record_build(parsed, build_id=build_id)
        confirmed = bool(build and build.get('work', {}).get('outcome') == 'cancelled')
        requested = bool(isinstance(parsed, Mapping) and parsed.get('format') == 'hypit.cli-cancel@1' and parsed.get('requested') is True)
        if requested and not confirmed:
            status = self._job('build_status', {'build_id': build_id}, None, on_job, honor_cancel=False)
            state, latest = self._record_build(status.get('parsed'), build_id=build_id)
            confirmed = bool(latest and latest.get('work', {}).get('outcome') == 'cancelled')
        ledger = self._ledger()
        cancellation = 'confirmed' if confirmed else 'requested' if requested else 'unknown'
        ledger['builds'][build_id]['official_cancellation'] = cancellation
        self._save_ledger(ledger)
        return {'official_cancellation': cancellation, 'official_cancel_result': parsed,
                'official_execution_state': state,
                'message': '官方 Build 已确认取消。' if confirmed else '已停止观察并核对官方取消请求；尚未确认官方 Build 已停止。'}

    def _result(self, native: dict, *, build_id=None, **extra) -> dict:
        outputs = []
        for row in native.get('artifacts', []):
            if not isinstance(row, dict) or not isinstance(row.get('path'), str):
                continue
            value = Path(row['path'])
            if value.is_absolute() or '..' in value.parts:
                raise ValueError('Hypit 产物路径不在本 session 工程内')
            path = self._assert_path(self.workspace / value)
            if path.is_file():
                outputs.append(self._media_record(path))
        result = self._envelope(status=native.get('status', 'unknown'), message=native.get('message', ''),
            job_id=native.get('job_id'), build_id=build_id, outputs=outputs,
            command_succeeded=bool(native.get('command_succeeded')),
            native_result=native.get('parsed'), native_job=native)
        result.update(extra)
        if 'status_override' in result:
            result['status'] = result.pop('status_override')
        return result

    def execute(self, arguments: Mapping[str, Any], expected_fingerprint: str,
                cancel_event: threading.Event | None = None, on_job=None) -> dict:
        """Execute only a caller-approved, unchanged session package.

        All operations require the matching fingerprint, including Check/Plan.
        Build sends no paid_approval: the official runtime's Plan preflight is
        the authoritative local/external gate. External work is explicitly blocked.
        """
        with self.lock:
            self._verify_fingerprint(expected_fingerprint)
            operation, args = self._arguments(arguments)
            if cancel_event is not None and cancel_event.is_set():
                return self._envelope(status='cancelled', message='执行审批后、提交命令前收到取消；未运行 Hypit。', official_cancellation='not_submitted')
            if operation == 'build':
                ledger = self._ledger()
                if ledger.get('unresolved_submission') or any(row.get('execution_state') != 'terminal' for row in ledger['builds'].values()):
                    return self._envelope(status='blocked', message='本 session 有尚未确认终结的官方 Build；请先 inspect 已知 Build ID，避免重复提交。', official_execution_state='unknown')
                ledger['unresolved_submission'] = {'run': args['run'], 'state': 'submitting', 'fingerprint': expected_fingerprint}
                self._save_ledger(ledger)
                # Preserve the pending receipt even if a callback/transport
                # raises after submission. Never infer that no work ran.
                native = self._job('build', {**args, 'follow': False}, cancel_event, on_job)
                state, build = self._record_build(native.get('parsed'), job_id=native.get('job_id'))
                build_id = build['id'] if build else None
                if build is None:
                    # The runtime's explicit Plan gate can establish that no
                    # Build was submitted. An interrupted Build observer cannot.
                    command = native.get('command') or []
                    definitely_no_build = native.get('build_submitted') is False or native.get('cost_classification') == 'external' or native.get('status') in {
                        'plan_required', 'preflight_failed', 'authorization_required', 'awaiting_authorization'
                    } or (len(command) > 2 and command[2] == 'plan')
                    if definitely_no_build:
                        ledger = self._ledger()
                        ledger.pop('unresolved_submission', None)
                        self._save_ledger(ledger)
                        if native.get('cost_classification') == 'external':
                            return self._result(native, status_override='blocked', cost_classification='external', external_build_blocked=True,
                                message='官方 Plan 判定本次 Run 包含外部 Provider；导演桥接本轮仅允许本地执行，未提交 Build。')
                        return self._result(native, official_execution_state='not_submitted',
                                            official_cancellation='not_submitted')
                    stopped = bool(native.get('cancelled') or native.get('observer_stopped'))
                    ledger = self._ledger()
                    ledger['unresolved_submission'].update(state='unknown', adapter_job_id=native.get('job_id'),
                        observer_stopped=stopped, official_cancellation='unknown')
                    self._save_ledger(ledger)
                    return self._result(native, status_override='interrupted' if stopped else native.get('status', 'unknown'),
                        official_execution_state='unknown', official_cancellation='unknown', observer_stopped=stopped,
                        message='未取得官方 Build 回执；官方执行与取消状态均未知。已停止 adapter 观察并阻止本 session 重复 Build。')
                deadline = time.monotonic() + float(self._runtime().settings.command_timeout_seconds)
                while state == 'active':
                    if cancel_event is not None and cancel_event.is_set():
                        cancellation = self._cancel_build(build_id, on_job)
                        result = self._result(native, build_id=build_id, observer_stopped=True, **cancellation)
                        result['status'] = 'cancelled' if cancellation['official_cancellation'] == 'confirmed' else 'interrupted'
                        return result
                    if time.monotonic() >= deadline:
                        return self._result(native, build_id=build_id, status_override='interrupted', official_execution_state=state,
                            observer_stopped=True, official_cancellation='not_requested',
                            message='已停止等待，官方 Build 仍未确认终结；可用保存的 Build ID inspect，重复 Build 已阻止。')
                    time.sleep(0.1)
                    self._verify_fingerprint(expected_fingerprint)
                    native = self._job('build_status', {'build_id': build_id}, cancel_event, on_job)
                    state, build = self._record_build(native.get('parsed'), build_id=build_id)
                if cancel_event is not None and cancel_event.is_set() and state != 'terminal':
                    cancellation = self._cancel_build(build_id, on_job)
                    result = self._result(native, build_id=build_id, observer_stopped=True, **cancellation)
                    result['status'] = 'cancelled' if cancellation['official_cancellation'] == 'confirmed' else 'interrupted'
                    return result
                if build and state == 'terminal':
                    outcome = build.get('work', {}).get('outcome')
                    final_state = build.get('result', {}).get('state')
                    completed = outcome == 'complete' and final_state == 'complete'
                    native = {**native, 'status': 'build_completed' if completed
                        else 'cancelled' if outcome == 'cancelled' else 'failed' if outcome == 'failed' else 'needs_attention',
                        'command_succeeded': completed, 'build_completed': completed,
                        'message': '官方 Build 与 Result 均已完成；成片仍需 Get 后单独观看核验。' if completed
                            else '官方 Build 已取消。' if outcome == 'cancelled' else '官方 Build 已终结，但 Result 尚未确认完成。'}
                elif state == 'unknown':
                    native = {**native, 'status': 'needs_attention', 'command_succeeded': False,
                              'message': '官方 Build 状态未知；已保存 Build ID 并阻止重复 Build，请 inspect 核对。'}
                return self._result(native, build_id=build_id, official_execution_state=state)
            if operation == 'get':
                # A fresh official Inspect establishes an actual output name;
                # a model-supplied name and a stored receipt alone are insufficient.
                inspected = self._job('inspect', {'build_id': args['build_id']}, cancel_event, on_job)
                parsed_inspect = inspected.get('parsed')
                state, inspected_build = self._record_build(parsed_inspect, build_id=args['build_id'])
                if cancel_event is not None and cancel_event.is_set():
                    return self._result(inspected, build_id=args['build_id'], observer_stopped=True)
                if not inspected.get('command_succeeded'):
                    return self._result(inspected, build_id=args['build_id'])
                if not isinstance(parsed_inspect, Mapping) or parsed_inspect.get('format') != 'hypit.cli-inspect@1' or not inspected_build or not isinstance(inspected_build.get('outputs'), list):
                    raise ValueError('Hypit get 必须先取得本 session 的有效官方 Inspect 输出列表')
                outputs = self._ledger()['builds'][args['build_id']].get('outputs', {})
                output = outputs.get(args['output'])
                if not output:
                    raise ValueError('Hypit get 输出名未出现在本 session 的官方 Inspect 结果中')
                suffix = OUTPUT_SUFFIXES.get(output.get('mediaType'), '.json' if output.get('kind') == 'scalar' else '.bin')
                destination = self._assert_path(self.workspace / 'exports' / (uuid.uuid4().hex + suffix))
                destination.parent.mkdir(exist_ok=True)
                self._verify_fingerprint(expected_fingerprint)
                native = self._job('get', {**args, 'to': destination.relative_to(self.workspace).as_posix()}, cancel_event, on_job)
                parsed = native.get('parsed')
                if native.get('command_succeeded') and (not isinstance(parsed, Mapping) or parsed.get('format') != 'hypit.cli-get@1'
                    or parsed.get('build') != args['build_id'] or parsed.get('output') != args['output']):
                    raise ValueError('Hypit Get 官方回执与审批的 Build/Output 不一致')
                if native.get('command_succeeded'):
                    reported = Path(str(parsed.get('path') or ''))
                    reported = reported if reported.is_absolute() else self.workspace / reported
                    self._assert_path(reported)
                    if reported != destination:
                        raise ValueError('Hypit Get 官方产物路径与服务器分配的新文件不一致')
                if native.get('command_succeeded') and not destination.is_file():
                    native = {**native, 'status': 'failed', 'command_succeeded': False, 'message': 'Hypit Get 退出成功，但分配的产物文件不存在。'}
                native = {**native, 'artifacts': [{'path': destination.relative_to(self.workspace).as_posix()}] if destination.is_file() else []}
                result = self._result(native, build_id=args['build_id'])
                result['output'] = args['output']
                result['build_fingerprint'] = self._ledger()['builds'][args['build_id']].get('fingerprint')
                return result
            native = self._job(operation, args, cancel_event, on_job)
            if operation == 'inspect':
                self._record_build(native.get('parsed'), build_id=args['build_id'])
            elif operation == 'plan':
                parsed_plan = native.get('parsed')
                if isinstance(parsed_plan, Mapping) and parsed_plan.get('format') == 'hypit.cli-plan@1':
                    ledger = self._ledger()
                    ledger['last_plan'] = {'fingerprint': expected_fingerprint, 'run': args['run'],
                                           'job_id': native.get('job_id'), 'plan': parsed_plan}
                    self._save_ledger(ledger)
            return self._result(native, build_id=args.get('build_id'), **({'plan': native.get('parsed')} if operation == 'plan' else {}))
