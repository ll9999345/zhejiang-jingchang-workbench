"""Provider inventory. Importing this module never imports upstream services or keys."""
from __future__ import annotations
import importlib.util
import ast
from functools import lru_cache
import json
import os
from pathlib import Path
import sys
import ipaddress
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
UPSTREAM = Path(__file__).resolve().parent / 'upstream'
PYTHON = ROOT / '.runtime/mpt-python/bin/python'


def whisper_model():
    paths = [Path(os.environ['MPT_WHISPER_MODEL_PATH'])] if os.getenv('MPT_WHISPER_MODEL_PATH') else [ROOT / f'.runtime/models/whisper-{name}' for name in ('small', 'base')]
    return next((str(p.resolve()) for p in paths if (p/'model.bin').is_file() and (p/'tokenizer.json').is_file()), '')


def llm_specs():
    name = '_mpt_llm_registry'
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, UPSTREAM / 'app/models/llm_provider.py')
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return sys.modules[name].LLM_PROVIDER_REGISTRY


# Values are environment variable NAMES, never credentials. Section variables
# map to config.<section>; app variables retain upstream spelling.
PROVIDERS = {
    'tts': {
        'edge': ('Edge 免费在线语音', [], 'zh-CN-XiaoxiaoNeural-Female'),
        'azure': ('Azure 语音', ['MPT_AZURE__SPEECH_KEY', 'MPT_AZURE__SPEECH_REGION'], 'zh-CN-XiaoxiaoNeural-V2'),
        'siliconflow': ('SiliconFlow', ['MPT_SILICONFLOW__API_KEY'], 'siliconflow:FunAudioLLM/CosyVoice2-0.5B:alex'),
        'gemini': ('Gemini TTS', ['MPT_GEMINI_API_KEY'], 'gemini:Kore'),
        'mimo': ('MiMo TTS', ['MPT_MIMO_API_KEY'], 'mimo:mimo_default'),
        'minimax': ('MiniMax TTS', ['MPT_MINIMAX_TTS__API_KEY'], 'minimax:Chinese_Female_News_Anchor'),
        'elevenlabs': ('ElevenLabs 语音（可选）', ['MPT_ELEVENLABS__API_KEY'], ''),
        'chatterbox': ('Chatterbox 服务', ['MPT_CHATTERBOX__BASE_URL'], 'chatterbox:default'),
        'kokoro': ('Kokoro 服务', ['MPT_KOKORO__BASE_URL'], 'kokoro:af_heart'),
        'fish': ('Fish Audio', ['MPT_FISH_AUDIO__API_KEY'], 'fish_audio:default'),
        'voxcpm': ('VoxCPM', ['MPT_VOXCPM__API_KEY', 'MPT_VOXCPM__MODEL_ID'], 'voxcpm:default'),
    },
    'image': {'openai_image': ('OpenAI 兼容生图', ['MPT_OPENAI_IMAGE_API_KEYS', 'MPT_OPENAI_IMAGE_BASE_URL', 'MPT_OPENAI_IMAGE_MODEL'], '')},
    'video': {
        'wavespeed': ('WaveSpeed', ['MPT_WAVESPEED_API_KEYS'], ''),
        'volcengine_seedance': ('火山 Seedance', ['MPT_VOLCENGINE_SEEDANCE_API_KEY'], ''),
        'ofox': ('OFox', ['MPT_OFOX_API_KEY'], ''),
        'muapi': ('MuAPI', ['MPT_MUAPI_API_KEY'], ''),
        'metaso_minimax': ('Metaso MiniMax H3', ['MPT_METASO_MINIMAX_API_KEY'], ''),
    },
    'music': {
        'sonilo': ('Sonilo 按视频配乐', ['MPT_SONILO_API_KEY'], ''),
        'elevenlabs': ('ElevenLabs Music（可选）', ['MPT_ELEVENLABS__API_KEY'], ''),
    },
    'edit': {'moviepy': ('MPT 高级剪辑（本机）', [], '')},
    'transcribe': {'whisper': ('Whisper 逐词字幕（本机）', ['MPT_WHISPER_MODEL_PATH'], '')},
    'analyze': {'twelvelabs': ('TwelveLabs 画面理解', ['MPT_TWELVELABS_API_KEYS'], '')},
    'publish': {'upload_post': ('Upload-Post 多平台发布', ['MPT_UPLOAD_POST_API_KEY', 'MPT_UPLOAD_POST_USERNAME'], '')},
    'loomloom_quote': {'loomloom': ('LoomLoom 批量视频报价', ['MPT_LOOMLOOM_API_TOKEN'], '')},
    'loomloom_execute': {'loomloom': ('LoomLoom 按已确认报价执行', ['MPT_LOOMLOOM_API_TOKEN'], '')},
}

