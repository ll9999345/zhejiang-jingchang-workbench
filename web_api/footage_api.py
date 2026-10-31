"""Same-origin API for the native real-footage workbench."""
from __future__ import annotations

import asyncio
from pathlib import Path
import re
import uuid
from urllib.parse import urlsplit
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field
from web_api.footage_batches import BatchRequest, FootageBatches
from web_api.footage_music import paid_music_requested, preflight_footage_music

from web_api.footage_pipeline import (
    AUDIO_EXTS, IMAGE_EXTS, VIDEO_EXTS, FootageJobs, FootageOptions, FootageRequest,
    capabilities, local_path, now, plan_footage, probe, project_context, project_path,
    read_json, rel, synthesize, write_json, save_footage_draft,
)


class VoicePreview(BaseModel):
    model_config = ConfigDict(extra='forbid')
    project_id: str
    text: str = Field(default='让风景被看见，让故事被记住。', min_length=1, max_length=20000)
    text_mode: Literal['sample', 'full'] = 'sample'
    narration: str = Field(default='local', pattern='^(local|edge)$')
    voice: str = Field(default='Tingting', max_length=100)
    voice_rate: float = Field(default=1, ge=.5, le=2)
    confirm_network: bool = False


def create_footage_router(project_root: Path, *, jobs: FootageJobs | None = None) -> APIRouter:
    async def same_origin(request: Request):
        if request.method not in {'GET', 'HEAD', 'OPTIONS'}:
            origin = request.headers.get('origin')
            if (origin and urlsplit(origin).netloc != request.headers.get('host')) or request.headers.get('sec-fetch-site') == 'cross-site':
                raise HTTPException(status_code=403, detail='仅允许从本机工作台发起操作')
    router = APIRouter(prefix='/model-api/footage', tags=['real-footage'], dependencies=[Depends(same_origin)])
    manager = jobs or FootageJobs(project_root)
    batches = FootageBatches(manager)

    async def run(fn, *args, **kwargs):
        try:
            return await asyncio.to_thread(fn, *args, **kwargs)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @router.get('/capabilities')
    async def get_capabilities():
        return await run(capabilities)

    @router.get('/context/{project_id}')
    async def get_context(project_id: str):
        result = await run(project_context, project_root, project_id)
        result['jobs'] = await run(manager.list, project_id)
        return result

    @router.post('/plan')
    async def plan(body: FootageRequest):
        return await run(plan_footage, project_root, body)

    @router.post('/draft')
    async def save_draft(body: FootageRequest):
        return await run(save_footage_draft, project_root, body)

    async def music_preflight(body: FootageRequest, *, require_approval=False):
        if not paid_music_requested(body):
            return {'required': False, 'ready': True, 'errors': [], 'approvals': []}
        planned = await run(plan_footage, project_root, body)
        duration = sum(shot['duration_seconds'] for shot in planned['shots'])
        return await run(preflight_footage_music, project_root, body, duration, require_approval=require_approval)

    @router.post('/music/preflight')
    async def preview_music(body: FootageRequest):
        return await music_preflight(body)

    def guard_batch_music(body: BatchRequest):
        # Each paid BGM needs its own review. Batch consent cannot authorise many calls.
        if any(paid_music_requested(FootageRequest.model_validate(raw)) for raw in body.requests):
            raise ValueError('ElevenLabs 配乐请逐个任务预检并授权；批量入口仅支持免费或已导入配乐')

    @router.post('/batches/preflight')
    async def batch_preflight(body: BatchRequest):
        await run(guard_batch_music, body)
        return await run(batches.preflight, body)

    @router.post('/batches', status_code=202)
    async def create_batch(body: BatchRequest):
        await run(guard_batch_music, body)
        return await run(batches.submit, body)

    @router.get('/batches')
    async def list_batches(project_id: str):
        return {'batches': await run(batches.list, project_id)}

    @router.get('/batches/{batch_id}')
    async def get_batch(batch_id: str, project_id: str):
        return await run(batches.get, project_id, batch_id)

    @router.post('/batches/{batch_id}/cancel')
    async def cancel_batch(batch_id: str, body: dict):
        return await run(batches.cancel, str(body.get('project_id') or ''), batch_id)

    @router.post('/jobs', status_code=202)
    async def create_job(body: FootageRequest):
        check = await music_preflight(body, require_approval=True)
        if not check['ready']:
            raise HTTPException(status_code=422, detail='；'.join(check.get('errors', []) + check.get('approvals', [])) or '配乐预检未通过，未提交任务')
        return await run(manager.submit, body)

    @router.get('/jobs')
    async def list_jobs(project_id: str):
        return {'jobs': await run(manager.list, project_id)}

    @router.get('/jobs/{job_id}')
    async def get_job(job_id: str, project_id: str):
        return await run(manager.get, project_id, job_id)

    @router.post('/jobs/{job_id}/cancel')
    async def cancel_job(job_id: str, body: dict):
        return await run(manager.cancel, str(body.get('project_id') or ''), job_id)

    @router.get('/settings/{project_id}')
    async def settings(project_id: str):
        project = await run(project_path, project_root, project_id)
        return read_json(project / 'artifacts/footage_settings.json', FootageOptions().model_dump())

    @router.post('/settings/{project_id}')
    async def save_settings(project_id: str, body: FootageOptions):
        project = await run(project_path, project_root, project_id)
        # The typed model disallows API keys and arbitrary configuration imports.
        for name in ('audio_path', 'bgm_path', 'subtitle_path'):
            if getattr(body, name):
                await run(local_path, project, getattr(body, name))
        await run(write_json, project / 'artifacts/footage_settings.json', body.model_dump())
        return {'status': 'saved', 'options': body.model_dump()}

    @router.get('/assets/{project_id}')
    async def asset(project_id: str, path: str, download: bool = False):
        project = await run(project_path, project_root, project_id)
        file = await run(local_path, project, path)
        suffix = file.suffix.lower()
        # No .env, arbitrary project text, executable or config downloads.
        if suffix not in VIDEO_EXTS | IMAGE_EXTS | AUDIO_EXTS | {'.srt', '.json', '.txt'}:
            raise HTTPException(status_code=404, detail='unsupported media')
        if suffix in {'.json', '.txt'} and not (path.startswith('artifacts/footage_jobs/') or path.startswith('renders/footage-')):
            raise HTTPException(status_code=404, detail='not a footage artifact')
        return FileResponse(file, filename=file.name if download else None,
                            headers={'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff'})

    @router.post('/upload')
    async def upload(request: Request, project_id: str, filename: str, role: Literal['media', 'music', 'voice'] = 'media'):
        project = await run(project_path, project_root, project_id)
        extension = Path(filename).suffix.lower()
        if extension not in VIDEO_EXTS | IMAGE_EXTS | AUDIO_EXTS | {'.srt'}:
            raise HTTPException(status_code=422, detail='请选择视频、图片、音频或 SRT 字幕文件')
        limit = 512 * 1024 * 1024
        if int(request.headers.get('content-length') or 0) > limit:
            raise HTTPException(status_code=413, detail='单个文件最多 512 MB')
        directory = local_path(project, 'assets/footage/imports', exists=False)
        directory.mkdir(parents=True, exist_ok=True)
        token = uuid.uuid4().hex
        target = directory / (token + extension)
        partial = directory / (token + '.upload')
        size = 0
        with partial.open('xb') as handle:
            async for chunk in request.stream():
                size += len(chunk)
                if size > limit:
                    raise HTTPException(status_code=413, detail='单个文件最多 512 MB；未完成的上传不会参与剪辑')
                handle.write(chunk)
        if size == 0:
            raise HTTPException(status_code=422, detail='文件为空')
        if extension == '.srt':
            if size > 2 * 1024 * 1024:
                raise HTTPException(status_code=413, detail='字幕文件过大')
            content = partial.read_text('utf-8-sig', errors='replace')
            if not re.search(r'\d\d:\d\d:\d\d[,\.]\d+\s+-->\s+\d\d:', content):
                raise HTTPException(status_code=422, detail='没有识别到 SRT 字幕时间码')
            kind, info = 'subtitle', {}
        elif extension in IMAGE_EXTS:
            from PIL import Image
            try:
                with Image.open(partial) as im:
                    im.verify()
                kind, info = 'image', {}
            except Exception as exc:
                raise HTTPException(status_code=422, detail='图片无法解码') from exc
        else:
            info = await run(probe, partial)
            kind = 'video' if extension in VIDEO_EXTS else 'audio'
            if info['duration'] <= 0 or not info['has_video' if kind == 'video' else 'has_audio']:
                raise HTTPException(status_code=422, detail='文件没有有效媒体轨道')
        partial.rename(target)
        result = {'path': rel(project, target), 'kind': kind, 'label': Path(filename).name,
                  'origin': 'uploaded', 'bytes': size, 'role': role,
                  'is_music': kind == 'audio' and role == 'music', **info}
        write_json(directory / (token + '.json'), dict(result, imported_at=now()))
        return result

    @router.post('/voice-preview')
    async def voice_preview(body: VoicePreview):
        if body.narration == 'edge' and not body.confirm_network:
            raise HTTPException(status_code=422, detail='在线配音会发送试听文本，请先确认')
        project = await run(project_path, project_root, body.project_id)
        output = local_path(project, f'assets/footage/voice-previews/{uuid.uuid4().hex}.wav', exists=False)
        try:
            text = body.text.strip() if body.text_mode == 'full' else body.text.strip()[:200]
            if not text:
                raise HTTPException(status_code=422, detail='请填写要试听的文本')
            await run(synthesize, text, body.narration, body.voice, body.voice_rate, output)
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=502, detail='配音服务暂不可用，请尝试本机音色或导入音频') from exc
        info = probe(output)
        if not info['has_audio'] or info['duration'] <= 0:
            raise HTTPException(status_code=502, detail='试听没有产出有效音轨')
        return {'status': 'completed', 'path': rel(project, output), **info,
                'duration_seconds': info['duration'], 'text_mode': body.text_mode,
                'full_text': body.text_mode == 'full'}

    from web_api.mpt_extensions import create_extension_router
    router.include_router(create_extension_router(project_root))
    return router
