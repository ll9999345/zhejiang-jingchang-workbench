"""Typed, project-isolated access to the pinned MoneyPrinterTurbo adapters."""
from __future__ import annotations
import asyncio
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import threading
import uuid
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from typing import Literal

from integrations.moneyprinterturbo.catalog import ROOT, PYTHON, catalog, model_config_key, provider_rows
from web_api.footage_pipeline import AUDIO_EXTS, IMAGE_EXTS, VIDEO_EXTS, local_path, now, probe, project_path, read_json, write_json


class ExtensionRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    project_id: str
    operation: Literal['script', 'terms', 'social', 'connection', 'tts', 'image', 'video', 'music', 'edit',
                       'transcribe', 'analyze', 'publish', 'publish_status', 'rerank', 'loomloom_quote', 'loomloom_execute', 'loomloom_script_quote', 'loomloom_script_execute']
    provider: str = Field(max_length=80)
    topic: str = Field(default='', max_length=1000)
    text: str = Field(default='', max_length=10000)
    language: str = Field(default='zh-CN', max_length=30)
    paragraphs: int = Field(default=3, ge=1, le=10)
    terms_count: int = Field(default=5, ge=1, le=12)
    system_prompt: str = Field(default='', max_length=8000)
    model: str = Field(default='', max_length=200)
    voice: str = Field(default='', max_length=160)
    voice_rate: float = Field(default=1, ge=.5, le=2)
    voice_volume: float = Field(default=1, ge=0, le=2)
    reference_audio: str = Field(default='', max_length=500)
    reference_text: str = Field(default='', max_length=500)
    video_path: str = Field(default='', max_length=500)
    video_paths: list[str] = Field(default_factory=list, max_length=30)
    audio_path: str = Field(default='', max_length=500)
    subtitle_path: str = Field(default='', max_length=500)
    bgm_path: str = Field(default='', max_length=500)
    bgm_volume: float = Field(default=.15, ge=0, le=1)
    duration: int = Field(default=5, ge=1, le=120)
    aspect_ratio: Literal['16:9', '9:16', '1:1'] = '16:9'
    order: Literal['sequential', 'random'] = 'sequential'
    transition: Literal['none', 'Shuffle', 'FadeIn', 'FadeOut', 'SlideIn', 'SlideOut', 'ZoomIn', 'ZoomOut'] = 'FadeIn'
    clip_duration: int = Field(default=5, ge=1, le=30)
    clip_speed: float = Field(default=1, ge=.5, le=2)
    fit: Literal['cover', 'contain'] = 'cover'
    word_level: bool = False
    subtitle_animation: Literal['none', 'pop_spring'] = 'none'
    subtitle_position: Literal['top', 'center', 'bottom', 'two_thirds_bottom', 'custom'] = 'bottom'
    custom_position: float = Field(default=70, ge=0, le=100)
    font_name: str = Field(default='PingFang.ttc', max_length=160, pattern=r'^[^/\\]+\.(ttf|ttc|otf)$')
    font_size: int = Field(default=60, ge=20, le=120)
    stroke_color: str = Field(default='#000000', pattern='^#[0-9a-fA-F]{6}$')
    stroke_width: float = Field(default=1.5, ge=0, le=10)
    rounded_subtitle_background: bool = True
    text_color: str = Field(default='#FFFFFF', pattern='^#[0-9a-fA-F]{6}$')
    background_color: str = Field(default='', pattern='^(|#[0-9a-fA-F]{6})$')
    public_video_url: str = Field(default='', max_length=1000)
    social_platform: Literal['tiktok', 'youtube_shorts', 'instagram_reels', 'facebook_reels'] = 'tiktok'
    platforms: list[Literal['tiktok', 'instagram', 'youtube', 'facebook']] = Field(default_factory=list, max_length=4)
    privacy: Literal['private', 'unlisted', 'public'] = 'private'
    made_for_kids: bool = False
    listing_version_id: str = Field(default='', max_length=160)
    remote_request_id: str = Field(default='', max_length=160, pattern='^[A-Za-z0-9_-]*$')
    request_id: str = Field(default='', max_length=100, pattern='^[A-Za-z0-9_-]*$')
    confirm_network: bool = False
    confirm_paid: bool = False
    budget: float = Field(default=0, ge=0, le=10000)
    billing_limit_configured: bool = False
    confirm_upload: bool = False
    confirm_publish: bool = False


