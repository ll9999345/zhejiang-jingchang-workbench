"""Evidence-based reference rhythm -> editable, independent footage project.

Uses OpenMontage's local scene/frame tools. Hypit's separation of reference
evidence, target direction and performed timing informed the design; no Hypit
source or runtime is embedded. Semantic claims are never invented from cuts.
"""
from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import math
from pathlib import Path
import re
import threading
import uuid
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field

from web_api.footage_pipeline import (
    VIDEO_EXTS, FootageOptions, FootageRequest, _sentences, local_path, now,
    plan_footage, probe, project_context, project_path, read_json, rel,
    save_footage_draft, write_json,
)

REF_ID = re.compile(r'^ref-[a-f0-9]{24}$')


class StandaloneRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    filename: str = Field(default='', max_length=200)


class AnalyzeRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    project_id: str
    source_path: str = Field(min_length=1, max_length=1024)
    max_frames: int = Field(default=12, ge=3, le=24)


class Observation(BaseModel):
    model_config = ConfigDict(extra='forbid')
    id: str = Field(max_length=80)
    visual: str = Field(default='', max_length=500)
    query: str = Field(default='', max_length=300)


class AdaptRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    project_id: str
    reference_id: str
    topic: str = Field(min_length=1, max_length=200)
    script: str = Field(min_length=1, max_length=12000)
    target_duration: float | None = Field(default=None, ge=2, le=600)
    direction: str = Field(default='', max_length=3000)
    # Authored observations are not presented as machine vision results.
    observations: list[Observation] = Field(default_factory=list, max_length=60)
    options: FootageOptions = Field(default_factory=FootageOptions)
    request_id: str = Field(default='', max_length=100, pattern=r'^[A-Za-z0-9._-]*$')


def reference_dir(root: Path, project_id: str, ref_id: str) -> Path:
    if not REF_ID.fullmatch(ref_id):
        raise ValueError('参考分析编号无效')
    return local_path(project_path(root, project_id), f'analysis/reference_runs/{ref_id}', exists=False)


