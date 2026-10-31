"""Offline Chinese forced alignment using pinned, original WhisperX code.

Alignment uses supplied text, not text-length timing or new speech recognition.
No implicit downloads, diarization or approximate fallback are allowed.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

from tools.base_tool import BaseTool, ToolResult, ToolStatus, ToolTier, ToolStability, ResourceProfile
from tools import local_ml_runtime

ROOT = Path(__file__).resolve().parents[2]
WHISPERX_REV = '771b4a14a9486f8fd5aef18ef49e35d639523dd3'
MODEL_REV = '99ccb2737be22b8bb50dcfcc39ad4d567fb90cfd'
VENDOR = ROOT / '.runtime/vendor' / f'WhisperX-{WHISPERX_REV}'
MODEL = ROOT / '.runtime/models/whisperx-align-zh-20261001'
LIMITATIONS = [
    '对齐已给定的文本，不纠正识别错字；文字须与实际配音一致。',
    '中文按汉字定位，不等于中文分词；数字、符号、外语可能无法直接对齐。',
    '对齐分数是模型匹配分数，不是准确率；字幕与听感仍需人工核对。',
    '本机 CPU 每段最多 30 秒；长录音须先提供有时间段的 JSON/SRT/VTT。',
    '此功能不区分说话人，没有调用付费服务或上传媒体。',
]


def alignment_ready():
    required = [MODEL / name for name in ('model.safetensors', 'config.json', 'vocab.json', 'preprocessor_config.json')]
    required += [VENDOR / 'whisperx' / name for name in ('alignment.py', 'audio.py', 'utils.py', 'schema.py', 'log_utils.py')]
    required += [ROOT / '.runtime/nltk_data/tokenizers/punkt_tab/english' / name for name in (
        'abbrev_types.txt', 'collocations.tab', 'ortho_context.tab', 'sent_starters.txt')]
    return all(p.is_file() for p in required) and local_ml_runtime.runtime_ready('alignment')


def _number(value):
    if isinstance(value, bool):
        raise ValueError('时间须为有效秒数')
    try:
        value = float(value)
    except (ValueError, TypeError):
        raise ValueError('时间须为有效秒数') from None
    if not math.isfinite(value):
        raise ValueError('时间须为有限秒数')
    return value


def probe_audio(path):
    response = subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-show_format',
        '-of', 'json', str(path)], capture_output=True, text=True, check=True, timeout=20)
    payload = json.loads(response.stdout)
    audio = [s for s in payload.get('streams', []) if s.get('codec_type') == 'audio']
    if not audio:
        raise ValueError('媒体没有可解码音轨，无法对齐字幕')
    duration = _number(payload.get('format', {}).get('duration') or audio[0].get('duration'))
    if duration <= 0:
        raise ValueError('音轨没有有效时长')
    return duration


def read_segments(inputs, duration):
    path = inputs.get('transcript_path')
    text = inputs.get('text', '').strip()
    supplied = inputs.get('segments')
    if sum(bool(x) for x in (path, text, supplied)) != 1:
        raise ValueError('请提供字幕文件、已确认文字或分段列表中的一种')
    if path:
        source = Path(path)
        if not source.is_file() or source.stat().st_size > 2_000_000:
            raise ValueError('字幕文件不存在或超过 2 MB')
        content = source.read_text(encoding='utf-8-sig')
        if source.suffix.lower() == '.json':
            payload = json.loads(content)
            supplied = payload.get('segments') if isinstance(payload, dict) else payload
        elif source.suffix.lower() in {'.srt', '.vtt'}:
            supplied = []
            for block in re.split(r'\n\s*\n', content.replace('\r\n', '\n').strip()):
                lines = block.splitlines()
                for index, line in enumerate(lines):
                    match = re.fullmatch(r'\s*((?:\d{1,3}:)?\d{2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d{1,3}:)?\d{2}:\d{2}[.,]\d{3})(?:\s+.*)?', line)
                    if match:
                        def seconds(value):
                            parts = value.replace(',', '.').split(':')
                            return sum(float(part) * 60**power for power, part in enumerate(reversed(parts)))
                        supplied.append({'start': seconds(match[1]), 'end': seconds(match[2]),
                                         'text': re.sub(r'<[^>]*>', '', ' '.join(lines[index+1:])).strip()})
                        break
        else:
            raise ValueError('字幕文件须为 JSON、SRT 或 VTT')
    elif text:
        supplied = [{'start': 0, 'end': duration, 'text': text}]
    if not isinstance(supplied, list) or not supplied or len(supplied) > 300:
        raise ValueError('没有有效字幕段，或字幕段超过 300 个')
    segments = []
    previous_end = 0
    for row in supplied:
        if not isinstance(row, dict):
            raise ValueError('字幕段须为对象')
        start, end = _number(row.get('start')), _number(row.get('end'))
        content = str(row.get('text') or '').strip()
        if not content or len(content) > 1000 or start < previous_end - .001 or end <= start or end > duration + .05:
            raise ValueError('字幕段有空文字、重叠、超出音轨或无效时间')
        if end-start > 30.05:
            raise ValueError('单段超过 30 秒，请先转录或提供分段时间；没有按字数编造时间')
        segments.append({'start': start, 'end': min(end, duration), 'text': content})
        previous_end = end
    if sum(len(s['text']) for s in segments) > 6000:
        raise ValueError('本次对齐文字超过 6000 字，请分批处理')
    return segments


def _timestamp(seconds, separator):
    total = round(seconds*1000)
    return f'{total//3600000:02d}:{total//60000%60:02d}:{total//1000%60:02d}{separator}{total%1000:03d}'


def align_segments(input_path, segments):
    """Run only the reviewed alignment modules, with safe local HF weights."""
    os.environ['NLTK_DATA'] = str(ROOT / '.runtime/nltk_data')
    sys.path.insert(0, str(VENDOR))
    import nltk
    nltk.data.path.insert(0, str(ROOT / '.runtime/nltk_data'))
    from whisperx.alignment import load_align_model, align
    model, metadata = load_align_model('zh', 'cpu', model_name=str(MODEL), model_cache_only=True)
    dictionary = metadata['dictionary']
    unsupported = sorted({c for s in segments for c in s['text']
                          if c.isalnum() and c.lower() not in dictionary})
    if unsupported:
        raise ValueError('中文对齐词典不支持这些字符：' + ''.join(unsupported[:30]) +
                         '；请校对为实际发音的简体文字，或改用标准定位。没有丢字后假装全部完成。')
    result = align(segments, model, metadata, str(input_path), device='cpu',
                   interpolate_method='ignore', return_char_alignments=True)
    expected = sum(c.lower() in dictionary for s in segments for c in s['text'] if not c.isspace())
    normalized = []
    words = []
    for row in result.get('segments', []):
        timed = []
        for word in row.get('words', []):
            value = word.get('word', '')
            # Ignore wildcard/interpolated punctuation instead of claiming it
            # was acoustically recognized. The original segment text stays.
            if value.lower() not in dictionary or value.isspace():
                continue
            try:
                start, end, score = (_number(word.get(key)) for key in ('start', 'end', 'score'))
            except ValueError:
                continue
            if start >= 0 and end > start and score >= 0:
                timed.append({'word': value, 'start': start, 'end': end, 'score': score})
        if timed:
            normalized.append({'id': len(normalized)+1, 'text': row['text'],
                'start': timed[0]['start'], 'end': timed[-1]['end'], 'words': timed})
            words.extend(timed)
    if not words or expected == 0 or len(words) < expected * .9:
        raise ValueError('模型未对齐足够的汉字，请核对文字、语言与配音；未回退到估算时间')
    if any(b['start'] < a['start'] for a, b in zip(words, words[1:])):
        raise ValueError('模型返回非递增时间，请检查分段；未写出假完成字幕')
    return {'segments': normalized, 'word_timestamps': words,
        'alignment': {'engine': 'whisperx_forced_ctc', 'unit': 'chinese_character',
            'model': 'jonatasgrosman/wav2vec2-large-xlsr-53-chinese-zh-cn',
            'model_revision': MODEL_REV, 'source_revision': WHISPERX_REV, 'device': 'cpu',
            'alignable_character_count': expected, 'aligned_character_count': len(words),
            'low_score_character_count': sum(w['score'] < .25 for w in words),
            'unalignable_character_count': sum(not c.isspace() and c.lower() not in dictionary for s in segments for c in s['text']),
            'interpolated_timestamps': False, 'human_review_required': True,
            'limitations': LIMITATIONS}, 'language': 'zh'}


class TranscriptAligner(BaseTool):
    name = 'transcript_aligner'
    version = '0.1.0'
    tier = ToolTier.ANALYZE
    capability = 'analysis'
    provider = 'whisperx_local'
    stability = ToolStability.BETA
    dependencies = ['cmd:ffmpeg', 'cmd:ffprobe']
    install_instructions = '项目内 ML 环境、固定 WhisperX 对齐模块和中文 wav2vec2 权重；不需要云端账号'
    capabilities = ['forced_alignment', 'chinese_character_timestamps', 'srt', 'vtt']
    input_schema = {'type': 'object', 'required': ['input_path'], 'properties': {
        'input_path': {'type': 'string', 'description': '待对齐的本机配音或有声视频'},
        'transcript_path': {'type': 'string', 'description': '已确认的 JSON/SRT/VTT 字幕，与文字二选一'},
        'text': {'type': 'string', 'maxLength': 2000, 'description': '已确认文字，适合不超过 30 秒的配音'},
        'segments': {'type': 'array', 'description': '已有 start/end/text 的时间段；与文件或文字三选一'},
        'language': {'type': 'string', 'enum': ['zh'], 'default': 'zh'},
        'max_duration_seconds': {'type': 'integer', 'minimum': 1, 'maximum': 600, 'default': 120},
        'output_dir': {'type': 'string'},
    }}
    output_schema = {'type': 'object', 'properties': {'segments': {'type': 'array'},
        'word_timestamps': {'type': 'array'}, 'alignment': {'type': 'object'}, 'subtitles': {'type': 'object'}}}
    resource_profile = ResourceProfile(cpu_cores=2, ram_mb=5000, disk_mb=2600, network_required=False)
    side_effects = ['writes a new aligned JSON/SRT/VTT without changing the source']
    user_visible_verification = ['Play the audio while checking the Chinese character boundaries',
                                 'Check recognized text and low-score characters before publishing']

    def get_status(self):
        return ToolStatus.AVAILABLE if alignment_ready() else ToolStatus.UNAVAILABLE

    def execute(self, inputs):
        start = time.monotonic()
        try:
            source = Path(inputs['input_path'])
            if not source.is_file():
                raise ValueError('待对齐媒体不存在')
            if inputs.get('language', 'zh') != 'zh':
                raise ValueError('本机目前只安装中文对齐模型，没有切换语言或联网下载')
            limit = _number(inputs.get('max_duration_seconds', 120))
            if not 1 <= limit <= 600:
                raise ValueError('时长上限须为 1–600 秒')
            duration = probe_audio(source)
            if duration > limit:
                raise ValueError('媒体超过本次时长上限，请分批；没有截断后假装全部完成')
            segments = read_segments(inputs, duration)
            if not alignment_ready():
                raise ValueError('本机中文对齐运行时或权重未就绪，没有联网下载或调用其他模型')
            if local_ml_runtime.needs_bridge():
                return local_ml_runtime.execute(self.name, inputs)
            result = align_segments(source, segments)
            result.update(duration_seconds=round(duration, 3),
                source_sha256=hashlib.sha256(source.read_bytes()).hexdigest())
            if inputs.get('write_outputs', True):
                directory = Path(inputs.get('output_dir', source.parent))
                directory.mkdir(parents=True, exist_ok=True)
                stem = 'aligned-' + uuid.uuid4().hex[:12]
                paths = {ext: directory / f'{stem}.{ext}' for ext in ('json', 'srt', 'vtt')}
                result['subtitles'] = {ext: str(p) for ext, p in paths.items()}
                with paths['json'].open('x', encoding='utf-8') as stream:
                    json.dump(result, stream, ensure_ascii=False, indent=2, allow_nan=False)
                for ext, separator in (('srt', ','), ('vtt', '.')):
                    content = 'WEBVTT\n\n' if ext == 'vtt' else ''
                    content += '\n\n'.join(f"{i}\n{_timestamp(s['start'], separator)} --> {_timestamp(s['end'], separator)}\n{s['text']}" for i, s in enumerate(result['segments'], 1)) + '\n'
                    with paths[ext].open('x', encoding='utf-8') as stream:
                        stream.write(content)
                artifacts = list(result['subtitles'].values())
            else:
                artifacts = []
            return ToolResult(success=True, data=result, artifacts=artifacts,
                              duration_seconds=round(time.monotonic()-start, 2))
        except (ValueError, OSError, subprocess.SubprocessError, RuntimeError) as exc:
            return ToolResult(success=False, error=str(exc)[:400])
