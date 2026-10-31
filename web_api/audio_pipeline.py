"""Narration and subtitle-timeline service for the OpenMontage web API.

The service deliberately separates the free planning path from paid narration:

* ``POST /api/audio/estimate`` only asks :class:`TTSSelector` to rank providers;
  it never calls a provider and never writes a file.
* ``POST /api/audio/render`` is a dry-run unless the request explicitly sets
  ``execute=true`` and ``dry_run=false``.  A second confirmation flag and the
  same ``WEB_API_PAID_AUTH_TOKEN`` used by ``web_api.app`` are required before
  a provider can be called.

When a provider returns an audio file, its duration is measured with ffprobe.
Subtitle timestamps are derived from that measured duration, then SRT, VTT,
JSON, and a SHA-256-bearing artifact manifest are committed to the project.
No synthetic audio is produced when a provider is unavailable.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import secrets
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field, field_validator

from tools.analysis.audio_probe import probe_duration
from tools.audio.tts_selector import TTSSelector
from tools.base_tool import ToolStatus


PROJECT_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
SAFE_FORMAT_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$")
DEFAULT_PROJECT_ROOT = Path(__file__).resolve().parent.parent / "projects"
DEFAULT_OUTPUT_FORMAT = "mp3_44100_128"
CHINESE_CHARACTERS_PER_SECOND = 3.5
_SENSITIVE_ERROR_PATTERN = re.compile(
    r"(?i)(api[_-]?key|token|authorization|secret|password|credential)"
    r"\s*[:=]\s*[^\s,;]+"
)


class NarrationSegment(BaseModel):
    """One script segment that becomes one subtitle cue."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=128)
    text: str = Field(min_length=1, max_length=20_000)
    speaker: str | None = Field(default=None, max_length=128)

    @field_validator("id", "text", "speaker")
    @classmethod
    def _trim_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise ValueError("must not be blank")
        return value


