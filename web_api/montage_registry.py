"""Native tool contracts for the web workbench, without inventing a second registry.

Every concrete provider and selector is discovered from OpenMontage itself.
The web layer adds project isolation and explicit side-effect permissions; it
does not replace native implementations or make unavailable tools look ready.
"""
from __future__ import annotations

import copy
import ipaddress
import json
import math
import os
import platform
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import jsonschema
from pydantic import Field, field_validator

from lib.pipeline_loader import list_pipelines, load_pipeline_readonly
from tools.tool_registry import registry
from web_api.media_pipeline import PROJECT_ID_PATTERN
from web_api.montage_composition import ClosedModel, resolve_project, safe_destination

ROOT = Path(__file__).resolve().parents[1]
CAPABILITY_LABELS = {
    'analysis': '视频与声音分析', 'transcription': '语音转录', 'tts': '旁白配音',
    'music': '配乐', 'music_generation': '音乐生成', 'composition': '合成与动画',
    'video_generation': '视频生成', 'image_generation': '图片生成',
    'character_animation': '角色动画', '3d_world': '三维世界',
    '3d_asset_generation': '三维资产', 'enhancement': '画质与声音增强',
    'screen_capture': '屏幕录制', 'publishing': '本机交付',
    'stock_video': '真实素材', 'stock_image': '图片素材',
    '3d_asset_acquisition': '三维素材获取', '3d_world_generation': '三维世界生成',
    '3d_world_rendering': '三维渲染', 'audio_processing': '声音处理', 'avatar': '数字人',
    'clip_acquisition': '素材搜集', 'clip_highlights': '精彩片段', 'clip_retrieval': '语义素材检索',
    'corpus_population': '语义素材库', 'graphics': '图形与图解', 'music_library': '本机音乐库',
    'music_search': '音乐搜索', 'publish': '交付与发布', 'source_ingest': '参考视频导入',
    'subtitle': '字幕', 'video_post': '剪辑与后期',
}
PIPELINE_LABELS = {
    'animated-explainer': '动画解说', 'animation': '动画短片',
    'avatar-spokesperson': '数字人讲解', 'character-animation': '角色动画',
    'cinematic': '电影感短片', 'clip-factory': '长视频拆条',
    'documentary-montage': '真实素材纪录片', 'hybrid': '实拍与生成混合',
    'localization-dub': '翻译与配音', 'podcast-repurpose': '播客剪辑',
    'screen-demo': '产品与操作演示', 'talking-head': '口播剪辑',
}
LABELS = {
    'audio_probe': '声音信息检测', 'audio_energy': '声音节奏分析',
    'frame_sampler': '视频抽帧', 'scene_detect': '镜头切分', 'transcriber': '本地语音识别',
    'video_analyzer': '参考视频分析', 'visual_qa': '画面技术检查',
    'composition_validator': '合成工程检查', 'video_understand': '视频语义理解',
    'video_downloader': '下载参考视频', 'transcript_fetcher': '读取公开视频字幕',
    'character_spec_generator': '角色设定', 'svg_rig_builder': '角色骨架',
    'pose_library_builder': '动作姿态库', 'action_timeline_compiler': '角色动作时间线',
    'character_rig_renderer': '角色动画渲染', 'character_animation_reviewer': '角色动画检查',
    'blender_world': 'Blender 世界与镜头', 'threejs_world': '可编辑三维世界',
    'threejs_asset_catalog': '三维素材库', 'corpus_builder': '语义素材建库',
    'clip_search': '按画面含义找素材', 'direct_clip_search': '公开素材搜索',
    'green_screen_processor': '绿幕抠像', 'green_screen_composite': '人物与背景合成',
    'remotion_caption_burn': '逐词动态字幕', 'showcase_card': '作品展示卡',
    'code_snippet': '代码图像', 'diagram_gen': '流程图与图解', 'math_animate': 'Manim 动画',
    'video_stitch': '视频拼接', 'video_trimmer': '视频裁剪与变速',
    'video_compose': '原生视频合成', 'hyperframes_compose': 'HyperFrames 动画工程',
    'audio_mixer': '混音与音乐适配', 'audio_enhance': '声音增强',
    'subtitle_gen': '字幕制作', 'export_bundle': '交付包',
    'music_library': '本机音乐库', 'screen_recorder': '录制屏幕', 'cap_recorder': 'Cap 录制素材',
    'bg_remove': '图片抠图', 'color_grade': '调色', 'auto_reframe': '自动重构画幅',
    'silence_cutter': '去静音与节奏整理', 'footage_auto_edit': '真实素材自动成片',
    'face_tracker': '人脸追踪', 'eye_enhance': '眼部增强', 'upscale': '超分辨率',
    'face_restore': '人脸修复', 'face_enhance': '人像增强',
    'highlight_selector': '长视频候选片段推荐',
    'corpus_importer': '本机素材语义建库',
    'local_music': '本机器乐配乐（免费）',
    'transcript_aligner': '中文精细字幕对齐',
    'tts_selector': '选择旁白服务', 'image_selector': '选择生图服务',
    'video_selector': '选择视频服务', 'screen_capture_selector': '选择屏幕录制方式',
}
SELECTORS = frozenset({'tts_selector', 'image_selector', 'video_selector', 'screen_capture_selector'})
OUTPUT_KEYS = frozenset({'output_path', 'output_dir', 'export_dir', 'metadata_path',
                         'video_output_path', 'blend_path'})