# Keep the request's model choice aligned with the configuration field the
# pinned service actually consumes. MuAPI uses a configured endpoint; Metaso H3
# has a fixed model. Neither accepts a generic model override.
MODEL_CONFIG_KEYS = {
    ('image', 'openai_image'): 'openai_image_model',
    ('video', 'wavespeed'): 'wavespeed_text_to_video_model',
    ('video', 'volcengine_seedance'): 'volcengine_seedance_model',
    ('video', 'ofox'): 'ofox_text_to_video_model',
    ('analyze', 'twelvelabs'): 'twelvelabs_pegasus_model',
    ('rerank', 'twelvelabs'): 'twelvelabs_marengo_model',
}


def model_config_key(operation, provider):
    if operation in ('script', 'terms', 'social', 'connection'):
        return f'{provider}_model_name'
    return MODEL_CONFIG_KEYS.get((operation, provider), '')


def supports_model(operation, provider):
    return bool(model_config_key(operation, provider)) or operation.startswith('loomloom_') and not operation.startswith('loomloom_script')


def loopback_provider(operation, provider):
    """Classify only explicitly configured local endpoints, never a cloud CLI."""
    if operation in ('script', 'terms', 'social', 'connection') and provider == 'ollama':
        value = os.getenv('MPT_OLLAMA_BASE_URL', '')
    elif operation == 'tts' and provider in ('chatterbox', 'kokoro'):
        value = os.getenv(f'MPT_{provider.upper()}__BASE_URL', '')
    else:
        return False
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in ('http', 'https') or parsed.username or parsed.password:
            return False
        return parsed.hostname == 'localhost' or ipaddress.ip_address(parsed.hostname or '').is_loopback
    except ValueError:
        return False


@lru_cache(maxsize=1)
def voice_presets():
    """Read only pinned literals/data; never import a service or query accounts."""
    tree = ast.parse((UPSTREAM / 'app/services/voice.py').read_text(encoding='utf-8'))
    def literal(variable, function=None):
        body = tree.body if function is None else next(node.body for node in tree.body
            if isinstance(node, ast.FunctionDef) and node.name == function)
        for node in body:
            if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == variable for target in node.targets):
                return ast.literal_eval(node.value)
        raise ValueError('pinned voice preset literal changed')
    gender = {'Female': '女声', 'Male': '男声'}
    names = {'Xiaoxiao': '晓晓', 'Xiaoyi': '晓伊', 'Yunjian': '云健', 'Yunxi': '云希',
        'Yunxia': '云夏', 'Yunyang': '云扬', 'HiuGaai': '晓佳', 'HiuMaan': '晓曼',
        'WanLung': '云龙', 'HsiaoChen': '晓臻', 'HsiaoYu': '晓雨', 'YunJhe': '云哲'}
    rows = json.loads((UPSTREAM / 'app/services/data/azure_voices.json').read_text(encoding='utf-8'))
    presets = {provider: [] for provider in PROVIDERS['tts']}
    for row in sorted(rows, key=lambda row: (not row['name'].startswith('zh-'), row['name'])):
        name = row['name']; short = name.split('-')[-1].replace('Neural', '')
        label = f"{names.get(short, short)} · {'-'.join(name.split('-')[:2])} · {gender.get(row['gender'], row['gender'])}"
        if not name.endswith('-V2'):
            presets['edge'].append({'id': f"{name}-{row['gender']}", 'label': label})
        presets['azure'].append({'id': name if name.endswith('-V2') else name + '-V2', 'label': label})
    for model, name, sex in literal('voices_with_gender', 'get_siliconflow_voices'):
        presets['siliconflow'].append({'id': f'siliconflow:{model}:{name}-{sex}', 'label': f'{name} · CosyVoice2 · {gender[sex]}'})
    styles = {'Bright':'明亮','Upbeat':'轻快','Informative':'清晰讲解','Firm':'坚定','Excitable':'活泼',
        'Youthful':'年轻','Breezy':'轻柔','Soft':'柔和','Warm':'温暖','Friendly':'亲切','Smooth':'流畅',
        'Clear':'清楚','Casual':'自然','Gentle':'温和','Even':'平稳','Mature':'成熟','Lively':'生动'}
    presets['gemini'] = [{'id': f'gemini:{name}-{style}', 'label': f'{name} · {styles.get(style, style)}'}
        for name, style in literal('GEMINI_TTS_VOICES')]
    presets['mimo'] = [{'id': f'mimo:{name}-{sex}', 'label': f"{'MiMo 默认' if name == 'mimo_default' else name} · {gender[sex]}"}
        for name, sex in literal('voices_with_gender', 'get_mimo_voices')]
    presets['fish'] = [{'id': value, 'label': label} for value, label in zip(literal('result', 'get_fish_audio_voices'), ('清晰女声', '清晰男声', '服务默认音色'))]
    for provider, label in (('minimax','中文新闻女声'), ('chatterbox','服务默认音色'),
                           ('kokoro','Heart · 内置默认'), ('voxcpm','默认 · 可使用参考音频')):
        presets[provider] = [{'id': PROVIDERS['tts'][provider][2], 'label': label}]
    presets['minimax'].append({'id': 'minimax:' + literal('MINIMAX_TTS_DEFAULT_VOICE'), 'label': '英语表现力旁白'})
    # ElevenLabs lists account-specific favorites via GET. No guessed IDs and
    # no implicit account request belong in a local catalog.
    return presets