def make_blueprint(recipe: dict, request: AdaptRequest) -> dict:
    """Distribute new sentences over measured shot proportions; never copy speech."""
    lines = _sentences(request.script)
    if not lines:
        raise ValueError('请填写新视频要讲的内容')
    scenes = recipe.get('scenes') or []
    if not scenes or len(scenes) > 60:
        raise ValueError('参考镜头数应为 1—60；请先截取更短的参考视频')
    source_duration = float((recipe.get('source') or {}).get('duration') or 0)
    if not math.isfinite(source_duration) or source_duration <= 0:
        raise ValueError('参考分析缺少有效的原片时长')
    previous_end = 0.0
    normalized_scenes = []
    for index, scene in enumerate(scenes):
        try:
            start = float(scene['start'])
            end = float(scene['end'])
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError('参考分析的镜头边界无效') from exc
        if not (math.isfinite(start) and math.isfinite(end) and end > start):
            raise ValueError('参考分析包含无效镜头时长')
        if start < 0 or end > source_duration + .05 or abs(start - previous_end) > .05:
            raise ValueError('参考分析没有完整覆盖原片时间轴')
        normalized_scenes.append(dict(scene, start=round(max(0.0, start), 4),
                                      end=round(min(source_duration, end), 4),
                                      duration=round(end - start, 4)))
        previous_end = end
    if abs(normalized_scenes[0]['start']) > .05 or abs(previous_end - source_duration) > .05:
        raise ValueError('参考分析没有完整覆盖原片时间轴')
    scenes = normalized_scenes
    duration = float(request.target_duration or source_duration)
    if not math.isfinite(duration) or duration < .5 * len(scenes):
        raise ValueError('目标时长过短，每个参考镜头至少需要 0.5 秒')
    total = sum(float(s['duration']) for s in scenes)
    if not total or not math.isfinite(total):
        raise ValueError('参考分析缺少有效镜头时长')
    # Sentence midpoint maps to a source interval. Text remains verbatim/in order.
    # Empty intervals intentionally remain visual holds rather than fake speech.
    weights = [max(1, len(line)) for line in lines]
    cumulative, cursor, buckets = [], 0., [[] for _ in scenes]
    for scene in scenes:
        cursor += scene['duration'] / total
        cumulative.append(cursor)
    cursor = 0
    for line, weight in zip(lines, weights):
        midpoint = (cursor + weight / 2) / sum(weights)
        index = next((i for i, end in enumerate(cumulative) if midpoint <= end), len(scenes)-1)
        buckets[index].append(line)
        cursor += weight
    # Constrained proportional allocation (minimum 0.5 s; no cumulative rounding drift).
    durations = [0.] * len(scenes)
    pending, remaining = set(range(len(scenes))), duration
    while pending:
        weight = sum(scenes[i]['duration'] for i in pending)
        too_short = {i for i in pending if remaining * scenes[i]['duration'] / weight < .5}
        if not too_short:
            for i in pending:durations[i] = remaining * scenes[i]['duration'] / weight
            break
        for i in too_short:durations[i] = .5
        remaining -= .5 * len(too_short)
        pending -= too_short
    slots, shot_rows, clock = [], [], 0.
    annotations = {x.id: x.model_dump() for x in request.observations}
    for index, scene in enumerate(scenes):
        seconds = round(durations[index], 4)
        if index == len(scenes)-1:
            seconds = round(duration-clock, 4)
        if seconds > 120:
            raise ValueError('单镜头超过 120 秒，请缩短目标时长或截取参考片段')
        sid = f'ref-shot-{index+1}'
        annotation = annotations.get(scene['id'], {})
        text = '\n'.join(buckets[index])
        note = str(annotation.get('visual', '')).strip()[:500]
        query = str(annotation.get('query', '')).strip()[:300]
        shot_rows.append({'id': sid, 'title': note or f'参考节奏 · 镜头 {index+1}',
                          'text': text, 'query': query, 'duration_seconds': seconds,
                          'start_seconds': 0, 'source_path': ''})
        slots.append({'shot_id': sid, 'source_scene_id': scene['id'],
                      'source_start': scene['start'], 'source_end': scene['end'],
                      'planned_start': round(clock, 4), 'planned_duration': seconds,
                      'narration_segment_id': sid, 'authored_observation': note,
                      'evidence_frame': scene.get('frame'), 'new_text': text})
        clock += seconds
    return {'schema_version': '1.0', 'reference_id': request.reference_id,
            'source_project_id': request.project_id, 'created_at': now(),
            'topic': request.topic.strip(), 'script': request.script.strip(),
            'direction': request.direction, 'source': recipe['source'],
            'target_duration': duration, 'slots': slots, 'shots': shot_rows,
            'semantic_analysis': 'creator_authored_not_automatic',
            'timing_policy': 'actual_narration_first' if request.options.narration != 'none' else 'reference_proportions',
            'warnings': ['参考片仅用于节奏和画面证据，不自动复制原片、原声或人物。',
                         '逐镜配音后以实测语音时长为准；原片节奏是规划参考，导出后可查看时长对照。',
                         '本机检测没有自动理解钩子、人物、文案或字幕特效；画面说明由创作者补充。']}