PATH_KEYS = frozenset({'path', 'src', 'source', 'file', 'clips', 'image', 'images',
                      'assets_root', 'library_dir', 'corpus_dir', 'workspace_path', 'asset_catalog_paths'})
CODE_KEYS = frozenset({'scene_code', 'code', 'scene_source', 'custom_af', 'extra_args'})
SECRET_KEYS = frozenset({'api_key', 'password', 'access_token', 'secret_key', 'authorization'})
FREE_NETWORK_TOOLS = frozenset({'pexels_video', 'pexels_image', 'pixabay_video', 'pixabay_image',
    'unsplash_image', 'freesound', 'direct_clip_search', 'corpus_builder', 'video_downloader',
    'transcript_fetcher', 'threejs_asset_catalog', 'edge_tts'})


def blender_cpu_default():
    # Blender is installed here, but Intel macOS Metal cannot initialize the
    # native Eevee path. Prefer the actually verified Cycles CPU renderer.
    return platform.system() == 'Darwin' and platform.machine() == 'x86_64'


def pin_provider(tool, inputs):
    """Native selectors may rank freely, but generation stays on one provider."""
    if tool.name not in SELECTORS or inputs.get('operation') == 'rank':
        return tool, inputs
    preferred = inputs.get('preferred_provider')
    if not preferred or preferred == 'auto':
        raise ValueError('请指定具体提供者，网页不会自动更换服务')
    providers = [t for t in tool._providers() if preferred in {t.name, t.provider}]
    if len(providers) != 1:
        raise ValueError('请填写一个具体工具名，避免提供者对应多个工具')
    inputs = copy.deepcopy(inputs)
    inputs['allowed_providers'] = [providers[0].name]
    return providers[0], inputs


class NativeToolRequest(ClosedModel):
    project_id: str = Field(min_length=1, max_length=128)
    tool: str = Field(pattern=r'^[a-z][a-z0-9_]{0,79}$')
    inputs: dict[str, Any] = Field(default_factory=dict)
    confirm: bool = False
    allow_network: bool = False
    allow_paid: bool = False
    allow_capture: bool = False
    allow_code: bool = False
    max_cost_usd: float = Field(default=0, ge=0, le=1000)
    timeout_seconds: int = Field(default=900, ge=10, le=3600)

    @field_validator('project_id')
    @classmethod
    def project_name(cls, value):
        if not PROJECT_ID_PATTERN.fullmatch(value):
            raise ValueError('项目编号无效')
        return value


def native_tool(name: str):
    registry.ensure_discovered()
    tool = registry.get(name)
    if tool is None:
        raise ValueError('没有这个 OpenMontage 工具')
    return tool