OPERATIONS = {
    'script': '生成 / 改写脚本', 'terms': '按脚本生成搜索词', 'social': '生成标题与发布文案',
    'connection': '测试文本模型连接（一次最小请求）',
    'tts': '多服务配音', 'image': 'AI 图片素材', 'video': 'AI 视频素材',
    'music': '按视频生成配乐', 'edit': '高级剪辑与动态字幕', 'transcribe': '音频识别与逐词字幕',
    'analyze': '理解公开素材画面', 'publish': '发布到指定账号',
    'loomloom_quote': 'LoomLoom 视频报价', 'loomloom_execute': 'LoomLoom 视频执行',
    'loomloom_script_quote': 'LoomLoom 文案报价', 'loomloom_script_execute': 'LoomLoom 文案执行',
    'publish_status': '查询发布结果', 'rerank': '语义排序搜索词',
}


def provider_rows(operation):
    requested_operation = operation
    operation = {'publish_status':'publish', 'rerank':'analyze', 'loomloom_script_quote':'loomloom_quote', 'loomloom_script_execute':'loomloom_execute'}.get(operation,operation)
    if operation in ('script', 'terms', 'social', 'connection'):
        rows = []
        for spec in llm_specs():
            required = []
            if spec.requires_api_key:
                required.append(f'MPT_{spec.provider_id.upper()}_API_KEY')
            if spec.requires_model_name and not spec.default_model:
                required.append(f'MPT_{spec.provider_id.upper()}_MODEL_NAME')
            if spec.requires_base_url and not spec.effective_default_base_url:
                required.append(f'MPT_{spec.provider_id.upper()}_BASE_URL')
            required.extend(f'MPT_{spec.provider_id.upper()}_{f.config_suffix.upper()}' for f in spec.extra_fields if f.required)
            # A local installation/endpoint must be explicitly selected, too.
            if spec.provider_id in ('ollama', 'claude_code'):
                required.append('MPT_LOCAL_LLM_ENABLED')
            if spec.provider_id == 'litellm':
                required.append('MPT_LITELLM_ENABLED')
            rows.append((spec.provider_id, spec.default_label, required, spec.default_model))
    else:
        rows = [(key, *value) for key, value in PROVIDERS.get(operation, {}).items()]
    ready = lambda k: bool(whisper_model()) if k == 'MPT_WHISPER_MODEL_PATH' else bool(os.getenv(k))
    return [dict(id=key, label=label, required_env=env, missing=[k for k in env if not ready(k)],
                 configured=all(ready(k) for k in env), default=default,
                 local=loopback_provider(requested_operation, key) or requested_operation in ('edit', 'transcribe'),
                 supports_model=supports_model(requested_operation, key),
                 supports_voice_rate=requested_operation == 'tts' and key not in ('gemini','mimo','elevenlabs','voxcpm'),
                 supports_voice_volume=requested_operation in ('tts','edit'),
                 voices=[dict(voice) for voice in voice_presets()[key]] if requested_operation == 'tts' else [])
            for key, label, env, default in rows]


def catalog():
    return {'runtime_installed': PYTHON.is_file(), 'version': '1.3.7',
            'commit': 'e0c9cb77ffd0226a789441420190f80a125c20c4',
            'operations': [dict(id=op, label=label, providers=provider_rows(op),
                                local=op in ('edit', 'transcribe')) for op, label in OPERATIONS.items()],
            'notice': '已安装适配器不代表已开通服务。预检不发起模型请求；账号、费用和对外上传须逐次确认。'}