class ReferenceJobs:
    def __init__(self, root: Path, *, executor=None):
        self.root = root
        self.pool = executor or ThreadPoolExecutor(max_workers=1, thread_name_prefix='reference')
        self.lock = threading.RLock()
        self.active: set[str] = set()
        self._memory: dict[tuple[str, str], dict] = {}

    def _remember(self, project_id: str, ref_id: str, data: dict) -> dict:
        value = dict(data)
        self._memory[(project_id, ref_id)] = value
        return value

    def _state(self, project_id: str, ref_id: str) -> dict:
        directory = reference_dir(self.root, project_id, ref_id)
        data = read_json(directory / 'job.json')
        if not data:
            data = self._memory.get((project_id, ref_id), {})
        return data

    def _persist_state(self, project_id: str, ref_id: str, **values) -> dict:
        directory = reference_dir(self.root, project_id, ref_id)
        with self.lock:
            data = self._state(project_id, ref_id)
            if not data:
                raise ValueError('未找到参考分析记录')
            data.update(values, updated_at=now())
            self._remember(project_id, ref_id, data)
            try:
                write_json(directory / 'job.json', data)
            except Exception as exc:
                # Make the worker fail closed. The caller records a terminal
                # failure in memory even when the filesystem is temporarily
                # unable to accept the status update.
                raise RuntimeError('参考分析状态无法保存') from exc
            return data

    def get(self, project_id: str, ref_id: str) -> dict:
        directory = reference_dir(self.root, project_id, ref_id)
        with self.lock:
            data = self._state(project_id, ref_id)
            if not data:
                raise ValueError('未找到参考分析记录')
            if data['status'] in ('queued', 'running') and ref_id not in self.active:
                data.update(status='interrupted', message='分析被中断；原文件与已提取画面保留，可重新分析。')
                self._remember(project_id, ref_id, data)
                try:
                    write_json(directory / 'job.json', data)
                except Exception:
                    pass
        if data['status'] == 'completed':
            recipe = read_json(directory / 'recipe.json')
            if not recipe:
                raise ValueError('参考分析记录缺少节奏表')
            data['recipe'] = recipe
        return data

    def list(self, project_id: str) -> list[dict]:
        project = project_path(self.root, project_id)
        files = sorted((project/'analysis/reference_runs').glob('ref-*/job.json'), key=lambda p:p.stat().st_mtime, reverse=True)
        return [self.get(project_id, p.parent.name) for p in files[:30]]

    def submit(self, request: AnalyzeRequest) -> dict:
        project = project_path(self.root, request.project_id)
        source = local_path(project, request.source_path)
        if not source.is_file() or source.suffix.lower() not in VIDEO_EXTS or source.stat().st_size <= 0 or source.stat().st_size > 512*1024*1024:
            raise ValueError('请选择本项目中小于 512 MB 的视频')
        info = probe(source)
        if not info['has_video'] or not .5 <= info['duration'] <= 600:
            raise ValueError('参考视频应为 0.5 秒至 10 分钟，请先截取代表片段')
        with source.open('rb') as file:
            digest = hashlib.file_digest(file, 'sha256').hexdigest()
        fingerprint = hashlib.sha256(f'{digest}:{request.max_frames}'.encode()).hexdigest()
        with self.lock:
            for previous in self.list(request.project_id):
                if previous.get('fingerprint') == fingerprint and previous['status'] in ('queued','running','completed'):
                    return previous
            if len(self.active) >= 3:
                raise ValueError('已有分析任务排队，请完成后再试')
            ref_id = 'ref-'+uuid.uuid4().hex[:24]
            directory = reference_dir(self.root, request.project_id, ref_id)
            state = {'reference_id': ref_id, 'project_id': request.project_id, 'status': 'queued',
                     'fingerprint': fingerprint, 'source_path': request.source_path, 'created_at': now(),
                     'progress': 0, 'message': '参考分析已排队，刷新不会重复执行'}
            write_json(directory/'job.json', state)
            self._remember(request.project_id, ref_id, state)
            self.active.add(ref_id)
            self.pool.submit(self._run, request, ref_id, info, digest)
            return state

    def _run(self, request: AnalyzeRequest, ref_id: str, info: dict, digest: str):
        project = project_path(self.root, request.project_id)
        directory = reference_dir(self.root, request.project_id, ref_id)
        source = local_path(project, request.source_path)
        def update(**kwargs):
            return self._persist_state(request.project_id, ref_id, **kwargs)
        try:
            from tools.analysis.scene_detect import SceneDetect
            from tools.analysis.frame_sampler import FrameSampler
            update(status='running', progress=10, message='正在本机检测镜头边界')
            result = SceneDetect().execute({'input_path': str(source), 'method': 'content',
                     'min_scene_length_seconds': .5, 'output_path': str(directory/'boundaries.json')})
            if not result.success:
                raise ValueError('镜头检测未取得结果')
            boundaries = result.data.get('scenes', [])
            warnings = []
            if not boundaries:
                boundaries = [{'start_seconds': 0, 'end_seconds': info['duration']}]
                warnings.append('未检出明显切镜，按一个连续镜头记录；这不表示内容只有一个段落。')
            if len(boundaries) > 60:
                raise ValueError('检测到超过 60 个镜头，请先截取代表片段')
            scenes = []
            # Always cover the complete source, including the first/last frames.
            starts = sorted({0.0, *[round(float(s['start_seconds']),4) for s in boundaries
                                   if 0 < float(s['start_seconds']) < info['duration']-.1]})
            for index, start in enumerate(starts):
                end = starts[index+1] if index+1<len(starts) else info['duration']
                scenes.append({'id':f'scene-{index+1}', 'start':start, 'end':end,
                               'duration':round(end-start,4), 'description':'',
                               'semantic_status':'not_analyzed'})
            indices = list(range(len(scenes))) if len(scenes)<=request.max_frames else sorted({round(i*(len(scenes)-1)/(request.max_frames-1)) for i in range(request.max_frames)})
            timestamps = [(scenes[i]['start']+scenes[i]['end'])/2 for i in indices]
            update(progress=55, message='正在提取关键帧并建立可编辑节奏表')
            sampled = FrameSampler().execute({'input_path': str(source), 'strategy':'timestamps',
                        'timestamps':timestamps, 'output_dir':str(directory/'frames'), 'format':'jpg', 'max_width':640})
            frames = (sampled.data or {}).get('frames') if sampled.success else []
            if not sampled.success or not frames or len(frames) != len(indices):
                raise ValueError('关键帧提取失败，未将分析标为完成')
            for i, frame in zip(indices, frames):
                frame_path = Path(frame.get('path', ''))
                if not frame_path.is_absolute():
                    frame_path = directory / frame_path
                frame_path = frame_path.resolve()
                if not frame_path.is_relative_to(directory.resolve()) or not frame_path.is_file():
                    raise ValueError('关键帧输出路径无效')
                scenes[i]['frame'] = rel(project, frame_path)
            recipe = {'schema_version':'1.0', 'reference_id':ref_id, 'created_at':now(),
                      'source':{'path':request.source_path, 'sha256':digest, **info},
                      'scenes':scenes, 'scene_count':len(scenes), 'sampled_frames':len(frames),
                      'measured':{'detector':result.data.get('method'),
                                  'average_shot_seconds':round(info['duration']/len(scenes),3),
                                  'cuts_per_minute':round(max(0,len(scenes)-1)/info['duration']*60,2)},
                      'semantic_analysis':{'status':'not_analyzed','summary':'人物、钩子、叙事、字幕和特效需要结合关键帧与原片补充判断。'},
                      'warnings':warnings, 'network_used':False}
            write_json(directory/'recipe.json', recipe)
            update(status='completed', progress=100, message='镜头节奏与关键帧已提取，可填写新脚本并建立改编项目')
        except Exception as exc:
            message = str(exc) if isinstance(exc, ValueError) else '本机分析未完成，请检查视频格式与本机工具'
            try:
                update(status='failed', message=message[:300], error_type=type(exc).__name__)
            except Exception:
                # Keep a terminal snapshot available to this manager even if
                # the filesystem is temporarily unable to accept the update.
                with self.lock:
                    data = self._state(request.project_id, ref_id)
                    data.update(status='failed', message=message[:300], error_type=type(exc).__name__, updated_at=now())
                    self._remember(request.project_id, ref_id, data)
        finally:
            with self.lock:self.active.discard(ref_id)