def native_inputs(tool, inputs):
    values = copy.deepcopy(inputs)
    if tool.name == 'corpus_builder':
        # The worker always builds a new library in this run's outputs.
        values.setdefault('corpus_dir', 'corpus')
    return values


def redact(value: Any) -> Any:
    """Never persist provider credentials or exception bodies containing them."""
    secrets = [v for k, v in os.environ.items()
               if any(s in k.upper() for s in ('KEY', 'TOKEN', 'SECRET', 'PASSWORD')) and len(v) >= 8]
    def clean(item):
        if isinstance(item, dict):
            return {k: clean(v) for k, v in item.items() if str(k).lower() not in SECRET_KEYS}
        if isinstance(item, (tuple, list)):
            return [clean(v) for v in item]
        if isinstance(item, str):
            for secret in secrets:
                item = item.replace(secret, '[credential omitted]')
            return item
        return item
    return clean(value)


def effects(tool, inputs: dict) -> dict:
    if tool.name in SELECTORS:
        if inputs.get('operation') == 'rank':
            return dict(network=False, paid=False, capture=False, code=False, gpu=False)
        if inputs.get('preferred_provider') and inputs['preferred_provider'] != 'auto':
            actual, _ = pin_provider(tool, inputs)
            return effects(actual, inputs)
    runtime = str(getattr(tool.runtime, 'value', tool.runtime))
    network = runtime in {'api', 'hybrid'} or bool(tool.resource_profile.network_required)
    # These native tools access archives/CDNs or can download model weights.
    network |= tool.name in {'corpus_builder', 'direct_clip_search', 'video_downloader',
                            'transcript_fetcher', 'threejs_asset_catalog'}
    # Generated templates stage their animation script locally. Arbitrary
    # authored HTML can still load external resources when opened in Chrome;
    # keep those operations gated, along with explicit registry operations.
    network |= tool.name == 'hyperframes_compose' and inputs.get('operation') in {
        'doctor', 'add_block', 'render_existing', 'check', 'inspect', 'validate'}
    capture = tool.name in {'screen_recorder', 'cap_recorder', 'screen_capture_selector'}
    code = any(k in inputs and inputs[k] for k in CODE_KEYS)
    code |= tool.name in {'hyperframes_compose', 'character_rig_renderer', 'video_compose'}
    def urls(item):
        if isinstance(item, dict): return any(urls(v) for v in item.values())
        if isinstance(item, list): return any(urls(v) for v in item)
        return isinstance(item, str) and item.startswith(('http://', 'https://'))
    network |= urls(inputs)
    return {'network': bool(network), 'paid': runtime in {'api', 'hybrid'} and tool.name not in FREE_NETWORK_TOOLS,
            'capture': capture, 'code': bool(code), 'gpu': runtime == 'local_gpu'}


def tool_catalog() -> dict:
    registry.ensure_discovered()
    rows = []
    for name in sorted(registry.list_all()):
        tool = registry.get(name)
        try:
            status = tool.get_status().value
        except Exception:
            status = 'unavailable'
        schema = copy.deepcopy(tool.input_schema)
        props = schema.get('properties', {})
        readiness = None
        if name in {'corpus_builder','direct_clip_search'}:
            from lib.stock_readiness import stock_readiness
            readiness = stock_readiness(needs_embedding=name == 'corpus_builder')
            status = readiness['state']
        if name == 'corpus_builder':
            props.pop('corpus_dir', None)
            schema['required'] = [key for key in schema.get('required', []) if key != 'corpus_dir']
        if name == 'direct_clip_search':
            props['unique_across_queries']['default'] = True
        if name == 'piper_tts' and os.environ.get('PIPER_MODEL') and 'model' in props:
            props['model']['default'] = Path(os.environ['PIPER_MODEL']).stem
        if name == 'blender_world' and blender_cpu_default():
            props['render_engine']['default'] = 'CYCLES'
            props['cpu_render']['default'] = True
        # Never expose a way to disable the native Manim safety scanner.
        props.pop('allow_unsafe_code', None)
        rows.append({'name': name, 'label': LABELS.get(name, name.replace('_', ' ')),
                     'capability': tool.capability,
                     'group': CAPABILITY_LABELS.get(tool.capability, tool.capability.replace('_', ' ')),
                     'provider': tool.provider, 'status': status,
                     'runtime': getattr(tool.runtime, 'value', tool.runtime),
                     'selector': name in SELECTORS, 'input_schema': schema,
                     'dependencies': list(tool.dependencies), 'effects': effects(tool, {}),
                     'setup_hint': str(tool.install_instructions or ''),
                     'readiness': readiness,
                     'best_for': list(tool.best_for), 'agent_skills': list(tool.agent_skills),
                     'entry': '/footage' if name == 'footage_auto_edit' else 'native_tool',
                     'implementation': tool.__class__.__module__})
    return {'status': 'ready', 'tool_count': len(rows), 'tools': redact(rows),
            'note': '依赖就绪不代表账号、模型权重或作品质量已验收。原始输入不被覆盖。'}