class AudioPipelineRequest(BaseModel):
    """Validated request shared by the estimate and narration routes.

    Credential fields are intentionally absent.  Provider credentials stay in
    the server environment and are never accepted from browser payloads.
    """

    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1, max_length=128)
    segments: list[NarrationSegment] = Field(min_length=1, max_length=500)

    preferred_provider: str = Field(default="auto", max_length=128)
    allowed_providers: list[str] | None = Field(default=None, max_length=32)
    output_format: str = Field(default=DEFAULT_OUTPUT_FORMAT, max_length=32)

    # Common capability-level TTS controls.  They are passed through to the
    # selector; provider-specific credentials are never part of this model.
    voice_id: str | None = Field(default=None, max_length=256)
    voice: str | None = Field(default=None, max_length=256)
    voice_language: str | None = Field(default=None, max_length=32)
    model_id: str | None = Field(default=None, max_length=256)
    stability: float | None = Field(default=None, ge=0, le=1)
    similarity_boost: float | None = Field(default=None, ge=0, le=1)
    style: float | str | None = Field(default=None)
    instructions: str | None = Field(default=None, max_length=5_000)
    voice_prompt: str | None = Field(default=None, max_length=5_000)
    speaking_rate: float | None = Field(default=None, ge=0.25, le=2)
    speed: float | None = Field(default=None, ge=0.25, le=4)
    pitch: float | None = Field(default=None, ge=-50, le=50)
    input_type: str = Field(default="text", max_length=16)
    language_code: str | None = Field(default=None, max_length=32)
    timestamps: bool = False
    apply_text_normalization: str | None = Field(default=None, max_length=16)
    seed: int | None = None
    voice_performance: dict[str, Any] | None = None
    sample_mode: bool = False
    task_context: dict[str, Any] | None = None

    # Safe by default.  The route also requires an explicit confirmation for
    # the only path that can call an external provider.
    dry_run: bool = True
    execute: bool = False
    confirm: bool = False

    @field_validator("project_id")
    @classmethod
    def _safe_project_id(cls, value: str) -> str:
        value = value.strip()
        if not PROJECT_ID_PATTERN.fullmatch(value):
            raise ValueError("project_id contains unsupported path characters")
        return value

    @field_validator("preferred_provider", "input_type")
    @classmethod
    def _trim_setting(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("must not be blank")
        return value

    @field_validator("output_format")
    @classmethod
    def _safe_output_format(cls, value: str) -> str:
        value = value.strip()
        if not SAFE_FORMAT_PATTERN.fullmatch(value):
            raise ValueError("output_format contains unsupported characters")
        return value

    @field_validator("segments")
    @classmethod
    def _unique_segment_ids(cls, value: list[NarrationSegment]) -> list[NarrationSegment]:
        ids = [segment.id for segment in value]
        if len(ids) != len(set(ids)):
            raise ValueError("segment ids must be unique")
        return value


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _status_name(value: Any) -> str:
    """Normalize ToolStatus, enum, and tiny injected fake-provider statuses."""

    raw = getattr(value, "value", value)
    text = str(raw or "unknown").lower()
    if text.endswith(".available"):
        return "available"
    if text.endswith(".unavailable"):
        return "unavailable"
    if text.endswith(".degraded"):
        return "degraded"
    if text in {"available", "unavailable", "degraded"}:
        return text
    return text


def _selector_status(selector: Any) -> str:
    try:
        return _status_name(selector.get_status())
    except Exception:
        return "unknown"


def _provider_objects(selector: Any) -> list[Any]:
    """Read selector-discovered providers without depending on a registry API."""

    discover = getattr(selector, "_providers", None)
    if callable(discover):
        try:
            return list(discover())
        except Exception:
            return []
    providers = getattr(selector, "providers", None)
    if isinstance(providers, Sequence) and not isinstance(providers, (str, bytes)):
        return list(providers)
    return []


def _runtime_name(provider: Any) -> str:
    runtime = getattr(provider, "runtime", "")
    return str(getattr(runtime, "value", runtime) or "").lower()


def _local_tts_selection(selector: Any, request: "AudioPipelineRequest") -> bool:
    """Return whether the current request can run without paid credentials.

    A local provider is free, but an ``auto`` request must not accidentally
    bypass authorization when a cloud provider is also available.  Therefore
    the free path is allowed only when the preferred provider is local, or
    when every currently available provider is local.
    """

    providers = [
        provider
        for provider in _provider_objects(selector)
        if _selector_status(provider) == "available"
    ]
    if not providers:
        return False

    preferred = str(getattr(request, "preferred_provider", "auto") or "auto").strip().casefold()
    allowed = {
        str(item).strip().casefold()
        for item in (getattr(request, "allowed_providers", None) or [])
        if str(item).strip()
    }
    if allowed:
        providers = [
            provider
            for provider in providers
            if str(getattr(provider, "provider", "")).casefold() in allowed
            or str(getattr(provider, "name", "")).casefold() in allowed
        ]
    if not providers:
        return False

    if preferred != "auto":
        providers = [
            provider
            for provider in providers
            if str(getattr(provider, "provider", "")).casefold() == preferred
            or str(getattr(provider, "name", "")).casefold() == preferred
        ]
        if not providers:
            return False

    return all(_runtime_name(provider) in {"local", "local_gpu"} for provider in providers)


def _provider_snapshot(selector: Any) -> list[dict[str, Any]]:
    snapshot: list[dict[str, Any]] = []
    for provider in _provider_objects(selector):
        name = str(getattr(provider, "name", "unknown"))
        vendor = str(getattr(provider, "provider", name))
        item: dict[str, Any] = {
            "tool": name,
            "provider": vendor,
            "status": _selector_status(provider),
        }
        try:
            info = provider.get_info()
        except Exception:
            info = {}
        if isinstance(info, Mapping):
            dependencies = info.get("dependencies")
            instructions = info.get("install_instructions")
            if dependencies:
                item["dependencies"] = _json_safe(dependencies)
            if instructions:
                item["install_instructions"] = _json_safe(instructions)

        # Provider diagnostics are optional.  Keep the response deliberately
        # allow-listed because this endpoint is browser-visible and a custom
        # provider must not be able to accidentally return a credential.
        diagnose = getattr(provider, "diagnostics", None)
        if callable(diagnose):
            try:
                raw_diagnostics = diagnose()
            except Exception:
                raw_diagnostics = None
            if isinstance(raw_diagnostics, Mapping):
                safe_keys = {
                    "ready",
                    "api_key_configured",
                    "api_key_env",
                    "voice_configured",
                    "voice_env",
                    "auth_scheme",
                    "resource_id",
                    "issues",
                }
                item["diagnostics"] = {
                    str(key): _json_safe(value)
                    for key, value in raw_diagnostics.items()
                    if str(key) in safe_keys
                }
        snapshot.append(item)
    return snapshot


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, Mapping):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(item) for item in value]
    return str(value)


