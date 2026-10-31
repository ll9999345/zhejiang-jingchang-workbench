"""Durable, project-scoped stock-to-film workflow.

MoneyPrinterTurbo's script -> materials -> voice -> subtitles -> music -> edit
workflow is adapted to Backlot's existing projects.  This module owns jobs, not
provider secrets. Every run gets a new directory; old projects and renders are
inputs, never replacement targets. A completed job means a probed local MP4.
"""
from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import random
import re
import shutil
import subprocess
import threading
import time
import uuid
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from web_api.footage_selection import (asset_key, assign_automatic, deduplicate_records, is_manual,
                                      matches_query, plan_queries, query_groups)

VIDEO_EXTS = {'.mp4', '.mov', '.m4v', '.webm', '.mkv', '.ogv', '.avi', '.ts'}
IMAGE_EXTS = {'.png', '.jpg', '.jpeg', '.webp'}
AUDIO_EXTS = {'.wav', '.mp3', '.m4a', '.aac', '.ogg', '.flac', '.aiff'}
PROJECT_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')
JOB_RE = re.compile(r'^footage-[a-f0-9]{24}$')
TERMINAL = {'completed', 'stage_completed', 'failed', 'cancelled', 'interrupted', 'awaiting_review', 'needs_materials'}
PLACES = {'三清山': 'Mount Sanqing', '南北湖': 'Nanbei Lake', '西湖': 'West Lake Hangzhou',
          '乌镇': 'Wuzhen', '硖石': 'Xiashi', '嘉兴': 'Jiaxing', '杭州': 'Hangzhou',
          '绍兴': 'Shaoxing', '舟山': 'Zhoushan', '雁荡山': 'Yandang Mountain'}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_json(path: Path, default=None):
    try:
        return json.loads(path.read_text('utf-8'))
    except (OSError, ValueError):
        return {} if default is None else default


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f'.{path.name}.{uuid.uuid4().hex}.part')
    with tmp.open('x', encoding='utf-8') as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2, allow_nan=False)
    os.replace(tmp, path)


def write_reference_timing_comparison(project: Path, output_dir: Path,
                                      shots: list[dict], rendered_duration: float) -> str | None:
    """Record reference rhythm against the performed narration for one version.

    Ordinary footage projects do not have ``reference_blueprint.json`` and
    therefore keep the existing render path byte-for-byte unchanged. Reference
    projects get one comparison artifact alongside each rendered version.
    """
    blueprint_path = project / 'artifacts/reference_blueprint.json'
    if not blueprint_path.is_file():
        return None
    blueprint = read_json(blueprint_path)
    slots = blueprint.get('slots') if isinstance(blueprint, dict) else None
    source = blueprint.get('source') if isinstance(blueprint, dict) else None
    if not isinstance(slots, list) or not isinstance(source, dict):
        raise ValueError('参考改编项目缺少有效的 reference_blueprint.json')
    by_shot = {str(slot.get('shot_id')): slot for slot in slots if isinstance(slot, dict)}
    rows = []
    actual_total = 0.0
    planned_total = 0.0
    source_total = 0.0
    for shot in shots:
        shot_id = str(shot.get('id') or '')
        slot = by_shot.get(shot_id)
        if slot is None:
            raise ValueError(f'参考改编项目缺少镜头 {shot_id} 的节奏记录')
        try:
            source_start = float(slot['source_start'])
            source_end = float(slot['source_end'])
            planned = float(slot['planned_duration'])
            actual = float(shot.get('duration_seconds') or 0)
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(f'镜头 {shot_id} 的参考时长记录无效') from exc
        if min(source_start, source_end, planned, actual) < 0 or source_end < source_start:
            raise ValueError(f'镜头 {shot_id} 的参考时长记录无效')
        source_duration = source_end - source_start
        actual_total += actual
        planned_total += planned
        source_total += source_duration
        rows.append({
            'shot_id': shot_id,
            'source_scene_id': slot.get('source_scene_id'),
            'source_start_seconds': source_start,
            'source_end_seconds': source_end,
            'reference_duration_seconds': round(source_duration, 4),
            'planned_start_seconds': float(slot.get('planned_start') or 0),
            'planned_duration_seconds': planned,
            'actual_narration_duration_seconds': actual,
            'actual_minus_planned_seconds': round(actual - planned, 4),
            'actual_minus_reference_seconds': round(actual - source_duration, 4),
        })
    rendered = float(rendered_duration or 0)
    comparison = {
        'schema_version': '1.0',
        'reference_id': blueprint.get('reference_id'),
        'source_project_id': blueprint.get('source_project_id'),
        'source_duration_seconds': float(source.get('duration') or source_total),
        'planned_duration_seconds': round(planned_total, 4),
        'actual_narration_duration_seconds': round(actual_total, 4),
        'actual_rendered_duration_seconds': round(rendered, 4),
        'actual_minus_planned_seconds': round(actual_total - planned_total, 4),
        'actual_minus_source_seconds': round(actual_total - source_total, 4),
        'shots': rows,
        'timing_policy': blueprint.get('timing_policy', 'actual_narration_first'),
    }
    path = output_dir / 'reference_timing_comparison.json'
    write_json(path, comparison)
    return rel(project, path)


def project_path(root: Path, project_id: str) -> Path:
    if not PROJECT_RE.fullmatch(project_id):
        raise ValueError('项目编号无效')
    base = root.resolve()
    result = (base / project_id).resolve()
    if result.parent != base or not result.is_dir():
        raise ValueError('找不到该项目，请先保存方案')
    return result


def local_path(project: Path, value: str, *, exists=True) -> Path:
    value = str(value or '').strip()
    p = Path(value)
    if not value or p.is_absolute() or '..' in p.parts:
        raise ValueError('素材必须位于当前项目中')
    p = (project / p).resolve()
    if not p.is_relative_to(project.resolve()):
        raise ValueError('素材路径越出了当前项目')
    if exists and not p.is_file():
        raise ValueError('素材文件不存在：' + value[:160])
    return p


def rel(project: Path, p: Path) -> str:
    return p.resolve().relative_to(project.resolve()).as_posix()


def probe(path: Path) -> dict:
    process = subprocess.run(['ffprobe', '-v', 'error', '-show_format', '-show_streams',
                              '-of', 'json', str(path)], capture_output=True, timeout=25)
    if process.returncode:
        raise ValueError('文件无法解码：' + path.name)
    data = json.loads(process.stdout)
    video = next((s for s in data.get('streams', []) if s.get('codec_type') == 'video'), {})
    return {'duration': float(data.get('format', {}).get('duration') or 0),
            'width': int(video.get('width') or 0), 'height': int(video.get('height') or 0),
            'has_audio': any(s.get('codec_type') == 'audio' for s in data.get('streams', [])),
            'has_video': bool(video)}


def material_coverage(project: Path, shots: list[dict]) -> dict:
    from web_api.footage_coverage import selected_window_coverage
    def measure(relative):
        path = local_path(project, relative)
        result = probe(path)
        result['is_still'] = path.suffix.lower() in IMAGE_EXTS
        return result
    return selected_window_coverage(shots,measure)