def pipeline_catalog() -> dict:
    rows = []
    for name in sorted(list_pipelines()):
        if name == 'framework-smoke':
            continue
        manifest = load_pipeline_readonly(name)
        rows.append({'id': name, 'label': PIPELINE_LABELS.get(name, name),
                     'description': manifest.get('description', '').strip(),
                     'stages': [{'name': s['name'], 'produces': s.get('produces', []),
                                 'tools': s.get('tools_available', []),
                                 'human_approval': bool(s.get('human_approval_default'))}
                                for s in manifest['stages']]})
    return {'pipelines': rows, 'production_pipeline_count': len(rows)}


def validate_inputs(tool, inputs: dict) -> dict:
    if len(json.dumps(inputs, ensure_ascii=False, allow_nan=False)) > 250_000:
        raise ValueError('参数过大，请使用项目内工程文件')
    schema = copy.deepcopy(tool.input_schema)
    props = schema.get('properties', {})
    unknown = set(inputs) - set(props)
    if unknown:
        raise ValueError('不支持的参数：' + ', '.join(sorted(unknown)))
    if inputs.get('allow_unsafe_code'):
        raise ValueError('网页不能关闭原生代码安全检查')
    if inputs.get('callback_url'):
        raise ValueError('网页任务使用本机记录，不接受外部回调地址')
    try:
        jsonschema.validate(inputs, schema)
    except jsonschema.ValidationError as exc:
        location = '.'.join(map(str, exc.path)) or '输入'
        # Do not include invalid values or verbose schemas in the response.
        raise ValueError(f'{location} 不符合 {exc.validator} 参数要求') from None
    _, pinned = pin_provider(tool, inputs)
    return copy.deepcopy(pinned)


def _public_url(value: str) -> None:
    uri = urlsplit(value)
    if uri.scheme not in {'http', 'https'} or not uri.hostname or uri.username or uri.password:
        raise ValueError('素材网址必须是没有账号密码的 HTTP(S) 地址')
    if uri.hostname.lower() == 'localhost':
        raise ValueError('素材网址不能指向本机内部服务')
    try:
        if not ipaddress.ip_address(uri.hostname).is_global:
            raise ValueError('素材网址不能指向局域网或内部服务')
    except ValueError as exc:
        if '素材' in str(exc): raise