def _safe_error(value: Any) -> str:
    """Keep provider errors actionable without echoing credential-shaped data."""

    message = str(value or "request failed")
    for key in ("WEB_API_PAID_AUTH_TOKEN", "ARK_API_KEY"):
        secret = os.environ.get(key)
        if secret:
            message = message.replace(secret, "[redacted]")
    message = _SENSITIVE_ERROR_PATTERN.sub(r"\1=[redacted]", message)
    # Query strings may contain signed URLs or access tokens.  Keep only the
    # origin/path when returning an error to a browser.
    message = re.sub(r"(https?://[^\s?]+)[^\s]*", r"\1", message)
    return message[:1_000]


def _result_parts(raw: Any) -> tuple[bool, dict[str, Any], str | None]:
    if isinstance(raw, Mapping):
        nested = raw.get("data")
        data = nested if isinstance(nested, Mapping) else raw
        success = bool(raw.get("success", data.get("valid", True)))
        error = raw.get("error")
    else:
        nested = getattr(raw, "data", {})
        data = nested if isinstance(nested, Mapping) else {}
        success = bool(getattr(raw, "success", False))
        error = getattr(raw, "error", None)
    return success, dict(_json_safe(data)), _safe_error(error) if error else None


def _joined_text(segments: Sequence[NarrationSegment]) -> str:
    # Newlines preserve intentional segment boundaries for providers that use
    # punctuation/prosody, while subtitle allocation remains segment-based.
    return "\n".join(segment.text for segment in segments)


def _text_weight(text: str) -> int:
    weight = len(re.sub(r"\s+", "", text))
    return max(1, weight)


def _estimated_duration(text: str) -> float:
    characters = _text_weight(text)
    return round(max(0.1, characters / CHINESE_CHARACTERS_PER_SECOND), 3)


def _task_context(request: AudioPipelineRequest, operation: str) -> dict[str, Any]:
    context = dict(request.task_context or {})
    context.setdefault("intent", "narration")
    context.setdefault("language", request.language_code or request.voice_language or "zh")
    context.setdefault("operation", operation)
    return context


def _selector_inputs(
    request: AudioPipelineRequest,
    *,
    operation: str,
    output_path: Path | None = None,
) -> dict[str, Any]:
    values: dict[str, Any] = {
        "text": _joined_text(request.segments),
        "operation": operation,
        "preferred_provider": request.preferred_provider,
        "task_context": _task_context(request, operation),
    }
    for field_name in (
        "allowed_providers",
        "voice_id",
        "voice",
        "voice_language",
        "model_id",
        "stability",
        "similarity_boost",
        "style",
        "instructions",
        "speaking_rate",
        "speed",
        "pitch",
        "input_type",
        "language_code",
        "timestamps",
        "apply_text_normalization",
        "seed",
        "voice_performance",
        "sample_mode",
        "output_format",
    ):
        value = getattr(request, field_name)
        if value is not None:
            values[field_name] = value
    if request.voice_prompt and not request.instructions:
        values["instructions"] = request.voice_prompt
    if output_path is not None:
        values["output_path"] = str(output_path)
    return values