def preflight(root: Path, request: ExtensionRequest) -> dict:
    project = project_path(root, request.project_id)
    row = next((p for p in provider_rows(request.operation) if p['id'] == request.provider), None)
    if not row:
        raise ValueError('所选服务不支持这项操作')
    errors, approvals = [], []
    source_duration = None
    if not PYTHON.is_file():
        errors.append('MoneyPrinterTurbo 项目运行环境未安装')
    missing = list(row['missing'])
    if request.model.strip() and row['supports_model']:
        model_env = 'MPT_' + model_config_key(request.operation, request.provider).upper()
        missing = [name for name in missing if name != model_env]
    if missing:
        errors.append('尚未配置：' + '、'.join(missing))
    if request.model.strip() and not row['supports_model']:
        errors.append('所选服务不接受模型 ID；请清空模型字段，使用该服务已配置的固定模型或入口')
    op = request.operation
    network = not row['local']
    paid = network and not (op.endswith('_quote') or op == 'publish_status' or op == 'tts' and request.provider == 'edge')
    upload = op in ('music', 'publish') or bool(request.reference_audio)
    # Never accept arbitrary absolute or cross-project input paths.
    for path in [request.video_path, request.audio_path, request.subtitle_path, request.bgm_path,
                 request.reference_audio, *request.video_paths]:
        if path:
            local_path(project, path)
    for paths, extensions, label in [
        ([request.video_path, *request.video_paths], VIDEO_EXTS, '视频'),
        ([request.audio_path, request.bgm_path, request.reference_audio], AUDIO_EXTS, '音频'),
        ([request.subtitle_path], {'.srt'}, 'SRT 字幕'),
    ]:
        for path in filter(None, paths):
            if Path(path).suffix.lower() not in extensions:
                errors.append(f'请选择有效的{label}文件')
    if request.reference_audio and local_path(project, request.reference_audio).stat().st_size > 20 * 1024 * 1024:
        errors.append('参考音频不能超过 20 MB')
    if (op in ('script', 'terms', 'social', 'tts', 'image', 'video', 'rerank') or op.startswith('loomloom_')) and not (request.text or request.topic):
        errors.append('请填写脚本、主题或提示词')
    if op == 'tts' and not request.voice:
        errors.append('请填写所选服务的音色 ID')
    if op == 'tts' and not row['supports_voice_rate'] and request.voice_rate != 1:
        errors.append('所选配音服务的当前适配器不支持语速调整；请使用原速 1')
    if request.reference_audio and (op != 'tts' or request.provider != 'voxcpm'):
        errors.append('参考音频仅用于 VoxCPM；其他服务不会上传这段文件')
    if request.reference_text and (op != 'tts' or request.provider != 'voxcpm' or not request.reference_audio):
        errors.append('参考音频文字需要同时选择 VoxCPM 参考音频')
    if op in ('music', 'publish') and not request.video_path:
        errors.append('请选择当前项目的视频')
    if op == 'music' and request.video_path:
        try:
            source = probe(local_path(project, request.video_path))
            source_duration = source['duration']
            if not source['has_video'] or source_duration <= 0:
                errors.append('配乐输入必须是可播放的视频')
            maximum = 360 if request.provider == 'sonilo' else 600
            if source_duration > maximum:
                errors.append(f'所选配乐服务仅支持 {maximum} 秒以内的视频，请先在本机剪短')
        except (ValueError, subprocess.SubprocessError):
            errors.append('无法读取配乐视频的实际时长，请选择可播放的视频')
    if op == 'edit' and not (request.video_path or request.video_paths):
        errors.append('请选择要剪辑的视频')
    if op in ('edit', 'transcribe') and not request.audio_path:
        errors.append('请选择旁白音频；其实际时长决定剪辑长度')
    if op == 'edit' and request.subtitle_path and not (Path('/System/Library/Fonts') / request.font_name).is_file():
        errors.append('所选字幕字体没有安装在本机系统字体目录')
    if op == 'publish' and (not request.platforms or not request.text):
        errors.append('请明确发布平台与文案')
    if op == 'publish' and request.privacy != 'public' and any(p != 'youtube' for p in request.platforms):
        errors.append('私密或不公开发布目前仅支持 YouTube；其他平台请明确选择公开，或移除该平台')
    if op == 'analyze':
        url = urlsplit(request.public_video_url)
        import ipaddress
        try:
            private = ipaddress.ip_address(url.hostname or '').is_private
        except ValueError:
            private = False
        if url.scheme != 'https' or not url.hostname or url.username or url.password or private or url.hostname.endswith(('.local', 'localhost')):
            errors.append('仅接受公开 HTTPS 素材视频链接')
    if op in ('loomloom_quote', 'loomloom_execute') and not request.model:
        errors.append('请填写 LoomLoom 模型 ID')
    if op in ('loomloom_quote', 'loomloom_execute') and request.aspect_ratio == '1:1':
        errors.append('LoomLoom 视频仅支持横屏 16:9 或竖屏 9:16')
    if op.endswith('_execute') and not request.listing_version_id:
        errors.append('请先报价，再填写已确认的 listing_version_id')
    if op == 'publish_status' and not request.remote_request_id:
        errors.append('请填写发布任务回执中的 request_id')
    if op == 'rerank':
        if not request.topic.strip():
            errors.append('语义排序需要明确的视频主题')
        if not 2 <= len([line for line in request.text.splitlines() if line.strip()]) <= 12:
            errors.append('请逐行填写 2 到 12 条非空关键词')
    if op == 'script' and request.topic and len(request.text) > 2000:
        errors.append('脚本生成提示词不能超过 2000 字；较长脚本请作为主题或缩短提示词')
    if network and not request.confirm_network:
        approvals.append('确认向所选服务发送文本或公开链接')
    if paid and not (request.confirm_paid and request.budget > 0 and request.billing_limit_configured):
        approvals.append('确认本次服务、预算，并在服务商设置支出上限；工作台不能替第三方限制实际账单')
    if upload and not request.confirm_upload:
        approvals.append('确认向所选服务上传本次选定的音视频文件')
    if op == 'publish' and not request.confirm_publish:
        approvals.append('确认将当前视频和文案发布到已配置账号的指定平台')
    return {'ready': not errors and not approvals, 'errors': errors, 'approvals': approvals,
            'provider': row['label'], 'network': network, 'paid': paid, 'upload': upload,
            'files_to_upload': [p for p in (request.reference_audio, request.video_path if upload else '') if p],
            'account': '服务环境中已配置的 Upload-Post 账号' if op == 'publish' else '',
            'source_duration': source_duration,
            'network_used': False}