def path_inputs(project: Path, inputs: dict, output: Path, *, resolve=True) -> dict:
    """Resolve nested native paths and redirect *every* output to a new run.

    Caller-owned output paths are only filename suggestions. Existing corpus
    directories are read-only inputs to search; corpus building gets a fresh
    destination. Existing HTML packages are copied before tools can modify them.
    """
    def walk(item, key='', parent=''):
        if isinstance(item, dict):
            if any(str(k).lower() in SECRET_KEYS for k in item):
                raise ValueError('密钥只由服务端认证管理，不放入工具参数')
            return {k: walk(v, k, key) for k, v in item.items()}
        if isinstance(item, list):
            return [walk(v, key, parent) for v in item]
        if not isinstance(item, str) or not item:
            return item
        if item.startswith(('http://', 'https://')):
            _public_url(item)
            return item
        if key in OUTPUT_KEYS:
            filename = Path(item).name
            if filename in {'', '.', '..'}:
                raise ValueError('输出文件名无效')
            return str(output / key / filename) if resolve else f'<new-run>/{key}/{filename}'
        if key == 'source' and parent in {'cuts', 'metadata'}:
            return item  # Asset ids and provenance labels are not filesystem paths.
        is_path = key.endswith(('_path', '_dir', '_paths')) or key in PATH_KEYS
        if not is_path:
            return item
        if key == 'source' and '\n' in item:
            raise ValueError('source 必须是项目内文件')
        path = Path(item)
        if path.is_absolute() or '..' in path.parts or item.startswith(('file:', 'data:', 'javascript:')):
            raise ValueError(f'{key} 只接受当前项目内相对路径')
        resolved = safe_destination(project, item)
        if not resolved.exists():
            raise ValueError(f'{key} 指向的项目文件不存在')
        # Secrets are not source media or authoring assets.
        if any(part.startswith('.') for part in path.parts) or path.suffix.lower() in {'.key', '.pem'}:
            raise ValueError('不读取隐藏文件或认证文件')
        return str(resolved) if resolve else item
    return walk(inputs)


def preflight_tool(request: NativeToolRequest, project_root: Path) -> dict:
    project = resolve_project(project_root, request.project_id)
    tool = native_tool(request.tool)
    inputs = validate_inputs(tool, native_inputs(tool, request.inputs))
    if request.tool == 'footage_auto_edit':
        return {'status': 'existing_workflow', 'can_execute': False,
                'url': f'/footage?project={request.project_id}', 'message': '请在真实素材成片中使用已接通的任务队列。'}
    path_values = {k: v for k, v in inputs.items() if not (request.tool == 'corpus_builder' and k == 'corpus_dir')}
    path_inputs(project, path_values, project / 'analysis/montage/<new-run>', resolve=False)
    provider_tool, inputs = pin_provider(tool, inputs)
    permissions = effects(tool, inputs)
    requirements = []
    if provider_tool.get_status().value == 'unavailable':
        if tool.name in {'corpus_builder','direct_clip_search'}:
            from lib.stock_readiness import stock_readiness
            requirements.extend(stock_readiness(needs_embedding=tool.name == 'corpus_builder')['requirements'])
        else:
            hint = str(provider_tool.install_instructions or '')
            requirements.append('原生运行环境或服务配置未就绪' + ('：' + hint if hint else '；请检查所选提供者的认证、权重与运行时'))
    check_inputs = getattr(provider_tool, 'input_requirements', None)
    if callable(check_inputs):
        requirements.extend(check_inputs(inputs))
    if permissions['network'] and not request.allow_network:
        requirements.append('需要确认联网与所选素材/文字的外部传输')
    if permissions['paid'] and (not request.allow_paid or request.max_cost_usd <= 0):
        requirements.append('需要指定本次服务费用上限并确认付费调用')
    if permissions['capture'] and not request.allow_capture:
        requirements.append('需要确认本次录屏或读取屏幕录制素材')
    if permissions['code'] and not request.allow_code:
        requirements.append('需要确认渲染所选代码或本地动画工程')
    # Estimation is native, never fabricated. Unknown native prices are explicit.
    try:
        estimate = float(provider_tool.estimate_cost(inputs))
    except Exception:
        estimate = None
    if estimate is not None and not math.isfinite(estimate): estimate = None
    if permissions['paid'] and estimate and estimate > request.max_cost_usd:
        requirements.append('原生估算超出本次费用上限')
    if permissions['paid'] and (estimate is None or estimate <= 0):
        requirements.append('提供者尚无可核验估价；不能在未知费用下自动提交')
    return {'status': 'ready' if not requirements else 'needs_setup', 'can_execute': not requirements,
            'tool': tool.name, 'provider': provider_tool.provider, 'provider_tool': provider_tool.name, 'effects': permissions,
            'estimated_cost_usd': estimate, 'price_known': bool(estimate) or not permissions['paid'],
            'requirements': requirements, 'would_write': False,
            'output': 'analysis/montage/tools/<new-run>/outputs/',
            'message': '预检未运行工具、写入文件或联系外部服务。'}
