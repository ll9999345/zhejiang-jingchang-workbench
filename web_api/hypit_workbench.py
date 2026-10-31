"""Server-selected Hypit versions and a local, non-destructive engineering UI."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
import shutil
import threading
from typing import Mapping

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field

from web_api.hypit_runtime import (
    HYPIT_ROOT, HYPIT_VERSION, MEDIA_SUFFIXES, HypitRuntime, HypitRuntimeError,
    HypitSettings, _same_origin, create_hypit_router,
)
from web_api.montage_hypit import _chrome_selection
from web_api.hypit_migration import inspect_legacy, migrate_legacy
from web_api.hypit_speech import SpeechServiceController

CANDIDATE_ROOT = HYPIT_ROOT.parents[2] / '.runtime/hypit-candidates/0.3.1-0d36de9a/source-reviewed'
PREFIXES = {'0.2.12': '/model-api/hypit', '0.3.1': '/model-api/hypit-v031'}
LOCAL_ENDPOINTS = {
    '@hypit/provider-media-local': 'media', '@hypit/provider-hyperframes-local': 'html',
    '@hypit/media-local': 'media', '@hypit/provider-html-local': 'html',
}


class ImportLocalExample(BaseModel):
    model_config = ConfigDict(extra='forbid')
    example_id: str = Field(pattern=r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')


class LegacyProject(BaseModel):
    model_config = ConfigDict(extra='forbid')
    project_id: str = Field(pattern=r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')


class LegacyCopy(LegacyProject):
    fingerprint: str = Field(pattern=r'^[a-f0-9]{64}$')


class SpeechStart(LegacyProject):
    profile_sha256: str = Field(pattern=r'^[a-f0-9]{64}$')
    configure: bool = False


def prepare_imported_local_example(manager: HypitRuntime, example_id: str) -> dict:
    """Configure only a newly copied, entirely local official example.

    The original checkout and copied upstream Profile remain available. Never
    install a browser/provider, alter a pre-existing project, or overwrite an
    explicitly configured executable. Unsupported/remote examples stay on the
    native import path and need their own setup/authorization.
    """
    example = (manager.hypit_root / 'examples' / example_id).resolve(strict=False)
    if example.parent != (manager.hypit_root / 'examples').resolve(strict=False):
        raise HypitRuntimeError('官方示例编号无效')
    original = example / 'hypit.runtime.json'
    try:
        profile = json.loads(original.read_text('utf-8'))
    except (OSError, ValueError) as exc:
        raise HypitRuntimeError('此示例没有可配置的本机 Profile，请使用原生工程流程') from exc
    endpoints = profile.get('endpoints') if isinstance(profile, dict) else None
    if not isinstance(endpoints, dict) or not endpoints or any(
        not isinstance(row, dict) or row.get('use') not in LOCAL_ENDPOINTS
        for row in endpoints.values()
    ):
        raise HypitRuntimeError('此入口只导入纯本机示例；其他示例请按原生配置与服务授权处理')
    result = manager.import_example('.', example_id, threading.Event())
    project = manager.project(result['hypit_project_id'])
    copied = project / 'hypit.runtime.json'
    with (project / 'hypit.upstream.runtime.json').open('xb') as stream:
        stream.write(copied.read_bytes())
    # Bind new Runtime data to the new project, never to an upstream path.
    profile['dataRoot'] = '.hypit/runtimes/workbench-local'
    chrome = _chrome_selection().get('chrome_path')
    for endpoint in profile['endpoints'].values():
        config = endpoint.setdefault('config', {})
        if not isinstance(config, dict):
            raise HypitRuntimeError('示例配置格式不受支持，已保留新副本供检查')
        for key, tool in [('ffmpegPath', 'ffmpeg'), ('ffprobePath', 'ffprobe')]:
            found = shutil.which(tool)
            if found:
                config.setdefault(key, found)
        if LOCAL_ENDPOINTS[endpoint['use']] == 'html':
            config.setdefault('nodePath', shutil.which(manager.settings.node_executable) or manager.settings.node_executable)
            config.setdefault('browserGpu', 'software')
            if chrome and not any(key in config for key in ('chromePath', 'browserVersion', 'browserDownloadBaseUrl')):
                config['chromePath'] = chrome
    copied.write_text(json.dumps(profile, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    result.update(distribution_version=manager.distribution_version, local_profile_configured=True,
                  upstream_profile_preserved='hypit.upstream.runtime.json',
                  message='官方本机示例已另存为独立工程；现在可以检查工程和执行计划。')
    return result


def create_hypit_workbench_router(
    project_root: Path, *, services: Mapping[str, HypitRuntime] | None = None,
    candidate_root: Path = CANDIDATE_ROOT,
    speech_controller: SpeechServiceController | None = None,
) -> APIRouter:
    root = Path(project_root).resolve(strict=False)
    if services is None:
        managers = {HYPIT_VERSION: HypitRuntime(root)}
        try:
            candidate_version = json.loads((candidate_root / 'package.json').read_text('utf-8')).get('version')
        except (OSError, ValueError, AttributeError):
            candidate_version = None
        if candidate_version == '0.3.1':
            # New-version projects cannot be selected by the legacy manager.
            separate = root.parent / 'hypit-workspaces/v031'
            separate.mkdir(parents=True, exist_ok=True)
            managers['0.3.1'] = HypitRuntime(settings=HypitSettings(
                project_root=separate, hypit_root=candidate_root.resolve(),
                node_executable=shutil.which('node') or 'node',
                state_home=root.parent / '.runtime/hypit-workbench-host/v031',
            ))
    else:
        managers = dict(services)
    if any(version not in PREFIXES or manager.distribution_version != version for version, manager in managers.items()):
        raise ValueError('Hypit server distribution does not match its version route')
    router = APIRouter()
    speech = speech_controller or (SpeechServiceController(managers['0.3.1']) if '0.3.1' in managers else None)

    @router.get('/model-api/hypit-v031/speech/status', dependencies=[Depends(_same_origin)])
    async def speech_status(project_id: str):
        if speech is None:
            raise HTTPException(status_code=503, detail='新版运行环境尚未就绪')
        try:
            return await asyncio.to_thread(speech.status, project_id)
        except (HypitRuntimeError,OSError,ValueError) as exc:
            raise HTTPException(status_code=422, detail=str(exc) if isinstance(exc,HypitRuntimeError) else '工程语音状态无法读取') from exc

    @router.post('/model-api/hypit-v031/speech/start', dependencies=[Depends(_same_origin)])
    async def speech_start(body: SpeechStart):
        if speech is None:
            raise HTTPException(status_code=503, detail='新版运行环境尚未就绪')
        try:
            return await asyncio.to_thread(speech.start,body.project_id,fingerprint=body.profile_sha256,configure=body.configure)
        except (HypitRuntimeError,OSError,ValueError) as exc:
            raise HTTPException(status_code=409, detail=str(exc) if isinstance(exc,HypitRuntimeError) else '语音服务未启动，请刷新状态') from exc

    @router.post('/model-api/hypit-v031/speech/stop', dependencies=[Depends(_same_origin)])
    async def speech_stop(body: LegacyProject):
        if speech is None:
            raise HTTPException(status_code=503, detail='新版运行环境尚未就绪')
        try:
            return await asyncio.to_thread(speech.stop,body.project_id)
        except (HypitRuntimeError,OSError,ValueError) as exc:
            raise HTTPException(status_code=409, detail=str(exc) if isinstance(exc,HypitRuntimeError) else '语音服务尚未确认停止，请刷新状态') from exc

    def migration_managers():
        if '0.2.12' not in managers or '0.3.1' not in managers:
            raise HTTPException(status_code=503, detail='旧版与新版均就绪后才可迁移')
        return managers['0.2.12'], managers['0.3.1']

    @router.get('/model-api/hypit-v031/migration/projects')
    async def migration_projects():
        old, _ = migration_managers()
        return {'projects': await asyncio.to_thread(old.packages)}

    @router.post('/model-api/hypit-v031/migration/inspect', dependencies=[Depends(_same_origin)])
    async def migration_preview(body: LegacyProject):
        old, _ = migration_managers()
        try:
            return await asyncio.to_thread(inspect_legacy, old, body.project_id)
        except HypitRuntimeError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @router.post('/model-api/hypit-v031/migration/copy', status_code=201, dependencies=[Depends(_same_origin)])
    async def migration_copy(body: LegacyCopy):
        old, new = migration_managers()
        try:
            return await asyncio.to_thread(migrate_legacy, old, new, body.project_id, body.fingerprint)
        except HypitRuntimeError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @router.get('/model-api/hypit/versions')
    async def versions():
        rows = []
        for version, prefix in PREFIXES.items():
            manager = managers.get(version)
            available = bool(manager and (manager.hypit_root / 'bin/hypit.mjs').is_file()
                             and (manager.hypit_root / 'node_modules').is_dir()
                             and shutil.which(manager.settings.node_executable))
            rows.append({'version': version, 'label': ('兼容版 ' if version == HYPIT_VERSION else '新版 ') + version,
                         'api': prefix, 'available': available,
                         'message': '本机命令和依赖可用，工程仍需检查' if available else '此版本的本机依赖尚未就绪'})
        return {'versions': rows, 'default': HYPIT_VERSION, 'legacy_projects_preserved': True}

    def extension_routes(manager: HypitRuntime, prefix: str) -> APIRouter:
        extension = APIRouter(prefix=prefix, dependencies=[Depends(_same_origin)])

        @extension.post('/local-examples', status_code=201)
        async def import_local(body: ImportLocalExample):
            try:
                return await asyncio.to_thread(prepare_imported_local_example, manager, body.example_id)
            except HypitRuntimeError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc

        @extension.get('/projects/{project_id}/files/{file_path:path}')
        async def media_file(project_id: str, file_path: str):
            try:
                selected = manager.project(project_id)
                # Serve explicit exports, never runtime stores, credentials or
                # guessed absolute files. _safe_file also rejects link escapes.
                if not file_path.startswith('exports/') or any(part.startswith('.') for part in Path(file_path).parts):
                    raise HypitRuntimeError('只能读取当前工程已导出的媒体')
                path = manager._safe_file(selected, file_path, suffixes=MEDIA_SUFFIXES)
                return FileResponse(path, content_disposition_type='inline')
            except HypitRuntimeError as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc

        @extension.get('/projects/{project_id}/migration')
        async def migration_receipt(project_id: str):
            try:
                selected = manager.project(project_id)
                path = manager._safe_file(selected, 'migration.receipt.json', suffixes={'.json'})
                value = json.loads(path.read_text('utf-8'))
                if not isinstance(value, dict) or value.get('format') != 'openmontage.hypit-migration@1':
                    raise HypitRuntimeError('迁移回执格式不正确')
                return value
            except (HypitRuntimeError, OSError, ValueError) as exc:
                raise HTTPException(status_code=404, detail='当前工程没有已完成的迁移回执') from exc

        return extension

    for version, manager in managers.items():
        prefix = PREFIXES[version]
        router.include_router(extension_routes(manager, prefix))
        router.include_router(create_hypit_router(root, service=manager, api_prefix=prefix))
    return router
