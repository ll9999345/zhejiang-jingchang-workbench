"""Local clip suggestions grounded in sentence boundaries or detected scenes.

This is an explicit heuristic recommender, not a promise of virality or a
replacement for the native clip-factory director's semantic editorial review.
"""
from __future__ import annotations
import json
import math
from pathlib import Path
import re

from tools.base_tool import BaseTool, ResourceProfile, ToolResult, ToolStability, ToolTier


def read_transcript(path: Path):
    if path.stat().st_size > 5_000_000: raise ValueError('字幕或转录文件过大')
    text = path.read_text(encoding='utf-8-sig')
    if path.suffix.lower() == '.json':
        raw = json.loads(text)
        rows = raw.get('segments', []) if isinstance(raw, dict) else raw
        if not isinstance(rows, list): raise ValueError('转录 JSON 需要 segments 数组')
    else:
        def seconds(value):
            h, m, s = value.replace(',', '.').split(':')
            return int(h) * 3600 + int(m) * 60 + float(s)
        rows = []
        for block in re.split(r'\r?\n\s*\r?\n', text):
            lines = block.strip().splitlines()
            for index, line in enumerate(lines):
                match = re.match(r'(\d+:\d+:\d+[.,]\d+)\s*-->\s*(\d+:\d+:\d+[.,]\d+)', line)
                if match:
                    rows.append({'start': seconds(match[1]), 'end': seconds(match[2]), 'text': ' '.join(lines[index + 1:])})
                    break
    valid = []
    for row in rows:
        start, end = float(row['start']), float(row['end'])
        content = str(row.get('text', '')).strip()
        if not math.isfinite(start + end) or start < 0 or end <= start: raise ValueError('转录时间范围无效')
        if content: valid.append({'start': start, 'end': end, 'text': content})
    valid.sort(key=lambda row: row['start'])
    if any(b['start'] < a['end'] - 0.1 for a, b in zip(valid, valid[1:])):
        raise ValueError('转录时间重叠，请先校正字幕')
    return valid


def suggest_segments(rows, duration, *, min_seconds=12, max_seconds=60, count=5):
    if min_seconds <= 0 or max_seconds < min_seconds or count < 1: raise ValueError('候选参数无效')
    if any(row['end'] > duration + 0.2 for row in rows): raise ValueError('字幕时间超出原视频')
    candidates = []
    hook = re.compile(r'为什么|如何|没想到|关键|其实|但是|首先|注意|秘诀|原来|why|how|secret|important|but', re.I)
    for index, first in enumerate(rows):
        group = []
        for row in rows[index:]:
            if row['end'] - first['start'] > max_seconds: break
            group.append(row)
            length = row['end'] - first['start']
            if length < min_seconds: continue
            content = ' '.join(item['text'] for item in group)
            punctuation = bool(re.search(r'[。！？.!?]$', row['text']))
            keyword_count = len(hook.findall(content))
            score = min(40, len(content) / 5) + min(25, keyword_count * 8) + (20 if punctuation else 5)
            score += 15 * max(0, 1 - abs(length - (min_seconds + max_seconds) / 2) / max_seconds)
            candidates.append({'start_seconds': round(first['start'], 3), 'end_seconds': round(row['end'], 3),
                'score': round(score, 1), 'text': content, 'title': content[:48],
                'reasons': ['从实际字幕边界开始和结束', '段落信息量与目标时长匹配'] +
                    (['包含解释、转折或提问词'] if keyword_count else []) + (['末尾标点完整'] if punctuation else [])})
    chosen = []
    for row in sorted(candidates, key=lambda item: (-item['score'], item['start_seconds'])):
        if any(min(row['end_seconds'], old['end_seconds']) > max(row['start_seconds'], old['start_seconds']) for old in chosen): continue
        chosen.append(row)
        if len(chosen) >= count: break
    chosen.sort(key=lambda row: row['start_seconds'])
    for i, row in enumerate(chosen): row['id'] = f'clip-{i + 1}'
    return chosen


class HighlightSelector(BaseTool):
    name = 'highlight_selector'
    version = '0.1.0'
    tier = ToolTier.ANALYZE
    stability = ToolStability.BETA
    capability = 'clip_highlights'
    dependencies = ['cmd:ffmpeg', 'cmd:ffprobe']
    agent_skills = ['speech-to-text']
    input_schema = {'type': 'object', 'required': ['input_path'], 'properties': {
        'input_path': {'type': 'string'}, 'transcript_path': {'type': 'string'},
        'min_seconds': {'type': 'number', 'minimum': 1, 'maximum': 300, 'default': 12},
        'max_seconds': {'type': 'number', 'minimum': 1, 'maximum': 600, 'default': 60},
        'count': {'type': 'integer', 'minimum': 1, 'maximum': 30, 'default': 5},
        'language': {'type': 'string', 'default': 'zh'}, 'output_path': {'type': 'string'}}}
    output_schema = {'type': 'object', 'properties': {'candidates': {'type': 'array'}, 'selection_basis': {'type': 'string'}}}
    resource_profile = ResourceProfile(cpu_cores=2, ram_mb=2048, disk_mb=50)
    capabilities = ['sentence_boundary_clip_suggestions', 'editable_ranked_candidates']
    best_for = ['Grounded first-pass suggestions for local spoken videos; final selection is editorial']
    not_good_for = ['Promising viral performance or visual semantic understanding without a director model']
    side_effects = ['writes a fresh suggestion report and optional local transcription']

    def execute(self, inputs):
        from web_api.media_pipeline import _probe_media
        from tools.analysis.transcriber import Transcriber
        source = Path(inputs['input_path'])
        probe = _probe_media(source)
        if not probe or not probe.get('video'): return ToolResult(success=False, error='需要可解码的原视频')
        output = Path(inputs['output_path'])
        output.parent.mkdir(parents=True, exist_ok=True)
        transcript = inputs.get('transcript_path')
        artifacts = []
        if transcript:
            rows = read_transcript(Path(transcript))
            basis = 'creator_transcript_sentence_boundaries'
        elif probe.get('audio'):
            model = Path(__file__).resolve().parents[2] / '.runtime/models/whisper-small'
            if not (model / 'model.bin').is_file():
                return ToolResult(success=False, error='需要现有字幕或已安装的本地 Whisper 模型；没有自动下载或上传音频')
            result = Transcriber().execute({'input_path': str(source), 'model_size': str(model),
                'language': inputs.get('language', 'zh'), 'output_dir': str(output.parent / 'transcript')})
            if not result.success: return result
            rows = result.data.get('segments', [])
            artifacts.extend(result.artifacts)
            basis = 'local_whisper_sentence_boundaries'
        else:
            return ToolResult(success=False, error='原视频无声音，请导入字幕时间线，或通过场景检测和导演审阅选择片段')
        candidates = suggest_segments(rows, float(probe['duration_seconds']),
            min_seconds=float(inputs.get('min_seconds', 12)), max_seconds=float(inputs.get('max_seconds', 60)),
            count=int(inputs.get('count', 5)))
        if not candidates: return ToolResult(success=False, error='未找到满足时长的完整段落；请缩短最小时长或校正字幕')
        data = {'candidates': candidates, 'selection_basis': basis,
                'semantic_ai_reviewed': False, 'source_duration_seconds': probe['duration_seconds'],
                'review_required': True, 'note': '这是有依据的初选建议；不保证爆款，不冒充 AI 视觉语义评审。'}
        output.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
        return ToolResult(success=True, data=data, artifacts=artifacts + [str(output)])