def artifact_evidence(project: Path, file: str, operation: str) -> dict:
    media = local_path(project, file)
    with media.open('rb') as handle:
        digest = hashlib.file_digest(handle, 'sha256').hexdigest()
    record = {'path': file, 'bytes': media.stat().st_size, 'sha256': digest}
    if not record['bytes']:
        raise ValueError('服务结果为空文件')
    if media.suffix.lower() in VIDEO_EXTS | AUDIO_EXTS:
        record['probe'] = probe(media)
        if record['probe']['duration'] <= 0:
            raise ValueError('文件不可播放')
        if operation in ('video', 'edit', 'loomloom_execute') and not record['probe']['has_video']:
            raise ValueError('服务未产生可播放的视频')
        if operation in ('tts', 'music') and not record['probe']['has_audio']:
            raise ValueError('服务未产生可播放的音频')
    elif media.suffix.lower() in IMAGE_EXTS:
        from PIL import Image
        with Image.open(media) as picture:
            record['image'] = {'width': picture.width, 'height': picture.height, 'format': picture.format}
            picture.verify()
    if operation == 'image' and 'image' not in record:
        raise ValueError('生图服务结果不是可解码的图片')
    return record


class ExtensionJobs:
    def __init__(self, root):
        self.root = Path(root)
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='mpt-extension')
        self.lock = threading.RLock()
        self.active = {}
        self.cancelled = set()

    def directory(self, project_id, job_id):
        if not re.fullmatch(r'mpt-[a-f0-9]{24}', job_id):
            raise ValueError('任务编号无效')
        return project_path(self.root, project_id) / 'artifacts/footage_jobs' / job_id

    def get(self, project_id, job_id):
        path = self.directory(project_id, job_id) / 'job.json'
        data = read_json(path)
        if not data:
            raise ValueError('当前项目没有这个扩展任务')
        with self.lock:
            if data['status'] in ('running', 'queued') and job_id not in self.active:
                data.update(status='interrupted', message='服务重启中断了任务；请先核对服务商记录，不会自动重试付费请求。')
                write_json(path, data)
        return data

    def list(self, project_id):
        project = project_path(self.root, project_id)
        paths = sorted((project / 'artifacts/footage_jobs').glob('mpt-*/job.json'), key=lambda p:p.stat().st_mtime)[-100:]
        return [self.get(project_id, p.parent.name) for p in paths]

    def submit(self, req):
        check = preflight(self.root, req)
        if not check['ready']:
            raise ValueError('；'.join(check['errors'] + check['approvals']))
        with self.lock:
            if req.request_id:
                for old in self.list(req.project_id):
                    if old['request'].get('request_id') == req.request_id:
                        if old['request'] != req.model_dump():
                            raise ValueError('同一请求编号的内容发生变化，请重新预检')
                        return old
            if len(self.active) >= 8:
                raise ValueError('已有 8 项任务，请等当前任务结束')
            job_id = 'mpt-' + uuid.uuid4().hex[:24]
            directory = self.directory(req.project_id, job_id)
            data = dict(job_id=job_id, project_id=req.project_id, status='queued',
                        created_at=now(), request=req.model_dump(), message='等待本机扩展服务')
            write_json(directory / 'job.json', data)
            self.active[job_id] = None
            self.pool.submit(self._run, req, job_id)
            return data

    @staticmethod
    def stop_process(process):
        if process is None or process.poll() is not None:
            return
        # Each worker owns its process group, including its FFmpeg children.
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
        except ProcessLookupError:
            pass

    def cancel(self, project_id, job_id):
        with self.lock:
            data = self.get(project_id, job_id)
            if data['status'] not in ('running', 'queued'):
                return data
            self.cancelled.add(job_id)
            process = self.active.get(job_id)
            data.update(status='cancelled', updated_at=now(),
                        message='本机任务已停止，已有文件保留。远端已受理的请求可能继续计费，请核对服务商回执。'
                        if data['request']['operation'] not in ('edit', 'transcribe')
                        else '本机任务已停止，已有素材和结果保留。')
            write_json(self.directory(project_id, job_id) / 'job.json', data)
        self.stop_process(process)
        return data

    def _run(self, req, job_id):
        project = project_path(self.root, req.project_id)
        path = self.directory(req.project_id, job_id) / 'job.json'
        output = project / 'assets/footage' / job_id
        def update(**values):
            with self.lock:
                data = read_json(path)
                if job_id not in self.cancelled:
                    data.update(values, updated_at=now())
                    write_json(path, data)
        try:
            with self.lock:
                if job_id in self.cancelled:
                    return
            output.mkdir(parents=True, exist_ok=False)
            update(status='running', message='正在运行所选服务；请勿重复提交')
            with self.lock:
                if job_id in self.cancelled:
                    return
                process = subprocess.Popen([str(PYTHON), str(ROOT / 'integrations/moneyprinterturbo/bridge.py')],
                    stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, text=True,
                    cwd=str(ROOT), start_new_session=True)
                self.active[job_id] = process
            payload = {'project': str(project), 'output': str(output), 'request': req.model_dump()}
            process.communicate(json.dumps(payload, ensure_ascii=False), timeout=1800)
            result = read_json(output / 'result.json')
            if result.get('status') in ('completed', 'accepted'):
                files = result.get('files') or []
                evidence = [artifact_evidence(project, file, req.operation) for file in files]
                result['evidence'] = evidence
                result['provider'] = req.provider
                result['operation'] = req.operation
                result['upstream_commit'] = catalog()['commit']
                write_json(output / 'verified-result.json', result)
                update(status=result['status'], result=result, message='结果已保存到本项目' if result['status'] == 'completed' else '发布请求已受理；尚不代表发布完成')
            else:
                update(status='interrupted' if result.get('status') == 'interrupted' else 'failed',
                    result=result, message=result.get('message', '扩展服务未完成；请检查本机依赖'), error_type=result.get('error_type', 'WorkerExit'))
        except subprocess.TimeoutExpired:
            self.stop_process(process)
            update(status='interrupted', message='处理超时；远端可能已受理，请核对服务商后决定是否重试')
        except Exception as exc:
            update(status='failed', message='没有取得可验证的结果；原素材保留。', error_type=type(exc).__name__)
        finally:
            with self.lock:
                self.active.pop(job_id, None)
                self.cancelled.discard(job_id)


def create_extension_router(root: Path):
    router = APIRouter(prefix='/extensions')
    jobs = ExtensionJobs(root)
    async def call(fn, *args):
        try:
            return await asyncio.to_thread(fn, *args)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
    @router.get('/catalog')
    async def get_catalog():
        return await call(catalog)
    @router.post('/preflight')
    async def check(req: ExtensionRequest):
        return await call(preflight, root, req)
    @router.post('/jobs', status_code=202)
    async def submit(req: ExtensionRequest):
        return await call(jobs.submit, req)
    @router.get('/jobs')
    async def listing(project_id: str):
        return {'jobs': await call(jobs.list, project_id)}
    @router.get('/jobs/{job_id}')
    async def status(job_id: str, project_id: str):
        return await call(jobs.get, project_id, job_id)
    @router.post('/jobs/{job_id}/cancel')
    async def cancel(job_id: str, project_id: str):
        return await call(jobs.cancel, project_id, job_id)
    return router
