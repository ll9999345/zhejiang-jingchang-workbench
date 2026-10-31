"""Free deterministic instrumental beds made from local oscillators.

This is procedural composition, not a trained AI music model. No samples,
third-party recordings, account, key or external prompt upload are involved.
"""
from __future__ import annotations

import math
from pathlib import Path
import shutil
import time
import uuid
import wave

import numpy as np

from tools.base_tool import BaseTool, Determinism, ResourceProfile, ToolResult, ToolRuntime, ToolStatus, ToolTier

STYLES = ('guofeng_ambient', 'cinematic', 'documentary')


class LocalMusic(BaseTool):
    name = 'local_music'
    version = '1.0.0'
    tier = ToolTier.GENERATE
    capability = 'music_generation'
    provider = 'local_synthesis'
    runtime = ToolRuntime.LOCAL
    determinism = Determinism.SEEDED
    dependencies = ['python:numpy', 'cmd:ffmpeg']
    best_for = ['免费器乐草稿', '不联网的文旅氛围音乐', '给旁白留出空间的背景音乐']
    install_instructions = '本机 NumPy / FFmpeg 合成，无需 ElevenLabs。预设作曲，不冒充自然语言音乐大模型。'
    resource_profile = ResourceProfile(cpu_cores=1, ram_mb=512, disk_mb=200)
    side_effects = ['writes a new instrumental audio file; never overwrites an existing track']
    supports = {'instrumental': True, 'offline': True, 'trained_ai_model': False}
    input_schema = {
        'type': 'object', 'required': ['duration_seconds'],
        'properties': {
            'duration_seconds': {'type': 'number', 'minimum': 3, 'maximum': 600,
                'description': '按最终剪辑时长生成，3–600 秒'},
            'style': {'type': 'string', 'enum': list(STYLES), 'default': 'guofeng_ambient',
                'description': '国风氛围 / 电影铺底 / 纪录片预设；不复刻已发行歌曲'},
            'prompt': {'type': 'string', 'maxLength': 5000,
                'description': '可选文字备注；未指定风格时仅按简单关键词选择预设，不进行 AI 语义作曲'},
            'tempo_bpm': {'type': 'integer', 'minimum': 50, 'maximum': 120, 'default': 72},
            'seed': {'type': 'integer', 'minimum': 0, 'maximum': 2147483647, 'default': 20261001},
            'cue_sheet': {'type': 'array', 'maxItems': 64, 'items': {'type': 'object',
                'required': ['start_seconds', 'end_seconds', 'energy'],
                'properties': {'start_seconds': {'type': 'number', 'minimum': 0},
                    'end_seconds': {'type': 'number', 'exclusiveMinimum': 0},
                    'energy': {'type': 'string', 'enum': ['low', 'medium', 'high']}}},
                'description': '可选时间段能量；只控制编排力度，不分析参考视频内容'},
            'output_path': {'type': 'string'},
            'force_instrumental': {'type': 'boolean', 'const': True, 'default': True},
        },
    }

    def get_status(self):
        return ToolStatus.AVAILABLE if shutil.which('ffmpeg') else ToolStatus.UNAVAILABLE

    def estimate_cost(self, inputs):
        return 0.0

    def execute(self, inputs):
        start = time.monotonic()
        duration = inputs.get('duration_seconds')
        if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or not 3 <= duration <= 600:
            return ToolResult(success=False, error='本机配乐时长必须为 3–600 秒')
        if inputs.get('force_instrumental', True) is not True:
            return ToolResult(success=False, error='本机合成仅支持器乐，不支持歌声或歌词')
        output = Path(inputs.get('output_path', 'local-instrumental.wav'))
        if output.exists():
            return ToolResult(success=False, error='输出已存在，请选择新文件名；已有配乐保留')
        if output.suffix.lower() not in {'.wav', '.mp3', '.m4a', '.aac', '.ogg', '.flac'}:
            return ToolResult(success=False, error='请选择支持的音频扩展名')
        tempo, seed = inputs.get('tempo_bpm', 72), inputs.get('seed', 20261001)
        if isinstance(tempo, bool) or not isinstance(tempo, int) or not 50 <= tempo <= 120:
            return ToolResult(success=False, error='tempo_bpm 必须是 50–120 的整数')
        if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 2147483647:
            return ToolResult(success=False, error='seed 超出范围')
        prompt = str(inputs.get('prompt', ''))
        style = inputs.get('style') or ('documentary' if any(k in prompt.lower() for k in ('documentary', '纪录'))
            else 'cinematic' if any(k in prompt.lower() for k in ('cinematic', 'epic', '史诗')) else 'guofeng_ambient')
        if style not in STYLES:
            return ToolResult(success=False, error='未知配乐预设；不会切换到云端服务')
        cues = inputs.get('cue_sheet', [])
        if not isinstance(cues, list) or len(cues) > 64:
            return ToolResult(success=False, error='能量段最多 64 个')
        for cue in cues:
            try:
                a, b = float(cue['start_seconds']), float(cue['end_seconds'])
                if not 0 <= a < b <= duration + .01 or cue['energy'] not in {'low', 'medium', 'high'}:
                    raise ValueError('Invalid cue')
            except (ValueError, KeyError, TypeError):
                return ToolResult(success=False, error='能量段时间或力度无效；不会先生成部分音频')
        try:
            sample_rate = 24000
            signal = self._compose(float(duration), sample_rate, tempo, seed, style, cues)
            output.parent.mkdir(parents=True, exist_ok=True)
            source = output if output.suffix.lower() == '.wav' else output.with_name(output.stem + '-source-' + uuid.uuid4().hex[:8] + '.wav')
            with source.open('xb') as stream, wave.open(stream, 'wb') as audio:
                audio.setnchannels(2); audio.setsampwidth(2); audio.setframerate(sample_rate)
                audio.writeframes((signal * 32767).astype('<i2').tobytes())
            if source != output:
                self.run_command(['ffmpeg', '-n', '-v', 'error', '-i', str(source), str(output)], timeout=90)
            rms = float(np.sqrt(np.mean(signal ** 2)))
            return ToolResult(success=True, data={
                'output': str(output), 'duration_seconds': len(signal) / sample_rate,
                'style': style, 'tempo_bpm': tempo, 'seed': seed, 'instrumental': True,
                'sample_rate': sample_rate, 'channels': 2, 'rms': round(rms, 6),
                'peak': round(float(np.max(np.abs(signal))), 6), 'provider': self.provider,
                'creative_method': 'procedural_synthesis_not_trained_ai', 'offline': True,
                'cue_sheet_applied': bool(cues), 'external_samples_used': False,
                'limitations': ['本机预设合成器乐适合草稿铺底；不等同于专业音乐制作或自由提示词 AI 作曲。'],
            }, artifacts=[str(output)] + ([str(source)] if source != output else []),
                cost_usd=0, duration_seconds=round(time.monotonic() - start, 2), seed=seed)
        except Exception as exc:
            return ToolResult(success=False, error=f'本机配乐未完成，已有产物保留：{exc}')

    @staticmethod
    def _compose(duration, sample_rate, tempo, seed, style, cues):
        rng = np.random.default_rng(seed)
        count = round(duration * sample_rate)
        mono = np.zeros(count, dtype=np.float32)
        beat = 60 / tempo
        notes = [60, 62, 64, 67, 69] if style == 'guofeng_ambient' else [57, 60, 62, 64, 67]
        roots = [48, 45, 41, 43]
        def add(at, seconds, midi, amp, kind):
            start = round(at * sample_rate)
            size = min(round(seconds * sample_rate), count - start)
            if size <= 0: return
            t = np.arange(size, dtype=np.float32) / sample_rate
            frequency = 440 * 2 ** ((midi - 69) / 12)
            envelope = np.minimum(t / (.06 if kind == 'pad' else .015), 1)
            envelope *= np.exp(-t / (seconds * .48 if kind == 'pad' else max(.25, seconds * .28)))
            envelope *= np.minimum((size / sample_rate - t) / .08, 1)
            tone = np.sin(2 * np.pi * frequency * t)
            tone += (.15 if kind == 'pad' else .35) * np.sin(4 * np.pi * frequency * t)
            tone += .08 * np.sin(6 * np.pi * frequency * t)
            mono[start:start + size] += (amp * envelope * tone).astype(np.float32)
        bars = math.ceil(duration / (4 * beat))
        motif = rng.choice(notes, size=8)
        for bar in range(bars):
            at = bar * 4 * beat
            energy = .65 + .2 * math.sin(math.pi * min(at / duration, 1))
            for cue in cues:
                if cue['start_seconds'] <= at < cue['end_seconds']:
                    energy *= {'low': .65, 'medium': .85, 'high': 1.15}[cue['energy']]
            root = roots[(bar // 2) % len(roots)]
            for offset in [0, 7, 12]: add(at, 4.8 * beat, root + offset, .13 * energy, 'pad')
            for i in range(4):
                if (bar + i) % 5 == 3: continue
                pitch = int(motif[(bar * 2 + i) % 8]) + (12 if i == 3 and bar % 4 == 2 else 0)
                add(at + (i + .1) * beat, 1.8 * beat, pitch, .16 * energy, 'pluck')
            if style == 'cinematic': add(at, 3 * beat, root - 12, .17 * energy, 'pad')
        for delay, gain in [(.19, .14), (.41, .09), (.73, .06)]:
            shift = round(delay * sample_rate)
            if shift < count: mono[shift:] += gain * mono[:-shift].copy()
        fade = min(round(1.2 * sample_rate), count // 3)
        mono[:fade] *= np.linspace(0, 1, fade, dtype=np.float32)
        mono[-fade:] *= np.linspace(1, 0, fade, dtype=np.float32)
        peak = float(np.max(np.abs(mono)))
        if peak <= 0: raise ValueError('No audible instrumental signal')
        mono *= .7 / peak
        right = mono * .94
        delay = round(.013 * sample_rate)
        right[delay:] += .05 * mono[:-delay]
        return np.column_stack((mono, right)).astype(np.float32)