def _rankings(selector: Any, request: AudioPipelineRequest) -> tuple[list[dict[str, Any]], str | None]:
    rank = getattr(selector, "execute", None)
    if not callable(rank):
        return [], None
    try:
        raw = rank(_selector_inputs(request, operation="rank"))
        success, data, error = _result_parts(raw)
        if not success:
            return [], error
        rankings = data.get("rankings", [])
        return (
            list(_json_safe(rankings)) if isinstance(rankings, list) else [],
            error,
        )
    except Exception as exc:
        return [], _safe_error(exc)


def _estimate_payload(request: AudioPipelineRequest, selector: Any) -> dict[str, Any]:
    selector_status = _selector_status(selector)
    providers = _provider_snapshot(selector)
    rankings, rank_error = _rankings(selector, request)
    available = selector_status == "available"

    estimated_cost: float | None = None
    if available:
        estimate_cost = getattr(selector, "estimate_cost", None)
        if callable(estimate_cost):
            try:
                raw_cost = float(estimate_cost(_selector_inputs(request, operation="generate")))
                if math.isfinite(raw_cost) and raw_cost >= 0:
                    estimated_cost = round(raw_cost, 6)
            except Exception:
                estimated_cost = None

    message = None
    if not available:
        message = (
            "No usable TTS provider is configured. Configure one of the listed "
            "providers on the server, then repeat the free estimate."
        )
    elif rank_error:
        message = f"Provider ranking was incomplete: {rank_error}"

    return {
        "status": "available" if available else "unavailable",
        "selector_status": selector_status,
        "project_id": request.project_id,
        "segment_count": len(request.segments),
        "character_count": len(re.sub(r"\s+", "", _joined_text(request.segments))),
        "estimated_duration_seconds": _estimated_duration(_joined_text(request.segments)),
        "estimated_cost_cny": estimated_cost,
        "cost_estimate_cny": estimated_cost,
        "providers": providers,
        "rankings": rankings,
        "would_generate": False,
        "dry_run": True,
        # An unavailable selector still cannot execute until the creator
        # configures a provider.  Keep this flag true in that case so the UI
        # does not imply that a missing capability is ready to run.
        "authorization_required": (not available) or not _local_tts_selection(selector, request),
        "error": message,
    }


def _resolve_project(root: str | Path, project_id: str) -> Path:
    if not PROJECT_ID_PATTERN.fullmatch(project_id):
        raise ValueError("project_id contains unsupported path characters")
    root_path = Path(root).expanduser().resolve()
    project_dir = (root_path / project_id).resolve()
    if project_dir.parent != root_path:
        raise ValueError("project_id escaped the project root")
    if not project_dir.is_dir():
        raise FileNotFoundError(f"project does not exist: {project_id}")
    return project_dir


