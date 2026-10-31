"""Offline faster-whisper transcription, with explicit optional alignment.

Speaker diarization is a separate unavailable capability on this machine;
requesting it must never silently succeed without speaker labels.
"""

from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from tools.base_tool import (
    BaseTool,
    Determinism,
    ExecutionMode,
    ResourceProfile,
    RetryPolicy,
    ResumeSupport,
    ToolResult,
    ToolStability,
    ToolStatus,
    ToolTier,
)


class Transcriber(BaseTool):
    name = "transcriber"
    version = "0.2.0"
    tier = ToolTier.CORE
    capability = "analysis"
    provider = "faster_whisper"
    stability = ToolStability.EXPERIMENTAL
    execution_mode = ExecutionMode.SYNC
    determinism = Determinism.DETERMINISTIC

    dependencies = ["python:faster_whisper"]
    install_instructions = (
        "pip install faster-whisper  # CPU mode\n"
        "pip install faster-whisper[gpu]  # GPU mode (requires CUDA)\n"
        "scripts/install_montage_alignment.py  # Optional offline Chinese alignment"
    )
    # The upstream speech-to-text skill describes cloud ElevenLabs Scribe.
    # It is not a requirement for this offline recognizer.
    agent_skills = []

    capabilities = [
        "transcribe",
        "word_timestamps",
        "language_detection",
        "optional_chinese_forced_alignment",
    ]

    input_schema = {
        "type": "object",
        "required": ["input_path"],
        "properties": {
            "input_path": {"type": "string", "description": "Path to audio or video file"},
            "model_size": {
                "type": "string",
                "enum": ["tiny", "base", "small", "medium", "large-v2", "large-v3"],
                "default": "base",
            },
            "language": {"type": "string", "description": "ISO 639-1 language code, or null for auto-detect"},
            "diarize": {"type": "boolean", "default": False,
                        "description": "Separate speaker diarization is not configured; requesting it fails explicitly"},
            "alignment": {"type": "string", "enum": ["faster_whisper", "whisperx_zh"],
                          "default": "faster_whisper", "description": "Optional genuine Chinese forced alignment (CPU, max 120 seconds)"},
            "output_dir": {"type": "string", "description": "Directory for output files"},
        },
    }

    output_schema = {
        "type": "object",
        "properties": {
            "segments": {"type": "array"},
            "word_timestamps": {"type": "array"},
            "language": {"type": "string"},
            "duration_seconds": {"type": "number"},
        },
    }

    resource_profile = ResourceProfile(
        cpu_cores=2,
        ram_mb=2048,
        vram_mb=0,  # CPU by default; GPU optional
        disk_mb=500,
        network_required=False,
    )

    retry_policy = RetryPolicy(max_retries=1, retryable_errors=["MemoryError"])
    resume_support = ResumeSupport.FROM_START
    idempotency_key_fields = ["input_path", "model_size", "language"]
    side_effects = ["writes transcript JSON to output_dir"]
    fallback = None
    user_visible_verification = [
        "Check transcript text against source audio",
        "Verify word timestamps align with speech",
    ]

    def get_status(self) -> ToolStatus:
        try:
            import faster_whisper  # noqa: F401
            return ToolStatus.AVAILABLE
        except ImportError:
            return ToolStatus.UNAVAILABLE

    @staticmethod
    def local_model(model_size: str) -> Path:
        root = Path(__file__).resolve().parents[2] / '.runtime/models'
        model = Path(model_size) if Path(model_size).is_absolute() else root / f'whisper-{model_size}'
        if not model.resolve().is_relative_to(root.resolve()) or not (model / 'model.bin').is_file():
            raise ValueError('所选本地识别模型未安装；没有改用其他模型或联网下载')
        return model

    def estimate_runtime(self, inputs: dict[str, Any]) -> float:
        """Rough estimate: ~0.5x real-time on CPU for 'base' model."""
        return 60.0  # conservative default

    def execute(self, inputs: dict[str, Any]) -> ToolResult:
        input_path = Path(inputs["input_path"])
        model_size = inputs.get("model_size", "base")
        language = inputs.get("language")
        diarize = inputs.get("diarize", False)
        alignment = inputs.get('alignment', 'faster_whisper')
        output_dir = Path(inputs.get("output_dir", input_path.parent))

        if not input_path.exists():
            return ToolResult(success=False, error=f"Input file not found: {input_path}")

        if diarize:
            return ToolResult(success=False, error='本机说话人区分尚未配置；没有忽略该选项或伪造说话人标签')
        if alignment not in {'faster_whisper', 'whisperx_zh'}:
            return ToolResult(success=False, error='请选择已支持的字幕对齐方式')
        if alignment == 'whisperx_zh':
            from tools.analysis.transcript_aligner import alignment_ready
            if language not in {None, '', 'zh'} or not alignment_ready():
                return ToolResult(success=False, error='中文精细对齐仅支持 zh 且须有本机权重；没有联网替代')
        try:
            local_model = self.local_model(str(model_size))
        except ValueError as exc:
            return ToolResult(success=False, error=str(exc))

        try:
            from faster_whisper import WhisperModel
        except ImportError:
            return ToolResult(
                success=False,
                error="faster-whisper is not installed. Run: pip install faster-whisper",
            )

        start = time.time()

        # faster-whisper executes through CTranslate2, so that runtime—not
        # PyTorch—is authoritative for CUDA availability and compute types.
        device = "cpu"
        compute_type = "int8"
        try:
            import ctranslate2

            if ctranslate2.get_cuda_device_count() > 0:
                supported = ctranslate2.get_supported_compute_types("cuda")
                for candidate in ("float16", "int8_float16", "float32"):
                    if candidate in supported:
                        device = "cuda"
                        compute_type = candidate
                        break
        except Exception:
            # Probing is advisory. CPU remains a safe deterministic baseline.
            pass

        def _transcribe_on(selected_device: str, selected_compute_type: str):
            model = WhisperModel(
                str(local_model),
                device=selected_device,
                compute_type=selected_compute_type,
                local_files_only=True,
            )
            segments_iter, transcription_info = model.transcribe(
                str(input_path),
                language=language,
                word_timestamps=True,
                vad_filter=True,
            )

            parsed_segments = []
            parsed_words = []
            # faster-whisper evaluates lazily. Draining the iterator here keeps
            # missing CUDA runtime libraries inside the fallback boundary.
            for seg in segments_iter:
                seg_data = {
                    "id": seg.id,
                    "start": round(seg.start, 3),
                    "end": round(seg.end, 3),
                    "text": seg.text.strip(),
                }

                if seg.words:
                    words = []
                    for word in seg.words:
                        word_entry = {
                            "word": word.word,
                            "start": round(word.start, 3),
                            "end": round(word.end, 3),
                            "probability": round(word.probability, 3),
                        }
                        words.append(word_entry)
                        parsed_words.append(word_entry)
                    seg_data["words"] = words

                parsed_segments.append(seg_data)

            return parsed_segments, parsed_words, transcription_info

        gpu_fallback_reason = None
        try:
            segments, word_timestamps, info = _transcribe_on(device, compute_type)
        except Exception as exc:
            # PyAV/faster-whisper raises ``IndexError: tuple index out of
            # range`` when a video has no audio stream.  Convert that library
            # detail into a truthful tool result so the web worker can show an
            # actionable message instead of an opaque failed request.
            if isinstance(exc, IndexError):
                return ToolResult(
                    success=False,
                    error=(
                        "Input media has no decodable audio stream. "
                        "Provide an audio track or use the script-to-subtitle stage."
                    ),
                )
            if device == "cpu":
                return ToolResult(success=False, error='本机识别未完成；请核对音轨和本地模型，没有联网重试')
            gpu_fallback_reason = f"{type(exc).__name__}: {exc}"
            device = "cpu"
            compute_type = "int8"
            try:
                segments, word_timestamps, info = _transcribe_on(device, compute_type)
            except IndexError:
                return ToolResult(
                    success=False,
                    error=(
                        "Input media has no decodable audio stream. "
                        "Provide an audio track or use the script-to-subtitle stage."
                    ),
                )

        detected_language = language or info.language
        duration = info.duration

        alignment_data = {'engine': 'faster_whisper_attention', 'unit': 'model_tokens',
                          'human_review_required': True, 'interpolated_timestamps': False}
        if alignment == 'whisperx_zh':
            if detected_language != 'zh':
                return ToolResult(success=False, error='识别语言不是中文，未擅自切换对齐模型')
            from tools.analysis.transcript_aligner import TranscriptAligner
            aligned = TranscriptAligner().execute({'input_path': str(input_path),
                'segments': segments, 'language': 'zh', 'max_duration_seconds': 120, 'write_outputs': False})
            if not aligned.success:
                return ToolResult(success=False, error=aligned.error,
                    data={'recognition_completed': True, 'alignment_completed': False})
            segments, word_timestamps = aligned.data['segments'], aligned.data['word_timestamps']
            alignment_data = aligned.data['alignment']

        elapsed = time.time() - start

        result_data = {
            "segments": segments,
            "word_timestamps": word_timestamps,
            "language": detected_language,
            "duration_seconds": round(duration, 3),
            "model_size": model_size,
            "device": device,
            "compute_type": compute_type,
            "gpu_fallback_reason": gpu_fallback_reason,
            "alignment": alignment_data,
            "diarization": {"requested": False, "performed": False},
            "local_model": local_model.name,
            "network_used": False,
        }

        # Write transcript JSON
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / f"{input_path.stem}_transcript-{uuid.uuid4().hex[:12]}.json"
        with output_path.open('x', encoding='utf-8') as stream:
            json.dump(result_data, stream, ensure_ascii=False, indent=2, allow_nan=False)

        return ToolResult(
            success=True,
            data=result_data,
            artifacts=[str(output_path)],
            duration_seconds=round(elapsed, 2),
        )
