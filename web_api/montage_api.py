"""Same-origin, closed-schema web entry points for native local Montage tools."""
import asyncio
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import Field

from web_api.montage_clips import MontageClipsRequest, clip_runtime, execute_clips, preflight_clips
from web_api.montage_composition import (
    ClosedModel, MontageCompositionRequest, composition_runtime, execute_composition, preflight_composition,
)
from web_api.montage_registry import NativeToolRequest, pipeline_catalog, preflight_tool, tool_catalog
from web_api.montage_jobs import MontageJobs
from web_api.montage_director import DirectorRequest, MontageDirector, director_capabilities, preflight_director


class JobAction(ClosedModel):
    project_id: str = Field(min_length=1, max_length=128)
    job_id: str = Field(min_length=1, max_length=80)


class DirectorAction(ClosedModel):
    project_id: str = Field(min_length=1, max_length=128)
    session_id: str = Field(min_length=1, max_length=80)
    approval_id: str | None = Field(default=None, max_length=80)
    confirm: bool = False


def create_montage_router(project_root: Path):
    async def same_origin(request: Request):
        if request.method in {'POST', 'PUT', 'PATCH', 'DELETE'}:
            origin = request.headers.get('origin')
            if (origin and urlsplit(origin).netloc != request.headers.get('host')) or request.headers.get('sec-fetch-site') == 'cross-site':
                raise HTTPException(status_code=403, detail='仅允许从本机工作台发起操作')

    router = APIRouter(prefix='/model-api/montage', tags=['local-montage'], dependencies=[Depends(same_origin)])
    execution_lock = asyncio.Lock()
    jobs = MontageJobs(project_root)
    director = MontageDirector(project_root, jobs)

    def require_local(request: Request, write=False):
        host = urlsplit('http://' + request.headers.get('host', '')).hostname
        if host not in {'127.0.0.1', 'localhost', '::1', 'testserver'} or request.client.host not in {'127.0.0.1', '::1', 'testclient'}:
            raise HTTPException(403, '喵喵连接设置仅允许本机访问')
        if write and not request.headers.get('origin'):
            raise HTTPException(403, '请从本机连接设置页面保存')

    @router.get('/director/miaoapi/setup')
    async def miao_setup(request: Request):
        require_local(request)
        return FileResponse(Path(__file__).resolve().parents[1] / 'backlot/ui/miaoapi-setup.html',
            headers={'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY',
                     'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'"})

    @router.get('/director/miaoapi/setup.js')
    async def miao_setup_js(request: Request):
        require_local(request)
        return FileResponse(Path(__file__).resolve().parents[1] / 'backlot/ui/miaoapi-setup.js',
                            media_type='application/javascript', headers={'Cache-Control': 'no-store'})

    @router.get('/director/miaoapi/status')
    async def miao_status(request: Request):
        require_local(request)
        from .miaoapi_director import MiaoCanvas, MODELS, pricing
        try:
            state = await asyncio.to_thread(MiaoCanvas().status)
        except Exception:
            state = {'provider': 'miaoapi', 'configured': False, 'error': '喵喵本机配置不可读取'}
        return {**state, 'models': [{'id': m, 'pricing': pricing(m)} for m in MODELS]}

    @router.post('/director/miaoapi/config')
    async def miao_config(request: Request):
        require_local(request, write=True)
        from .miaoapi_director import configure, DirectorError
        body = None
        try:
            raw = await request.body()
            if len(raw) > 8192:
                raise HTTPException(413, '配置内容过大')
            import json
            body = json.loads(raw)
            return await asyncio.to_thread(configure, body)
        except DirectorError as error:
            raise HTTPException(error.status, str(error)) from None
        except (ValueError, TypeError):
            raise HTTPException(400, '配置内容无效') from None
        finally:
            if isinstance(body, dict):
                body['apiKey'] = ''

    async def call(fn, body):
        try:
            return await asyncio.to_thread(fn, body, project_root=project_root)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    async def operation(fn, *args):
        try:
            return await asyncio.to_thread(fn, *args)
        except (ValueError, FileNotFoundError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None

    @router.on_event('shutdown')
    def shutdown_workers():
        director.shutdown()
        jobs.shutdown()

    @router.get('/tools')
    async def tools():
        return await operation(tool_catalog)

    @router.get('/pipelines')
    async def pipelines():
        return await operation(pipeline_catalog)

    @router.get('/files/{project_id}/{file_path:path}')
    async def artifact_file(project_id: str, file_path: str):
        from web_api.montage_composition import resolve_project, safe_destination
        try:
            project = resolve_project(project_root, project_id)
            if not file_path.startswith('analysis/montage/'):
                raise ValueError('只下载 OpenMontage 独立运行的产物')
            path = safe_destination(project, file_path)
            if not path.is_file(): raise FileNotFoundError('产物不存在')
        except (ValueError, FileNotFoundError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None
        # Authored HTML/SVG is downloaded, never executed under the workbench origin.
        media = path.suffix.lower() in {'.mp4','.mov','.webm','.wav','.mp3','.m4a','.ogg','.flac','.png','.jpg','.jpeg','.webp'}
        return FileResponse(path, filename=None if media else path.name, headers={
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'"})

    @router.post('/tools/preflight')
    async def tools_preflight(body: NativeToolRequest):
        return await operation(preflight_tool, body, project_root)

    @router.post('/tools/execute')
    async def tools_execute(body: NativeToolRequest):
        return await operation(jobs.submit, body)

    @router.get('/jobs')
    async def job_list(project_id: str):
        return await operation(jobs.list, project_id)

    @router.get('/jobs/{job_id}')
    async def job_get(job_id: str, project_id: str):
        return await operation(jobs.get, project_id, job_id)

    @router.post('/jobs/cancel')
    async def job_cancel(body: JobAction):
        return await operation(jobs.cancel, body.project_id, body.job_id)

    @router.get('/director/capabilities')
    async def director_configuration():
        return await operation(director_capabilities)

    @router.post('/director/preflight')
    async def director_preflight(body: DirectorRequest):
        return await operation(preflight_director, body, project_root)

    @router.post('/director/start')
    async def director_start(body: DirectorRequest):
        return await operation(director.start, body)

    @router.get('/director/sessions')
    async def director_list(project_id: str):
        return await operation(director.list, project_id)

    @router.get('/director/sessions/{session_id}')
    async def director_get(session_id: str, project_id: str):
        return await operation(director.state, project_id, session_id)

    @router.get('/director/requests/{client_request_id}')
    async def director_submission(client_request_id: str, project_id: str):
        return await operation(director.submission, project_id, client_request_id)

    @router.post('/director/approve')
    async def director_approve(body: DirectorAction):
        return await operation(director.resume, body.project_id, body.session_id, body.approval_id, body.confirm)

    @router.post('/director/cancel')
    async def director_cancel(body: DirectorAction):
        return await operation(director.cancel, body.project_id, body.session_id)

    @router.get('/capabilities')
    async def capabilities():
        composition, clips = await asyncio.gather(asyncio.to_thread(composition_runtime), asyncio.to_thread(clip_runtime))
        return {'composition': composition, 'clips': clips}

    @router.post('/composition/preflight')
    async def composition_preflight(body: MontageCompositionRequest):
        return await call(preflight_composition, body)

    @router.post('/composition/execute')
    async def composition_execute(body: MontageCompositionRequest):
        async with execution_lock:
            return await call(execute_composition, body)

    @router.post('/clips/preflight')
    async def clips_preflight(body: MontageClipsRequest):
        return await call(preflight_clips, body)

    @router.post('/clips/execute')
    async def clips_execute(body: MontageClipsRequest):
        async with execution_lock:
            return await call(execute_clips, body)

    return router