class SubtitleStyle(BaseModel):
    model_config = ConfigDict(extra='forbid')
    enabled: bool = True
    font: str = Field(default='PingFang SC', max_length=80, pattern=r'^[\w \-\u3400-\u9fff]+$')
    font_size: int = Field(default=40, ge=16, le=100)
    color: str = Field(default='#FFFFFF', pattern=r'^#[0-9a-fA-F]{6}$')
    outline_color: str = Field(default='#000000', pattern=r'^#[0-9a-fA-F]{6}$')
    outline_width: float = Field(default=2, ge=0, le=8)
    background: bool = False
    position: Literal['top', 'center', 'bottom'] = 'bottom'


class FootageOptions(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    aspect_ratio: Literal['16:9', '9:16', '1:1'] = '16:9'
    resolution: Literal[480, 720, 1080] = 720
    fps: Literal[24, 30] = 24
    fit: Literal['crop', 'contain'] = 'crop'
    transition: Literal['cut', 'fade', 'crossfade'] = 'crossfade'
    transition_seconds: float = Field(default=.4, ge=.1, le=2)
    narration: Literal['none', 'local', 'edge', 'uploaded'] = 'local'
    voice: str = Field(default='Tingting', max_length=100)
    voice_rate: float = Field(default=1, ge=.5, le=2)
    audio_path: str | None = Field(default=None, max_length=1024)
    bgm_path: str | None = Field(default=None, max_length=1024)
    bgm_mode: Literal['none', 'selected', 'random', 'local', 'elevenlabs'] = 'none'
    bgm_style: Literal['guofeng_ambient', 'cinematic', 'documentary'] = 'guofeng_ambient'
    bgm_prompt: str = Field(default='', max_length=3100)
    bgm_model_id: Literal['music_v1', 'music_v2', 'music_v2_5'] = 'music_v1'
    # Consent belongs to this submission only, never to saved presets or job records.
    bgm_confirm_paid: bool = Field(default=False, strict=True, exclude=True)
    bgm_confirm_text: bool = Field(default=False, strict=True, exclude=True)
    bgm_billing_limit_configured: bool = Field(default=False, strict=True, exclude=True)
    bgm_budget_usd: float | None = Field(default=None, gt=0, strict=True, exclude=True)
    narration_volume: float = Field(default=1, ge=0, le=2)
    bgm_volume: float = Field(default=.18, ge=0, le=1)
    duck_bgm: bool = True
    source_volume: float = Field(default=0, ge=0, le=1)
    subtitles: SubtitleStyle = Field(default_factory=SubtitleStyle)
    subtitle_path: str | None = Field(default=None, max_length=1024)
    ken_burns: bool = True
    variants: int = Field(default=1, ge=1, le=5)
    order: Literal['sequential', 'random'] = 'sequential'


class FootageShot(BaseModel):
    model_config = ConfigDict(extra='ignore', allow_inf_nan=False)
    id: str = Field(min_length=1, max_length=80, pattern=r'^[A-Za-z0-9._-]+$')
    title: str = Field(default='', max_length=200)
    text: str = Field(default='', max_length=2000)
    query: str = Field(default='', max_length=300)
    visual_prompt: str = Field(default='', max_length=3000)
    selection_mode: Literal['manual', 'auto'] = 'manual'
    source_locked: bool = False
    source_path: str = Field(default='', max_length=1024)
    start_seconds: float = Field(default=0, ge=0, le=86400)
    duration_seconds: float = Field(default=5, ge=.5, le=120)


class FootageRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    project_id: str = Field(pattern=r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')
    topic: str = Field(default='', max_length=1000)
    script: str = Field(default='', max_length=20000)
    shots: list[FootageShot] = Field(default_factory=list, max_length=60)
    sources: list[str] = Field(default_factory=list, max_length=16)
    material_mode: Literal['stock', 'local', 'mixed'] = 'mixed'
    allow_generic: bool = False
    options: FootageOptions = Field(default_factory=FootageOptions)
    action: Literal['collect', 'render', 'create'] = 'collect'
    stop_at: Literal['script', 'terms', 'materials', 'audio', 'subtitle', 'video'] = 'video'
    confirm_network: bool = False
    request_id: str = Field(default='', max_length=100, pattern=r'^[A-Za-z0-9._-]*$')

    @model_validator(mode='after')
    def valid_shots(self):
        if len({s.id for s in self.shots}) != len(self.shots):
            raise ValueError('镜头编号不可重复')
        if sum(s.duration_seconds for s in self.shots) > 600:
            raise ValueError('一次初剪最长为 10 分钟')
        return self


def _sentences(script: str) -> list[str]:
    lines = [x.strip() for x in re.split(r'\n+|(?<=[。！？!?])\s*', script) if x.strip()]
    result = []
    for line in lines:
        # Long paragraphs are split at punctuation instead of overflowing cues.
        pieces = re.split(r'(?<=[，,；;])', line) if len(line) > 160 else [line]
        result.extend(p.strip() for p in pieces if p.strip())
    if len(result) > 60:
        raise ValueError('脚本超过 60 段，请先精简或分成多个项目')
    return result


def _queries(topic: str, text: str, override: str = '') -> list[dict]:
    return plan_queries(topic, text, override, PLACES)


def candidate_matches_query(record: dict, query: str) -> bool:
    """Metadata relevance gate, NOT visual/location verification.

    Search providers may use OR search. 'Mount Sanqing' previously returned a
    Linux filesystem tutorial; the input query itself cannot prove relevance.
    """
    return matches_query(record, query, PLACES)


def project_context(root: Path, project_id: str) -> dict:
    project = project_path(root, project_id)
    workflow = read_json(project / 'artifacts/workflow_state.json')
    script = read_json(project / 'artifacts/script.json')
    sections = script.get('sections') or []
    storyboard = (workflow.get('storyboard') or {}).get('shots') or []
    topic = str(workflow.get('prompt') or script.get('title') or project_id)
    shots = []
    for i, item in enumerate(storyboard or sections):
        section = sections[i] if i < len(sections) else {}
        text = str(item.get('narration') or section.get('text') or item.get('text') or '')
        visual = str(item.get('visual_prompt') or item.get('title') or text)
        shots.append({'id': str(item.get('id') or f'shot-{i+1}'), 'title': str(item.get('title') or item.get('label') or f'镜头 {i+1}'),
                      'text': text, 'visual_prompt': visual, 'query': '', 'queries': _queries(topic, visual),
                      'duration_seconds': float(item.get('duration_seconds') or 5),
                      'start_seconds': 0, 'source_path': '', 'candidates': []})
    narration = '\n'.join(s['text'] for s in shots) or str(script.get('narration') or '')
    signature = hashlib.sha256(json.dumps([topic, sections, storyboard], ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    draft = read_json(project / 'artifacts/footage_draft.json')
    if draft.get('source_signature') == signature:
        topic, narration, shots = draft.get('topic', topic), draft.get('script', narration), draft.get('shots', shots)
    for shot in shots:
        shot['candidates'] = []
        shot['queries'] = _queries(topic, ' '.join(str(shot.get(k) or '') for k in ('title', 'text', 'visual_prompt')), shot.get('query', ''))
    clips = read_json(project / 'artifacts/stock_search_manifest.json').get('clips') or []
    for manifest in sorted((project / 'artifacts/footage_jobs').glob('footage-*/stock_manifest.json'))[-50:]:
        clips.extend(read_json(manifest).get('clips') or [])
    for shot in shots:
        seen = set()
        for c in clips:
            query_matches = c.get('query') in [q['text'] for q in shot['queries']]
            if shot['id'] in (c.get('shot_ids') or []) and query_matches and candidate_matches_query(c, c['query']) and _valid_clip(project, c) and c['path'] not in seen:
                kind = next((q['kind'] for q in shot['queries'] if q['text'] == c.get('query')), 'generic')
                shot['candidates'].append(dict(c, match_kind='illustrative' if kind == 'generic' else 'place_candidate', location_verified=False))
                seen.add(c['path'])
    assets = []
    # Existing generated media is selectable but never called real footage.
    for dirname in ('assets', 'renders', 'subtitles', 'artifacts/footage_jobs'):
        for p in sorted((project / dirname).rglob('*')):
            if len(assets) >= 600:
                break
            if not p.is_file() or not p.resolve().is_relative_to(project) or '/thumbnails/' in p.as_posix() or any(part.startswith('.') for part in p.relative_to(project).parts):
                continue
            if dirname == 'artifacts/footage_jobs' and p.name != 'narration.wav':
                continue
            ext = p.suffix.lower()
            kind = 'video' if ext in VIDEO_EXTS else 'image' if ext in IMAGE_EXTS else 'audio' if ext in AUDIO_EXTS else 'subtitle' if ext == '.srt' else ''
            if kind:
                path = rel(project, p)
                original = read_json(p.with_suffix('.json')) if '/footage/imports/' in path else {}
                extension_dir = next((parent for parent in p.parents if parent.name.startswith('mpt-') and parent.is_relative_to(project)), None)
                extension = read_json(extension_dir / 'verified-result.json', read_json(extension_dir / 'result.json')) if extension_dir else {}
                if extension_dir and path not in extension.get('files', []):
                    continue
                assets.append({'path': path, 'kind': kind, 'label': original.get('label') or p.name,
                               'origin': 'generated' if '/frames/' in path or '/mpt-' in path or path.startswith(('renders/', 'artifacts/')) else original.get('origin', 'local'),
                               'is_music': '/music/' in path or '/bgm/' in path or original.get('role') == 'music' or extension.get('operation') == 'music'})
    return {'project_id': project_id, 'topic': topic, 'script': narration, 'shots': shots, 'source_signature': signature,
            'draft_updated_at': draft.get('updated_at', '') if draft.get('source_signature') == signature else '',
            'source_records': {c['path']: c for c in clips if _valid_clip(project, c)},
            'assets': assets, 'selected_candidate_id': workflow.get('selected_candidate_id'),
            'settings': read_json(project / 'artifacts/footage_settings.json')}


def _valid_clip(project: Path, item: dict) -> bool:
    try:
        return local_path(project, item.get('path', '')).suffix.lower() in VIDEO_EXTS | IMAGE_EXTS
    except (ValueError, OSError):
        return False


def plan_footage(root: Path, request: FootageRequest) -> dict:
    context = project_context(root, request.project_id)
    topic = request.topic.strip() or context['topic']
    script = request.script.strip()
    if request.shots:
        shots = [s.model_dump() for s in request.shots]
    elif script:
        shots = [{'id': f'shot-{i+1}', 'title': f'镜头 {i+1}', 'text': text, 'query': '',
                  'source_path': '', 'start_seconds': 0,
                  'duration_seconds': min(30, max(3, len(text) / (4 if re.search(r'[\u3400-\u9fff]', text) else 14)))}
                 for i, text in enumerate(_sentences(script))]
    else:
        shots = context['shots']
    if not shots:
        raise ValueError('当前方案没有旁白或分镜，请生成分镜或输入要讲的内容')
    project = project_path(root, request.project_id)
    existing = {s['id']: s for s in context['shots']}
    for shot in shots:
        old = existing.get(shot['id'], {})
        shot['queries'] = _queries(topic, ' '.join(str(shot.get(k) or '') for k in ('title', 'text', 'visual_prompt')), shot.get('query', ''))
        shot['candidates'] = [c for c in old.get('candidates', [])
                              if c.get('query') in [q['text'] for q in shot['queries']]
                              and (request.allow_generic or c.get('match_kind') != 'illustrative')]
        known_paths = {c['path'] for c in shot['candidates']}
        for c in context['source_records'].values():
            if c['path'] in known_paths:
                continue
            match = next((q for q in shot['queries'] if (q['kind'] != 'generic' or request.allow_generic) and candidate_matches_query(c, q['text'])), None)
            if match:
                shot['candidates'].append(dict(c, match_kind='illustrative' if match['kind'] == 'generic' else 'place_candidate', location_verified=False))
                known_paths.add(c['path'])
        if shot.get('source_path'):
            source = local_path(project, shot['source_path'])
            if source.suffix.lower() not in VIDEO_EXTS | IMAGE_EXTS:
                raise ValueError('镜头素材必须是视频或图片')
            shot['selected_source'] = next((c for c in shot['candidates'] if c['path'] == shot['source_path']),
                                           dict(context['source_records'].get(shot['source_path']) or
                                                {'path': shot['source_path'], 'source': 'user_selected',
                                                 'license': '由创作者提供或确认授权'}, location_verified=False))
        shot['candidates'] = deduplicate_records(shot['candidates'])
    if sum(s['duration_seconds'] for s in shots) > 600:
        raise ValueError('一次初剪最长为 10 分钟')
    for key in ('audio_path', 'bgm_path', 'subtitle_path'):
        if getattr(request.options, key):
            local_path(project, getattr(request.options, key))
    return {'status': 'planned', 'project_id': request.project_id, 'topic': topic,
            'script': '\n'.join(s['text'] for s in shots), 'shots': shots,
            'options': request.options.model_dump(), 'network_used': False,
            'missing_shots': [s['id'] for s in shots if not s.get('source_path') and not s.get('candidates')],
            'summary': f"已承接 {len(shots)} 个镜头；关键词自动准备，配音后按实测时长剪辑。"}


def capabilities() -> dict:
    from tools.video.stock_sources import source_catalog
    local = platform.system() == 'Darwin' and bool(shutil.which('say'))
    installed = ''
    if local:
        installed = subprocess.run(['say', '-v', '?'], capture_output=True, text=True, timeout=10).stdout
    voices = [{'id': name, 'label': label, 'provider': 'local', 'available': local and name in installed, 'network': False}
              for name, label in [('Tingting', '婷婷 · 本机中文'), ('Mei-Jia', '美佳 · 本机中文'), ('Alex', 'Alex · 本机英文')]]
    edge = importlib.util.find_spec('edge_tts') is not None
    voices += [{'id': name, 'label': label, 'provider': 'edge', 'available': edge, 'network': True}
               for name, label in [('zh-CN-XiaoxiaoNeural', '晓晓 · 在线中文'), ('zh-CN-YunxiNeural', '云希 · 在线中文'),
                                   ('en-US-JennyNeural', 'Jenny · 在线英文'), ('ja-JP-NanamiNeural', 'Nanami · 在线日语')]]
    return {'status': 'available' if shutil.which('ffmpeg') and shutil.which('ffprobe') else 'unavailable',
            'sources': source_catalog(), 'voices': voices,
            'stages': ['script', 'terms', 'materials', 'audio', 'subtitle', 'video'],
            'default_sources': ['pexels', 'pixabay_video', 'wikimedia', 'mixkit', 'archive_org'],
            'features': ['automatic_queries', 'stock_acquisition', 'local_upload', 'storyboard_edit',
                         'trim', 'transitions', 'aspect_fit', 'still_motion', 'narration', 'voice_preview',
                         'subtitle_style', 'bgm', 'local_instrumental_bgm', 'canvas_cut_handoff', 'mixing', 'batch_variants', 'batch_jobs', 'stage_outputs',
                         'full_voice_preview', 'task_history', 'cancel', 'settings_export', 'upstream_preset_import'],
            'upstream': {'name': 'MoneyPrinterTurbo', 'integration': 'native_workflow',
                         'license': 'MIT', 'provider_services': 'explicit_configuration_required'}}


class JobCancelled(RuntimeError):
    pass


def save_footage_draft(root: Path, request: FootageRequest, plan=None):
    plan = plan or plan_footage(root, request)
    context = project_context(root, request.project_id)
    project = project_path(root, request.project_id)
    write_json(project / 'artifacts/footage_draft.json', {
        'source_signature': context['source_signature'], 'updated_at': now(),
        'topic': plan['topic'], 'script': plan['script'], 'shots': plan['shots']})
    write_json(project / 'artifacts/footage_settings.json', request.options.model_dump())
    return {'status': 'saved', 'network_used': False}


class FootageJobs:
    """One bounded worker per service; idempotency and status survive refresh."""

    def __init__(self, root: Path, *, executor=None, search=None, renderer=None):
        self.root = Path(root)
        self.executor = executor or ThreadPoolExecutor(max_workers=1, thread_name_prefix='footage')
        self.search = search
        self.renderer = renderer
        self._lock = threading.RLock()
        self._active: dict[str, threading.Event] = {}

    def directory(self, project_id: str, job_id: str) -> Path:
        if not JOB_RE.fullmatch(job_id):
            raise ValueError('任务编号无效')
        project = project_path(self.root, project_id)
        return local_path(project, f'artifacts/footage_jobs/{job_id}', exists=False)

    def get(self, project_id: str, job_id: str) -> dict:
        with self._lock:
            path = self.directory(project_id, job_id) / 'job.json'
            state = read_json(path)
            if not state:
                raise ValueError('找不到当前项目中的该任务')
            if state['status'] not in TERMINAL and job_id not in self._active:
                state.update(status='interrupted', message='服务重启，任务已停止。已下载的素材保留，可重新发起；不会自动重试。', updated_at=now())
                write_json(path, state)
            return state

    def list(self, project_id: str) -> list[dict]:
        base = project_path(self.root, project_id) / 'artifacts/footage_jobs'
        paths = sorted(base.glob('footage-*/job.json'), key=lambda p: p.stat().st_mtime, reverse=True)
        return [self.get(project_id, p.parent.name) for p in paths[:100]]

    def update(self, project_id: str, job_id: str, **values) -> dict:
        with self._lock:
            path = self.directory(project_id, job_id) / 'job.json'
            state = read_json(path)
            state.update(values, updated_at=now())
            write_json(path, state)
            return state

    def validate_request(self, request: FootageRequest) -> dict:
        """Read-only validation shared by single and batch submission."""
        plan = plan_footage(self.root, request)
        text_only = request.stop_at in ('script', 'terms')
        materials = not text_only and (request.action == 'collect' or request.stop_at in ('materials', 'video'))
        narration = not text_only and request.action != 'collect' and request.stop_at != 'materials'
        network = (materials and request.action != 'render' and request.material_mode != 'local') or (narration and request.options.narration == 'edge')
        if network and not request.confirm_network:
            raise ValueError('请确认联网查找公开素材；选择在线配音时会发送旁白文本')
        from tools.video.stock_sources import source_catalog
        catalog = {s['name']: s for s in source_catalog()}
        invalid = [s for s in request.sources if s not in catalog or catalog[s]['status'] != 'available']
        if materials and invalid:
            raise ValueError('素材源尚未配置：' + ', '.join(invalid))
        if request.stop_at == 'audio' and request.action != 'collect' and request.options.narration == 'none':
            raise ValueError('只生成旁白时请选择音色或已导入的旁白')
        if narration and request.options.narration == 'uploaded' and not request.options.audio_path:
            raise ValueError('请选择已导入的旁白音频')
        if request.stop_at == 'subtitle' and request.action != 'collect' and not request.options.subtitle_path and not any(s['text'].strip() for s in plan['shots']):
            raise ValueError('生成字幕需要原稿或已导入的 SRT')
        plan.update(stop_at=request.stop_at, network_required=network)
        return plan

    def submit(self, request: FootageRequest) -> dict:
        plan = self.validate_request(request)
        with self._lock:
            payload = request.model_dump()
            fingerprint_payload = dict(payload, request_id='')
            fingerprint_payload['resolved_plan'] = plan
            fingerprint = hashlib.sha256(json.dumps(fingerprint_payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
            for previous in self.list(request.project_id):
                if request.request_id and previous.get('request_id') == request.request_id:
                    if previous['request'] != payload:
                        raise ValueError('同一请求编号对应的内容已改变，请重新提交')
                    return previous
                if previous['fingerprint'] == fingerprint and previous['status'] not in TERMINAL:
                    return previous
            if len(self._active) >= 8:
                raise ValueError('队列已有 8 个任务，请等待或取消后再提交')
            job_id = 'footage-' + uuid.uuid4().hex[:24]
            directory = self.directory(request.project_id, job_id)
            directory.mkdir(parents=True, exist_ok=False)
            event = threading.Event()
            self._active[job_id] = event
            state = {'job_id': job_id, 'project_id': request.project_id, 'status': 'queued',
                     'stage': 'queued', 'progress': 0, 'message': '已排队，刷新页面不会重复提交',
                     'created_at': now(), 'updated_at': now(), 'request_id': request.request_id,
                     'fingerprint': fingerprint, 'shots': plan['shots'], 'outputs': [], 'warnings': [],
                     'request': payload, 'title': plan['topic'], 'cost_cny': 0}
            write_json(directory / 'job.json', state)
            save_footage_draft(self.root, request, plan)
            self.executor.submit(self._run, request, plan, job_id, event)
            return state

    def cancel(self, project_id: str, job_id: str) -> dict:
        with self._lock:
            state = self.get(project_id, job_id)
            event = self._active.get(job_id)
            if event and state['status'] not in TERMINAL:
                event.set()
                return self.update(project_id, job_id, message='正在停止，已完成的素材和版本会保留', cancel_requested=True)
            return state

    def _check(self, event):
        if event.is_set():
            raise JobCancelled('任务已停止，已有素材和导出版本已保留')

    def _run(self, request: FootageRequest, plan: dict, job_id: str, event: threading.Event):
        project = project_path(self.root, request.project_id)
        directory = self.directory(request.project_id, job_id)
        def update(**kw):
            self._check(event)
            return self.update(request.project_id, job_id, **kw)
        try:
            if request.stop_at in ('script', 'terms'):
                update(status='running', stage=request.stop_at, progress=20,
                       message='正在整理当前确认文案与镜头关键词；不搜索素材或制作配音')
                script_path = directory / 'script.txt'
                script_path.write_text(plan['script'], encoding='utf-8')
                output = {'stage': request.stop_at, 'script_path': rel(project, script_path),
                          'script_source': 'project_or_user', 'network_used': False}
                if request.stop_at == 'terms':
                    terms_path = directory / 'search-terms.json'
                    rows = [{'shot_id': shot['id'], 'text': shot['text'], 'queries': shot['queries']}
                            for shot in plan['shots']]
                    terms = list(dict.fromkeys(query['text'] for row in rows for query in row['queries']))
                    write_json(terms_path, {'version': 1, 'topic': plan['topic'], 'terms': terms, 'shots': rows,
                                            'keyword_source': 'local_query_planner', 'network_used': False})
                    output.update(terms_path=rel(project, terms_path), terms_count=len(terms),
                                  keyword_source='local_query_planner')
                write_json(directory / 'stage-result.json', output)
                update(status='stage_completed', stage=request.stop_at, progress=100, outputs=[output],
                       message='文案已保存，可下载或继续制作；未调用 AI 生成新文案。' if request.stop_at == 'script'
                       else '当前镜头的搜索词已整理，可下载或继续找素材；本阶段未联网。')
                return
            update(status='running', stage='materials', progress=3, message='正在检查项目素材与镜头对应关系')
            shots = plan['shots']
            warnings: list[str] = []
            only_sound = request.action != 'collect' and request.stop_at in ('audio', 'subtitle')
            if not only_sound and request.action != 'render' and request.material_mode != 'local':
                self._collect(request, plan, job_id, event, warnings)
            elif not only_sound and request.material_mode == 'local':
                # Locally uploaded sources may be automatically distributed, generated
                # storyboard pictures are never silently substituted for real footage.
                assets = ([a for a in project_context(self.root, request.project_id)['assets']
                           if a['kind'] in ('video', 'image') and '/footage/imports/' in a['path']]
                          if any(not is_manual(s) and not s.get('source_locked') for s in shots) else [])
                candidates = []
                for asset in assets:
                    try:
                        info = probe(local_path(project, asset['path']))
                        candidates.append(dict(asset, title=asset.get('label') or Path(asset['path']).name,
                                               duration=info['duration'], source='user_local',
                                               license='由创作者提供或确认授权', location_verified=False))
                    except (ValueError, OSError, subprocess.SubprocessError):
                        warnings.append('已跳过无法测量时长的本机素材。')
                for shot in shots:
                    if not is_manual(shot) and not shot.get('source_locked'):
                        shot['candidates'] = candidates
                assignment = assign_automatic(shots, valid=lambda c: _valid_clip(project, c))
                warnings.extend(assignment['warnings'])
                plan['material_assignment'] = assignment
            if not only_sound:
                if 'material_coverage' not in plan:
                    plan['material_coverage'] = material_coverage(project,shots)
                update(material_coverage=plan['material_coverage'])
            missing = [s['id'] for s in shots if not s.get('source_path')]
            if not only_sound and (request.action == 'collect' or request.stop_at == 'materials' or missing):
                status = 'needs_materials' if missing else 'awaiting_review'
                covered = plan.get('material_coverage') or {}
                coverage_note = (f" 片段时长核对：{covered.get('covered_seconds',0):g}/{covered.get('required_seconds',0):g} 秒；地点与内容仍需逐镜复核。"
                                 if covered else '')
                update(status=status, stage='materials', progress=100, shots=shots, warnings=warnings,
                       missing_shots=missing, message=(f'还有 {len(missing)} 个镜头缺素材，可上传实拍或调整来源后重试。' if missing
                       else '候选素材已下载并自动选片；可逐镜预览、替换，然后生成初剪。') + coverage_note)
                return
            update(shots=shots, progress=42, stage='narration', message='正在制作配音并测量每段实际时长', warnings=warnings)
            options = request.options.model_dump()
            audio = self._narrate(project, directory, shots, request, event)
            options['audio_path'] = rel(project, audio) if audio else None
            if not only_sound and any(s.get('selection_mode') == 'auto' for s in shots):
                assignment = assign_automatic(shots, allow_generic=request.allow_generic,
                                              valid=lambda c: _valid_clip(project, c))
                warnings.extend(assignment['warnings'])
                plan['material_coverage'] = material_coverage(project,shots)
                update(material_coverage=plan['material_coverage'])
                if assignment['missing_shots']:
                    update(status='needs_materials', stage='materials', progress=100, shots=shots,
                           missing_shots=assignment['missing_shots'], warnings=list(dict.fromkeys(warnings)),
                           audio_path=options['audio_path'], material_assignment=assignment,
                           message='实测旁白长于可用片段；已保留旁白，请补充足够长的素材后继续。')
                    return
            if only_sound:
                output = {'stage': request.stop_at, 'duration_seconds': round(sum(s['duration_seconds'] for s in shots), 4)}
                if audio:
                    output['audio_path'] = rel(project, audio)
                if request.stop_at == 'subtitle':
                    target = directory / 'subtitles.srt'
                    if request.options.subtitle_path:
                        target.write_bytes(local_path(project, request.options.subtitle_path).read_bytes())
                    else:
                        from web_api.footage_render import _generate_srt
                        cursor, segments = 0.0, []
                        for shot in shots:
                            end = cursor + shot['duration_seconds']
                            segments.append(dict(shot, timeline_start_seconds=cursor, timeline_end_seconds=end))
                            cursor = end
                        target.write_bytes(_generate_srt(segments))
                    output['subtitle_path'] = rel(project, target)
                    output['timing_source'] = ('imported_srt' if request.options.subtitle_path else
                                              'proportional_uploaded_audio' if request.options.narration == 'uploaded' else
                                              'measured_narration_segments' if audio else 'planned_shot_durations')
                    if request.options.narration == 'uploaded' and not request.options.subtitle_path:
                        warnings.append('导入旁白按总时长分配字幕，未逐句识别；请核对时间点或运行 Whisper 转录。')
                    if not audio and not request.options.subtitle_path:
                        warnings.append('字幕按计划镜头时长排布，未进行语音识别或词级对齐。')
                write_json(directory / 'stage-result.json', output)
                update(status='stage_completed', stage=request.stop_at, progress=100, shots=shots, outputs=[output], warnings=warnings,
                       message='旁白阶段已完成，可下载音频。' if request.stop_at == 'audio' else '字幕阶段已完成，可下载字幕并核对时间轴。')
                return
            if options['bgm_mode'] == 'none':
                options['bgm_path'] = None
            elif options['bgm_mode'] == 'elevenlabs':
                update(stage='music', progress=54, message='正在按实际旁白时长生成已授权的 ElevenLabs 器乐；本任务仅调用一次')
                from web_api.footage_music import render_footage_music
                music = render_footage_music(
                    self.root, request, sum(s['duration_seconds'] for s in shots),
                    output_name=f'footage-{job_id}-bgm.mp3')
                self._check(event)
                options['bgm_path'] = music['music']['path']
                update(music=music, resolved_options=options)
            elif options['bgm_mode'] == 'local':
                update(stage='music', progress=54, message='正在按实际旁白时长合成本机器乐；不联网、不收费')
                from web_api.local_music_pipeline import render_local_music
                from web_api.music_pipeline import MusicPipelineRequest
                length = sum(s['duration_seconds'] for s in shots)
                music = render_local_music(MusicPipelineRequest(
                    project_id=request.project_id, prompt='真实素材初剪 · 本机器乐铺底',
                    duration_seconds=max(3, length), preferred_provider='local',
                    local_style=options['bgm_style'], output_name='footage-bgm.wav',
                    dry_run=False, execute=True, confirm=True), project_root=self.root)
                self._check(event)
                if music.get('status') != 'completed':
                    raise ValueError('本机配乐未完成；已生成旁白保留，可换用已导入音乐或不配乐后继续')
                options['bgm_path'] = music['music']['path']
                update(music=music, resolved_options=options)
            elif options['bgm_mode'] == 'random':
                music = [a['path'] for a in project_context(self.root, request.project_id)['assets'] if a['kind'] == 'audio' and a['is_music']]
                if not music:
                    raise ValueError('项目中没有配乐，请上传一首音乐或选择不配乐')
                options['bgm_path'] = random.Random(job_id).choice(music)
            elif not options['bgm_path']:
                raise ValueError('请选择一首已导入的配乐')
            update(shots=shots, stage='editing', progress=55, message='正在按实际旁白时长剪辑、添加字幕和混音')
            if self.renderer is None:
                from web_api.footage_render import render_footage
                renderer = render_footage
            else:
                renderer = self.renderer
            outputs = []
            if options['variants'] > 1 and all(len({c['path'] for c in shot.get('candidates', [])} | {shot.get('source_path')}) <= 1 for shot in shots):
                warnings.append('素材候选有限，各版本可能相同；增加候选素材后可获得不同组合。')
            for index in range(options['variants']):
                self._check(event)
                variant_shots = [dict(s) for s in shots]
                rng = random.Random(f'{job_id}-{index}')
                # Alternative cuts vary footage within a shot. Narration/story order
                # stays fixed, avoiding a shuffled voice-to-picture mismatch.
                used_offsets = {}
                explicit = {s['id'] for s in variant_shots if is_manual(s) or s.get('source_locked')}
                if index or options['order'] == 'random':
                    for shot in variant_shots:
                        if shot['id'] not in explicit:
                            shot['candidates'] = list(shot.get('candidates') or [])
                            rng.shuffle(shot['candidates'])
                    assignment = assign_automatic(variant_shots, allow_generic=request.allow_generic,
                                                  valid=lambda c: _valid_clip(project, c))
                    if assignment['missing_shots']:
                        raise ValueError('不同版本缺少足够的合适片段，请补充素材后继续')
                for shot in variant_shots:
                    source_path = local_path(project, shot['source_path'])
                    info = probe(source_path)
                    if source_path.suffix.lower() in VIDEO_EXTS:
                        previous_end = used_offsets.get(shot['source_path'], 0)
                        if shot['id'] not in explicit and shot.get('selection_mode') != 'auto' and previous_end + shot['duration_seconds'] <= info['duration']:
                            shot['start_seconds'] = previous_end
                        used_offsets[shot['source_path']] = shot['start_seconds'] + shot['duration_seconds']
                        if shot['start_seconds'] >= info['duration']:
                            raise ValueError(f"镜头 {shot['id']} 的起点超出了素材时长")
                        shot['repeat_to_fill'] = shot['start_seconds'] + shot['duration_seconds'] > info['duration'] + .1
                        if shot['repeat_to_fill'] and shot.get('selection_mode') == 'auto':
                            raise ValueError(f"镜头 {shot['id']} 的自动选片区间超出素材时长，请补充素材")
                        if shot['repeat_to_fill']:
                            warnings.append(f"镜头 {shot['id']} 的素材短于旁白，已循环补齐；可换成更长素材。")
                out_dir = project / 'renders' / job_id / f'version-{index+1}'
                def render_progress(percent, message):
                    translated = {'validating footage inputs': '正在检查素材', 'assembling footage': '正在拼接与转场',
                                  'normalizing footage duration': '正在对齐视频时长', 'burning subtitles': '正在添加字幕',
                                  'mixing audio': '正在混合旁白与配乐', 'footage render verified': '视频文件验证通过'}
                    if message.startswith(('rendering shot', 'prepared shot')):
                        message = '正在处理镜头 ' + message.split()[-1]
                    update(progress=int(55+40*(index+percent/100)/options['variants']), message=translated.get(message, message))
                result = renderer(project, out_dir, variant_shots, options,
                                  progress=render_progress,
                                  cancelled=event.is_set)
                if result.get('status') != 'completed' or not local_path(project, result.get('output_path', '')).is_file():
                    raise ValueError('剪辑器未产出有效视频')
                actual = probe(local_path(project, result['output_path']))
                if not actual['has_video'] or actual['duration'] <= 0:
                    raise ValueError('导出文件没有有效的视频轨道')
                reference_timing_path = write_reference_timing_comparison(
                    project, out_dir, variant_shots, actual['duration'])
                if reference_timing_path:
                    result['reference_timing_path'] = reference_timing_path
                result['provenance_path'] = rel(project, directory / f'sources-{index+1}.json')
                write_json(directory / f'sources-{index+1}.json', {'job_id': job_id, 'shots': variant_shots,
                           'notice': '来源与许可来自素材平台。文字匹配不代表地点或画面已人工核验。'})
                if result.get('segments'):
                    from web_api.footage_canvas import write_canvas_cut
                    result['canvas_cut_path'] = write_canvas_cut(
                        project, out_dir, request.project_id, job_id, index + 1,
                        plan['topic'], result, options)
                outputs.append(result)
                update(outputs=outputs, resolved_options=options, warnings=list(dict.fromkeys(warnings)))
            update(status='completed', stage='completed', progress=100, shots=shots, outputs=outputs,
                   message=f'已导出 {len(outputs)} 个初剪版本；请试听配音、核对画面地点与许可后交付。')
            from backlot.server import notify_project_changed
            notify_project_changed(request.project_id)
        except Exception as exc:
            cancelled = event.is_set() or isinstance(exc, JobCancelled)
            # Never persist exception representations of remote requests/tokens.
            message = str(exc)[:400] if isinstance(exc, (ValueError, JobCancelled)) else '处理未完成，请检查素材是否可播放、来源连接和本机运行环境。'
            self.update(request.project_id, job_id, status='cancelled' if cancelled else 'failed',
                        stage='cancelled' if cancelled else 'failed', message=message,
                        error_type=type(exc).__name__)
        finally:
            with self._lock:
                self._active.pop(job_id, None)

    def _collect(self, request, plan, job_id, event, warnings):
        from tools.video.direct_clip_search import DirectClipSearch, stock_progress_context
        from tools.video.stock_sources import source_catalog
        from tools.video.stock_sources.base import clean_source_failure, stop_source_for_run
        from web_api.media_pipeline import _stock_failure_summary
        project = project_path(self.root, request.project_id)
        available = {s['name'] for s in source_catalog() if s['status'] == 'available'}
        sources = request.sources or [s for s in ('pexels', 'pixabay_video', 'wikimedia', 'mixkit', 'archive_org') if s in available]
        if not sources:
            raise ValueError('没有可用素材源，请配置免费素材库或导入本地实拍')
        shots = plan['shots']
        queries: dict[str, dict] = {}
        for shot in shots:
            if is_manual(shot) or shot.get('source_locked'):
                continue
            for q in shot['queries']:
                if q['kind'] == 'generic' and not request.allow_generic:
                    continue
                row = queries.setdefault(q['text'], {'query': q['text'], 'kind': q['kind'], 'shot_ids': []})
                row['shot_ids'].append(shot['id'])
        if len(queries) > 20:
            warnings.append('本次最多检索 20 个关键词；其余镜头可继续补搜。')
        pool = []
        # Reuse candidate media already owned by the project without replacing its manifest.
        for shot in shots:
            pool.extend(shot.get('candidates') or [])
        pool = deduplicate_records([c for c in pool if _valid_clip(project, c)])
        for candidate in pool:
            if not candidate.get('duration'):
                try:
                    info = probe(local_path(project, candidate['path']))
                    candidate.update(duration=info['duration'], width=info['width'], height=info['height'])
                except (ValueError, OSError, subprocess.SubprocessError):
                    warnings.append('已跳过无法测量时长的旧候选素材。')
        search = self.search or DirectClipSearch().execute
        blocked_sources = set()
        source_errors = []
        specs = sorted(queries.values(), key=lambda q: {'place_intent': 0, 'place': 1, 'generic': 2}[q['kind']])[:20]
        for index, spec in enumerate(specs):
            self._check(event)
            target_shots = [s for s in shots if s['id'] in spec['shot_ids']]
            # One old candidate is not enough for a shared multi-shot query.
            matching_assets = {asset_key(c) for c in pool if candidate_matches_query(c, spec['query'])
                               and (request.allow_generic or c.get('match_kind') != 'illustrative')
                               and not re.search(r'by-nc-nd|by-nd|no.?derivatives|禁止.*改编', str(c.get('license') or ''), re.I)
                               and float(c.get('duration') or 0) >= max(s['duration_seconds'] for s in target_shots)}
            if target_shots and len(matching_assets) >= len(target_shots):
                continue
            effective_sources = [source for source in sources if source not in blocked_sources]
            if not effective_sources:
                warnings.append('本次素材来源均已停止后续请求；保留已有素材，请核对来源后手动补搜。')
                break
            self.update(request.project_id, job_id, progress=5+int(30*index/max(1,len(queries))),
                        message=f"正在找真实素材：{spec['query']}（{index+1}/{min(20,len(queries))}）")
            last_progress = 5 + int(30 * index / max(1, len(specs)))
            ready_count = 0
            last_coverage = {}
            def report_stock_progress(detail):
                nonlocal last_progress, ready_count, last_coverage
                if event.is_set() or not isinstance(detail, dict):
                    return
                phase = detail.get('phase')
                labels = {'query_started': '开始检索', 'search_started': '正在查询来源',
                          'search_completed': '来源查询已返回', 'download_started': '正在下载候选素材',
                          'clip_ready': '候选素材已校验'}
                if phase not in labels:
                    return
                source = detail.get('source')
                label = f" · {source}" if source in effective_sources else ''
                count = detail.get('clips_ready', ready_count)
                count = count if type(count) is int and 0 <= count <= 120 else ready_count
                ready_count = max(ready_count, count)
                count = ready_count
                value = detail.get('coverage')
                if isinstance(value,dict):
                    numbers = [value.get(k) for k in ('verified_usable_seconds','required_seconds')]
                    if all(type(v) in (int,float) and math.isfinite(v) and 0 <= v <= 7200 for v in numbers):
                        last_coverage = dict(zip(('verified_usable_seconds','required_seconds'),numbers))
                duration_note = ''
                if last_coverage.get('required_seconds',0) > 0:
                    duration_note = f"，候选可用 {last_coverage['verified_usable_seconds']:g}/{last_coverage['required_seconds']:g} 秒"
                fraction = {'query_started': 0, 'search_started': .1, 'search_completed': .25,
                            'download_started': .4, 'clip_ready': .5 + .4 * min(1, count / min(6, max(2, len(target_shots))))}[phase]
                if phase == 'clip_ready' and last_coverage.get('required_seconds',0) > 0:
                    fraction = .5 + .4 * min(1, last_coverage['verified_usable_seconds']/last_coverage['required_seconds'],
                                              count / min(6,len(target_shots)))
                last_progress = max(last_progress, 5 + int(30 * (index + fraction) / max(1, len(specs))))
                self.update(request.project_id, job_id, progress=last_progress,
                            message=f"{labels[phase]}{label}（关键词 {index+1}/{len(specs)}，已校验 {count} 个候选{duration_note}）",
                            stock_progress={'phase': phase, 'source': source if source in effective_sources else '',
                                            'query_index': index + 1, 'queries_total': len(specs), 'clips_ready': count,
                                            'candidate_coverage':last_coverage})
            with stock_progress_context(report_stock_progress):
                raw = search({'output_dir': str(project / 'assets/footage' / job_id / 'stock'),
                              'stock_engine': 'moneyprinterturbo', 'search_concurrency': 2, 'download_concurrency': 2,
                              'queries': [{'query': spec['query'], 'slot_id': ','.join(spec['shot_ids']), 'kind': 'video',
                                           'required_duration_seconds':sum(s['duration_seconds'] for s in target_shots),
                                           'minimum_clips':min(6,len(target_shots)),
                                           'max_clip_duration_seconds':max(s['duration_seconds'] for s in target_shots)}],
                              'sources': effective_sources, 'clips_per_query': min(6, max(2, len(target_shots))), 'extract_thumbnails': True,
                              'exclude_clip_ids': list(dict.fromkeys(c['clip_id'] for c in pool if c.get('clip_id'))),
                              'metadata_groups': query_groups(spec['query'], PLACES),
                              'timeout_seconds': 50, 'skip_existing': True,
                              'filters': {'min_duration': min(s['duration_seconds'] for s in target_shots),
                                          'orientation': {'16:9':'landscape', '9:16':'portrait', '1:1':'square'}[request.options.aspect_ratio]}})
            data = raw.data if hasattr(raw, 'data') else raw.get('data', raw)
            data = data or {}
            if data.get('errors') or data.get('timed_out'):
                warnings.append(f"“{spec['query']}”部分来源超时或不可访问；保留已取得的素材。")
            for failure in data.get('errors') or []:
                if not isinstance(failure, dict) or failure.get('source') not in sources:
                    continue
                safe = {'source': failure['source'], 'query': spec['query'], **clean_source_failure(failure)}
                if failure.get('phase') in {'search', 'download', 'validation'}:
                    safe['phase'] = failure['phase']
                if len(source_errors) < 100:
                    source_errors.append(safe)
                if stop_source_for_run(safe):
                    blocked_sources.add(safe['source'])
                    warnings.append(_stock_failure_summary([safe]) + '；已停止本次任务对该来源的后续请求。')
            if source_errors:
                self.update(request.project_id, job_id, source_errors=source_errors,
                            blocked_sources=sorted(blocked_sources), warnings=list(dict.fromkeys(warnings)))
            for record in data.get('clips', []):
                try:
                    if not candidate_matches_query(record, spec['query']):
                        warnings.append('已排除标题或描述与关键词不符的检索结果；不会用无关画面填满镜头。')
                        continue
                    path = Path(record['path'])
                    path = path if path.is_absolute() else project / path
                    path = local_path(project, rel(project, path))
                    info = probe(path)
                    if not info['has_video'] or info['duration'] <= 0:
                        continue
                    clip = {key: record.get(key) for key in ('clip_id', 'source', 'source_id', 'source_url', 'creator', 'license', 'source_tags', 'title', 'provenance')}
                    clip.update(path=rel(project, path), duration=info['duration'], width=info['width'], height=info['height'],
                                query=spec['query'],
                                shot_ids=spec['shot_ids'], match_kind='illustrative' if spec['kind'] == 'generic' else 'place_candidate',
                                location_verified=False)
                    if record.get('thumbnail'):
                        clip['thumbnail'] = rel(project, Path(record['thumbnail']))
                    pool.append(clip)
                except (ValueError, OSError, KeyError, subprocess.SubprocessError):
                    warnings.append('已跳过一个无法解码的候选素材。')
            pool = deduplicate_records(pool)
            for shot in shots:
                if is_manual(shot) or shot.get('source_locked'):
                    continue
                shot['candidates'] = deduplicate_records([c for c in pool if any(
                    (q['kind'] != 'generic' or request.allow_generic) and candidate_matches_query(c, q['text'])
                    for q in shot['queries'])])
            self.update(request.project_id, job_id, shots=shots, warnings=list(dict.fromkeys(warnings)))
        assignment = assign_automatic(shots, allow_generic=request.allow_generic,
                                      valid=lambda c: _valid_clip(project, c))
        warnings.extend(assignment['warnings'])
        plan['material_assignment'] = assignment
        plan['material_coverage'] = material_coverage(project,shots)
        self.update(request.project_id, job_id, shots=shots, material_assignment=assignment, material_coverage=plan['material_coverage'],
                    warnings=list(dict.fromkeys(warnings)))
        write_json(self.directory(request.project_id, job_id) / 'stock_manifest.json',
                   {'sources': sources, 'clips': pool, 'shots': shots, 'assignment': assignment, 'material_coverage':plan['material_coverage'],
                    'source_errors': source_errors, 'blocked_sources': sorted(blocked_sources),
                    'warnings': list(dict.fromkeys(warnings)), 'created_at': now()})

    def _narrate(self, project, directory, shots, request, event):
        options = request.options
        if options.narration == 'none':
            return None
        if options.narration == 'uploaded':
            if not options.audio_path:
                raise ValueError('请选择已导入的旁白音频')
            path = local_path(project, options.audio_path)
            info = probe(path)
            if not info['has_audio'] or info['duration'] <= 0:
                raise ValueError('旁白文件不包含有效音频')
            total = sum(s['duration_seconds'] for s in shots)
            for shot in shots:
                shot['duration_seconds'] = round(info['duration'] * shot['duration_seconds'] / total, 4)
            return path
        paths = []
        for index, shot in enumerate(shots):
            self._check(event)
            path = directory / f'voice-{index+1}.wav'
            if shot['text'].strip():
                synthesize(shot['text'], options.narration, options.voice, options.voice_rate, path)
                shot['duration_seconds'] = probe(path)['duration']
            else:
                subprocess.run(['ffmpeg', '-v', 'error', '-n', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
                                '-t', str(shot['duration_seconds']), str(path)], check=True, capture_output=True, timeout=30)
            paths.append(path)
            self.update(request.project_id, directory.name, progress=42+int(12*(index+1)/len(shots)),
                        message=f'配音 {index+1}/{len(shots)} 已完成，正在对齐镜头时长')
        if sum(s['duration_seconds'] for s in shots) > 600:
            raise ValueError('实测旁白超过 10 分钟，请精简脚本后再试')
        # Filenames here are generated safe ASCII names, never raw user paths.
        concat = directory / 'narration-concat.txt'
        concat.write_text(''.join(f"file '{p.name}'\n" for p in paths), encoding='utf-8')
        output = directory / 'narration.wav'
        subprocess.run(['ffmpeg', '-v', 'error', '-n', '-f', 'concat', '-safe', '1', '-i', str(concat),
                        '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '1', str(output)],
                       check=True, capture_output=True, timeout=120)
        return output


def synthesize(text: str, mode: str, voice: str, rate: float, output: Path) -> None:
    if output.exists():
        raise ValueError('配音输出已存在，请新建任务')
    output.parent.mkdir(parents=True, exist_ok=True)
    if mode == 'local':
        from tools.audio.macos_say_tts import MacOSSayTTS
        raw = MacOSSayTTS().execute({'text': text, 'voice': voice, 'speaking_rate': rate, 'output_path': str(output)})
        if not raw.success:
            raise ValueError('本机配音不可用，请换一个已安装的音色或导入旁白')
    elif mode == 'edge':
        if not re.fullmatch(r'[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural', voice):
            raise ValueError('请选择在线语音列表中的音色')
        import edge_tts
        async def generate():
            await asyncio.wait_for(edge_tts.Communicate(text, voice, rate=f'{round((rate-1)*100):+d}%').save(str(output.with_suffix('.mp3'))), timeout=120)
        asyncio.run(generate())
        subprocess.run(['ffmpeg', '-v', 'error', '-n', '-i', str(output.with_suffix('.mp3')),
                        '-ar', '44100', '-ac', '1', '-c:a', 'pcm_s16le', str(output)],
                       capture_output=True, check=True, timeout=120)
    else:
        raise ValueError('不支持的配音方式')
    info = probe(output)
    if not info['has_audio'] or info['duration'] <= 0:
        raise ValueError('没有取得可播放的配音')