def create_reference_router(root: Path) -> APIRouter:
    async def same_origin(request: Request):
        if request.method not in {'GET','HEAD','OPTIONS'}:
            origin = request.headers.get('origin')
            if (origin and urlsplit(origin).netloc != request.headers.get('host')) or request.headers.get('sec-fetch-site')=='cross-site':
                raise HTTPException(403, '仅允许从本机工作台发起操作')
    router = APIRouter(prefix='/model-api/reference', tags=['reference-adaptation'], dependencies=[Depends(same_origin)])
    manager = ReferenceJobs(root)
    async def run(fn, *args):
        try:return await asyncio.to_thread(fn, *args)
        except (ValueError, FileNotFoundError) as exc:raise HTTPException(422,str(exc)) from exc

    @router.get('/projects')
    async def projects():
        def available():
            base = root.resolve()
            if not base.is_dir():
                return {'projects': []}
            rows = []
            for directory in base.iterdir():
                if (directory.is_symlink() or not directory.is_dir() or directory.name.startswith(('_', '.'))
                        or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}', directory.name)):
                    continue
                metadata = directory / 'project.json'
                if not metadata.is_file() or metadata.is_symlink():
                    continue
                info = read_json(metadata)
                label = str(info.get('title') or info.get('name') or directory.name).strip()[:100]
                rows.append({'project_id': directory.name, 'label': label or directory.name,
                             'updated_at': metadata.stat().st_mtime})
            rows.sort(key=lambda row: row['updated_at'], reverse=True)
            return {'projects': rows[:100]}
        return await run(available)

    @router.post('/standalone', status_code=201)
    async def standalone(body: StandaloneRequest):
        def create():
            filename = body.filename.strip()
            if filename and (Path(filename).name != filename or '\\' in filename):
                raise ValueError('参考片文件名无效')
            title = re.sub(r'\s+', ' ', Path(filename).stem).strip()[:80] if filename else ''
            title = f'{title} · 视频复刻' if title else '独立视频复刻'
            root.mkdir(parents=True, exist_ok=True)
            project_id = 'reference-' + uuid.uuid4().hex[:20]
            project = root / project_id
            project.mkdir(exist_ok=False)
            write_json(project / 'project.json', {
                'project_id': project_id, 'title': title, 'pipeline_type': 'hybrid',
                'workspace_kind': 'reference_standalone', 'created_at': now(), 'updated_at': now(),
            })
            write_json(project / 'artifacts/workflow_state.json', {'prompt': title, 'storyboard': {'shots': []}})
            return {'project_id': project_id, 'title': title, 'workspace_kind': 'reference_standalone'}
        return await run(create)

    @router.get('/context/{project_id}')
    async def context(project_id: str):
        data = await run(project_context, root, project_id)
        project = project_path(root, project_id)
        metadata = read_json(project / 'project.json')
        data['workspace_kind'] = str(metadata.get('workspace_kind') or '')
        data['workspace_title'] = str(metadata.get('title') or metadata.get('name') or project_id)
        data['reference_sources'] = [{'path':rel(project,p),'label':read_json(p.with_suffix('.json')).get('label',p.name)}
                                    for p in sorted((project/'analysis/reference_imports').glob('*'))
                                    if p.is_file() and p.suffix.lower() in VIDEO_EXTS and p.with_suffix('.json').is_file()]
        data['references'] = await run(manager.list, project_id)
        return data

    @router.post('/upload')
    async def upload(request: Request, project_id: str, filename: str):
        project = await run(project_path, root, project_id)
        raw_name = str(filename or '')
        name = Path(raw_name).name
        if not raw_name or name != raw_name or '\\' in raw_name:
            raise HTTPException(422, '文件名无效')
        suffix = Path(name).suffix.lower()
        if suffix not in VIDEO_EXTS:raise HTTPException(422,'请选择视频文件')
        directory = project/'analysis/reference_imports'
        directory.mkdir(parents=True, exist_ok=True)
        token = uuid.uuid4().hex
        output = directory/(token+suffix)
        partial = directory/(token+'.upload')
        limit = 512*1024*1024
        if int(request.headers.get('content-length') or 0) > limit:
            raise HTTPException(413,'参考视频最多 512 MB')
        size=0
        try:
            with partial.open('xb') as file:
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > limit:
                        raise HTTPException(413,'参考视频最多 512 MB；未完成文件不会参与剪辑')
                    file.write(chunk)
            if not size:
                raise HTTPException(422, '文件为空')
            info = await run(probe, partial)
            if not info['has_video'] or not .5 <= info['duration'] <= 600:
                raise HTTPException(422,'文件没有可用的视频轨，或时长不在 0.5 秒至 10 分钟内')
            partial.rename(output)
            write_json(output.with_suffix('.json'), {'label':name[:200], 'role':'reference_only'})
            return {'path':rel(project,output), 'label':name[:200], **info}
        except HTTPException:
            partial.unlink(missing_ok=True)
            raise
        except Exception as exc:
            partial.unlink(missing_ok=True)
            raise HTTPException(422, '参考视频无法验证，请选择可播放的视频文件') from exc

    @router.post('/analyze', status_code=202)
    async def analyze(body: AnalyzeRequest):return await run(manager.submit, body)

    @router.get('/jobs/{ref_id}')
    async def job(ref_id: str, project_id: str):return await run(manager.get, project_id, ref_id)

    @router.get('/file/{project_id}')
    async def file(project_id: str, path: str, download: bool=False):
        project = await run(project_path, root, project_id)
        target = await run(local_path, project, path)
        if not (path.startswith('analysis/reference_runs/') or path.startswith('analysis/reference_imports/')) or target.suffix.lower() not in VIDEO_EXTS|{'.jpg','.json'}:
            raise HTTPException(404,'不是参考分析产物')
        return FileResponse(target, filename=target.name if download else None, headers={'X-Content-Type-Options':'nosniff'})

    def blueprint(body):
        job = manager.get(body.project_id, body.reference_id)
        if job['status']!='completed':raise ValueError('请先完成参考视频分析')
        return make_blueprint(job['recipe'], body)

    @router.post('/preview')
    async def preview(body: AdaptRequest):return await run(blueprint, body)

    def create_project(body):
        plan = blueprint(body)
        if body.options.narration not in {'local', 'none'}:
            raise ValueError('新参考改编项目仅支持本机配音或无配音，不会复制原项目旁白')
        if body.options.audio_path or body.options.bgm_path or body.options.subtitle_path:
            raise ValueError('新参考改编项目不会跨项目引用原旁白、配乐或字幕文件，请重新导入到新项目')
        if body.options.bgm_mode != 'none':
            raise ValueError('新参考改编项目不继承原项目配乐，请在新项目中重新选择配乐')
        directory = reference_dir(root, body.project_id, body.reference_id)
        signature = hashlib.sha256(json.dumps(body.model_dump(),sort_keys=True,ensure_ascii=False).encode()).hexdigest()
        token = hashlib.sha256((body.request_id or signature).encode()).hexdigest()
        receipt = directory/'adaptations'/f'{token}.json'
        with manager.lock:
            previous = read_json(receipt)
            if previous:
                if previous.get('signature') != signature:
                    raise ValueError('请求编号对应另一份改编内容，请重新预览')
                return previous
            pid = 'reference-'+uuid.uuid4().hex[:20]
            project = root/pid
            project.mkdir(parents=False,exist_ok=False)
            write_json(project/'project.json', {'project_id':pid,'title':plan['topic']+' · 参考改编',
                       'pipeline_type':'hybrid','created_at':now(),'updated_at':now()})
            write_json(project/'artifacts/script.json', {'title':plan['topic'], 'narration':plan['script'],
                       'sections':[{'id':s['id'],'text':s['text'],'title':s['title'],'duration_seconds':s['duration_seconds']} for s in plan['shots']]})
            write_json(project/'artifacts/reference_blueprint.json', plan)
            write_json(project/'artifacts/workflow_state.json', {'prompt':plan['topic'],
                       'storyboard':{'shots':[dict(s,narration=s['text']) for s in plan['shots']]},
                       'reference_parent':body.project_id})
            req = FootageRequest(project_id=pid,topic=plan['topic'],script=plan['script'],shots=plan['shots'],options=body.options)
            save_footage_draft(root,req)
            result={'status':'created','project_id':pid,'url':'/footage?project='+pid,
                    'signature':signature,'source_project_id':body.project_id,'source_unchanged':True}
            write_json(receipt,result)
            return result

    @router.post('/adapt')
    async def adapt(body: AdaptRequest):return await run(create_project,body)
    return router