def _sha256(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _sha256_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _format_extension(output_format: str) -> str:
    lowered = output_format.lower()
    if lowered.startswith(("wav", "riff", "pcm")):
        return "wav"
    if lowered.startswith("ogg"):
        return "ogg"
    if lowered.startswith("flac"):
        return "flac"
    return "mp3"


def _relative_path(path: Path, project_dir: Path) -> str:
    return path.relative_to(project_dir).as_posix()


def _atomic_bytes(path: Path, content: bytes) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(
        dir=str(path.parent), prefix=f".{path.name}.", suffix=".part"
    )
    temp_path = Path(temp_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
    finally:
        temp_path.unlink(missing_ok=True)
    return path


def _subtitle_timestamp(seconds: float, separator: str) -> str:
    total_ms = max(0, int(round(seconds * 1_000)))
    hours, remainder = divmod(total_ms, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1_000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}{separator}{millis:03d}"


def _build_cues(
    segments: Sequence[NarrationSegment], duration_seconds: float
) -> list[dict[str, Any]]:
    weights = [_text_weight(segment.text) for segment in segments]
    total_weight = sum(weights) or len(weights)
    cues: list[dict[str, Any]] = []
    cursor = 0.0
    cumulative = 0
    for index, (segment, weight) in enumerate(zip(segments, weights, strict=True), start=1):
        start = cursor
        cumulative += weight
        if index == len(segments):
            end = duration_seconds
        else:
            end = duration_seconds * cumulative / total_weight
        end = min(duration_seconds, max(start, end))
        cues.append(
            {
                "index": index,
                "segment_id": segment.id,
                "speaker": segment.speaker,
                "text": segment.text,
                "start_seconds": round(start, 3),
                "end_seconds": round(end, 3),
                "start": _subtitle_timestamp(start, ","),
                "end": _subtitle_timestamp(end, ","),
            }
        )
        cursor = end
    return cues


def _srt(cues: Sequence[Mapping[str, Any]]) -> bytes:
    blocks = []
    for cue in cues:
        blocks.append(
            "{index}\n{start} --> {end}\n{text}\n".format(
                index=cue["index"],
                start=cue["start"],
                end=cue["end"],
                text=cue["text"],
            )
        )
    return ("\n".join(blocks) + ("\n" if blocks else "")).encode("utf-8")


def _vtt(cues: Sequence[Mapping[str, Any]]) -> bytes:
    blocks = []
    for cue in cues:
        start = _subtitle_timestamp(float(cue["start_seconds"]), ".")
        end = _subtitle_timestamp(float(cue["end_seconds"]), ".")
        blocks.append(f"{cue['index']}\n{start} --> {end}\n{cue['text']}\n")
    body = "\n".join(blocks)
    return ("WEBVTT\n\n" + body + ("\n" if blocks else "")).encode("utf-8")


def _timeline_json(
    request: AudioPipelineRequest,
    cues: Sequence[Mapping[str, Any]],
    duration_seconds: float,
    audio_sha256: str,
) -> bytes:
    payload = {
        "schema_version": "1.0",
        "project_id": request.project_id,
        "stage": "narration",
        "audio_duration_seconds": round(duration_seconds, 3),
        "duration_source": "ffprobe",
        "source_text_sha256": _sha256_bytes(_joined_text(request.segments).encode("utf-8")),
        "source_audio_sha256": audio_sha256,
        "cue_count": len(cues),
        "cues": list(cues),
        "bgm": {
            "status": "deferred",
            "reason": "BGM is generated only after narration, video, and quality review.",
        },
        "created_at": _utc_now(),
    }
    return json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8") + b"\n"


def _provider_metadata(data: Mapping[str, Any]) -> tuple[str | None, str | None]:
    provider = data.get("selected_provider") or data.get("provider")
    model = data.get("model") or data.get("model_id")
    return (
        str(provider) if provider is not None else None,
        str(model) if model is not None else None,
    )


def _audio_manifest(
    request: AudioPipelineRequest,
    project_dir: Path,
    audio_path: Path,
    audio_duration: float,
    audio_sha256: str,
    audio_size: int,
    srt_path: Path,
    srt_content: bytes,
    vtt_path: Path,
    vtt_content: bytes,
    timeline_path: Path,
    timeline_content: bytes,
    cues: Sequence[Mapping[str, Any]],
    provider: str | None,
    model: str | None,
) -> bytes:
    payload = {
        "schema_version": "1.0",
        "project_id": request.project_id,
        "stage": "narration",
        "status": "completed",
        "created_at": _utc_now(),
        "provider": provider,
        "model": model,
        "source_text_sha256": _sha256_bytes(_joined_text(request.segments).encode("utf-8")),
        "audio": {
            "path": _relative_path(audio_path, project_dir),
            "sha256": audio_sha256,
            "size_bytes": audio_size,
            "duration_seconds": round(audio_duration, 3),
            "duration_source": "ffprobe",
            "format": audio_path.suffix.lstrip(".") or None,
        },
        "subtitles": {
            "cue_count": len(cues),
            "srt": {
                "path": _relative_path(srt_path, project_dir),
                "sha256": _sha256_bytes(srt_content),
                "size_bytes": len(srt_content),
            },
            "vtt": {
                "path": _relative_path(vtt_path, project_dir),
                "sha256": _sha256_bytes(vtt_content),
                "size_bytes": len(vtt_content),
            },
            "json": {
                "path": _relative_path(timeline_path, project_dir),
                "sha256": _sha256_bytes(timeline_content),
                "size_bytes": len(timeline_content),
            },
        },
        "segments": [
            {
                "id": segment.id,
                "speaker": segment.speaker,
                "character_count": _text_weight(segment.text),
                "text_sha256": _sha256_bytes(segment.text.encode("utf-8")),
            }
            for segment in request.segments
        ],
        "bgm": {
            "status": "deferred",
            "reason": "BGM is generated after the narration/video quality review.",
        },
    }
    return json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8") + b"\n"


def estimate_audio_pipeline(
    request: AudioPipelineRequest | Mapping[str, Any],
    *,
    selector: Any | None = None,
) -> dict[str, Any]:
    """Return a free TTS ranking/estimate without writing files or generating."""

    model = request if isinstance(request, AudioPipelineRequest) else AudioPipelineRequest.model_validate(request)
    chosen = selector if selector is not None else TTSSelector()
    return _estimate_payload(model, chosen)


def render_audio_pipeline(
    request: AudioPipelineRequest | Mapping[str, Any],
    *,
    selector: Any | None = None,
    project_root: str | Path = DEFAULT_PROJECT_ROOT,
    authorized: bool = False,
) -> dict[str, Any]:
    """Run a guarded narration generation and commit verified artifacts.

    ``authorized`` is intentionally false by default so direct service calls
    are planning-only.  The FastAPI route sets it only after validating the
    second confirmation and ``WEB_API_PAID_AUTH_TOKEN``.
    """

    model = request if isinstance(request, AudioPipelineRequest) else AudioPipelineRequest.model_validate(request)
    chosen = selector if selector is not None else TTSSelector()

    if model.dry_run or not model.execute:
        estimate = _estimate_payload(model, chosen)
        estimate["status"] = "dry_run"
        estimate["would_generate"] = estimate["selector_status"] == "available"
        # A dry-run must reveal the real gate.  An explicitly selected local
        # provider (for example macOS ``say``) needs no paid credential,
        # while ``auto``/cloud selection still does.  Keeping this value from
        # ``_estimate_payload`` lets the UI explain the next safe action.
        estimate["authorization_required"] = bool(estimate.get("authorization_required"))
        return estimate

    if not authorized or not model.confirm:
        return {
            "status": "authorization_required",
            "project_id": model.project_id,
            "would_generate": False,
            "dry_run": True,
            "authorization_required": True,
            "error": (
                "Explicit paid authorization and confirm=true are required "
                "before narration generation."
            ),
        }

    selector_status = _selector_status(chosen)
    if selector_status != "available":
        estimate = _estimate_payload(model, chosen)
        estimate.update(
            {
                "status": "unavailable",
                "would_generate": False,
                "error": (
                    "Narration was not generated because no usable TTS provider is "
                    "configured. No audio or subtitle artifacts were written."
                ),
            }
        )
        return estimate

    try:
        project_dir = _resolve_project(project_root, model.project_id)
    except (ValueError, FileNotFoundError) as exc:
        return {
            "status": "invalid_project",
            "project_id": model.project_id,
            "would_generate": False,
            "dry_run": False,
            "error": _safe_error(exc),
        }

    audio_dir = project_dir / "assets" / "audio"
    extension = _format_extension(model.output_format)
    audio_path = audio_dir / f"narration.{extension}"
    audio_dir.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(
        dir=str(audio_dir), prefix=f".narration.{extension}.", suffix=".part"
    )
    os.close(descriptor)
    temp_audio = Path(temp_name)
    temp_audio.unlink(missing_ok=True)

    try:
        execute = getattr(chosen, "execute", None)
        if not callable(execute):
            raise RuntimeError("TTS selector has no execute method")
        raw = execute(
            _selector_inputs(model, operation="generate", output_path=temp_audio)
        )
        success, data, error = _result_parts(raw)
        if not success:
            raise RuntimeError(error or "TTS provider generation failed")
        if not temp_audio.is_file() or temp_audio.stat().st_size <= 0:
            raise RuntimeError("TTS provider returned success but no audio file")

        duration = probe_duration(temp_audio)
        if duration is None or not math.isfinite(duration) or duration <= 0:
            raise RuntimeError(
                "Generated audio duration could not be verified with ffprobe; "
                "no artifacts were committed"
            )
        duration = float(duration)
        audio_sha256 = _sha256(temp_audio)
        audio_size = temp_audio.stat().st_size
        cues = _build_cues(model.segments, duration)
        srt_content = _srt(cues)
        vtt_content = _vtt(cues)

        srt_path = project_dir / "subtitles.srt"
        vtt_path = project_dir / "subtitles.vtt"
        timeline_path = project_dir / "subtitles.json"
        timeline_content = _timeline_json(model, cues, duration, audio_sha256)
        provider, provider_model = _provider_metadata(data)
        manifest_content = _audio_manifest(
            model,
            project_dir,
            audio_path,
            duration,
            audio_sha256,
            audio_size,
            srt_path,
            srt_content,
            vtt_path,
            vtt_content,
            timeline_path,
            timeline_content,
            cues,
            provider,
            provider_model,
        )

        # Commit each artifact atomically.  The provider's temporary output is
        # not visible under its final name until duration/hash verification has
        # succeeded.
        audio_path.parent.mkdir(parents=True, exist_ok=True)
        os.replace(temp_audio, audio_path)
        _atomic_bytes(srt_path, srt_content)
        _atomic_bytes(vtt_path, vtt_content)
        _atomic_bytes(timeline_path, timeline_content)
        manifest_path = project_dir / "artifacts" / "audio_manifest.json"
        _atomic_bytes(manifest_path, manifest_content)

        return {
            "status": "completed",
            "project_id": model.project_id,
            "provider": provider,
            "model": provider_model,
            "would_generate": True,
            "dry_run": False,
            "duration_seconds": round(duration, 3),
            "audio": {
                "path": _relative_path(audio_path, project_dir),
                "sha256": _sha256(audio_path),
                "size_bytes": audio_path.stat().st_size,
            },
            "subtitles": {
                "srt": _relative_path(srt_path, project_dir),
                "vtt": _relative_path(vtt_path, project_dir),
                "json": _relative_path(timeline_path, project_dir),
                "cue_count": len(cues),
            },
            "artifacts": {
                "manifest": _relative_path(manifest_path, project_dir),
                "manifest_sha256": _sha256(manifest_path),
            },
            "bgm": {"status": "deferred"},
        }
    except Exception as exc:
        return {
            "status": "failed",
            "project_id": model.project_id,
            "would_generate": False,
            "dry_run": False,
            "error": _safe_error(exc),
        }
    finally:
        temp_audio.unlink(missing_ok=True)


def _require_paid_audio_authorization(authorization: str | None) -> None:
    expected = os.environ.get("WEB_API_PAID_AUTH_TOKEN")
    if not expected:
        raise HTTPException(status_code=503, detail="paid audio generation is not configured")
    if not authorization or not secrets.compare_digest(authorization, expected):
        raise HTTPException(status_code=403, detail="invalid generation authorization")


def create_audio_app(
    *,
    selector: Any | None = None,
    project_root: str | Path = DEFAULT_PROJECT_ROOT,
) -> FastAPI:
    """Create a mountable FastAPI app for narration and subtitle artifacts."""

    application = FastAPI(title="OpenMontage Narration API", version="0.1.0")
    application.state.selector = selector
    application.state.project_root = Path(project_root)

    origin = os.environ.get("WEB_ORIGIN", "http://127.0.0.1:3010")
    application.add_middleware(
        CORSMiddleware,
        allow_origins=[origin],
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type", "X-Generation-Authorization"],
    )

    def get_selector() -> Any:
        if application.state.selector is None:
            application.state.selector = TTSSelector()
        return application.state.selector

    @application.get("/api/audio/health")
    def health() -> dict[str, Any]:
        chosen = get_selector()
        status = _selector_status(chosen)
        providers = _provider_snapshot(chosen)
        diagnostics = {
            str(provider["provider"]): provider["diagnostics"]
            for provider in providers
            if provider.get("diagnostics")
        }
        # BGM is a separate post-video stage.  Report the real provider
        # capability here instead of the old static ``deferred`` placeholder,
        # while keeping the narration manifest's deferred marker (that marker
        # describes a particular narration artifact, not provider health).
        try:
            from tools.audio.music_gen import MusicGen

            music_tool = MusicGen()
            music_status = _status_name(music_tool.get_status())
            music_provider = getattr(music_tool, "provider", "elevenlabs")
            music_dependencies = list(getattr(music_tool, "dependencies", []) or [])
        except Exception:
            music_status = "unknown"
            music_provider = "elevenlabs"
            music_dependencies = ["env:ELEVENLABS_API_KEY"]
        return {
            "status": "ok" if status == "available" else "degraded",
            "selector_status": status,
            "providers": providers,
            # This is a credential-safe summary for the workbench.  It only
            # contains allow-listed booleans and configuration names; no key
            # value is ever serialized into the health response.
            "diagnostics": diagnostics,
            "paid_authorization_configured": bool(
                os.environ.get("WEB_API_PAID_AUTH_TOKEN")
            ),
            "ffprobe_configured": shutil.which("ffprobe") is not None,
            "bgm": {
                "status": music_status,
                "provider": music_provider,
                "post_video": True,
                "dependencies": music_dependencies,
                "reference_support": "textualized_local_reference_only",
            },
        }

    @application.post("/api/audio/estimate")
    def estimate(request: AudioPipelineRequest) -> dict[str, Any]:
        return estimate_audio_pipeline(request, selector=get_selector())

    @application.post("/api/audio/render")
    def render(
        request: AudioPipelineRequest,
        x_generation_authorization: str | None = Header(
            default=None, alias="X-Generation-Authorization"
        ),
    ) -> dict[str, Any]:
        # dry_run remains free and never needs an auth header.  Both flags are
        # checked so a client cannot accidentally turn a preview into a paid
        # call by only toggling one boolean.
        if request.dry_run or not request.execute:
            return render_audio_pipeline(
                request,
                selector=get_selector(),
                project_root=application.state.project_root,
                authorized=False,
            )
        if not request.confirm:
            raise HTTPException(
                status_code=400,
                detail="confirm=true is required for paid narration generation",
            )
        # The creator's explicit button click is still required for local
        # narration, but a Mac built-in voice has no provider charge or secret
        # to authorize. Cloud voices continue through the paid authorization
        # gate even when a local fallback is installed.
        local_only = _local_tts_selection(get_selector(), request)
        if not local_only:
            _require_paid_audio_authorization(x_generation_authorization)
        return render_audio_pipeline(
            request,
            selector=get_selector(),
            project_root=application.state.project_root,
            authorized=True,
        )

    return application


app = create_audio_app()


__all__ = [
    "AudioPipelineRequest",
    "NarrationSegment",
    "app",
    "create_audio_app",
    "estimate_audio_pipeline",
    "render_audio_pipeline",
]
