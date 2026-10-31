"""Local media stages exposed by the OpenMontage web workbench.

This module fills the parts of the upstream pipeline that are useful even
when an external provider is not configured: local transcription and subtitle
timelines, image provider ranking, local multi-clip composition, and technical
media QA.
Network-backed image generation remains behind the same explicit authorization
used by narration and Seedance.  Every write is project-scoped and produces a
small manifest with file hashes so the Backlot board can show what really
exists on disk.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import secrets
import shutil
import subprocess
import tempfile
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator, Mapping, Sequence

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from backlot.server import notify_project_changed
from lib.events import emit_event
from tools.base_tool import ToolStatus, ToolResult
from tools.audio.audio_enhance import AudioEnhance
from tools.audio.audio_mixer import AudioMixer
from tools.analysis.face_tracker import FaceTracker
from tools.analysis.frame_sampler import FrameSampler
from tools.analysis.transcriber import Transcriber
from tools.analysis.scene_detect import SceneDetect
from tools.enhancement.color_grade import ColorGrade
from tools.analysis.video_analyzer import VideoAnalyzer
from tools.graphics.image_selector import ImageSelector
from tools.publishers.export_bundle import ExportBundle
from tools.subtitle.subtitle_gen import SubtitleGen
from tools.video.auto_reframe import AutoReframe
from tools.video.silence_cutter import SilenceCutter
from tools.video.video_stitch import VideoStitch
from tools.video.video_trimmer import VideoTrimmer


PROJECT_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
SAFE_FILE_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
DEFAULT_PROJECT_ROOT = Path(__file__).resolve().parent.parent / "projects"
MEDIA_VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".webm", ".mkv"}
MEDIA_AUDIO_EXTENSIONS = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"}
MEDIA_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}

# Storyboard batches run in the model-adapter worker, while this module keeps
# the public FastAPI route intentionally unchanged.  A context-local callback
# lets the worker receive one durable progress event after every written image
# without exposing an internal callback as a query/body parameter.
ImageProgressCallback = Callable[[dict[str, Any]], None]
_IMAGE_PROGRESS_CALLBACK: ContextVar[ImageProgressCallback | None] = ContextVar(
    "openmontage_image_progress_callback",
    default=None,
)


@contextmanager
def image_progress_context(callback: ImageProgressCallback | None) -> Iterator[None]:
    """Temporarily route per-image progress to a background-job callback."""

    token = _IMAGE_PROGRESS_CALLBACK.set(callback)
    try:
        yield
    finally:
        _IMAGE_PROGRESS_CALLBACK.reset(token)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_json(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, Mapping):
        return {str(k): _safe_json(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_safe_json(v) for v in value]
    return str(value)


def _status_name(value: Any) -> str:
    raw = getattr(value, "value", value)
    text = str(raw or "unknown").lower()
    if text.endswith(".available"):
        return "available"
    if text.endswith(".unavailable"):
        return "unavailable"
    if text.endswith(".degraded"):
        return "degraded"
    return text if text in {"available", "unavailable", "degraded"} else "unknown"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _sha256_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _relative(project_dir: Path, path: Path) -> str:
    return path.resolve().relative_to(project_dir.resolve()).as_posix()


def _resolve_project(root: str | Path, project_id: str) -> Path:
    if not PROJECT_ID_PATTERN.fullmatch(project_id):
        raise ValueError("project_id contains unsupported path characters")
    root_path = Path(root).expanduser().resolve()
    project_dir = (root_path / project_id).resolve()
    if project_dir.parent != root_path or not project_dir.is_dir():
        raise FileNotFoundError(f"project does not exist: {project_id}")
    return project_dir


def _resolve_project_file(project_dir: Path, raw_path: str, *, must_exist: bool = True) -> Path:
    """Resolve a project-relative path and reject traversal/absolute paths."""

    if not isinstance(raw_path, str) or not raw_path.strip():
        raise ValueError("media path must be a non-empty project-relative path")
    candidate = Path(raw_path.strip())
    if candidate.is_absolute() or ".." in candidate.parts:
        raise ValueError("media paths must stay inside the project")
    resolved = (project_dir / candidate).resolve()
    try:
        resolved.relative_to(project_dir.resolve())
    except ValueError as exc:
        raise ValueError("media path escaped the project") from exc
    if must_exist and (not resolved.is_file()):
        raise FileNotFoundError(f"media file does not exist: {raw_path}")
    return resolved


def _atomic_bytes(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".part")
    tmp = Path(name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def _write_manifest(project_dir: Path, name: str, payload: Mapping[str, Any]) -> tuple[Path, str]:
    path = project_dir / "artifacts" / name
    content = json.dumps(_safe_json(dict(payload)), ensure_ascii=False, indent=2).encode("utf-8") + b"\n"
    _atomic_bytes(path, content)
    return path, _sha256(path)


def _write_stage_checkpoint(
    project_dir: Path,
    stage: str,
    status: str,
    *,
    artifacts: Mapping[str, str],
    human_approval_required: bool = False,
    human_approved: bool = False,
    metadata: Mapping[str, Any] | None = None,
) -> Path:
    """Persist a small resumable checkpoint for a local media stage.

    Backlot derives its stage rail from these files.  Media endpoints used to
    write a manifest only, so the board could not tell that compose/publish
    had really finished.  This helper deliberately uses the same checkpoint
    shape as the upstream pipeline and keeps a history copy for replay.
    """

    now = _utc_now()
    checkpoint = {
        "version": "1.0",
        "project_id": project_dir.name,
        "pipeline_type": "cinematic",
        "stage": stage,
        "status": status,
        "timestamp": now,
        "checkpoint_policy": "guided",
        "human_approval_required": human_approval_required,
        "human_approved": human_approved,
        "artifacts": dict(artifacts),
        "style_playbook": "scenic-cinematic",
        "metadata": dict(metadata or {}),
    }
    current = project_dir / f"checkpoint_{stage}.json"
    content = json.dumps(_safe_json(checkpoint), ensure_ascii=False, indent=2).encode("utf-8") + b"\n"
    _atomic_bytes(current, content)
    history_name = f"checkpoint_{stage}_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S%f')}.json"
    _atomic_bytes(project_dir / "history" / history_name, content)
    return current


def _tool_result_parts(raw: Any) -> tuple[bool, dict[str, Any], str | None]:
    if isinstance(raw, ToolResult):
        return bool(raw.success), dict(_safe_json(raw.data or {})), raw.error
    if isinstance(raw, Mapping):
        nested = raw.get("data")
        data = nested if isinstance(nested, Mapping) else raw
        return bool(raw.get("success", data.get("valid", True))), dict(_safe_json(data)), raw.get("error")
    data = getattr(raw, "data", {})
    return bool(getattr(raw, "success", False)), dict(_safe_json(data or {})), getattr(raw, "error", None)


def _selector_snapshot(selector: Any, *, capability: str) -> list[dict[str, Any]]:
    try:
        providers = selector._providers()
    except Exception:
        providers = []
    rows: list[dict[str, Any]] = []
    for provider in providers:
        # Capability discovery is a read-only health check.  One broken or
        # partially-installed provider must not make the whole workbench's
        # capability endpoint fail; report that provider as unknown instead.
        try:
            status = _status_name(provider.get_status())
        except Exception:
            status = "unknown"
        try:
            info = provider.get_info() if callable(getattr(provider, "get_info", None)) else {}
        except Exception:
            info = {}
        runtime = getattr(provider, "runtime", "")
        rows.append({
            "name": getattr(provider, "name", None),
            "provider": getattr(provider, "provider", None),
            "status": status,
            "runtime": str(getattr(runtime, "value", runtime) or "").lower() or None,
            "capability": capability,
            "dependencies": _safe_json(info.get("dependencies", [])) if isinstance(info, Mapping) else [],
            "install_instructions": info.get("install_instructions") if isinstance(info, Mapping) else None,
        })
    return rows


def _local_provider_available(selector: Any) -> bool:
    """Return whether a selector exposes at least one healthy local provider.

    The web capability panel uses this only for truthful UX: a local provider
    such as macOS ``say`` does not need a paid token, while cloud providers do.
    Provider-specific selection rules remain enforced by the audio route.
    """

    try:
        providers = selector._providers()
    except Exception:
        providers = []
    for provider in providers:
        try:
            status = _status_name(provider.get_status())
        except Exception:
            status = "unknown"
        runtime = getattr(provider, "runtime", "")
        runtime_name = str(getattr(runtime, "value", runtime) or "").lower()
        if status == "available" and runtime_name in {"local", "local_gpu"}:
            return True
    return False


class SubtitleSegment(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=128)
    text: str = Field(min_length=1, max_length=20_000)
    start_seconds: float | None = Field(default=None, ge=0)
    end_seconds: float | None = Field(default=None, ge=0)
    start: float | None = Field(default=None, ge=0)
    end: float | None = Field(default=None, ge=0)
    speaker: str | None = Field(default=None, max_length=128)
    words: list[dict[str, Any]] | None = None

    @field_validator("id", "text", "speaker")
    @classmethod
    def _trim(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise ValueError("must not be blank")
        return value


class SubtitleRenderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1, max_length=128)
    segments: list[SubtitleSegment] = Field(min_length=1, max_length=500)
    formats: list[str] = Field(default_factory=lambda: ["srt", "vtt", "json"], min_length=1, max_length=3)
    max_chars_per_line: int = Field(default=42, ge=4, le=200)
    max_words_per_cue: int = Field(default=8, ge=1, le=50)
    highlight_style: str = Field(default="none", pattern="^(none|word_by_word|karaoke)$")
    corrections: dict[str, str] | None = None
    dry_run: bool = True
    execute: bool = False

    @field_validator("project_id")
    @classmethod
    def _safe_project(cls, value: str) -> str:
        value = value.strip()
        if not PROJECT_ID_PATTERN.fullmatch(value):
            raise ValueError("project_id contains unsupported path characters")
        return value

    @field_validator("formats")
    @classmethod
    def _formats(cls, values: list[str]) -> list[str]:
        cleaned = [str(v).strip().lower() for v in values]
        if not cleaned or any(v not in {"srt", "vtt", "json"} for v in cleaned):
            raise ValueError("formats must contain only srt, vtt, or json")
        return list(dict.fromkeys(cleaned))


class TranscriptRequest(BaseModel):
    """Request a real local transcription and timed subtitle artifacts.

    ``dry_run`` remains the safe default.  A caller must explicitly send both
    ``execute=true`` and ``confirm=true`` before the local recognizer can run
    and write files.  The media path is always project-relative so the API
    cannot be used to read arbitrary files on the host.
    """

    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1, max_length=128)
    media_path: str = Field(min_length=1, max_length=1024)
    language: str | None = Field(default=None, max_length=16)
    model_size: str = Field(default="base", pattern="^(tiny|base|small|medium|large-v2|large-v3)$")
    diarize: bool = False
    alignment: str = Field(default='faster_whisper', pattern='^(faster_whisper|whisperx_zh)$')
    formats: list[str] = Field(default_factory=lambda: ["srt", "vtt", "json"], min_length=1, max_length=3)
    max_chars_per_line: int = Field(default=42, ge=4, le=200)
    max_words_per_cue: int = Field(default=8, ge=1, le=50)
    highlight_style: str = Field(default="none", pattern="^(none|word_by_word|karaoke)$")
    corrections: dict[str, str] | None = None
    dry_run: bool = True
    execute: bool = False
    confirm: bool = False

    @field_validator("project_id")
    @classmethod
    def _safe_project(cls, value: str) -> str:
        value = value.strip()
        if not PROJECT_ID_PATTERN.fullmatch(value):
            raise ValueError("project_id contains unsupported path characters")
        return value

    @field_validator("media_path")
    @classmethod
    def _safe_media_path(cls, value: str) -> str:
        value = value.strip()
        path = Path(value)
        if not value or path.is_absolute() or ".." in path.parts:
            raise ValueError("media_path must be a project-relative path")
        return value

    @field_validator("language")
    @classmethod
    def _trim_language(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip().lower()
        return value or None

    @field_validator("formats")
    @classmethod
    def _formats(cls, values: list[str]) -> list[str]:
        cleaned = [str(v).strip().lower() for v in values]
        if not cleaned or any(v not in {"srt", "vtt", "json"} for v in cleaned):
            raise ValueError("formats must contain only srt, vtt, or json")
        return list(dict.fromkeys(cleaned))


class FrameSampleRequest(BaseModel):
    """Sample real video frames for local review or downstream analysis.

    The frame sampler is deliberately kept separate from reference-video
    analysis: callers can inspect a finished project video without invoking
    any model.  ``dry_run`` is the safe default and the explicit confirmation
    flag is required before files are written.
    """

    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1, max_length=128)
    media_path: str = Field(min_length=1, max_length=1024)
    strategy: str = Field(default="count", pattern="^(interval|count|timestamps|scene_guided)$")
    interval_seconds: float = Field(default=5.0, ge=0.1, le=3600)
    count: int = Field(default=8, ge=1, le=200)
    timestamps: list[float] = Field(default_factory=list, max_length=200)
    scene_boundaries: list[dict[str, float]] = Field(default_factory=list, max_length=200)
    max_frames: int = Field(default=20, ge=1, le=200)
    format: str = Field(default="jpg", pattern="^(jpg|png)$")
    quality: int = Field(default=2, ge=1, le=31)
    dry_run: bool = True
    execute: bool = False
    confirm: bool = False

    @field_validator("project_id")
    @classmethod
    def _safe_project(cls, value: str) -> str:
        value = value.strip()
        if not PROJECT_ID_PATTERN.fullmatch(value):
            raise ValueError("project_id contains unsupported path characters")
        return value

    @field_validator("media_path")
    @classmethod
    def _safe_media_path(cls, value: str) -> str:
        value = value.strip()
        path = Path(value)
        if not value or path.is_absolute() or ".." in path.parts:
            raise ValueError("media_path must be a project-relative path")
        return value

    @field_validator("timestamps")
    @classmethod
    def _timestamps_are_finite(cls, values: list[float]) -> list[float]:
        cleaned = [float(value) for value in values]
        if any(not math.isfinite(value) or value < 0 for value in cleaned):
            raise ValueError("timestamps must contain finite non-negative seconds")
        return cleaned

    @field_validator("scene_boundaries")
    @classmethod
    def _scene_boundaries_are_valid(cls, values: list[dict[str, float]]) -> list[dict[str, float]]:
        cleaned: list[dict[str, float]] = []
        for item in values:
            if not isinstance(item, Mapping):
                raise ValueError("scene_boundaries must contain objects")
            start = float(item.get("start_seconds", 0))
            end = float(item.get("end_seconds", 0))
            if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start:
                raise ValueError("scene boundaries must have finite start/end seconds")
            cleaned.append({"start_seconds": start, "end_seconds": end})
        return cleaned


class FaceTrackRequest(BaseModel):
    """Track faces in one project-local video with the real local tool."""

    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1, max_length=128)
    media_path: str = Field(min_length=1, max_length=1024)
    sample_fps: float = Field(default=5.0, ge=0.1, le=60)
    min_detection_confidence: float = Field(default=0.5, ge=0, le=1)
    dry_run: bool = True
    execute: bool = False
    confirm: bool = False

    @field_validator("project_id")
    @classmethod
    def _safe_project(cls, value: str) -> str:
        value = value.strip()
        if not PROJECT_ID_PATTERN.fullmatch(value):
            raise ValueError("project_id contains unsupported path characters")
        return value

    @field_validator("media_path")
    @classmethod
    def _safe_media_path(cls, value: str) -> str:
        value = value.strip()
        path = Path(value)
        if not value or path.is_absolute() or ".." in path.parts:
            raise ValueError("media_path must be a project-relative path")
        return value


class ReferenceReviewRequest(BaseModel):
    """Analyze a local reference video and save reusable research artifacts.

    OpenMontage treats a reference clip as research input rather than as a
    video to copy blindly.  The browser may provide either a project-relative
    path or an explicitly selected absolute local path; the result is always
    written inside the selected project.  URL downloading is intentionally
    not implicit in this endpoint so a pasted link cannot start network work
    without a future, explicit opt-in.
    """

    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1, max_length=128)
    source: str = Field(min_length=1, max_length=4096)
    analysis_depth: str = Field(default="standard", pattern="^(transcript_only|standard|deep)$")
    max_keyframes: int = Field(default=20, ge=1, le=50)
    dry_run: bool = True
    execute: bool = False
    confirm: bool = False

    @field_validator("project_id")
    @classmethod
    def _safe_project(cls, value: str) -> str:
        value = value.strip()
        if not PROJECT_ID_PATTERN.fullmatch(value):
            raise ValueError("project_id contains unsupported path characters")
        return value

    @field_validator("source")
    @classmethod
    def _trim_source(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("source must not be blank")
        return value


class StockSearchRequest(BaseModel):
    """Search and download free stock B-roll through OpenMontage adapters.

    The upstream project keeps source adapters behind ``direct_clip_search``
    so the director can fan out to Archive.org, NASA, Wikimedia and other
    providers without provider-specific UI code.  This request exposes that
    capability safely: dry-run is the default, downloads stay inside the
    selected project, and an explicit confirmation is required before network
    requests and file writes begin.
    """

    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1, max_length=128)
    queries: list[str] = Field(min_length=1, max_length=12)
    # Each query may serve one or more storyboard shots.  An empty value keeps
    # the original query-only contract compatible with existing callers.
    query_shot_ids: list[list[str]] = Field(default_factory=list, max_length=12)
    sources: list[str] | None = Field(default=None, max_length=16)
    kind: str = Field(default="video", pattern="^(video|image|any)$")
    clips_per_query: int = Field(default=3, ge=1, le=20)
    min_duration: float | None = Field(default=None, ge=0)
    max_duration: float | None = Field(default=None, ge=0)
    orientation: str | None = Field(default=None, pattern="^(landscape|portrait|square)$")
    min_width: int | None = Field(default=None, ge=1, le=20000)
    extract_thumbnails: bool = True
    timeout_seconds: float = Field(default=120, ge=1, le=900)
    dry_run: bool = True
    execute: bool = False
    confirm: bool = False

    @field_validator("query_shot_ids")
    @classmethod
    def _clean_query_shot_ids(cls, value: list[list[str]]) -> list[list[str]]:
        cleaned: list[list[str]] = []
        for shot_ids in value:
            ids = [str(shot_id).strip() for shot_id in shot_ids if str(shot_id).strip()]
            if len(ids) != len(shot_ids):
                raise ValueError("query_shot_ids must contain non-empty shot IDs")
            cleaned.append(ids)
        return cleaned

    @model_validator(mode="after")
    def _query_shot_ids_match_queries(self) -> "StockSearchRequest":
        if self.query_shot_ids and len(self.query_shot_ids) != len(self.queries):
            raise ValueError("query_shot_ids must have one entry per query")
        return self

    @field_validator("project_id")
    @classmethod
    def _safe_project(cls, value: str) -> str:
        value = value.strip()
        if not PROJECT_ID_PATTERN.fullmatch(value):
            raise ValueError("project_id contains unsupported path characters")
        return value

    @field_validator("queries")
    @classmethod
    def _clean_queries(cls, values: list[str]) -> list[str]:
        cleaned = [str(value).strip() for value in values]
        if not cleaned or any(not value for value in cleaned):
            raise ValueError("queries must contain non-empty search terms")
        return cleaned

    @field_validator("sources")
    @classmethod
    def _clean_sources(cls, values: list[str] | None) -> list[str] | None:
        if values is None:
            return None
        cleaned = [str(value).strip() for value in values if str(value).strip()]
        return list(dict.fromkeys(cleaned)) or None

    @field_validator("max_duration")
    @classmethod
    def _duration_order(cls, value: float | None, info) -> float | None:
        minimum = info.data.get("min_duration")
        if value is not None and minimum is not None and value < minimum:
            raise ValueError("max_duration must be greater than or equal to min_duration")
        return value


class TrimRequest(BaseModel):
    """Cut one project-local video into a reusable derived segment.

    OpenMontage's ``video_trimmer`` is deliberately exposed as a separate
    stage instead of hiding it inside composition: creators can inspect the
    source and choose exact in/out points before the segment enters the edit.
    ``dry_run`` is the safe default; local execution never calls a paid model.
    """

    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1, max_length=128)
    input_path: str = Field(min_length=1, max_length=1024)
    start_seconds: float = Field(default=0, ge=0)
    end_seconds: float | None = Field(default=None, ge=0)
    codec: str = Field(default="libx264", pattern="^(libx264|copy)$")
    output_name: str = Field(default="segment-01.mp4", max_length=128)
    dry_run: bool = True
    execute: bool = False

    @field_validator("project_id")
    @classmethod
    def _safe_project(cls, value: str) -> str:
        value = value.strip()
        if not PROJECT_ID_PATTERN.fullmatch(value):
            raise ValueError("project_id contains unsupported path characters")
        return value

    @field_validator("input_path")
    @classmethod
    def _safe_input(cls, value: str) -> str:
        value = value.strip()
        path = Path(value)
        if not value or path.is_absolute() or ".." in path.parts:
            raise ValueError("input_path must be a project-relative path")
        return value

    @field_validator("output_name")
    @classmethod
    def _safe_output(cls, value: str) -> str:
        value = value.strip()
        if not SAFE_FILE_PATTERN.fullmatch(value) or Path(value).suffix.lower() not in MEDIA_VIDEO_EXTENSIONS:
            raise ValueError("output_name must be a safe supported video filename")
        return value

    @field_validator("end_seconds")
    @classmethod
    def _end_after_start(cls, value: float | None, info) -> float | None:
        start = info.data.get("start_seconds", 0)
        if value is not None and value <= start:
            raise ValueError("end_seconds must be greater than start_seconds")
        return value


class VideoPostprocessRequest(BaseModel):
    """Run one deterministic OpenMontage video-analysis/edit operation.

    The endpoint intentionally groups the small, local post-production tools
    behind one request so the workbench can offer a single ``video finishing``
    surface without pretending that these are generative video models.  The
    default is always a dry run; only an explicit ``execute=true`` writes a
    derived video or JSON report.
    """

    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1, max_length=128)
    operation: str = Field(default="silence_cut", pattern="^(silence_cut|scene_detect|auto_reframe|color_grade)$")
    input_path: str = Field(min_length=1, max_length=1024)
    output_name: str = Field(default="processed-video.mp4", max_length=128)

    # SilenceCutter options.  ``mark`` creates a JSON report without changing
    # the source video; ``remove`` and ``speed_up`` create a derived video.
    mode: str = Field(default="remove", pattern="^(remove|speed_up|mark)$")
    silence_threshold_db: float = Field(default=-35, ge=-90, le=-1)
    min_silence_duration: float = Field(default=0.5, ge=0.1, le=60)
    padding_seconds: float = Field(default=0.08, ge=0, le=10)
    silence_speed_factor: float = Field(default=6, ge=1.5, le=100)

    # AutoReframe options.  The tool uses face tracking when available and
    # falls back to a deterministic center crop when it is not installed.
    target_aspect: str = Field(default="portrait", pattern="^(portrait|square|landscape|cinematic|vertical_4_5)$")
    target_width: int | None = Field(default=None, ge=64, le=8192)
    target_height: int | None = Field(default=None, ge=64, le=8192)
    face_tracking_json: str | None = Field(default=None, max_length=1024)
    smoothing_window: int = Field(default=15, ge=1, le=300)
    face_padding: float = Field(default=0.4, ge=0, le=1)

    # ColorGrade options.
    profile: str = Field(default="cinematic_warm", pattern="^(cinematic_warm|cinematic_cool|moody_dark|bright_clean|vintage_film|high_contrast|neutral)$")
    intensity: float = Field(default=1, ge=0, le=1)

    # SceneDetect options.
    scene_method: str = Field(default="content", pattern="^(content|threshold|adaptive)$")
    scene_threshold: float | None = Field(default=None, ge=0)
    min_scene_length_seconds: float = Field(default=1, ge=0.1, le=300)

    dry_run: bool = True
    execute: bool = False

    @field_validator("project_id")
    @classmethod
    def _safe_project(cls, value: str) -> str:
        value = value.strip()
        if not PROJECT_ID_PATTERN.fullmatch(value):
            raise ValueError("project_id contains unsupported path characters")
        return value

    @field_validator("input_path", "face_tracking_json")
    @classmethod
    def _safe_relative_path(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        path = Path(value)
        if not value or path.is_absolute() or ".." in path.parts:
            raise ValueError("video paths must be project-relative")
        return value

    @field_validator("output_name")
    @classmethod
    def _safe_output(cls, value: str) -> str:
        value = value.strip()
        if not SAFE_FILE_PATTERN.fullmatch(value):
            raise ValueError("output_name must be a safe filename")
        return value

    @model_validator(mode="after")
    def _target_dimensions_pair(self) -> "VideoPostprocessRequest":
        if (self.target_width is None) != (self.target_height is None):
            raise ValueError("target_width and target_height must be provided together")
        return self


class AudioTrack(BaseModel):
    """One project-local audio layer used by the OpenMontage mixer."""

    model_config = ConfigDict(extra="forbid")

    path: str = Field(min_length=1, max_length=1024)
    role: str = Field(pattern="^(speech|music|sfx|primary|secondary)$")
    volume: float = Field(default=1.0, ge=0, le=1)
    start_seconds: float = Field(default=0, ge=0)
    fade_in_seconds: float = Field(default=0, ge=0, le=60)
    fade_out_seconds: float = Field(default=0, ge=0, le=60)

    @field_validator("path")
    @classmethod
    def _safe_path(cls, value: str) -> str:
        value = value.strip()
        path = Path(value)
        if not value or path.is_absolute() or ".." in path.parts:
            raise ValueError("audio track paths must stay inside the project")
        return value


class AudioMixRequest(BaseModel):
    """Run a real local FFmpeg audio operation with a safe dry-run first."""

    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1, max_length=128)
    operation: str = Field(default="full_mix", pattern="^(mix|duck|extract|full_mix|segmented_music)$")
    tracks: list[AudioTrack] = Field(default_factory=list, max_length=100)
    primary_audio: str | None = Field(default=None, max_length=1024)
    secondary_audio: str | None = Field(default=None, max_length=1024)
    duck_level: float = Field(default=-12, ge=-60, le=0)
    input_path: str | None = Field(default=None, max_length=1024)
    video_path: str | None = Field(default=None, max_length=1024)
    music_path: str | None = Field(default=None, max_length=1024)
    ducking_enabled: bool = True
    music_volume_during_speech: float = Field(default=0.15, ge=0, le=1)
    attack_ms: float = Field(default=200, ge=0, le=10_000)
    release_ms: float = Field(default=500, ge=0, le=10_000)
    normalize: bool = True
    loudnorm_target: float = Field(default=-16, ge=-40, le=0)
    music_volume: float = Field(default=0.2, ge=0, le=1)
    segments: list[dict[str, float]] = Field(default_factory=list, max_length=100)
    fade_duration: float = Field(default=0.5, ge=0, le=10)
    target_duration: float | None = Field(default=None, gt=0, le=86_400)
    output_name: str = Field(default="openmontage-mix.wav", max_length=128)
    dry_run: bool = True
    execute: bool = False

    @field_validator("project_id")
    @classmethod
    def _safe_project(cls, value: str) -> str:
        value = value.strip()
        if not PROJECT_ID_PATTERN.fullmatch(value):
            raise ValueError("project_id contains unsupported path characters")
        return value

    @field_validator("primary_audio", "secondary_audio", "input_path", "video_path", "music_path")
    @classmethod
    def _safe_optional_path(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        path = Path(value)
        if not value or path.is_absolute() or ".." in path.parts:
            raise ValueError("audio paths must stay inside the project")
        return value

    @field_validator("output_name")
    @classmethod
    def _safe_output(cls, value: str) -> str:
        value = value.strip()
        if not SAFE_FILE_PATTERN.fullmatch(value):
            raise ValueError("output_name must be a safe filename")
        suffix = Path(value).suffix.lower()
        if suffix not in MEDIA_AUDIO_EXTENSIONS | MEDIA_VIDEO_EXTENSIONS:
            raise ValueError("output_name must use a supported audio or video extension")
        return value

    @field_validator("segments")
    @classmethod
    def _valid_segments(cls, values: list[dict[str, float]]) -> list[dict[str, float]]:
        cleaned: list[dict[str, float]] = []
        for item in values:
            try:
                start = float(item.get("start"))
                end = float(item.get("end"))
            except (AttributeError, TypeError, ValueError) as exc:
                raise ValueError("segments require numeric start and end") from exc
            if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start:
                raise ValueError("each segment requires end greater than non-negative start")
            cleaned.append({"start": start, "end": end})
        return cleaned


class AudioEnhanceRequest(BaseModel):
    """Clean or normalize one project-local audio/video file with FFmpeg."""

    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1, max_length=128)
    input_path: str = Field(min_length=1, max_length=1024)
    preset: str = Field(default="clean_speech", pattern="^(clean_speech|noise_reduce|normalize_only|podcast|broadcast|voice_clarity)$")
    output_name: str = Field(default="enhanced-audio.wav", max_length=128)
    dry_run: bool = True
    execute: bool = False

    @field_validator("project_id")
    @classmethod
    def _safe_project(cls, value: str) -> str:
        value = value.strip()
        if not PROJECT_ID_PATTERN.fullmatch(value):
            raise ValueError("project_id contains unsupported path characters")
        return value

    @field_validator("input_path")
    @classmethod
    def _safe_input(cls, value: str) -> str:
        value = value.strip()
        path = Path(value)
        if not value or path.is_absolute() or ".." in path.parts:
            raise ValueError("input_path must be a project-relative path")
        return value

    @field_validator("output_name")
    @classmethod
    def _safe_output(cls, value: str) -> str:
        value = value.strip()
        if not SAFE_FILE_PATTERN.fullmatch(value):
            raise ValueError("output_name must be a safe filename")
        suffix = Path(value).suffix.lower()
        if suffix not in MEDIA_AUDIO_EXTENSIONS | MEDIA_VIDEO_EXTENSIONS:
            raise ValueError("output_name must use a supported audio or video extension")
        return value


class ImageShot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=128)
    prompt: str = Field(min_length=2, max_length=20_000)
    negative_prompt: str | None = Field(default=None, max_length=20_000)
    width: int | None = Field(default=None, ge=64, le=8192)
    height: int | None = Field(default=None, ge=64, le=8192)
    aspect_ratio: str | None = Field(default=None, max_length=16)
    resolution: str | None = Field(default=None, max_length=32)
    seed: int | None = None

    @field_validator("id", "prompt", "negative_prompt")
    @classmethod
    def _trim(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise ValueError("must not be blank")
        return value


class ImagePipelineRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1, max_length=128)
    shots: list[ImageShot] = Field(min_length=1, max_length=100)
    preferred_provider: str = "auto"
    allowed_providers: list[str] | None = None
    dry_run: bool = True
    execute: bool = False
    confirm: bool = False

    @field_validator("project_id")
    @classmethod
    def _safe_project(cls, value: str) -> str:
        value = value.strip()
        if not PROJECT_ID_PATTERN.fullmatch(value):
            raise ValueError("project_id contains unsupported path characters")
        return value


class ComposeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1, max_length=128)
    clips: list[str] = Field(min_length=1, max_length=100)
    transition: str = Field(default="cut", pattern="^(cut|crossfade|fade)$")
    transition_duration: float = Field(default=0.5, ge=0.1, le=5)
    auto_normalize: bool = True
    audio_path: str | None = None
    subtitle_path: str | None = None
    output_name: str = Field(default="openmontage-compose.mp4", max_length=128)
    dry_run: bool = True
    execute: bool = False


class StillComposeRequest(BaseModel):
    """Turn storyboard stills into motion clips, then compose them locally.

    This is OpenMontage's useful no-video-provider fallback: each clean
    storyboard image receives a restrained Ken-Burns-style push, and the
    resulting clips go through the same FFmpeg transition/mux/manifest path as
    provider videos.  It is local-only and never pretends to be a video model.
    """

    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1, max_length=128)
    images: list[str] = Field(min_length=1, max_length=100)
    durations: list[float] | None = Field(default=None, max_length=100)
    default_duration_seconds: float = Field(default=5.0, ge=1.0, le=60.0)
    transition: str = Field(default="crossfade", pattern="^(cut|crossfade|fade)$")
    transition_duration: float = Field(default=0.5, ge=0.1, le=5)
    audio_path: str | None = None
    subtitle_path: str | None = None
    output_name: str = Field(default="openmontage-stills-compose.mp4", max_length=128)
    width: int = Field(default=720, ge=160, le=3840)
    height: int = Field(default=1280, ge=160, le=3840)
    fps: int = Field(default=24, ge=12, le=60)
    dry_run: bool = True
    execute: bool = False

    @field_validator("project_id")
    @classmethod
    def _safe_project(cls, value: str) -> str:
        value = value.strip()
        if not PROJECT_ID_PATTERN.fullmatch(value):
            raise ValueError("project_id contains unsupported path characters")
        return value

    @field_validator("images")
    @classmethod
    def _safe_images(cls, values: list[str]) -> list[str]:
        cleaned = [str(value).strip() for value in values]
        if not cleaned or any(not value for value in cleaned):
            raise ValueError("images must contain non-empty project-relative paths")
        for value in cleaned:
            path = Path(value)
            if path.is_absolute() or ".." in path.parts:
                raise ValueError("image paths must stay inside the project")
        return cleaned

    @field_validator("durations")
    @classmethod
    def _safe_durations(cls, values: list[float] | None) -> list[float] | None:
        if values is None:
            return None
        if not values:
            raise ValueError("durations cannot be empty when provided")
        if any(not math.isfinite(float(value)) or float(value) < 1 or float(value) > 60 for value in values):
            raise ValueError("durations must be between 1 and 60 seconds")
        return [float(value) for value in values]

    @field_validator("audio_path", "subtitle_path")
    @classmethod
    def _safe_optional_path(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        path = Path(value)
        if not value or path.is_absolute() or ".." in path.parts:
            raise ValueError("optional media paths must be project-relative")
        return value

    @field_validator("output_name")
    @classmethod
    def _safe_output(cls, value: str) -> str:
        value = value.strip()
        if not SAFE_FILE_PATTERN.fullmatch(value) or not value.lower().endswith(".mp4"):
            raise ValueError("output_name must be a safe .mp4 filename")
        return value

class QualityRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1, max_length=128)
    media_paths: list[str] = Field(min_length=1, max_length=200)
    expected_duration_seconds: float | None = Field(default=None, ge=0)
    sample_frames: int = Field(default=4, ge=0, le=12)
    check_audio: bool = True
    check_black_frames: bool = True
    check_subtitles: bool = True
    execute: bool = False

    @field_validator("project_id")
    @classmethod
    def _safe_project(cls, value: str) -> str:
        value = value.strip()
        if not PROJECT_ID_PATTERN.fullmatch(value):
            raise ValueError("project_id contains unsupported path characters")
        return value


class PublishRequest(BaseModel):
    """Package a verified local render for hand-off to a creator.

    This is intentionally a local export, not an upload API.  It mirrors the
    OpenMontage publish stage while keeping the browser inside the project
    directory and requiring an explicit ``execute`` flag before writing.
    """

    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1, max_length=128)
    video_path: str = Field(min_length=1, max_length=1024)
    title: str = Field(min_length=1, max_length=240)
    description: str = Field(default="", max_length=20_000)
    tags: list[str] = Field(default_factory=list, max_length=100)
    hashtags: list[str] = Field(default_factory=list, max_length=100)
    chapters: list[dict[str, Any]] = Field(default_factory=list, max_length=100)
    subtitles_path: str | None = Field(default=None, max_length=1024)
    thumbnail_path: str | None = Field(default=None, max_length=1024)
    thumbnail_concept: dict[str, Any] | None = None
    platform: str = Field(default="local", max_length=64)
    visibility: str = Field(default="private", pattern="^(public|private|unlisted)$")
    dry_run: bool = True
    execute: bool = False
    confirm: bool = False

    @field_validator("project_id")
    @classmethod
    def _safe_project(cls, value: str) -> str:
        value = value.strip()
        if not PROJECT_ID_PATTERN.fullmatch(value):
            raise ValueError("project_id contains unsupported path characters")
        return value

    @field_validator("video_path", "subtitles_path", "thumbnail_path")
    @classmethod
    def _safe_relative_path(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        path = Path(value)
        if not value or path.is_absolute() or ".." in path.parts:
            raise ValueError("publish asset paths must be project-relative")
        return value

    @field_validator("title", "description", "platform")
    @classmethod
    def _trim_publish_text(cls, value: str) -> str:
        # ``title`` is protected by ``min_length``; an empty description is
        # intentionally allowed.  Trimming here keeps metadata deterministic.
        return value.strip()


def _subtitle_segments(model: SubtitleRenderRequest) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    cursor = 0.0
    for segment in model.segments:
        start = segment.start_seconds if segment.start_seconds is not None else segment.start
        end = segment.end_seconds if segment.end_seconds is not None else segment.end
        if start is None:
            start = cursor
        if end is None:
            # A conservative local preview duration keeps cues contiguous while
            # still allowing a later measured TTS duration to replace them.
            end = start + max(0.5, len(segment.text.replace(" ", "")) / 4.0)
        if end <= start:
            raise ValueError(f"subtitle segment {segment.id} has non-positive duration")
        item: dict[str, Any] = {
            "id": segment.id,
            "text": segment.text,
            "start": float(start),
            "end": float(end),
        }
        if segment.speaker:
            item["speaker"] = segment.speaker
        if segment.words:
            item["words"] = segment.words
        out.append(item)
        cursor = float(end)
    return out


def _subtitle_plan(model: SubtitleRenderRequest) -> dict[str, Any]:
    segments = _subtitle_segments(model)
    return {
        "status": "dry_run",
        "project_id": model.project_id,
        "segment_count": len(segments),
        "formats": model.formats,
        "cue_count_estimate": len(segments),
        "duration_seconds": round(max(item["end"] for item in segments), 3),
        "would_write": False,
        "bgm": {"status": "deferred"},
    }


def render_subtitles(
    request: SubtitleRenderRequest | Mapping[str, Any],
    *,
    project_root: str | Path = DEFAULT_PROJECT_ROOT,
) -> dict[str, Any]:
    model = request if isinstance(request, SubtitleRenderRequest) else SubtitleRenderRequest.model_validate(request)
    if model.dry_run or not model.execute:
        return _subtitle_plan(model)
    try:
        project_dir = _resolve_project(project_root, model.project_id)
        segments = _subtitle_segments(model)
        subtitle_tool = SubtitleGen()
        output_dir = project_dir / "subtitles"
        output_dir.mkdir(parents=True, exist_ok=True)
        files: dict[str, dict[str, Any]] = {}
        for fmt in model.formats:
            output = output_dir / ("subtitles.caption.json" if fmt == "json" else f"subtitles.{fmt}")
            result = subtitle_tool.execute({
                "segments": segments,
                "format": fmt,
                "output_path": str(output),
                "max_chars_per_line": model.max_chars_per_line,
                "max_words_per_cue": model.max_words_per_cue,
                "highlight_style": model.highlight_style,
                "corrections": model.corrections,
            })
            ok, data, error = _tool_result_parts(result)
            if not ok or not output.is_file():
                raise RuntimeError(error or f"subtitle generation failed for {fmt}")
            files[fmt] = {
                "path": _relative(project_dir, output),
                "sha256": _sha256(output),
                "size_bytes": output.stat().st_size,
                "cue_count": data.get("cue_count"),
            }
        manifest, manifest_hash = _write_manifest(project_dir, "subtitle_manifest.json", {
            "schema_version": "1.0",
            "project_id": model.project_id,
            "stage": "subtitles",
            "status": "completed",
            "created_at": _utc_now(),
            "formats": files,
            "segments": [{"id": s["id"], "text_sha256": _sha256_bytes(s["text"].encode("utf-8")), "start": s["start"], "end": s["end"]} for s in segments],
            "bgm": {"status": "deferred"},
        })
        emit_event(project_dir, {"event": "subtitle_render", "status": "completed", "artifact": _relative(project_dir, manifest)})
        notify_project_changed(project_dir.name)
        return {
            "status": "completed",
            "project_id": model.project_id,
            "files": files,
            "manifest": {"path": _relative(project_dir, manifest), "sha256": manifest_hash},
            "cue_count": len(segments),
            "bgm": {"status": "deferred"},
        }
    except (ValueError, FileNotFoundError) as exc:
        return {"status": "invalid_request", "project_id": model.project_id, "would_write": False, "error": str(exc)}
    except Exception as exc:
        return {"status": "failed", "project_id": model.project_id, "would_write": False, "error": str(exc)[:500]}


def _tool_result_artifacts(raw: Any) -> list[str]:
    """Return provider artifacts without making assumptions about the result type."""

    if isinstance(raw, ToolResult):
        return [str(item) for item in (raw.artifacts or [])]
    if isinstance(raw, Mapping):
        values = raw.get("artifacts") or []
        return [str(item) for item in values] if isinstance(values, (list, tuple)) else []
    values = getattr(raw, "artifacts", []) or []
    return [str(item) for item in values] if isinstance(values, (list, tuple)) else []


def _transcriber_snapshot(transcriber: Any | None = None) -> dict[str, Any]:
    """Read the real local recognizer status without attempting a transcription."""

    chosen = transcriber if transcriber is not None else Transcriber()
    try:
        status = _status_name(chosen.get_status())
    except Exception as exc:
        status = "unknown"
        status_error = str(exc)[:240]
    else:
        status_error = None
    try:
        info = chosen.get_info() if callable(getattr(chosen, "get_info", None)) else {}
    except Exception:
        info = {}
    if not isinstance(info, Mapping):
        info = {}
    dependencies = info.get("dependencies", getattr(chosen, "dependencies", []))
    instructions = info.get("install_instructions", getattr(chosen, "install_instructions", None))
    snapshot: dict[str, Any] = {
        "name": info.get("name", getattr(chosen, "name", "transcriber")),
        "provider": info.get("provider", getattr(chosen, "provider", "whisperx")),
        "backend": "faster-whisper",
        "status": status,
        "local": True,
        "authorization_required": False,
        "dependencies": _safe_json(dependencies),
        "install_instructions": instructions,
        "capabilities": _safe_json(info.get("capabilities", getattr(chosen, "capabilities", []))),
        "word_timestamps": True,
    }
    if status_error:
        snapshot["status_error"] = status_error
    if status == "unavailable" and instructions:
        snapshot["unavailable_reason"] = "faster-whisper is not installed or is not importable"
    return snapshot


def _transcription_options_error(model, chosen, media):
    """Reject unsupported options before inference or staging any files."""
    if model.diarize:
        return '本机说话人区分尚未配置；没有忽略该选项或伪造说话人标签'
    resolver = getattr(chosen, 'local_model', None)
    if callable(resolver):
        try:
            resolver(model.model_size)
        except ValueError as exc:
            return str(exc)
    if model.alignment == 'whisperx_zh':
        from tools.analysis.transcript_aligner import alignment_ready
        if model.language not in {None, '', 'zh'}:
            return '中文精细对齐仅支持 zh；未擅自切换语言模型'
        if not alignment_ready():
            return '本机中文对齐模型尚未就绪；没有联网下载或调用云服务'
        duration = _finite_timestamp(media.get('probe', {}).get('duration_seconds'))
        if duration is not None and duration > 120:
            return '本次中文精细对齐上限为 120 秒，请分批处理'
    return None


def _transcript_media_record(project_dir: Path, raw_path: str) -> tuple[Path, dict[str, Any]]:
    path = _resolve_project_file(project_dir, raw_path)
    suffix = path.suffix.lower()
    if suffix not in MEDIA_VIDEO_EXTENSIONS | MEDIA_AUDIO_EXTENSIONS:
        supported = ", ".join(sorted(MEDIA_VIDEO_EXTENSIONS | MEDIA_AUDIO_EXTENSIONS))
        raise ValueError(f"unsupported media extension {suffix or '<none>'}; use one of {supported}")
    probe = _probe_media(path)
    record = {
        "path": _relative(project_dir, path),
        "media_type": "video" if suffix in MEDIA_VIDEO_EXTENSIONS else "audio",
        "sha256": _sha256(path),
        "size_bytes": path.stat().st_size,
    }
    if probe is not None:
        record["probe"] = probe
        record["audio_stream_available"] = bool(probe.get("audio"))
    return path, record


def _transcription_audio_available(media: Mapping[str, Any]) -> bool:
    """Return whether a source can be decoded as speech audio.

    Audio files are presumed to carry an audio stream.  For video files,
    ffprobe is authoritative when available; an absent probe is left
    undecided so the recognizer can still handle unusual containers.
    """

    if media.get("media_type") != "video":
        return True
    if "audio_stream_available" not in media:
        return True
    return bool(media.get("audio_stream_available"))


def _transcription_no_audio_result(
    model: TranscriptRequest,
    *,
    media: Mapping[str, Any],
    snapshot: Mapping[str, Any],
) -> dict[str, Any]:
    """Build a truthful, actionable response for silent video sources."""

    error = (
        "待识别视频没有音频轨道；它是无旁白成片，不能直接自动转录。"
        "请改用含旁白的音频/视频路径，或使用‘生成 SRT/VTT 字幕’把已确认的脚本分段转成字幕。"
    )
    return {
        "status": "unavailable",
        "project_id": model.project_id,
        "media": dict(media),
        "media_path": media.get("path", model.media_path),
        "transcriber": dict(snapshot),
        "would_execute": False,
        "would_write": False,
        "requires_confirmation": False,
        "error": error,
    }


def _safe_transcript_stem(media_path: Path) -> str:
    value = re.sub(r"[^A-Za-z0-9._-]+", "-", media_path.stem).strip(".-")
    return (value[:96] or "media")


def _transcript_plan(
    model: TranscriptRequest,
    *,
    transcriber: Any | None = None,
    project_root: str | Path = DEFAULT_PROJECT_ROOT,
) -> dict[str, Any]:
    chosen = transcriber if transcriber is not None else Transcriber()
    snapshot = _transcriber_snapshot(chosen)
    try:
        project_dir = _resolve_project(project_root, model.project_id)
        media_path, media = _transcript_media_record(project_dir, model.media_path)
    except (ValueError, FileNotFoundError) as exc:
        return {
            "status": "invalid_request",
            "project_id": model.project_id,
            "media_path": model.media_path,
            "transcriber": snapshot,
            "would_execute": False,
            "would_write": False,
            "error": str(exc),
        }
    if not _transcription_audio_available(media):
        return _transcription_no_audio_result(model, media=media, snapshot=snapshot)
    option_error = _transcription_options_error(model, chosen, media)
    return {
        "status": "dry_run",
        "project_id": model.project_id,
        "media": media,
        "media_path": media["path"],
        "transcriber": snapshot,
        "model_size": model.model_size,
        "language": model.language,
        "diarize": model.diarize,
        'alignment': model.alignment,
        "formats": model.formats,
        "would_execute": snapshot["status"] == "available" and not option_error,
        'error': option_error,
        "would_write": False,
        "requires_confirmation": True,
        "estimated_runtime_seconds": 60.0,
        "bgm": {"status": "deferred"},
    }


def _finite_timestamp(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _normalize_transcript_segments(raw_segments: Any) -> list[dict[str, Any]]:
    """Validate provider timestamps; never invent timing from text length."""

    if not isinstance(raw_segments, (list, tuple)):
        raise ValueError("transcriber returned no timed segment list")
    normalized: list[dict[str, Any]] = []
    errors: list[str] = []
    for index, raw in enumerate(raw_segments, start=1):
        if not isinstance(raw, Mapping):
            errors.append(f"segment {index} is not an object")
            continue
        text = str(raw.get("text") or "").strip()
        start = _finite_timestamp(raw.get("start", raw.get("start_seconds")))
        end = _finite_timestamp(raw.get("end", raw.get("end_seconds")))
        if not text:
            errors.append(f"segment {index} has empty text")
            continue
        if start is None or end is None or start < 0 or end <= start:
            errors.append(f"segment {index} has invalid start/end timestamps")
            continue
        item: dict[str, Any] = {
            "id": str(raw.get("id") or f"segment-{index:02d}"),
            "text": text,
            "start": round(start, 3),
            "end": round(end, 3),
        }
        speaker = raw.get("speaker")
        if speaker is not None and str(speaker).strip():
            item["speaker"] = str(speaker).strip()
        raw_words = raw.get("words")
        if isinstance(raw_words, (list, tuple)):
            words: list[dict[str, Any]] = []
            for word in raw_words:
                if not isinstance(word, Mapping):
                    continue
                word_text = str(word.get("word") or word.get("text") or "").strip()
                word_start = _finite_timestamp(word.get("start", word.get("start_seconds")))
                word_end = _finite_timestamp(word.get("end", word.get("end_seconds")))
                if not word_text or word_start is None or word_end is None or word_end <= word_start:
                    continue
                item_word = {"word": word_text, "start": round(word_start, 3), "end": round(word_end, 3)}
                score = _finite_timestamp(word.get('score'))
                if score is not None:
                    item_word['score'] = score
                words.append(item_word)
            if words:
                item["words"] = words
        normalized.append(item)
    if errors:
        raise ValueError("; ".join(errors[:4]))
    if not normalized:
        raise ValueError("transcriber returned no non-empty timed segments")
    return normalized


def _transcript_payload(data: Mapping[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    payload: Mapping[str, Any] = data
    for key in ("transcript", "result", "output"):
        nested = payload.get(key)
        if isinstance(nested, Mapping) and isinstance(nested.get("segments"), (list, tuple)):
            payload = nested
            break
    segments = payload.get("segments")
    normalized = _normalize_transcript_segments(segments)
    return normalized, dict(payload)


def _emit_transcription_event(project_dir: Path, status: str, **payload: Any) -> None:
    """Event writing is observability; it must not turn a real artifact into a failure."""

    try:
        emit_event(project_dir, {"event": "transcription", "status": status, **_safe_json(payload)})
        notify_project_changed(project_dir.name)
    except Exception:
        pass


def transcribe_media(
    request: TranscriptRequest | Mapping[str, Any],
    *,
    transcriber: Any | None = None,
    project_root: str | Path = DEFAULT_PROJECT_ROOT,
) -> dict[str, Any]:
    """Run faster-whisper when available, then persist truthful subtitle artifacts."""

    model = request if isinstance(request, TranscriptRequest) else TranscriptRequest.model_validate(request)
    if model.dry_run or not model.execute:
        return _transcript_plan(model, transcriber=transcriber, project_root=project_root)
    if not model.confirm:
        return {
            "status": "confirmation_required",
            "project_id": model.project_id,
            "would_execute": False,
            "would_write": False,
            "error": "confirm=true is required before local transcription can run",
        }

    chosen = transcriber if transcriber is not None else Transcriber()
    snapshot = _transcriber_snapshot(chosen)
    try:
        project_dir = _resolve_project(project_root, model.project_id)
        media_path, media = _transcript_media_record(project_dir, model.media_path)
    except (ValueError, FileNotFoundError) as exc:
        return {"status": "invalid_request", "project_id": model.project_id, "would_write": False, "error": str(exc)}

    if not _transcription_audio_available(media):
        _emit_transcription_event(project_dir, "unavailable", media_path=media["path"], error="source video has no audio stream")
        return _transcription_no_audio_result(model, media=media, snapshot=snapshot)

    if snapshot["status"] != "available":
        error = snapshot.get("unavailable_reason") or "faster-whisper is unavailable; no transcript artifacts were written"
        _emit_transcription_event(project_dir, "unavailable", media_path=media["path"], error=error)
        return {
            "status": "unavailable",
            "project_id": model.project_id,
            "media": media,
            "media_path": media["path"],
            "transcriber": snapshot,
            "would_execute": False,
            "would_write": False,
            "error": error,
        }

    option_error = _transcription_options_error(model, chosen, media)
    if option_error:
        return {'status': 'unavailable', 'project_id': model.project_id,
                'would_execute': False, 'would_write': False, 'error': option_error}
    run_id = secrets.token_hex(12)
    transcripts_dir = project_dir / 'transcripts' / 'runs' / run_id
    staging = transcripts_dir / 'provider'
    staging.mkdir(parents=True, exist_ok=False)
    stem = _safe_transcript_stem(media_path)
    written: list[Path] = []
    try:
        raw = chosen.execute({
            "input_path": str(media_path),
            "model_size": model.model_size,
            "language": model.language,
            "diarize": model.diarize,
            'alignment': model.alignment,
            "output_dir": str(staging),
        })
        ok, data, error = _tool_result_parts(raw)
        if not ok:
            raw_error = error or "transcriber execution failed"
            unavailable = "faster-whisper" in raw_error.lower() and "install" in raw_error.lower()
            status = "unavailable" if unavailable else "failed"
            _emit_transcription_event(project_dir, status, media_path=media["path"], error=raw_error)
            return {
                "status": status,
                "project_id": model.project_id,
                "media": media,
                "transcriber": snapshot,
                "would_write": False,
                "error": raw_error,
            }
        segments, payload = _transcript_payload(data)
        duration = _finite_timestamp(payload.get("duration_seconds"))
        derived_duration = max(segment["end"] for segment in segments)
        if duration is None or duration < derived_duration:
            duration = derived_duration
        language = payload.get("language") or model.language
        provider_model = payload.get("model") or payload.get("model_size") or model.model_size
        normalized_payload = {
            "schema_version": "1.0",
            "project_id": model.project_id,
            "media": media,
            "provider": {**snapshot, "model": provider_model, "language": language},
            "language": language,
            "duration_seconds": round(duration, 3),
            "segments": segments,
            'word_timestamps': [word for segment in segments for word in segment.get('words', [])],
            'alignment': _safe_json(payload.get('alignment', {'engine': 'faster_whisper_attention', 'human_review_required': True})),
            'diarization': _safe_json(payload.get('diarization', {'requested': False, 'performed': False})),
        }

        for fmt in model.formats:
            output = staging / f"{stem}.{fmt}"
            if fmt == "json":
                content = json.dumps(_safe_json(normalized_payload), ensure_ascii=False, indent=2).encode("utf-8") + b"\n"
                _atomic_bytes(output, content)
            else:
                result = SubtitleGen().execute({
                    "segments": segments,
                    "format": fmt,
                    "output_path": str(output),
                    "max_chars_per_line": model.max_chars_per_line,
                    "max_words_per_cue": model.max_words_per_cue,
                    "highlight_style": model.highlight_style,
                    "corrections": model.corrections,
                })
                subtitle_ok, _, subtitle_error = _tool_result_parts(result)
                if not subtitle_ok or not output.is_file():
                    raise RuntimeError(subtitle_error or f"subtitle generation failed for {fmt}")
            if not output.is_file() or output.stat().st_size <= 0:
                raise RuntimeError(f"transcript output was not written for {fmt}")
            written.append(output)

        # Preserve the provider's raw JSON, when it actually returned one,
        # inside the staging area.  External paths are intentionally ignored.
        provider_raw: Path | None = None
        artifact_candidates = [Path(item) for item in _tool_result_artifacts(raw)]
        artifact_candidates.extend(staging.glob("*_transcript.json"))
        for candidate in artifact_candidates:
            try:
                candidate = candidate.resolve()
                candidate.relative_to(staging.resolve())
            except (ValueError, OSError):
                continue
            if candidate.is_file() and candidate.suffix.lower() == ".json" and candidate not in written:
                provider_raw = candidate
                break

        files: dict[str, dict[str, Any]] = {}
        for fmt in model.formats:
            staged_output = staging / f"{stem}.{fmt}"
            final_output = transcripts_dir / f"{stem}.{fmt}"
            final_output.parent.mkdir(parents=True, exist_ok=True)
            os.replace(staged_output, final_output)
            files[fmt] = {
                "path": _relative(project_dir, final_output),
                "sha256": _sha256(final_output),
                "size_bytes": final_output.stat().st_size,
            }
        if provider_raw is not None:
            provider_output = transcripts_dir / f"{stem}.provider.json"
            os.replace(provider_raw, provider_output)
            files["provider_json"] = {
                "path": _relative(project_dir, provider_output),
                "sha256": _sha256(provider_output),
                "size_bytes": provider_output.stat().st_size,
            }

        manifest_payload = {
            "schema_version": "1.0",
            "project_id": model.project_id,
            "stage": "transcription",
            "status": "completed",
            "created_at": _utc_now(),
            "source_media": media,
            "provider": {**snapshot, "model": provider_model, "language": language, "diarize": model.diarize},
            "duration_seconds": round(duration, 3),
            "segment_count": len(segments),
            "segments": [{"id": item["id"], "start": item["start"], "end": item["end"], "text_sha256": _sha256_bytes(item["text"].encode("utf-8"))} for item in segments],
            "outputs": files,
            "bgm": {"status": "deferred"},
            'alignment': normalized_payload['alignment'],
            'run_id': run_id,
        }
        # Canonical index can advance because every run has an immutable
        # manifest and separate outputs. Preserve an existing legacy index
        # before its first replacement, including pre-upgrade transcripts.
        old_manifest = project_dir / 'artifacts/transcript_manifest.json'
        if old_manifest.is_file():
            previous = old_manifest.read_bytes()
            backup = old_manifest.with_name('transcript_manifest_preserved_' + hashlib.sha256(previous).hexdigest() + '.json')
            if not backup.exists():
                with backup.open('xb') as stream:
                    stream.write(previous)
        immutable, immutable_hash = _write_manifest(project_dir, f'transcript_manifest_{run_id}.json', manifest_payload)
        manifest, manifest_hash = _write_manifest(project_dir, 'transcript_manifest.json', manifest_payload)
        _emit_transcription_event(project_dir, "completed", media_path=media["path"], artifact=_relative(project_dir, manifest), segment_count=len(segments), duration_seconds=round(duration, 3))
        return {
            "status": "completed",
            "project_id": model.project_id,
            "media": media,
            "media_path": media["path"],
            "transcriber": {**snapshot, "model": provider_model, "language": language},
            "duration_seconds": round(duration, 3),
            "segment_count": len(segments),
            'word_count': len(normalized_payload['word_timestamps']),
            'segments': normalized_payload['segments'],
            'alignment': normalized_payload['alignment'],
            'run_manifest': {'path': _relative(project_dir, immutable), 'sha256': immutable_hash},
            "files": files,
            "manifest": {"path": _relative(project_dir, manifest), "sha256": manifest_hash},
            "bgm": {"status": "deferred"},
        }
    except (ValueError, FileNotFoundError) as exc:
        _emit_transcription_event(project_dir, "failed", media_path=media["path"], error=str(exc)[:500])
        return {"status": "invalid_request", "project_id": model.project_id, "would_write": False, "error": str(exc)}
    except Exception as exc:
        _emit_transcription_event(project_dir, "failed", media_path=media["path"], error=str(exc)[:500])
        return {"status": "failed", "project_id": model.project_id, "would_write": False, "error": str(exc)[:600]}
    # Keep provider files and failed intermediate outputs for inspection.


def _analysis_tool_snapshot(
    tool: Any,
    *,
    fallback_name: str,
    fallback_provider: str,
) -> dict[str, Any]:
    """Return truthful status for one local analysis tool.

    ``get_info`` is useful for the capability panel, but a third-party or test
    adapter is allowed to expose only ``get_status``.  Keep the snapshot
    defensive so one broken optional dependency cannot hide the rest of the
    workbench.
    """

    try:
        status = _status_name(tool.get_status())
    except Exception as exc:
        status = "unknown"
        status_error = str(exc)[:240]
    else:
        status_error = None
    try:
        info = tool.get_info() if callable(getattr(tool, "get_info", None)) else {}
    except Exception:
        info = {}
    if not isinstance(info, Mapping):
        info = {}
    runtime = info.get("runtime", getattr(tool, "runtime", "local"))
    runtime = str(getattr(runtime, "value", runtime) or "local").lower()
    dependencies = info.get("dependencies", getattr(tool, "dependencies", []))
    instructions = info.get("install_instructions", getattr(tool, "install_instructions", None))
    snapshot: dict[str, Any] = {
        "name": info.get("name", getattr(tool, "name", fallback_name)),
        "provider": info.get("provider", getattr(tool, "provider", fallback_provider)),
        "status": status,
        "runtime": runtime,
        "local": runtime in {"local", "local_gpu"},
        "authorization_required": False,
        "dependencies": _safe_json(dependencies),
        "install_instructions": instructions,
        "capabilities": _safe_json(info.get("capabilities", getattr(tool, "capabilities", []))),
    }
    if status_error:
        snapshot["status_error"] = status_error
    if status == "unavailable":
        snapshot["unavailable_reason"] = "local analysis dependencies are unavailable"
    elif status == "degraded":
        snapshot["degraded_reason"] = "optional dependency is missing; the tool will use its documented fallback"
    return snapshot


def _analysis_media_record(project_dir: Path, raw_path: str) -> tuple[Path, dict[str, Any]]:
    """Resolve and hash a project-local video used by frame/face analysis."""

    path = _resolve_project_file(project_dir, raw_path)
    suffix = path.suffix.lower()
    if suffix not in MEDIA_VIDEO_EXTENSIONS:
        supported = ", ".join(sorted(MEDIA_VIDEO_EXTENSIONS))
        raise ValueError(f"analysis accepts video files only ({supported})")
    return path, {
        "path": _relative(project_dir, path),
        "media_type": "video",
        "sha256": _sha256(path),
        "size_bytes": path.stat().st_size,
    }


def _analysis_plan(
    model: FrameSampleRequest | FaceTrackRequest,
    *,
    tool: Any,
    fallback_name: str,
    fallback_provider: str,
    project_root: str | Path,
    parameters: Mapping[str, Any],
) -> dict[str, Any]:
    snapshot = _analysis_tool_snapshot(
        tool,
        fallback_name=fallback_name,
        fallback_provider=fallback_provider,
    )
    try:
        project_dir = _resolve_project(project_root, model.project_id)
        _, media = _analysis_media_record(project_dir, model.media_path)
    except (ValueError, FileNotFoundError) as exc:
        return {
            "status": "invalid_request",
            "project_id": model.project_id,
            "media_path": model.media_path,
            "tool": snapshot,
            "would_execute": False,
            "would_write": False,
            "error": str(exc),
        }
    return {
        "status": "dry_run",
        "project_id": model.project_id,
        "media": media,
        "media_path": media["path"],
        "tool": snapshot,
        "parameters": _safe_json(dict(parameters)),
        "would_execute": snapshot["status"] in {"available", "degraded"},
        "would_write": False,
        "requires_confirmation": True,
        "bgm": {"status": "deferred"},
    }


def _emit_analysis_event(project_dir: Path, event: str, status: str, **payload: Any) -> None:
    """Record local analysis lifecycle without turning telemetry into a failure."""

    try:
        emit_event(project_dir, {"event": event, "status": status, **_safe_json(payload)})
        notify_project_changed(project_dir.name)
    except Exception:
        pass


def _checkpoint_record(project_dir: Path, stage: str, *, artifacts: Mapping[str, str], metadata: Mapping[str, Any]) -> dict[str, Any]:
    checkpoint = _write_stage_checkpoint(
        project_dir,
        stage,
        "completed",
        artifacts=artifacts,
        human_approval_required=False,
        human_approved=True,
        metadata=metadata,
    )
    return {"path": _relative(project_dir, checkpoint), "sha256": _sha256(checkpoint)}


def _analysis_parameters(model: FrameSampleRequest | FaceTrackRequest) -> dict[str, Any]:
    if isinstance(model, FrameSampleRequest):
        return {
            "strategy": model.strategy,
            "interval_seconds": model.interval_seconds,
            "count": model.count,
            "timestamps": model.timestamps,
            "scene_boundaries": model.scene_boundaries,
            "max_frames": model.max_frames,
            "format": model.format,
            "quality": model.quality,
        }
    return {
        "sample_fps": model.sample_fps,
        "min_detection_confidence": model.min_detection_confidence,
    }


def _frame_sampling_plan(
    model: FrameSampleRequest,
    *,
    frame_sampler: Any | None,
    project_root: str | Path,
) -> dict[str, Any]:
    chosen = frame_sampler if frame_sampler is not None else FrameSampler()
    return _analysis_plan(
        model,
        tool=chosen,
        fallback_name="frame_sampler",
        fallback_provider="ffmpeg",
        project_root=project_root,
        parameters=_analysis_parameters(model),
    )


def sample_frames_media(
    request: FrameSampleRequest | Mapping[str, Any],
    *,
    frame_sampler: Any | None = None,
    project_root: str | Path = DEFAULT_PROJECT_ROOT,
) -> dict[str, Any]:
    """Extract actual frames into ``analysis/frames`` after confirmation."""

    model = request if isinstance(request, FrameSampleRequest) else FrameSampleRequest.model_validate(request)
    chosen = frame_sampler if frame_sampler is not None else FrameSampler()
    if model.dry_run or not model.execute:
        return _frame_sampling_plan(model, frame_sampler=chosen, project_root=project_root)
    if not model.confirm:
        return {
            "status": "confirmation_required",
            "project_id": model.project_id,
            "would_execute": False,
            "would_write": False,
            "error": "confirm=true is required before frame sampling can write files",
        }

    snapshot = _analysis_tool_snapshot(chosen, fallback_name="frame_sampler", fallback_provider="ffmpeg")
    try:
        project_dir = _resolve_project(project_root, model.project_id)
        media_path, media = _analysis_media_record(project_dir, model.media_path)
    except (ValueError, FileNotFoundError) as exc:
        return {"status": "invalid_request", "project_id": model.project_id, "would_write": False, "error": str(exc)}

    if snapshot["status"] not in {"available", "degraded"}:
        error = snapshot.get("unavailable_reason") or snapshot.get("install_instructions") or "frame sampler is unavailable; no frames were written"
        _emit_analysis_event(project_dir, "frame_sampling", "unavailable", media_path=media["path"], error=error)
        return {
            "status": "unavailable",
            "project_id": model.project_id,
            "media": media,
            "tool": snapshot,
            "would_execute": False,
            "would_write": False,
            "error": error,
        }

    frames_root = project_dir / "analysis" / "frames"
    frames_root.mkdir(parents=True, exist_ok=True)
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", media_path.stem).strip(".-")[:72] or "video"
    run_id = secrets.token_hex(5)
    staging = frames_root / f".sample-{run_id}"
    final_dir = frames_root / f"{stem}-{media['sha256'][:12]}-{run_id}"
    staging.mkdir(parents=True, exist_ok=True)
    final_created = False
    try:
        raw = chosen.execute({
            "input_path": str(media_path),
            **_analysis_parameters(model),
            "output_dir": str(staging),
        })
        ok, data, error = _tool_result_parts(raw)
        if not ok:
            message = error or "frame sampling failed"
            _emit_analysis_event(project_dir, "frame_sampling", "failed", media_path=media["path"], error=message)
            return {"status": "failed", "project_id": model.project_id, "media": media, "tool": snapshot, "would_write": False, "error": message}

        rows = data.get("frames") if isinstance(data.get("frames"), list) else []
        if not rows:
            rows = [{"path": str(path), "index": index} for index, path in enumerate(sorted(staging.glob("frame_*.jpg")) + sorted(staging.glob("frame_*.png")))]
        if not rows:
            raise RuntimeError("frame sampler returned no files")

        final_dir.mkdir(parents=True, exist_ok=True)
        final_created = True
        frames: list[dict[str, Any]] = []
        for output_index, row in enumerate(rows, start=1):
            if not isinstance(row, Mapping) or not row.get("path"):
                raise RuntimeError(f"frame {output_index} has no output path")
            candidate = Path(str(row["path"]))
            if not candidate.is_absolute():
                candidate = staging / candidate
            candidate = candidate.resolve()
            try:
                candidate.relative_to(staging.resolve())
            except (ValueError, OSError) as exc:
                raise RuntimeError("frame sampler returned a path outside its staging directory") from exc
            if not candidate.is_file() or candidate.stat().st_size <= 0:
                raise RuntimeError(f"frame output is missing or empty: {candidate.name}")
            if candidate.suffix.lower() not in {".jpg", ".jpeg", ".png"}:
                raise RuntimeError(f"unsupported frame output format: {candidate.suffix}")
            suffix = ".jpg" if candidate.suffix.lower() in {".jpg", ".jpeg"} else ".png"
            final_output = final_dir / f"frame-{output_index:04d}{suffix}"
            os.replace(candidate, final_output)
            timestamp = _finite_timestamp(row.get("timestamp_seconds"))
            index = row.get("index", output_index - 1)
            frames.append({
                "path": _relative(project_dir, final_output),
                "index": int(index) if isinstance(index, (int, float)) and math.isfinite(float(index)) else output_index - 1,
                "timestamp_seconds": round(timestamp, 3) if timestamp is not None else None,
                "sha256": _sha256(final_output),
                "size_bytes": final_output.stat().st_size,
            })

        manifest, manifest_hash = _write_manifest(project_dir, "frame_sampling_manifest.json", {
            "schema_version": "1.0",
            "project_id": model.project_id,
            "stage": "frame_sampling",
            "status": "completed",
            "created_at": _utc_now(),
            "source_media": media,
            "tool": snapshot,
            "parameters": _analysis_parameters(model),
            "output_dir": _relative(project_dir, final_dir),
            "frame_count": len(frames),
            "frames": frames,
        })
        checkpoint = _checkpoint_record(
            project_dir,
            "frame_sampling",
            artifacts={
                "frame_sampling_manifest": _relative(project_dir, manifest),
                "frames": _relative(project_dir, final_dir),
            },
            metadata={"source_media": media["path"], "frame_count": len(frames)},
        )
        _emit_analysis_event(
            project_dir,
            "frame_sampling",
            "completed",
            media_path=media["path"],
            manifest=_relative(project_dir, manifest),
            manifest_sha256=manifest_hash,
            checkpoint=checkpoint,
            frame_count=len(frames),
        )
        return {
            "status": "completed",
            "project_id": model.project_id,
            "media": media,
            "tool": snapshot,
            "frames": frames,
            "frame_count": len(frames),
            "output_dir": _relative(project_dir, final_dir),
            "manifest": {"path": _relative(project_dir, manifest), "sha256": manifest_hash},
            "checkpoint": checkpoint,
            "bgm": {"status": "deferred"},
        }
    except (ValueError, FileNotFoundError) as exc:
        if final_created:
            shutil.rmtree(final_dir, ignore_errors=True)
        _emit_analysis_event(project_dir, "frame_sampling", "failed", media_path=media["path"], error=str(exc)[:500])
        return {"status": "invalid_request", "project_id": model.project_id, "media": media, "would_write": False, "error": str(exc)}
    except Exception as exc:
        if final_created:
            shutil.rmtree(final_dir, ignore_errors=True)
        _emit_analysis_event(project_dir, "frame_sampling", "failed", media_path=media["path"], error=str(exc)[:600])
        return {"status": "failed", "project_id": model.project_id, "media": media, "tool": snapshot, "would_write": False, "error": str(exc)[:600]}
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def _face_tracking_plan(
    model: FaceTrackRequest,
    *,
    face_tracker: Any | None,
    project_root: str | Path,
) -> dict[str, Any]:
    chosen = face_tracker if face_tracker is not None else FaceTracker()
    return _analysis_plan(
        model,
        tool=chosen,
        fallback_name="face_tracker",
        fallback_provider="mediapipe",
        project_root=project_root,
        parameters=_analysis_parameters(model),
    )


def track_faces_media(
    request: FaceTrackRequest | Mapping[str, Any],
    *,
    face_tracker: Any | None = None,
    project_root: str | Path = DEFAULT_PROJECT_ROOT,
) -> dict[str, Any]:
    """Track faces and persist the real JSON report inside the project."""

    model = request if isinstance(request, FaceTrackRequest) else FaceTrackRequest.model_validate(request)
    chosen = face_tracker if face_tracker is not None else FaceTracker()
    if model.dry_run or not model.execute:
        return _face_tracking_plan(model, face_tracker=chosen, project_root=project_root)
    if not model.confirm:
        return {
            "status": "confirmation_required",
            "project_id": model.project_id,
            "would_execute": False,
            "would_write": False,
            "error": "confirm=true is required before face tracking can write files",
        }

    snapshot = _analysis_tool_snapshot(chosen, fallback_name="face_tracker", fallback_provider="mediapipe")
    try:
        project_dir = _resolve_project(project_root, model.project_id)
        media_path, media = _analysis_media_record(project_dir, model.media_path)
    except (ValueError, FileNotFoundError) as exc:
        return {"status": "invalid_request", "project_id": model.project_id, "would_write": False, "error": str(exc)}

    if snapshot["status"] not in {"available", "degraded"}:
        error = snapshot.get("unavailable_reason") or snapshot.get("install_instructions") or "face tracker is unavailable; no report was written"
        _emit_analysis_event(project_dir, "face_tracking", "unavailable", media_path=media["path"], error=error)
        return {
            "status": "unavailable",
            "project_id": model.project_id,
            "media": media,
            "tool": snapshot,
            "would_execute": False,
            "would_write": False,
            "error": error,
        }

    tracking_root = project_dir / "analysis" / "face_tracking"
    tracking_root.mkdir(parents=True, exist_ok=True)
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", media_path.stem).strip(".-")[:72] or "video"
    run_id = secrets.token_hex(5)
    staging = tracking_root / f".track-{run_id}.json"
    final_output = tracking_root / f"{stem}-{media['sha256'][:12]}-{run_id}.json"
    try:
        raw = chosen.execute({
            "input_path": str(media_path),
            "output_path": str(staging),
            **_analysis_parameters(model),
        })
        ok, data, error = _tool_result_parts(raw)
        if not ok:
            message = error or "face tracking failed"
            _emit_analysis_event(project_dir, "face_tracking", "failed", media_path=media["path"], error=message)
            return {"status": "failed", "project_id": model.project_id, "media": media, "tool": snapshot, "would_write": False, "error": message}
        if not staging.is_file() or staging.stat().st_size <= 0:
            raise RuntimeError("face tracker did not write a JSON report")
        try:
            report = json.loads(staging.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise RuntimeError("face tracker output is not valid JSON") from exc
        if not isinstance(report, Mapping):
            raise RuntimeError("face tracker report must be a JSON object")
        os.replace(staging, final_output)
        report_meta = {
            "path": _relative(project_dir, final_output),
            "sha256": _sha256(final_output),
            "size_bytes": final_output.stat().st_size,
        }
        summary = {
            key: report.get(key)
            for key in ("video_width", "video_height", "fps", "duration_seconds", "frame_count", "face_detected_count")
            if key in report
        }
        summary.update({key: data[key] for key in ("frames_sampled", "faces_detected", "method") if key in data})
        manifest, manifest_hash = _write_manifest(project_dir, "face_tracking_manifest.json", {
            "schema_version": "1.0",
            "project_id": model.project_id,
            "stage": "face_tracking",
            "status": "completed",
            "created_at": _utc_now(),
            "source_media": media,
            "tool": snapshot,
            "parameters": _analysis_parameters(model),
            "report": report_meta,
            "summary": summary,
        })
        checkpoint = _checkpoint_record(
            project_dir,
            "face_tracking",
            artifacts={
                "face_tracking_manifest": _relative(project_dir, manifest),
                "face_tracking_report": report_meta["path"],
            },
            metadata={"source_media": media["path"], **summary},
        )
        _emit_analysis_event(
            project_dir,
            "face_tracking",
            "completed",
            media_path=media["path"],
            report=report_meta,
            manifest=_relative(project_dir, manifest),
            manifest_sha256=manifest_hash,
            checkpoint=checkpoint,
            summary=summary,
        )
        return {
            "status": "completed",
            "project_id": model.project_id,
            "media": media,
            "tool": snapshot,
            "report": {**report_meta, "summary": summary},
            "summary": summary,
            "manifest": {"path": _relative(project_dir, manifest), "sha256": manifest_hash},
            "checkpoint": checkpoint,
            "bgm": {"status": "deferred"},
        }
    except (ValueError, FileNotFoundError) as exc:
        staging.unlink(missing_ok=True)
        final_output.unlink(missing_ok=True)
        _emit_analysis_event(project_dir, "face_tracking", "failed", media_path=media["path"], error=str(exc)[:500])
        return {"status": "invalid_request", "project_id": model.project_id, "media": media, "would_write": False, "error": str(exc)}
    except Exception as exc:
        staging.unlink(missing_ok=True)
        final_output.unlink(missing_ok=True)
        _emit_analysis_event(project_dir, "face_tracking", "failed", media_path=media["path"], error=str(exc)[:600])
        return {"status": "failed", "project_id": model.project_id, "media": media, "tool": snapshot, "would_write": False, "error": str(exc)[:600]}
    finally:
        staging.unlink(missing_ok=True)


def _reference_source_record(project_dir: Path, raw_source: str) -> tuple[Path, dict[str, Any]]:
    """Resolve one explicitly supplied local reference video.

    Relative paths are constrained to the current project.  Absolute paths
    are allowed only because a desktop creator may select a file outside the
    project; derived frames and JSON never leave the project directory.  URL
    downloads are rejected here instead of being silently started by a paste
    into the browser.
    """

    source = str(raw_source or "").strip()
    if not source:
        raise ValueError("source must not be blank")
    if source.lower().startswith(("http://", "https://", "www.")):
        raise ValueError("URL reference analysis is not enabled yet; download the video and select the local file")

    candidate = Path(source).expanduser()
    if candidate.is_absolute():
        path = candidate.resolve()
        if not path.is_file():
            raise FileNotFoundError(f"reference video does not exist: {source}")
        try:
            project_path = _relative(project_dir, path)
        except (ValueError, OSError):
            project_path = None
    else:
        path = _resolve_project_file(project_dir, source)
        project_path = _relative(project_dir, path)

    if path.suffix.lower() not in MEDIA_VIDEO_EXTENSIONS:
        supported = ", ".join(sorted(MEDIA_VIDEO_EXTENSIONS))
        raise ValueError(f"reference analysis accepts video files only ({supported})")

    return path, {
        "name": path.name,
        "project_path": project_path,
        "media_type": "video",
        "extension": path.suffix.lower(),
        "sha256": _sha256(path),
        "size_bytes": path.stat().st_size,
    }


def _reference_analyzer_snapshot() -> dict[str, Any]:
    """Return the real local reference-analyzer status without running it."""

    analyzer = VideoAnalyzer()
    try:
        status = _status_name(analyzer.get_status())
    except Exception as exc:
        status = "unknown"
        status_error = str(exc)[:240]
    else:
        status_error = None
    info = {}
    try:
        maybe_info = analyzer.get_info() if callable(getattr(analyzer, "get_info", None)) else {}
        if isinstance(maybe_info, Mapping):
            info = maybe_info
    except Exception:
        info = {}
    snapshot: dict[str, Any] = {
        "name": info.get("name", analyzer.name),
        "provider": info.get("provider", analyzer.provider),
        "status": status,
        "local": True,
        "authorization_required": False,
        "network_required": False,
        "dependencies": _safe_json(info.get("dependencies", getattr(analyzer, "dependencies", []))),
        "install_instructions": info.get("install_instructions", getattr(analyzer, "install_instructions", None)),
        "capabilities": _safe_json(info.get("capabilities", getattr(analyzer, "capabilities", []))),
    }
    if status_error:
        snapshot["status_error"] = status_error
    return snapshot


def _reference_plan(
    model: ReferenceReviewRequest,
    *,
    project_root: str | Path = DEFAULT_PROJECT_ROOT,
) -> dict[str, Any]:
    analyzer = _reference_analyzer_snapshot()
    try:
        project_dir = _resolve_project(project_root, model.project_id)
        source_path, source = _reference_source_record(project_dir, model.source)
    except (ValueError, FileNotFoundError) as exc:
        return {
            "status": "invalid_request",
            "project_id": model.project_id,
            "source": {"name": Path(model.source).name},
            "analyzer": analyzer,
            "would_execute": False,
            "would_write": False,
            "error": str(exc),
        }

    digest = source["sha256"][:16]
    output_prefix = f"analysis/reference/{digest}-{model.analysis_depth}-{model.max_keyframes}"
    ready = analyzer["status"] == "available" and bool(shutil.which("ffmpeg")) and bool(shutil.which("ffprobe"))
    return {
        "status": "dry_run",
        "project_id": model.project_id,
        "source": source,
        "source_path": source.get("project_path") or source.get("name"),
        "analyzer": analyzer,
        "analysis_depth": model.analysis_depth,
        "max_keyframes": model.max_keyframes,
        "ffmpeg_configured": bool(shutil.which("ffmpeg")),
        "ffprobe_configured": bool(shutil.which("ffprobe")),
        "would_execute": ready,
        "would_write": False,
        "requires_confirmation": True,
        "planned_outputs": [
            f"{output_prefix}/video_analysis_brief.json",
            f"{output_prefix}/scenes.json",
            f"{output_prefix}/keyframes/",
            "artifacts/video_analysis_brief.json",
            "artifacts/source_media_review.json",
            "checkpoint_research.json",
        ],
        "network": {"used": False, "url_download": "disabled"},
        "message": "仅检查本机参考视频与分析器；发送 execute=true 且 confirm=true 才会提取关键帧并写入项目。",
        "_resolved_source_for_preview": str(source_path),
    }


def _sanitize_reference_brief(
    brief: Mapping[str, Any],
    *,
    project_dir: Path,
    source: Mapping[str, Any],
) -> dict[str, Any]:
    """Remove host paths from the analyzer brief while keeping its detail."""

    cleaned = _safe_json(dict(brief))
    if not isinstance(cleaned, dict):
        cleaned = {}
    source_payload = cleaned.get("source")
    if not isinstance(source_payload, dict):
        source_payload = {}
        cleaned["source"] = source_payload
    source_payload.pop("local_path", None)
    source_payload["name"] = source.get("name")
    source_payload["project_path"] = source.get("project_path")
    keyframes = cleaned.get("keyframes")
    if isinstance(keyframes, list):
        for item in keyframes:
            if not isinstance(item, dict):
                continue
            raw_path = item.get("path")
            if not raw_path:
                continue
            try:
                path = Path(str(raw_path)).expanduser()
                if not path.is_absolute():
                    path = (project_dir / path).resolve()
                item["path"] = _relative(project_dir, path)
            except (ValueError, OSError):
                item["path"] = Path(str(raw_path)).name
    return cleaned


def _reference_keyframes(brief: Mapping[str, Any], project_dir: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    values = brief.get("keyframes") if isinstance(brief, Mapping) else None
    if not isinstance(values, list):
        return rows
    for index, item in enumerate(values, start=1):
        if not isinstance(item, Mapping):
            continue
        raw_path = item.get("path")
        if not raw_path:
            continue
        try:
            path = Path(str(raw_path))
            if not path.is_absolute():
                path = (project_dir / path).resolve()
            relative = _relative(project_dir, path)
        except (ValueError, OSError):
            continue
        if not path.is_file():
            continue
        rows.append({
            "index": index,
            "path": relative,
            "timestamp_seconds": _finite_timestamp(item.get("timestamp", item.get("timestamp_seconds"))),
            "scene_index": item.get("scene_index", 0),
            "sha256": _sha256(path),
            "size_bytes": path.stat().st_size,
        })
    return rows


def _emit_reference_event(project_dir: Path, status: str, **payload: Any) -> None:
    try:
        emit_event(project_dir, {"event": "reference_review", "status": status, **_safe_json(payload)})
        notify_project_changed(project_dir.name)
    except Exception:
        pass


def review_reference_video(
    request: ReferenceReviewRequest | Mapping[str, Any],
    *,
    project_root: str | Path = DEFAULT_PROJECT_ROOT,
) -> dict[str, Any]:
    """Run OpenMontage's local reference-video analysis stage.

    The tool extracts structure, representative frames, motion/pacing and
    available audio/transcript signals.  It does not call a paid provider and
    does not claim that a missing recognizer produced a transcript.
    """

    model = request if isinstance(request, ReferenceReviewRequest) else ReferenceReviewRequest.model_validate(request)
    if model.dry_run or not model.execute:
        preview = _reference_plan(model, project_root=project_root)
        preview.pop("_resolved_source_for_preview", None)
        return preview
    if not model.confirm:
        return {
            "status": "confirmation_required",
            "project_id": model.project_id,
            "would_execute": False,
            "would_write": False,
            "error": "confirm=true is required before reference analysis can write frames and reports",
        }

    analyzer_snapshot = _reference_analyzer_snapshot()
    try:
        project_dir = _resolve_project(project_root, model.project_id)
        source_path, source = _reference_source_record(project_dir, model.source)
    except (ValueError, FileNotFoundError) as exc:
        return {"status": "invalid_request", "project_id": model.project_id, "would_write": False, "error": str(exc)}

    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        error = "ffmpeg 和 ffprobe 都是参考视频分析的必需依赖；本次没有写入分析结果"
        _emit_reference_event(project_dir, "unavailable", source=source.get("project_path") or source.get("name"), error=error)
        return {"status": "unavailable", "project_id": model.project_id, "source": source, "analyzer": analyzer_snapshot, "would_write": False, "error": error}
    if analyzer_snapshot["status"] != "available":
        error = analyzer_snapshot.get("install_instructions") or "本机 video_analyzer 不可用；没有写入分析结果"
        _emit_reference_event(project_dir, "unavailable", source=source.get("project_path") or source.get("name"), error=error)
        return {"status": "unavailable", "project_id": model.project_id, "source": source, "analyzer": analyzer_snapshot, "would_write": False, "error": error}

    digest = source["sha256"][:16]
    # Each review retains its own evidence; re-analysis must not delete frames
    # still referenced by an older report or creator's accepted work.
    import uuid
    output_dir = project_dir / "analysis" / "reference" / f"{digest}-{model.analysis_depth}-{model.max_keyframes}-{uuid.uuid4().hex[:8]}"
    output_dir.mkdir(parents=True, exist_ok=True)
    analyzer = VideoAnalyzer()
    try:
        raw = analyzer.execute({
            "source": str(source_path),
            "analysis_depth": model.analysis_depth,
            "max_keyframes": model.max_keyframes,
            "output_dir": str(output_dir),
        })
        ok, data, error = _tool_result_parts(raw)
        if not ok:
            message = error or "reference video analysis failed"
            _emit_reference_event(project_dir, "failed", source=source.get("project_path") or source.get("name"), error=message)
            return {"status": "failed", "project_id": model.project_id, "source": source, "analyzer": analyzer_snapshot, "would_write": False, "error": message}

        brief = _sanitize_reference_brief(data, project_dir=project_dir, source=source)
        brief_path = output_dir / "video_analysis_brief.json"
        if brief_path.is_file():
            _atomic_bytes(brief_path, json.dumps(brief, ensure_ascii=False, indent=2).encode("utf-8") + b"\n")
        keyframes = _reference_keyframes(brief, project_dir)
        scenes_path = output_dir / "scenes.json"
        brief_artifact, brief_hash = _write_manifest(project_dir, "video_analysis_brief.json", brief)
        review_payload = {
            "schema_version": "1.0",
            "project_id": model.project_id,
            "stage": "research",
            "status": "completed",
            "created_at": _utc_now(),
            "source": source,
            "analysis_depth": model.analysis_depth,
            "max_keyframes": model.max_keyframes,
            "summary": (brief.get("content_analysis") or {}).get("summary", ""),
            "duration_seconds": (brief.get("source") or {}).get("duration_seconds", 0),
            "scene_count": (brief.get("structure_analysis") or {}).get("total_scenes", 0),
            "pacing_profile": (brief.get("structure_analysis") or {}).get("pacing_profile", {}),
            "keyframes": keyframes,
            "transcript": {
                "available": bool(brief.get("narration_transcript")),
                "language": (brief.get("narration_transcript") or {}).get("language") if isinstance(brief.get("narration_transcript"), Mapping) else None,
            },
            "analysis": brief,
            "analyzer": analyzer_snapshot,
            "artifacts": {
                "video_analysis_brief": _relative(project_dir, brief_artifact),
                "source_analysis_brief": _relative(project_dir, brief_path) if brief_path.is_file() else None,
                "scenes": _relative(project_dir, scenes_path) if scenes_path.is_file() else None,
                "keyframes": [item["path"] for item in keyframes],
            },
            "steps_failed": ((brief.get("_analysis_meta") or {}).get("steps_failed", [])),
        }
        review_artifact, review_hash = _write_manifest(project_dir, "source_media_review.json", review_payload)
        checkpoint = _write_stage_checkpoint(
            project_dir,
            "research",
            "completed",
            artifacts={
                "source_media_review": "artifacts/source_media_review.json",
                "video_analysis_brief": "artifacts/video_analysis_brief.json",
            },
            metadata={
                "reference_analysis": True,
                "analysis_depth": model.analysis_depth,
                "keyframe_count": len(keyframes),
                "scene_count": review_payload["scene_count"],
                "partial": bool(review_payload["steps_failed"]),
            },
        )
        _emit_reference_event(
            project_dir,
            "completed",
            source=source.get("project_path") or source.get("name"),
            artifact=_relative(project_dir, review_artifact),
            keyframe_count=len(keyframes),
            scene_count=review_payload["scene_count"],
        )
        return {
            "status": "completed",
            "project_id": model.project_id,
            "source": source,
            "analysis_depth": model.analysis_depth,
            "summary": review_payload["summary"],
            "duration_seconds": review_payload["duration_seconds"],
            "scene_count": review_payload["scene_count"],
            "scenes": (brief.get("structure_analysis") or {}).get("scenes", []),
            "pacing_profile": review_payload["pacing_profile"],
            "keyframes": keyframes,
            "transcript": review_payload["transcript"],
            "steps_failed": review_payload["steps_failed"],
            "artifacts": {
                "source_media_review": {"path": _relative(project_dir, review_artifact), "sha256": review_hash},
                "video_analysis_brief": {"path": _relative(project_dir, brief_artifact), "sha256": brief_hash},
                "checkpoint": {"path": _relative(project_dir, checkpoint)},
            },
            "network": {"used": False},
        }
    except Exception as exc:
        _emit_reference_event(project_dir, "failed", source=source.get("project_path") or source.get("name"), error=str(exc)[:600])
        return {"status": "failed", "project_id": model.project_id, "source": source, "would_write": False, "error": str(exc)[:600]}


def _stock_source_snapshot() -> dict[str, Any]:
    """Return stock-adapter discovery without making a network request."""

    try:
        from tools.video.stock_sources import source_catalog, source_summary

        catalog = _safe_json(source_catalog())
        summary = _safe_json(source_summary())
        if not isinstance(catalog, list):
            catalog = []
        if not isinstance(summary, Mapping):
            summary = {"configured": 0, "total": len(catalog), "available_source_names": [], "unavailable_source_names": []}
        return {"catalog": catalog, "summary": dict(summary)}
    except Exception as exc:
        return {
            "catalog": [],
            "summary": {"configured": 0, "total": 0, "available_source_names": [], "unavailable_source_names": []},
            "error": f"stock source discovery failed: {type(exc).__name__}: {exc}",
        }


def _stock_relative_path(project_dir: Path, raw_path: Any) -> str | None:
    """Convert a tool path into a safe project-relative path."""

    if not raw_path:
        return None
    try:
        path = Path(str(raw_path)).expanduser()
        if not path.is_absolute():
            path = (project_dir / path).resolve()
        return _relative(project_dir, path)
    except (ValueError, OSError):
        return None


_STOCK_DEFAULT_SOURCE_ORDER = ("wikimedia", "archive_org", "mixkit", "pexels", "pixabay_video", "unsplash")
_STOCK_SPACE_TERMS = re.compile(
    r"(?:space|outer\s+space|moon|lunar|mars|planet|galaxy|astronomy|nasa|太空|宇宙|月球|月亮|星空|天文|火星|行星|银河)",
    re.IGNORECASE,
)


def _stock_query_specs(model: StockSearchRequest) -> list[dict[str, Any]]:
    """Build the one source of truth for query slots used by plan and execute."""
    shot_map = model.query_shot_ids or [[] for _ in model.queries]
    return [
        {
            "query": query,
            "kind": model.kind,
            "slot_id": ",".join(shot_map[index]) if shot_map[index] else f"query-{index + 1:02d}",
            "shot_ids": list(shot_map[index]),
        }
        for index, query in enumerate(model.queries)
    ]


def _stock_effective_sources(model: StockSearchRequest, available: Sequence[str]) -> tuple[list[str], list[str]]:
    """Resolve explicit/default sources without falling back to unrelated ones."""
    available_set = set(available)
    if model.sources is not None:
        return list(model.sources), [name for name in model.sources if name not in available_set]

    selected = [name for name in _STOCK_DEFAULT_SOURCE_ORDER if name in available_set]
    if any(_STOCK_SPACE_TERMS.search(query) for query in model.queries) and "nasa" in available_set:
        selected.append("nasa")
    return selected, []


def _stock_shot_results(clips: Sequence[Mapping[str, Any]], shot_ids: Sequence[str]) -> list[dict[str, Any]]:
    by_shot: dict[str, list[dict[str, Any]]] = {str(shot_id): [] for shot_id in shot_ids}
    for clip in clips:
        for shot_id in clip.get("shot_ids", []) if isinstance(clip.get("shot_ids"), list) else []:
            if str(shot_id) in by_shot:
                by_shot[str(shot_id)].append(dict(clip))
    return [
        {
            "shot_id": shot_id,
            "candidates_found": bool(by_shot[shot_id]),
            "missing": not bool(by_shot[shot_id]),
            "clips": by_shot[shot_id],
            "clip_count": len(by_shot[shot_id]),
        }
        for shot_id in by_shot
    ]
def _stock_plan(
    model: StockSearchRequest,
    *,
    project_root: str | Path = DEFAULT_PROJECT_ROOT,
) -> dict[str, Any]:
    sources = _stock_source_snapshot()
    try:
        _resolve_project(project_root, model.project_id)
    except (ValueError, FileNotFoundError) as exc:
        return {"status": "invalid_project", "project_id": model.project_id, "error": str(exc)}

    summary = sources.get("summary") if isinstance(sources.get("summary"), Mapping) else {}
    available = list(summary.get("available_source_names") or [])
    unavailable = list(summary.get("unavailable_source_names") or [])
    effective_sources, requested_unavailable = _stock_effective_sources(model, available)
    ready = bool(effective_sources) and not requested_unavailable
    output_dir = f"assets/stock"
    return {
        "status": "dry_run",
        "project_id": model.project_id,
        "queries": model.queries,
        "query_shot_ids": model.query_shot_ids,
        "kind": model.kind,
        "clips_per_query": model.clips_per_query,
        "sources": effective_sources,
        "source_catalog": sources.get("catalog", []),
        "source_summary": summary,
        "unavailable_requested_sources": requested_unavailable,
        "shot_results": _stock_shot_results([], [shot_id for ids in (model.query_shot_ids or []) for shot_id in ids]),
        "filters": {
            "min_duration": model.min_duration,
            "max_duration": model.max_duration,
            "orientation": model.orientation,
            "min_width": model.min_width,
        },
        "output_dir": output_dir,
        "would_execute": ready,
        "would_write": False,
        "requires_confirmation": True,
        "network": {"used": False, "free_tier": True},
        "planned_outputs": [
            "assets/stock/clips/",
            "assets/stock/thumbnails/",
            "artifacts/stock_search_manifest.json",
            "checkpoint_assets.json",
        ],
        "message": (
            "仅完成素材源和参数预检；发送 execute=true 且 confirm=true 才会检索并下载候选素材。"
            if ready else
            "当前没有满足条件的素材源；请配置或选择可用的免费来源后再执行。"
        ),
    }


def _stock_failure_summary(errors: list) -> str:
    """Explain source failures without exposing remote URLs or credentials."""
    messages = []
    for item in errors:
        if not isinstance(item, Mapping):
            continue
        raw = str(item.get("error", "")).lower()
        source = str(item.get("source", "素材源"))[:40]
        if item.get('status_code') == 403 or "403" in raw or "forbidden" in raw:
            reason = "来源拒绝访问"
        elif item.get('error_kind') == 'permission_denied' or "401" in raw or "unauthorized" in raw:
            reason = "接口认证未通过"
        elif item.get('error_kind') == 'rate_limited' or "429" in raw or item.get('status_code') == 429:
            reason = "来源限流，请稍后再手动查询"
        elif item.get('error_kind') == 'temporarily_unavailable' or item.get('status_code') == 503:
            reason = "来源服务繁忙，请稍后再手动查询"
        elif "download url" in raw:
            reason = "无法解析下载地址"
        elif item.get('error_kind') in {'timeout', 'connection_failed'} or "ssl" in raw or "connection" in raw or "timeout" in raw:
            reason = "连接失败或超时"
        elif item.get('error_kind') == 'invalid_response' or "json" in raw:
            reason = "返回内容不是预期的数据"
        elif item.get("phase") == "validation":
            reason = "下载文件未通过本机校验"
        else:
            reason = "下载失败" if item.get("phase") == "download" else "检索失败"
        message = f"{source}：{reason}"
        if message not in messages:
            messages.append(message)
    return "；".join(messages[:6])


def search_stock_media(
    request: StockSearchRequest | Mapping[str, Any],
    *,
    project_root: str | Path = DEFAULT_PROJECT_ROOT,
) -> dict[str, Any]:
    """Run OpenMontage's lightweight multi-source stock search.

    This deliberately uses ``DirectClipSearch`` rather than the heavier CLIP
    corpus builder.  The browser receives real downloaded files plus source,
    creator and licence metadata, while semantic embedding/ranking remains an
    optional later stage when the local ML dependencies are installed.
    """

    model = request if isinstance(request, StockSearchRequest) else StockSearchRequest.model_validate(request)
    if model.dry_run or not model.execute:
        return _stock_plan(model, project_root=project_root)
    if not model.confirm:
        return {
            "status": "confirmation_required",
            "project_id": model.project_id,
            "would_execute": False,
            "would_write": False,
            "error": "confirm=true is required before stock search can make network requests and write files",
        }

    try:
        project_dir = _resolve_project(project_root, model.project_id)
    except (ValueError, FileNotFoundError) as exc:
        return {"status": "invalid_project", "project_id": model.project_id, "would_write": False, "error": str(exc)}

    try:
        from tools.video.direct_clip_search import DirectClipSearch
        from tools.video.stock_sources import source_summary

        summary = source_summary()
        available = set(summary.get("available_source_names") or []) if isinstance(summary, Mapping) else set()
        effective_sources, requested_unavailable = _stock_effective_sources(model, sorted(available))
        if requested_unavailable:
            error = f"requested stock sources unavailable: {', '.join(requested_unavailable)}"
            emit_event(project_dir, {"event": "stock_search", "status": "unavailable", "error": error})
            return {"status": "unavailable", "project_id": model.project_id, "would_write": False, "error": error, "source_summary": summary}
        if not effective_sources:
            error = "no applicable stock sources are available for this topic; configure a suitable free source or choose sources explicitly"
            emit_event(project_dir, {"event": "stock_search", "status": "unavailable", "error": error})
            return {"status": "unavailable", "project_id": model.project_id, "would_write": False, "error": error, "source_summary": summary}

        output_dir = project_dir / "assets" / "stock"
        search_inputs: dict[str, Any] = {
            "output_dir": str(output_dir),
            "queries": _stock_query_specs(model),
            "sources": effective_sources,
            "clips_per_query": model.clips_per_query,
            "filters": {
                "min_duration": model.min_duration,
                "max_duration": model.max_duration,
                "orientation": model.orientation,
                "min_width": model.min_width,
            },
            "extract_thumbnails": model.extract_thumbnails,
            "timeout_seconds": model.timeout_seconds,
            "skip_existing": True,
        }
        raw = DirectClipSearch().execute(search_inputs)
        ok, data, error = _tool_result_parts(raw)
        data = dict(data or {})
        if not ok and not data.get("clips"):
            message = ("素材检索超时，尚未取得可用素材；可减少关键词或指定单个来源重试。" if data.get("timed_out") else "素材检索未完成，请检查来源配置或网络连接。")
            details = _stock_failure_summary(data.get("errors") or [])
            if details:
                message += " " + details
            raw_error = str(error or "").lower()
            status = "unavailable" if "unavailable" in raw_error or "no stock sources" in raw_error else "failed"
            emit_event(project_dir, {"event": "stock_search", "status": status, "error": message[:600]})
            return {"status": status, "project_id": model.project_id, "would_write": False, "error": message[:600], "source_summary": summary, "partial": data}

        clips: list[dict[str, Any]] = []
        for item in data.get("clips", []) if isinstance(data.get("clips"), list) else []:
            if not isinstance(item, Mapping):
                continue
            record = dict(_safe_json(dict(item)))
            raw_slot_id = str(record.get("slot_id") or "")
            record["shot_ids"] = [shot_id for shot_id in raw_slot_id.split(",") if shot_id] if model.query_shot_ids else []
            path = _stock_relative_path(project_dir, record.get("path"))
            thumbnail = _stock_relative_path(project_dir, record.get("thumbnail"))
            if path:
                record["path"] = path
            else:
                record.pop("path", None)
            if thumbnail:
                record["thumbnail"] = thumbnail
            else:
                record.pop("thumbnail", None)
            if record.get("path"):
                clips.append(record)

        source_errors = data.get("errors") or []
        if not ok:
            source_errors = [*source_errors, {"source": "检索任务", "phase": "search", "error": error or "timeout"}]
        result_status = "completed" if clips else "failed" if source_errors else "no_results"
        detail = _stock_failure_summary(source_errors)
        all_shot_ids = [shot_id for ids in (model.query_shot_ids or []) for shot_id in ids]
        shot_results = _stock_shot_results(clips, all_shot_ids)
        message = (
            f"已取得 {len(clips)} 个候选素材；请核对画面与地点。" if clips else
            "没有取得可用素材。" if source_errors else
            "没有找到符合条件的素材。可拆分关键词、尝试地点英文名或改选图片；不会用无关素材替代真实地点。"
        )
        if detail:
            message += f" 部分来源异常：{detail}。可指定其他来源重试。"
        manifest_payload = {
            "schema_version": "1.0",
            "project_id": model.project_id,
            "stage": "stock_search",
            "status": result_status,
            "created_at": _utc_now(),
            "queries": model.queries,
            "query_shot_ids": model.query_shot_ids,
            "kind": model.kind,
            "sources": data.get("resolved_sources") or effective_sources,
            "clips": clips,
            "shot_results": shot_results,
            "errors": source_errors,
            "network": {"used": True, "free_tier": True},
        }
        manifest, manifest_hash = _write_manifest(project_dir, "stock_search_manifest.json", manifest_payload)
        checkpoint = _write_stage_checkpoint(
            project_dir,
            "assets",
            "completed" if clips else "failed",
            artifacts={"stock_search_manifest": "artifacts/stock_search_manifest.json"},
            metadata={
                "stock_search": True,
                "query_count": len(model.queries),
                "clip_count": len(clips),
                "source_count": len(data.get("resolved_sources") or []),
                "partial": bool(data.get("errors")),
            },
        )
        emit_event(project_dir, {
            "event": "stock_search",
            "status": result_status,
            "artifact": _relative(project_dir, manifest),
            "clip_count": len(clips),
            "error_count": len(data.get("errors") or []),
        })
        notify_project_changed(project_dir.name)
        return {
            "status": result_status,
            "message": message,
            "error": message if result_status == "failed" else None,
            "partial": bool(clips and source_errors),
            "project_id": model.project_id,
            "clips": clips,
            "shot_results": shot_results,
            "clip_count": len(clips),
            "clips_downloaded": data.get("clips_downloaded", 0),
            "clips_reused": data.get("clips_reused", 0),
            "resolved_sources": data.get("resolved_sources") or [],
            "errors": source_errors,
            "source_summary": summary,
            "manifest": {"path": _relative(project_dir, manifest), "sha256": manifest_hash},
            "checkpoint": {"path": _relative(project_dir, checkpoint)},
            "network": {"used": True, "free_tier": True},
            "cost_cny": 0.0,
        }
    except Exception as exc:
        emit_event(project_dir, {"event": "stock_search", "status": "failed", "error": str(exc)[:600]})
        return {"status": "failed", "project_id": model.project_id, "would_write": False, "error": str(exc)[:600]}


def _trim_paths(
    project_dir: Path,
    model: TrimRequest,
) -> tuple[Path, Path, dict[str, Any]]:
    """Resolve and validate a trim request, returning input/output metadata."""

    source = _resolve_project_file(project_dir, model.input_path)
    if source.suffix.lower() not in MEDIA_VIDEO_EXTENSIONS:
        raise ValueError(f"input_path must use a supported video extension: {source.suffix or '<none>'}")
    probe = _probe_media(source) or {}
    duration = float(probe.get("duration_seconds") or 0)
    if duration > 0 and model.start_seconds >= duration:
        raise ValueError(f"start_seconds {model.start_seconds:g} is outside the source duration {duration:.3f}s")
    if duration > 0 and model.end_seconds is not None and model.end_seconds > duration + 0.05:
        raise ValueError(f"end_seconds {model.end_seconds:g} exceeds the source duration {duration:.3f}s")
    effective_end = model.end_seconds if model.end_seconds is not None else (duration or None)
    output = project_dir / "assets" / "trimmed" / model.output_name
    if output.resolve() == source.resolve():
        raise ValueError("output_name must not overwrite input_path")
    return source, output, {
        "input": {
            "path": _relative(project_dir, source),
            "sha256": _sha256(source),
            "size_bytes": source.stat().st_size,
            "probe": probe,
        },
        "start_seconds": round(float(model.start_seconds), 3),
        "end_seconds": round(float(effective_end), 3) if effective_end is not None else None,
        "codec": model.codec,
        "planned_output": _relative(project_dir, output),
    }


def _trim_plan(
    model: TrimRequest,
    *,
    project_root: str | Path,
) -> dict[str, Any]:
    try:
        project_dir = _resolve_project(project_root, model.project_id)
        source, output, details = _trim_paths(project_dir, model)
    except (ValueError, FileNotFoundError) as exc:
        return {
            "status": "invalid_request",
            "project_id": model.project_id,
            "would_write": False,
            "error": str(exc),
        }
    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    return {
        "status": "dry_run",
        "project_id": model.project_id,
        "input": details["input"],
        "start_seconds": details["start_seconds"],
        "end_seconds": details["end_seconds"],
        "codec": model.codec,
        "output": {"path": details["planned_output"], "exists": output.is_file()},
        "ffmpeg_configured": bool(ffmpeg),
        "ffprobe_configured": bool(ffprobe),
        "would_execute": bool(ffmpeg and ffprobe),
        "would_write": False,
        "requires_confirmation": False,
        "message": (
            "仅预览片段裁剪计划；execute=true 后才会写入 assets/trimmed。"
            " 精确重编码(libx264)更适合准确切点，copy 更快但切点可能落在关键帧。"
        ),
    }


def trim_media(
    request: TrimRequest | Mapping[str, Any],
    *,
    project_root: str | Path = DEFAULT_PROJECT_ROOT,
) -> dict[str, Any]:
    """Cut a local video with OpenMontage's deterministic ``video_trimmer``."""

    model = request if isinstance(request, TrimRequest) else TrimRequest.model_validate(request)
    project_dir: Path | None = None
    if model.dry_run or not model.execute:
        return _trim_plan(model, project_root=project_root)
    try:
        project_dir = _resolve_project(project_root, model.project_id)
        source, output, details = _trim_paths(project_dir, model)
        ffmpeg = shutil.which("ffmpeg")
        ffprobe = shutil.which("ffprobe")
        if not ffmpeg or not ffprobe:
            return {
                "status": "unavailable",
                "project_id": model.project_id,
                "would_write": False,
                "error": "ffmpeg 和 ffprobe 都是片段裁剪的必需依赖；本次没有写入视频。",
            }
        output.parent.mkdir(parents=True, exist_ok=True)
        raw = VideoTrimmer().execute({
            "operation": "cut",
            "input_path": str(source),
            "output_path": str(output),
            "start_seconds": float(model.start_seconds),
            "end_seconds": model.end_seconds,
            "codec": model.codec,
        })
        ok, data, error = _tool_result_parts(raw)
        if not ok or not output.is_file() or output.stat().st_size <= 0:
            message = error or "video trimmer did not produce an output file"
            emit_event(project_dir, {"event": "trim", "status": "failed", "error": message[:600]})
            return {"status": "failed", "project_id": model.project_id, "would_write": False, "error": message[:600]}
        output_probe = _probe_media(output)
        if not output_probe:
            return {
                "status": "failed",
                "project_id": model.project_id,
                "would_write": False,
                "error": "片段已写出，但 ffprobe 无法验证输出；请检查源视频编码。",
            }
        manifest_payload = {
            "schema_version": "1.0",
            "project_id": model.project_id,
            "stage": "edit",
            "operation": "trim",
            "status": "completed",
            "created_at": _utc_now(),
            "input": details["input"],
            "cut": {
                "start_seconds": details["start_seconds"],
                "end_seconds": details["end_seconds"],
                "codec": model.codec,
            },
            "output": {
                "path": _relative(project_dir, output),
                "sha256": _sha256(output),
                "size_bytes": output.stat().st_size,
                "probe": output_probe,
            },
            "tool": {"name": "video_trimmer", "provider": "ffmpeg", "data": data},
        }
        manifest, manifest_hash = _write_manifest(project_dir, "trim_manifest.json", manifest_payload)
        checkpoint = _write_stage_checkpoint(
            project_dir,
            "edit",
            "completed",
            artifacts={"trim_manifest": "artifacts/trim_manifest.json"},
            metadata={
                "video_trim": True,
                "input": _relative(project_dir, source),
                "output": _relative(project_dir, output),
                "duration_seconds": output_probe.get("duration_seconds"),
            },
        )
        emit_event(project_dir, {
            "event": "trim",
            "status": "completed",
            "artifact": _relative(project_dir, manifest),
            "output": _relative(project_dir, output),
        })
        notify_project_changed(project_dir.name)
        return {
            "status": "completed",
            "project_id": model.project_id,
            "input": details["input"],
            "output": {
                "path": _relative(project_dir, output),
                "sha256": _sha256(output),
                "size_bytes": output.stat().st_size,
                "probe": output_probe,
            },
            "cut": manifest_payload["cut"],
            "manifest": {"path": _relative(project_dir, manifest), "sha256": manifest_hash},
            "checkpoint": {"path": _relative(project_dir, checkpoint)},
            "cost_cny": 0.0,
            "message": "片段已裁剪并保存到当前项目；可把输出路径加入多段合成清单。",
        }
    except (ValueError, FileNotFoundError) as exc:
        return {"status": "invalid_request", "project_id": model.project_id, "would_write": False, "error": str(exc)}
    except Exception as exc:
        if project_dir is not None:
            emit_event(project_dir, {"event": "trim", "status": "failed", "error": str(exc)[:600]})
        return {"status": "failed", "project_id": model.project_id, "would_write": False, "error": str(exc)[:600]}


def _video_postprocess_output_path(project_dir: Path, model: VideoPostprocessRequest) -> Path:
    """Choose a derived output location for one local video post stage."""

    suffix = Path(model.output_name).suffix.lower()
    report_operation = model.operation == "scene_detect" or (
        model.operation == "silence_cut" and model.mode == "mark"
    )
    if report_operation:
        if suffix != ".json":
            raise ValueError("场景检测和静音标记的 output_name 必须是 .json 文件")
        directory = "analysis/video" if model.operation == "scene_detect" else "analysis/silence"
        return project_dir / directory / model.output_name
    if suffix not in MEDIA_VIDEO_EXTENSIONS:
        raise ValueError("视频后期输出必须使用 mp4、mov、m4v、webm 或 mkv")
    return project_dir / "renders" / "processed" / model.output_name


def _video_postprocess_paths(
    project_dir: Path,
    model: VideoPostprocessRequest,
) -> tuple[Path, Path, dict[str, Any]]:
    """Resolve and validate source, optional tracking data and derived output."""

    source = _resolve_project_file(project_dir, model.input_path)
    if source.suffix.lower() not in MEDIA_VIDEO_EXTENSIONS:
        raise ValueError(f"input_path must use a supported video extension: {source.suffix or '<none>'}")
    output = _video_postprocess_output_path(project_dir, model)
    if output.resolve() == source.resolve():
        raise ValueError("output_name must not overwrite input_path")

    tracking_record: dict[str, Any] | None = None
    tracking_path: Path | None = None
    if model.face_tracking_json:
        tracking_path = _resolve_project_file(project_dir, model.face_tracking_json)
        if tracking_path.suffix.lower() != ".json":
            raise ValueError("face_tracking_json must point to a .json file")
        tracking_record = {
            "path": _relative(project_dir, tracking_path),
            "sha256": _sha256(tracking_path),
            "size_bytes": tracking_path.stat().st_size,
        }

    details = {
        "input": {
            "path": _relative(project_dir, source),
            "sha256": _sha256(source),
            "size_bytes": source.stat().st_size,
            "probe": _probe_media(source),
        },
        "tracking": tracking_record,
        "planned_output": _relative(project_dir, output),
        "settings": {
            "mode": model.mode,
            "silence_threshold_db": model.silence_threshold_db,
            "min_silence_duration": model.min_silence_duration,
            "padding_seconds": model.padding_seconds,
            "silence_speed_factor": model.silence_speed_factor,
            "target_aspect": model.target_aspect,
            "target_width": model.target_width,
            "target_height": model.target_height,
            "smoothing_window": model.smoothing_window,
            "face_padding": model.face_padding,
            "profile": model.profile,
            "intensity": model.intensity,
            "scene_method": model.scene_method,
            "scene_threshold": model.scene_threshold,
            "min_scene_length_seconds": model.min_scene_length_seconds,
        },
    }
    return source, output, details


def _video_postprocess_plan(
    model: VideoPostprocessRequest,
    *,
    project_root: str | Path,
) -> dict[str, Any]:
    try:
        project_dir = _resolve_project(project_root, model.project_id)
        _source, output, details = _video_postprocess_paths(project_dir, model)
    except (ValueError, FileNotFoundError) as exc:
        return {
            "status": "invalid_request",
            "project_id": model.project_id,
            "operation": model.operation,
            "would_write": False,
            "error": str(exc),
        }

    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    report_operation = model.operation == "scene_detect" or (
        model.operation == "silence_cut" and model.mode == "mark"
    )
    return {
        "status": "dry_run",
        "project_id": model.project_id,
        "operation": model.operation,
        "input": details["input"],
        "tracking": details["tracking"],
        "settings": details["settings"],
        "output": {
            "path": _relative(project_dir, output),
            "kind": "report" if report_operation else "video",
            "exists": output.is_file(),
        },
        "ffmpeg_configured": bool(ffmpeg),
        "ffprobe_configured": bool(ffprobe),
        "would_execute": bool(ffmpeg and ffprobe),
        "would_write": False,
        "requires_confirmation": False,
        "cost_cny": 0.0,
        "message": (
            "仅预览本机视频后期计划；execute=true 后才会写入派生视频或分析报告。"
            "自动构图在未安装人脸跟踪依赖时使用中心裁切。"
            if model.operation == "auto_reframe"
            else "仅预览本机视频后期计划；execute=true 后才会写入项目。"
        ),
    }


def _video_postprocess_tool_payload(
    project_dir: Path,
    model: VideoPostprocessRequest,
    source: Path,
    output: Path,
    tracking_path: Path | None,
) -> dict[str, Any]:
    """Translate the web request to the exact OpenMontage tool schemas."""

    if model.operation == "silence_cut":
        return {
            "input_path": str(source),
            "output_path": str(output),
            "mode": model.mode,
            "silence_threshold_db": model.silence_threshold_db,
            "min_silence_duration": model.min_silence_duration,
            "padding_seconds": model.padding_seconds,
            "silence_speed_factor": model.silence_speed_factor,
            "codec": "libx264",
            "crf": 18,
        }
    if model.operation == "scene_detect":
        payload: dict[str, Any] = {
            "input_path": str(source),
            "output_path": str(output),
            "method": model.scene_method,
            "min_scene_length_seconds": model.min_scene_length_seconds,
        }
        if model.scene_threshold is not None:
            payload["threshold"] = model.scene_threshold
        return payload
    if model.operation == "auto_reframe":
        payload = {
            "input_path": str(source),
            "output_path": str(output),
            "target_aspect": model.target_aspect,
            "smoothing_window": model.smoothing_window,
            "face_padding": model.face_padding,
            "sample_fps": 5,
            "codec": "libx264",
            "crf": 18,
        }
        if model.target_width is not None and model.target_height is not None:
            payload["target_width"] = model.target_width
            payload["target_height"] = model.target_height
        if tracking_path is not None:
            payload["face_tracking_json"] = str(tracking_path)
        return payload
    return {
        "input_path": str(source),
        "output_path": str(output),
        "profile": model.profile,
        "intensity": model.intensity,
        "codec": "libx264",
        "crf": 18,
    }


def _video_postprocess_manifest_name(model: VideoPostprocessRequest) -> str:
    if model.operation == "silence_cut":
        return "silence_cut_manifest.json"
    return {
        "scene_detect": "scene_detect_manifest.json",
        "auto_reframe": "auto_reframe_manifest.json",
        "color_grade": "color_grade_manifest.json",
    }[model.operation]


def _video_postprocess_tool(model: VideoPostprocessRequest) -> Any:
    return {
        "silence_cut": SilenceCutter,
        "scene_detect": SceneDetect,
        "auto_reframe": AutoReframe,
        "color_grade": ColorGrade,
    }[model.operation]()


def video_postprocess_media(
    request: VideoPostprocessRequest | Mapping[str, Any],
    *,
    project_root: str | Path = DEFAULT_PROJECT_ROOT,
) -> dict[str, Any]:
    """Run one local OpenMontage video post-process tool and persist evidence."""

    model = request if isinstance(request, VideoPostprocessRequest) else VideoPostprocessRequest.model_validate(request)
    if model.dry_run or not model.execute:
        return _video_postprocess_plan(model, project_root=project_root)

    project_dir: Path | None = None
    try:
        project_dir = _resolve_project(project_root, model.project_id)
        source, output, details = _video_postprocess_paths(project_dir, model)
        ffmpeg = shutil.which("ffmpeg")
        ffprobe = shutil.which("ffprobe")
        if not ffmpeg or not ffprobe:
            return {
                "status": "unavailable",
                "project_id": model.project_id,
                "operation": model.operation,
                "would_write": False,
                "error": "ffmpeg 和 ffprobe 都是视频后期的必需依赖；本次没有写入文件。",
            }

        tracking_path = _resolve_project_file(project_dir, model.face_tracking_json) if model.face_tracking_json else None
        output.parent.mkdir(parents=True, exist_ok=True)
        tool_data: dict[str, Any]
        derived_copy = False

        # ColorGrade's upstream filter chain cannot express a zero-opacity
        # grade.  A zero intensity is explicitly defined as an identity pass,
        # so copy the source into the requested derived location and record it.
        if model.operation == "color_grade" and model.intensity == 0:
            shutil.copy2(source, output)
            tool_data = {"message": "intensity=0: copied source without applying a grade", "identity_pass": True}
        else:
            tool = _video_postprocess_tool(model)
            raw = tool.execute(
                _video_postprocess_tool_payload(project_dir, model, source, output, tracking_path)
            )
            ok, tool_data, error = _tool_result_parts(raw)
            if not ok:
                message = error or f"{model.operation} tool failed"
                emit_event(project_dir, {"event": "video_postprocess", "status": "failed", "operation": model.operation, "error": message[:600]})
                return {"status": "failed", "project_id": model.project_id, "operation": model.operation, "would_write": False, "error": message[:600]}

            # SilenceCutter and AutoReframe intentionally return the source
            # path when no edit is necessary.  Still create an explicit
            # derived artifact so the browser can pass a stable path onwards.
            if not output.is_file() and model.operation == "silence_cut" and model.mode == "mark":
                reported = str(tool_data.get("output") or "")
                if reported and Path(reported).resolve() == source.resolve():
                    duration = float((details["input"].get("probe") or {}).get("duration_seconds") or 0)
                    report = {
                        "silences": [],
                        "speech_segments": ([{"start": 0.0, "end": round(duration, 3)}] if duration > 0 else []),
                        "total_duration": round(duration, 3),
                        "silence_duration": 0.0,
                        "speech_duration": round(duration, 3),
                    }
                    _atomic_bytes(output, json.dumps(report, ensure_ascii=False, indent=2).encode("utf-8") + b"\n")
                    tool_data = {**tool_data, "identity_pass": True, "silence_segments": 0, "output": str(output)}
                    derived_copy = True
            elif not output.is_file() and model.operation in {"silence_cut", "auto_reframe"}:
                reported = str(tool_data.get("output") or "")
                if reported and Path(reported).resolve() == source.resolve():
                    shutil.copy2(source, output)
                    derived_copy = True

        if not output.is_file() or output.stat().st_size <= 0:
            message = f"{model.operation} 未生成可验证的输出文件"
            emit_event(project_dir, {"event": "video_postprocess", "status": "failed", "operation": model.operation, "error": message})
            return {"status": "failed", "project_id": model.project_id, "operation": model.operation, "would_write": False, "error": message}

        report_operation = model.operation == "scene_detect" or (
            model.operation == "silence_cut" and model.mode == "mark"
        )
        output_probe = None if report_operation else _probe_media(output)
        report_data: dict[str, Any] | None = None
        if report_operation:
            try:
                loaded = json.loads(output.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise RuntimeError(f"分析报告不是有效 JSON: {exc}") from exc
            if not isinstance(loaded, dict):
                raise RuntimeError("分析报告必须是 JSON 对象")
            report_data = loaded
        elif not output_probe:
            return {
                "status": "failed",
                "project_id": model.project_id,
                "operation": model.operation,
                "would_write": False,
                "error": "视频后期已写出，但 ffprobe 无法验证输出。",
            }

        output_record: dict[str, Any] = {
            "path": _relative(project_dir, output),
            "sha256": _sha256(output),
            "size_bytes": output.stat().st_size,
            "probe": output_probe,
        }
        manifest_payload: dict[str, Any] = {
            "schema_version": "1.0",
            "project_id": model.project_id,
            "stage": "research" if report_operation and model.operation == "scene_detect" else "edit",
            "operation": model.operation,
            "status": "completed",
            "created_at": _utc_now(),
            "input": details["input"],
            "tracking": details["tracking"],
            "settings": details["settings"],
            "output": output_record,
            "report": report_data,
            "derived_copy": derived_copy,
            "tool": {"name": model.operation, "provider": "ffmpeg", "data": tool_data},
        }
        manifest_name = _video_postprocess_manifest_name(model)
        manifest, manifest_hash = _write_manifest(project_dir, manifest_name, manifest_payload)
        stage = "research" if report_operation and model.operation == "scene_detect" else "edit"
        checkpoint = _write_stage_checkpoint(
            project_dir,
            stage,
            "completed",
            artifacts={manifest_name.removesuffix(".json"): f"artifacts/{manifest_name}"},
            metadata={
                "video_postprocess": True,
                "operation": model.operation,
                "output": output_record["path"],
                "duration_seconds": (output_probe or {}).get("duration_seconds") if output_probe else None,
            },
        )
        emit_event(project_dir, {
            "event": "video_postprocess",
            "status": "completed",
            "operation": model.operation,
            "artifact": _relative(project_dir, manifest),
            "output": output_record["path"],
        })
        notify_project_changed(project_dir.name)
        result: dict[str, Any] = {
            "status": "completed",
            "project_id": model.project_id,
            "operation": model.operation,
            "input": details["input"],
            "settings": details["settings"],
            "output": output_record,
            "report": report_data,
            "manifest": {"path": _relative(project_dir, manifest), "sha256": manifest_hash},
            "checkpoint": {"path": _relative(project_dir, checkpoint)},
            "cost_cny": 0.0,
            "message": "本机视频后期已完成，并通过输出文件与 ffprobe/JSON 校验。",
        }
        if model.operation == "auto_reframe":
            result["reframe_method"] = tool_data.get("method") or ("derived_copy" if derived_copy else None)
        if model.operation == "scene_detect":
            result["scene_count"] = len((report_data or {}).get("scenes") or [])
        if model.operation == "silence_cut":
            result["silence_segments"] = tool_data.get("silence_segments")
        return result
    except (ValueError, FileNotFoundError) as exc:
        return {"status": "invalid_request", "project_id": model.project_id, "operation": model.operation, "would_write": False, "error": str(exc)}
    except Exception as exc:
        if project_dir is not None:
            emit_event(project_dir, {"event": "video_postprocess", "status": "failed", "operation": model.operation, "error": str(exc)[:600]})
        return {"status": "failed", "project_id": model.project_id, "operation": model.operation, "would_write": False, "error": str(exc)[:600]}


def _audio_output_path(project_dir: Path, model: AudioMixRequest) -> Path:
    """Choose a project-scoped output location and reject mismatched containers."""

    suffix = Path(model.output_name).suffix.lower()
    if model.operation == "segmented_music":
        if suffix not in MEDIA_VIDEO_EXTENSIONS:
            raise ValueError("segmented_music 的 output_name 必须是 mp4、mov、m4v、webm 或 mkv")
        return project_dir / "renders" / model.output_name
    if suffix not in MEDIA_AUDIO_EXTENSIONS:
        raise ValueError("音频混音、抽取和旁白压低 BGM 的 output_name 必须是音频文件")
    return project_dir / "assets" / "audio" / "processed" / model.output_name


def _audio_resolve_inputs(
    project_dir: Path,
    model: AudioMixRequest,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Resolve all operation-specific inputs once for preview and execution."""

    resolved: dict[str, Any] = {}
    records: list[dict[str, Any]] = []

    def add_path(key: str, raw: str | None, *, required: bool = False) -> None:
        if not raw:
            if required:
                raise ValueError(f"{key} is required for {model.operation}")
            return
        path = _resolve_project_file(project_dir, raw)
        if path.suffix.lower() not in MEDIA_AUDIO_EXTENSIONS | MEDIA_VIDEO_EXTENSIONS:
            raise ValueError(f"{key} must point to a supported audio or video file")
        resolved[key] = path
        records.append({
            "role": key,
            "path": _relative(project_dir, path),
            "sha256": _sha256(path),
            "size_bytes": path.stat().st_size,
            "probe": _probe_media(path),
        })

    if model.operation == "extract":
        add_path("input_path", model.input_path, required=True)
        if resolved["input_path"].suffix.lower() not in MEDIA_VIDEO_EXTENSIONS:
            raise ValueError("extract 操作的 input_path 必须是视频文件")
    elif model.operation in {"mix", "full_mix"}:
        if not model.tracks:
            raise ValueError(f"{model.operation} 至少需要一条 tracks 音频轨道")
        track_paths: list[dict[str, Any]] = []
        for track in model.tracks:
            path = _resolve_project_file(project_dir, track.path)
            if path.suffix.lower() not in MEDIA_AUDIO_EXTENSIONS | MEDIA_VIDEO_EXTENSIONS:
                raise ValueError(f"音频轨道不是受支持的音频文件：{track.path}")
            track_paths.append({
                **track.model_dump(),
                "path": str(path),
            })
            records.append({
                "role": track.role,
                "path": _relative(project_dir, path),
                "sha256": _sha256(path),
                "size_bytes": path.stat().st_size,
                "probe": _probe_media(path),
            })
        resolved["tracks"] = track_paths
        if model.operation == "full_mix" and not any(item["role"] in {"speech", "primary", "music", "secondary", "sfx"} for item in track_paths):
            raise ValueError("full_mix 的 tracks 必须包含 speech、music 或 sfx 角色")
    elif model.operation == "duck":
        if model.primary_audio or model.secondary_audio:
            add_path("primary_audio", model.primary_audio, required=True)
            add_path("secondary_audio", model.secondary_audio, required=True)
        else:
            if not model.tracks:
                raise ValueError("duck 需要 primary_audio/secondary_audio，或带角色的 tracks")
            track_paths = []
            for track in model.tracks:
                path = _resolve_project_file(project_dir, track.path)
                track_paths.append({**track.model_dump(), "path": str(path)})
                records.append({
                    "role": track.role,
                    "path": _relative(project_dir, path),
                    "sha256": _sha256(path),
                    "size_bytes": path.stat().st_size,
                    "probe": _probe_media(path),
                })
            if not any(item["role"] in {"speech", "primary"} for item in track_paths) or not any(item["role"] in {"music", "secondary"} for item in track_paths):
                raise ValueError("duck 的 tracks 必须同时包含 speech/primary 和 music/secondary")
            resolved["tracks"] = track_paths
    elif model.operation == "segmented_music":
        add_path("video_path", model.video_path, required=True)
        add_path("music_path", model.music_path, required=True)
        if resolved["video_path"].suffix.lower() not in MEDIA_VIDEO_EXTENSIONS:
            raise ValueError("segmented_music 的 video_path 必须是视频文件")
        if resolved["music_path"].suffix.lower() not in MEDIA_AUDIO_EXTENSIONS:
            raise ValueError("segmented_music 的 music_path 必须是音频文件")
        if not model.segments:
            raise ValueError("segmented_music 至少需要一个 start/end 音乐片段")
    return resolved, {"inputs": records}


def _audio_tool_payload(
    project_dir: Path,
    model: AudioMixRequest,
    resolved: Mapping[str, Any],
    output: Path,
) -> dict[str, Any]:
    """Translate the friendly web request into the upstream AudioMixer schema."""

    ducking = {
        "enabled": model.ducking_enabled,
        "music_volume_during_speech": model.music_volume_during_speech,
        "attack_ms": model.attack_ms,
        "release_ms": model.release_ms,
    }
    payload: dict[str, Any] = {
        "operation": model.operation,
        "output_path": str(output),
        "normalize": model.normalize,
        "loudnorm_target": model.loudnorm_target,
        "ducking": ducking,
    }
    if model.operation in {"mix", "full_mix"}:
        payload["tracks"] = resolved.get("tracks", [])
        if model.operation == "full_mix" and model.target_duration is not None:
            payload["target_duration"] = model.target_duration
    elif model.operation == "duck":
        if resolved.get("primary_audio") and resolved.get("secondary_audio"):
            payload.update({
                "primary_audio": str(resolved["primary_audio"]),
                "secondary_audio": str(resolved["secondary_audio"]),
            })
        else:
            payload["tracks"] = resolved.get("tracks", [])
    elif model.operation == "extract":
        payload["input_path"] = str(resolved["input_path"])
    elif model.operation == "segmented_music":
        payload.update({
            "video_path": str(resolved["video_path"]),
            "music_path": str(resolved["music_path"]),
            "music_volume": model.music_volume,
            "segments": model.segments,
            "fade_duration": model.fade_duration,
        })
    return payload


def _audio_mix_plan(
    model: AudioMixRequest,
    *,
    project_root: str | Path,
) -> dict[str, Any]:
    try:
        project_dir = _resolve_project(project_root, model.project_id)
        resolved, details = _audio_resolve_inputs(project_dir, model)
        output = _audio_output_path(project_dir, model)
    except (ValueError, FileNotFoundError) as exc:
        return {"status": "invalid_request", "project_id": model.project_id, "operation": model.operation, "would_write": False, "error": str(exc)}
    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    return {
        "status": "dry_run",
        "project_id": model.project_id,
        "operation": model.operation,
        "inputs": details["inputs"],
        "output": {"path": _relative(project_dir, output), "exists": output.is_file()},
        "ducking": {
            "enabled": model.ducking_enabled,
            "music_volume_during_speech": model.music_volume_during_speech,
            "duck_level_db": model.duck_level,
        },
        "normalize": model.normalize,
        "loudnorm_target": model.loudnorm_target,
        "ffmpeg_configured": bool(ffmpeg),
        "ffprobe_configured": bool(ffprobe),
        "would_execute": bool(ffmpeg and ffprobe),
        "would_write": False,
        "requires_confirmation": False,
        "message": "仅预览音频后期计划；execute=true 后才会写入项目。BGM 需由创作者提供，系统不会自动生成。",
    }


def mix_audio_media(
    request: AudioMixRequest | Mapping[str, Any],
    *,
    project_root: str | Path = DEFAULT_PROJECT_ROOT,
) -> dict[str, Any]:
    """Execute OpenMontage's real AudioMixer and persist a verified manifest."""

    model = request if isinstance(request, AudioMixRequest) else AudioMixRequest.model_validate(request)
    if model.dry_run or not model.execute:
        return _audio_mix_plan(model, project_root=project_root)
    project_dir: Path | None = None
    try:
        project_dir = _resolve_project(project_root, model.project_id)
        resolved, details = _audio_resolve_inputs(project_dir, model)
        output = _audio_output_path(project_dir, model)
        if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
            return {"status": "unavailable", "project_id": model.project_id, "operation": model.operation, "would_write": False, "error": "ffmpeg 和 ffprobe 都是音频后期的必需依赖；本次没有写入文件。"}
        input_paths = [Path(record["path"]) for record in details["inputs"]]
        if output.resolve() in {(project_dir / path).resolve() for path in input_paths}:
            raise ValueError("输出文件不能覆盖输入文件")
        output.parent.mkdir(parents=True, exist_ok=True)
        raw = AudioMixer().execute(_audio_tool_payload(project_dir, model, resolved, output))
        ok, tool_data, error = _tool_result_parts(raw)
        if not ok or not output.is_file() or output.stat().st_size <= 0:
            message = error or "audio mixer did not produce an output file"
            emit_event(project_dir, {"event": "audio_mix", "status": "failed", "operation": model.operation, "error": message[:600]})
            return {"status": "failed", "project_id": model.project_id, "operation": model.operation, "would_write": False, "error": message[:600]}
        output_probe = _probe_media(output)
        if not output_probe:
            return {"status": "failed", "project_id": model.project_id, "operation": model.operation, "would_write": False, "error": "音频已写出，但 ffprobe 无法验证输出。"}
        manifest_name = "audio_mix_manifest.json"
        manifest_payload = {
            "schema_version": "1.0",
            "project_id": model.project_id,
            "stage": "edit" if model.operation != "segmented_music" else "compose",
            "operation": model.operation,
            "status": "completed",
            "created_at": _utc_now(),
            "inputs": details["inputs"],
            "settings": {
                "ducking_enabled": model.ducking_enabled,
                "music_volume_during_speech": model.music_volume_during_speech,
                "duck_level_db": model.duck_level,
                "normalize": model.normalize,
                "loudnorm_target": model.loudnorm_target,
                "music_volume": model.music_volume,
                "segments": model.segments,
                "target_duration": model.target_duration,
            },
            "output": {
                "path": _relative(project_dir, output),
                "sha256": _sha256(output),
                "size_bytes": output.stat().st_size,
                "probe": output_probe,
            },
            "tool": {"name": "audio_mixer", "provider": "ffmpeg", "data": tool_data},
        }
        manifest, manifest_hash = _write_manifest(project_dir, manifest_name, manifest_payload)
        stage = "compose" if model.operation == "segmented_music" else "edit"
        checkpoint = _write_stage_checkpoint(
            project_dir,
            stage,
            "completed",
            artifacts={"audio_mix_manifest": f"artifacts/{manifest_name}"},
            metadata={"audio_operation": model.operation, "output": _relative(project_dir, output), "duration_seconds": output_probe.get("duration_seconds")},
        )
        emit_event(project_dir, {"event": "audio_mix", "status": "completed", "operation": model.operation, "artifact": _relative(project_dir, manifest), "output": _relative(project_dir, output)})
        notify_project_changed(project_dir.name)
        return {
            "status": "completed",
            "project_id": model.project_id,
            "operation": model.operation,
            "inputs": details["inputs"],
            "output": {"path": _relative(project_dir, output), "sha256": _sha256(output), "size_bytes": output.stat().st_size, "probe": output_probe},
            "manifest": {"path": _relative(project_dir, manifest), "sha256": manifest_hash},
            "checkpoint": {"path": _relative(project_dir, checkpoint)},
            "cost_cny": 0.0,
            "message": "音频后期已完成并通过 ffprobe 验证；可在工作台预听或把输出加入合成。",
        }
    except (ValueError, FileNotFoundError) as exc:
        return {"status": "invalid_request", "project_id": model.project_id, "operation": model.operation, "would_write": False, "error": str(exc)}
    except Exception as exc:
        if project_dir is not None:
            emit_event(project_dir, {"event": "audio_mix", "status": "failed", "operation": model.operation, "error": str(exc)[:600]})
        return {"status": "failed", "project_id": model.project_id, "operation": model.operation, "would_write": False, "error": str(exc)[:600]}


def _enhance_output_path(project_dir: Path, model: AudioEnhanceRequest) -> Path:
    suffix = Path(model.output_name).suffix.lower()
    if suffix not in MEDIA_AUDIO_EXTENSIONS | MEDIA_VIDEO_EXTENSIONS:
        raise ValueError("增强输出必须使用受支持的音频或视频扩展名")
    # Audio-only results belong with processed narration; when the upstream
    # enhancer is asked to preserve a video stream, keep that derived video in
    # ``renders`` so the Backlot library can play it as a render.
    directory = "renders" if suffix in MEDIA_VIDEO_EXTENSIONS else "assets/audio/processed"
    return project_dir / directory / model.output_name


def _enhance_plan(model: AudioEnhanceRequest, *, project_root: str | Path) -> dict[str, Any]:
    try:
        project_dir = _resolve_project(project_root, model.project_id)
        source = _resolve_project_file(project_dir, model.input_path)
        if source.suffix.lower() not in MEDIA_AUDIO_EXTENSIONS | MEDIA_VIDEO_EXTENSIONS:
            raise ValueError("input_path 必须是受支持的音频或视频文件")
        output = _enhance_output_path(project_dir, model)
    except (ValueError, FileNotFoundError) as exc:
        return {"status": "invalid_request", "project_id": model.project_id, "would_write": False, "error": str(exc)}
    ffmpeg = shutil.which("ffmpeg")
    return {
        "status": "dry_run",
        "project_id": model.project_id,
        "input": {"path": _relative(project_dir, source), "sha256": _sha256(source), "size_bytes": source.stat().st_size, "probe": _probe_media(source)},
        "preset": model.preset,
        "output": {"path": _relative(project_dir, output), "exists": output.is_file()},
        "ffmpeg_configured": bool(ffmpeg),
        "would_execute": bool(ffmpeg),
        "would_write": False,
        "requires_confirmation": False,
        "message": "仅预览音频增强计划；execute=true 后才会写入项目。",
    }


def enhance_audio_media(
    request: AudioEnhanceRequest | Mapping[str, Any],
    *,
    project_root: str | Path = DEFAULT_PROJECT_ROOT,
) -> dict[str, Any]:
    """Run a deterministic FFmpeg speech-cleanup preset and save its evidence."""

    model = request if isinstance(request, AudioEnhanceRequest) else AudioEnhanceRequest.model_validate(request)
    if model.dry_run or not model.execute:
        return _enhance_plan(model, project_root=project_root)
    project_dir: Path | None = None
    try:
        project_dir = _resolve_project(project_root, model.project_id)
        source = _resolve_project_file(project_dir, model.input_path)
        output = _enhance_output_path(project_dir, model)
        if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
            return {"status": "unavailable", "project_id": model.project_id, "would_write": False, "error": "ffmpeg 和 ffprobe 都是音频增强的必需依赖；本次没有写入文件。"}
        if output.resolve() == source.resolve():
            raise ValueError("增强输出不能覆盖输入文件")
        output.parent.mkdir(parents=True, exist_ok=True)
        suffix = output.suffix.lower()
        codec = "pcm_s16le" if suffix == ".wav" else "libmp3lame" if suffix == ".mp3" else "libvorbis" if suffix == ".ogg" else "aac"
        raw = AudioEnhance().execute({"input_path": str(source), "output_path": str(output), "preset": model.preset, "audio_codec": codec})
        ok, tool_data, error = _tool_result_parts(raw)
        if not ok or not output.is_file() or output.stat().st_size <= 0:
            message = error or "audio enhancer did not produce an output file"
            emit_event(project_dir, {"event": "audio_enhance", "status": "failed", "error": message[:600]})
            return {"status": "failed", "project_id": model.project_id, "would_write": False, "error": message[:600]}
        probe = _probe_media(output)
        if not probe:
            return {"status": "failed", "project_id": model.project_id, "would_write": False, "error": "增强文件已写出，但 ffprobe 无法验证输出。"}
        manifest_payload = {
            "schema_version": "1.0", "project_id": model.project_id, "stage": "edit", "operation": "enhance", "status": "completed", "created_at": _utc_now(),
            "preset": model.preset,
            "input": {"path": _relative(project_dir, source), "sha256": _sha256(source), "size_bytes": source.stat().st_size, "probe": _probe_media(source)},
            "output": {"path": _relative(project_dir, output), "sha256": _sha256(output), "size_bytes": output.stat().st_size, "probe": probe},
            "tool": {"name": "audio_enhance", "provider": "ffmpeg", "data": tool_data},
        }
        manifest, manifest_hash = _write_manifest(project_dir, "audio_enhance_manifest.json", manifest_payload)
        checkpoint = _write_stage_checkpoint(project_dir, "edit", "completed", artifacts={"audio_enhance_manifest": "artifacts/audio_enhance_manifest.json"}, metadata={"audio_enhance": True, "preset": model.preset, "output": _relative(project_dir, output)})
        emit_event(project_dir, {"event": "audio_enhance", "status": "completed", "artifact": _relative(project_dir, manifest), "output": _relative(project_dir, output)})
        notify_project_changed(project_dir.name)
        return {"status": "completed", "project_id": model.project_id, "preset": model.preset, "output": {"path": _relative(project_dir, output), "sha256": _sha256(output), "size_bytes": output.stat().st_size, "probe": probe}, "manifest": {"path": _relative(project_dir, manifest), "sha256": manifest_hash}, "checkpoint": {"path": _relative(project_dir, checkpoint)}, "cost_cny": 0.0, "message": "音频增强已完成并通过 ffprobe 验证。"}
    except (ValueError, FileNotFoundError) as exc:
        return {"status": "invalid_request", "project_id": model.project_id, "would_write": False, "error": str(exc)}
    except Exception as exc:
        if project_dir is not None:
            emit_event(project_dir, {"event": "audio_enhance", "status": "failed", "error": str(exc)[:600]})
        return {"status": "failed", "project_id": model.project_id, "would_write": False, "error": str(exc)[:600]}


def _image_inputs(shot: ImageShot, request: ImagePipelineRequest, *, operation: str, output_path: Path | None = None) -> dict[str, Any]:
    values: dict[str, Any] = {
        # Keep the shot identity in the provider request.  Besides improving
        # observability, this gives every storyboard frame a stable but
        # distinct idempotency key when a transport retry occurs.
        "scene_id": shot.id,
        "prompt": shot.prompt,
        "operation": operation,
        "preferred_provider": request.preferred_provider,
        "task_context": {"intent": "storyboard_image", "operation": operation, "project_id": request.project_id},
    }
    if request.allowed_providers:
        values["allowed_providers"] = request.allowed_providers
    for key in ("negative_prompt", "width", "height", "aspect_ratio", "resolution", "seed"):
        value = getattr(shot, key)
        if value is not None:
            values[key] = value
    if output_path is not None:
        values["output_path"] = str(output_path)
    return values


def estimate_images(request: ImagePipelineRequest | Mapping[str, Any], *, selector: Any | None = None, project_root: str | Path = DEFAULT_PROJECT_ROOT) -> dict[str, Any]:
    model = request if isinstance(request, ImagePipelineRequest) else ImagePipelineRequest.model_validate(request)
    try:
        _resolve_project(project_root, model.project_id)
    except (ValueError, FileNotFoundError) as exc:
        return {"status": "invalid_project", "project_id": model.project_id, "error": str(exc)}
    chosen = selector or ImageSelector()
    rankings: list[dict[str, Any]] = []
    errors: list[str] = []
    for shot in model.shots:
        try:
            raw = chosen.execute(_image_inputs(shot, model, operation="rank"))
            ok, data, error = _tool_result_parts(raw)
            rankings.append({"shot_id": shot.id, "rankings": data.get("rankings", []), "error": error if not ok else None})
            if error:
                errors.append(f"{shot.id}: {error}")
        except Exception as exc:
            rankings.append({"shot_id": shot.id, "rankings": [], "error": str(exc)[:300]})
            errors.append(f"{shot.id}: {exc}")
    return {
        "status": "available" if _status_name(chosen.get_status()) == "available" else "unavailable",
        "project_id": model.project_id,
        "shot_count": len(model.shots),
        "rankings": rankings,
        "providers": _selector_snapshot(chosen, capability="image_generation"),
        "would_generate": False,
        "error": "；".join(errors) if errors else None,
    }


def _require_authorization(header: str | None) -> None:
    expected = os.environ.get("WEB_API_PAID_AUTH_TOKEN")
    if not expected:
        raise HTTPException(status_code=503, detail="paid media generation is not configured")
    if not header or not secrets.compare_digest(header, expected):
        raise HTTPException(status_code=403, detail="invalid generation authorization")


def _notify_image_progress(
    callback: ImageProgressCallback | None,
    generated: Sequence[Mapping[str, Any]],
) -> None:
    """Report committed image artifacts without affecting provider execution."""

    if callback is None:
        return
    items = [_safe_json(item) for item in generated]
    payload = {
        "completed_shots": len(items),
        "completed_shot_ids": [str(item.get("shot_id")) for item in items if item.get("shot_id")],
        "images_written": items,
        "last_artifact_at": _utc_now(),
    }
    try:
        callback(payload)
    except Exception:
        # Progress reporting is observability only.  A callback failure must
        # never turn an already successful provider response into a failed job.
        return


def render_images(
    request: ImagePipelineRequest | Mapping[str, Any],
    *,
    selector: Any | None = None,
    project_root: str | Path = DEFAULT_PROJECT_ROOT,
    authorized: bool = False,
    progress_callback: ImageProgressCallback | None = None,
) -> dict[str, Any]:
    model = request if isinstance(request, ImagePipelineRequest) else ImagePipelineRequest.model_validate(request)
    progress_callback = progress_callback or _IMAGE_PROGRESS_CALLBACK.get()
    if model.dry_run or not model.execute:
        preview = estimate_images(model, selector=selector, project_root=project_root)
        preview.update({"status": "dry_run", "would_generate": preview.get("status") == "available", "authorization_required": True})
        return preview
    if not authorized or not model.confirm:
        return {"status": "authorization_required", "project_id": model.project_id, "would_generate": False, "error": "confirm=true and explicit generation authorization are required"}
    try:
        project_dir = _resolve_project(project_root, model.project_id)
    except (ValueError, FileNotFoundError) as exc:
        return {"status": "invalid_project", "project_id": model.project_id, "would_generate": False, "error": str(exc)}
    chosen = selector or ImageSelector()
    if _status_name(chosen.get_status()) != "available":
        return {"status": "unavailable", "project_id": model.project_id, "would_generate": False, "authorization_required": True, "providers": _selector_snapshot(chosen, capability="image_generation"), "error": "no usable image provider is configured; no image artifacts were written"}

    frames_dir = project_dir / "assets" / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    generated: list[dict[str, Any]] = []
    try:
        for shot in model.shots:
            safe_id = re.sub(r"[^A-Za-z0-9._-]", "_", shot.id)[:96] or "shot"
            output = frames_dir / f"{safe_id}.png"
            result = chosen.execute(_image_inputs(shot, model, operation="generate", output_path=output))
            ok, data, error = _tool_result_parts(result)
            if not ok or not output.is_file() or output.stat().st_size <= 0:
                raise RuntimeError(error or f"image provider returned success without {safe_id}.png")
            generated.append({"shot_id": shot.id, "path": _relative(project_dir, output), "sha256": _sha256(output), "size_bytes": output.stat().st_size, "provider": data.get("selected_provider") or data.get("provider"), "model": data.get("model") or data.get("model_id"), "prompt_sha256": _sha256_bytes(shot.prompt.encode("utf-8"))})
            _notify_image_progress(progress_callback, generated)
        manifest, manifest_hash = _write_manifest(project_dir, "image_manifest.json", {"schema_version": "1.0", "project_id": model.project_id, "stage": "storyboard_images", "status": "completed", "created_at": _utc_now(), "images": generated})
        emit_event(project_dir, {"event": "image_render", "status": "completed", "artifact": _relative(project_dir, manifest)})
        notify_project_changed(project_dir.name)
        return {"status": "completed", "project_id": model.project_id, "images": generated, "images_written": generated, "completed_shots": len(generated), "completed_shot_ids": [item["shot_id"] for item in generated], "manifest": {"path": _relative(project_dir, manifest), "sha256": manifest_hash}}
    except Exception as exc:
        return {
            "status": "failed",
            "project_id": model.project_id,
            "would_generate": False,
            "error": str(exc)[:500],
            "images_written": generated,
            "completed_shots": len(generated),
            "completed_shot_ids": [item["shot_id"] for item in generated],
        }


def _probe_media(path: Path) -> dict[str, Any] | None:
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return None
    try:
        proc = subprocess.run([ffprobe, "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", str(path)], capture_output=True, text=True, timeout=20)
        if proc.returncode != 0:
            return None
        data = json.loads(proc.stdout)
        fmt = data.get("format", {})
        streams = data.get("streams", [])
        video = next((s for s in streams if s.get("codec_type") == "video"), None)
        audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
        try:
            duration = float(fmt.get("duration"))
        except (TypeError, ValueError):
            duration = 0.0
        result: dict[str, Any] = {"duration_seconds": round(duration, 3), "format": fmt.get("format_name"), "size_bytes": int(fmt.get("size", path.stat().st_size)), "stream_count": len(streams)}
        if video:
            result["video"] = {"codec": video.get("codec_name"), "width": video.get("width"), "height": video.get("height"), "fps": video.get("r_frame_rate")}
        if audio:
            result["audio"] = {"codec": audio.get("codec_name"), "channels": audio.get("channels"), "sample_rate": audio.get("sample_rate")}
        return result
    except Exception:
        return None


def _compose_mux(video: Path, audio: Path | None, subtitle: Path | None, output: Path) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is not installed; install it before composition")
    command = [ffmpeg, "-y", "-i", str(video)]
    if audio:
        command += ["-i", str(audio)]
    if subtitle:
        command += ["-i", str(subtitle)]
    command += ["-map", "0:v:0"]
    if audio:
        command += ["-map", "1:a:0"]
    if subtitle:
        subtitle_index = 2 if audio else 1
        command += ["-map", f"{subtitle_index}:0"]
    command += ["-c:v", "copy"]
    if audio:
        command += ["-c:a", "aac", "-b:a", "192k"]
    if subtitle:
        command += ["-c:s", "mov_text", "-metadata:s:s:0", "language=chi"]
    command += ["-movflags", "+faststart", str(output)]
    proc = subprocess.run(command, capture_output=True, text=True, timeout=300)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr[-600:] or "ffmpeg mux failed")


def _still_image_records(
    project_dir: Path,
    model: StillComposeRequest,
) -> tuple[list[Path], list[dict[str, Any]]]:
    paths: list[Path] = []
    records: list[dict[str, Any]] = []
    durations = model.durations or [model.default_duration_seconds] * len(model.images)
    if len(durations) != len(model.images):
        raise ValueError("durations must have the same number of items as images")
    for index, raw in enumerate(model.images):
        path = _resolve_project_file(project_dir, raw)
        if path.suffix.lower() not in MEDIA_IMAGE_EXTENSIONS:
            raise ValueError(f"unsupported still image extension: {path.suffix or '<none>'}")
        paths.append(path)
        records.append({
            "index": index + 1,
            "path": _relative(project_dir, path),
            "sha256": _sha256(path),
            "size_bytes": path.stat().st_size,
            "duration_seconds": round(float(durations[index]), 3),
        })
    return paths, records


def _still_plan(
    model: StillComposeRequest,
    *,
    project_root: str | Path,
) -> dict[str, Any]:
    try:
        project_dir = _resolve_project(project_root, model.project_id)
        _, images = _still_image_records(project_dir, model)
    except (ValueError, FileNotFoundError) as exc:
        return {
            "status": "invalid_request",
            "project_id": model.project_id,
            "would_write": False,
            "error": str(exc),
        }
    ready = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
    return {
        "status": "dry_run",
        "project_id": model.project_id,
        "image_count": len(images),
        "images": images,
        "transition": model.transition,
        "transition_duration": model.transition_duration,
        "motion": "restrained_ken_burns_push",
        "target": {"width": model.width, "height": model.height, "fps": model.fps},
        "ffmpeg_configured": bool(shutil.which("ffmpeg")),
        "ffprobe_configured": bool(shutil.which("ffprobe")),
        "would_execute": ready,
        "would_write": False,
        "requires_confirmation": False,
        "message": "仅预览本机分镜图转动态视频计划；execute=true 后才写入 renders/still_clips 与合成视频。",
    }


def compose_stills(
    request: StillComposeRequest | Mapping[str, Any],
    *,
    project_root: str | Path = DEFAULT_PROJECT_ROOT,
) -> dict[str, Any]:
    """Animate clean storyboard stills and send them through local composition."""

    model = request if isinstance(request, StillComposeRequest) else StillComposeRequest.model_validate(request)
    if model.dry_run or not model.execute:
        return _still_plan(model, project_root=project_root)
    try:
        project_dir = _resolve_project(project_root, model.project_id)
        image_paths, image_records = _still_image_records(project_dir, model)
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg or not shutil.which("ffprobe"):
            return {
                "status": "unavailable",
                "project_id": model.project_id,
                "would_write": False,
                "error": "ffmpeg 和 ffprobe 都是分镜图动态化的必需依赖；本次没有写入视频。",
            }
        digest = _sha256_bytes(json.dumps({
            "images": image_records,
            "width": model.width,
            "height": model.height,
            "fps": model.fps,
            "transition": model.transition,
            "transition_duration": model.transition_duration,
        }, ensure_ascii=False, sort_keys=True).encode("utf-8"))[:16]
        clips_dir = project_dir / "renders" / "still_clips" / digest
        clips_dir.mkdir(parents=True, exist_ok=True)
        clip_paths: list[Path] = []
        for record, image_path in zip(image_records, image_paths):
            duration = float(record["duration_seconds"])
            frames = max(1, int(round(duration * model.fps)))
            output = clips_dir / f"shot-{record['index']:02d}.mp4"
            # Pad rather than crop so a landscape scenic image stays legible in
            # a vertical project; zoompan then adds gentle movement instead of
            # leaving a static slideshow frame.
            vf = (
                f"scale={model.width}:{model.height}:force_original_aspect_ratio=decrease,"
                f"pad={model.width}:{model.height}:(ow-iw)/2:(oh-ih)/2,"
                f"zoompan=z='min(zoom+0.0015,1.08)':d={frames}:"
                f"s={model.width}x{model.height}:fps={model.fps},format=yuv420p"
            )
            command = [
                ffmpeg, "-y", "-loop", "1", "-i", str(image_path),
                "-vf", vf, "-frames:v", str(frames), "-an",
                "-c:v", "libx264", "-preset", "medium", "-crf", "18",
                "-pix_fmt", "yuv420p", str(output),
            ]
            proc = subprocess.run(command, capture_output=True, text=True, timeout=300)
            if proc.returncode != 0 or not output.is_file() or output.stat().st_size <= 0:
                raise RuntimeError(proc.stderr[-600:] or f"failed to animate {record['path']}")
            record["clip_path"] = _relative(project_dir, output)
            record["clip_sha256"] = _sha256(output)
            record["clip_probe"] = _probe_media(output)
            clip_paths.append(output)

        compose_request = ComposeRequest(
            project_id=model.project_id,
            clips=[_relative(project_dir, path) for path in clip_paths],
            transition=model.transition,
            transition_duration=model.transition_duration,
            auto_normalize=True,
            audio_path=model.audio_path,
            subtitle_path=model.subtitle_path,
            output_name=model.output_name,
            dry_run=False,
            execute=True,
        )
        composition = compose_media(compose_request, project_root=project_root)
        if composition.get("status") != "completed":
            return {
                **composition,
                "still_clips": image_records,
                "motion": "restrained_ken_burns_push",
            }
        manifest, manifest_hash = _write_manifest(project_dir, "still_composition_manifest.json", {
            "schema_version": "1.0",
            "project_id": model.project_id,
            "stage": "still_image_motion",
            "status": "completed",
            "created_at": _utc_now(),
            "motion": "restrained_ken_burns_push",
            "target": {"width": model.width, "height": model.height, "fps": model.fps},
            "images": image_records,
            "composition": composition.get("output"),
            "transition": model.transition,
            "transition_duration": model.transition_duration,
            "audio_path": model.audio_path,
            "subtitle_path": model.subtitle_path,
        })
        emit_event(project_dir, {
            "event": "still_compose",
            "status": "completed",
            "artifact": _relative(project_dir, manifest),
            "image_count": len(image_records),
        })
        notify_project_changed(project_dir.name)
        return {
            **composition,
            "still_clips": image_records,
            "motion": "restrained_ken_burns_push",
            "manifest": {"path": _relative(project_dir, manifest), "sha256": manifest_hash},
        }
    except (ValueError, FileNotFoundError) as exc:
        return {"status": "invalid_request", "project_id": model.project_id, "would_write": False, "error": str(exc)}
    except Exception as exc:
        return {"status": "failed", "project_id": model.project_id, "would_write": False, "error": str(exc)[:600]}


def compose_media(request: ComposeRequest | Mapping[str, Any], *, project_root: str | Path = DEFAULT_PROJECT_ROOT) -> dict[str, Any]:
    model = request if isinstance(request, ComposeRequest) else ComposeRequest.model_validate(request)
    if model.dry_run or not model.execute:
        return {"status": "dry_run", "project_id": model.project_id, "clip_count": len(model.clips), "transition": model.transition, "would_write": False, "ffmpeg_configured": shutil.which("ffmpeg") is not None, "ffprobe_configured": shutil.which("ffprobe") is not None}
    try:
        project_dir = _resolve_project(project_root, model.project_id)
        clip_paths = [_resolve_project_file(project_dir, clip) for clip in model.clips]
        audio_path = _resolve_project_file(project_dir, model.audio_path) if model.audio_path else None
        subtitle_path = _resolve_project_file(project_dir, model.subtitle_path) if model.subtitle_path else None
        output = project_dir / "renders" / model.output_name
        output.parent.mkdir(parents=True, exist_ok=True)
        stitch = VideoStitch()
        if _status_name(stitch.get_status()) != "available":
            return {"status": "unavailable", "project_id": model.project_id, "would_write": False, "error": "FFmpeg/ffprobe is not available; composition was not written"}
        if len(clip_paths) == 1:
            # A single clip is already a valid composition.  Keep this path
            # independent from VideoStitch so that adding optional narration
            # or subtitles does not accidentally ask the stitcher to combine
            # zero/one clips (which most stitchers reject).
            if audio_path or subtitle_path:
                with tempfile.TemporaryDirectory(prefix="openmontage-compose-", dir=str(output.parent)) as temp:
                    intermediate = Path(temp) / "source.mp4"
                    shutil.copy2(clip_paths[0], intermediate)
                    _compose_mux(intermediate, audio_path, subtitle_path, output)
            else:
                shutil.copy2(clip_paths[0], output)
            stitch_data = {"operation": "copy", "clip_count": 1, "transition": "cut"}
        else:
            with tempfile.TemporaryDirectory(prefix="openmontage-compose-", dir=str(output.parent)) as temp:
                intermediate = Path(temp) / "stitched.mp4"
                raw = stitch.execute({"operation": "stitch", "clips": [str(p) for p in clip_paths], "output_path": str(intermediate), "transition": model.transition, "transition_duration": model.transition_duration, "auto_normalize": model.auto_normalize})
                ok, data, error = _tool_result_parts(raw)
                if not ok or not intermediate.is_file():
                    raise RuntimeError(error or "video stitch failed")
                if audio_path or subtitle_path:
                    _compose_mux(intermediate, audio_path, subtitle_path, output)
                else:
                    shutil.copy2(intermediate, output)
                stitch_data = data
        probe = _probe_media(output)
        if not probe:
            raise RuntimeError("composed video was written but ffprobe could not verify it")
        input_records = [{"path": _relative(project_dir, path), "sha256": _sha256(path), "size_bytes": path.stat().st_size, "probe": _probe_media(path)} for path in clip_paths]
        manifest, manifest_hash = _write_manifest(project_dir, "composition_manifest.json", {"schema_version": "1.0", "project_id": model.project_id, "stage": "compose", "status": "completed", "created_at": _utc_now(), "inputs": input_records, "output": {"path": _relative(project_dir, output), "sha256": _sha256(output), "size_bytes": output.stat().st_size, "probe": probe}, "transition": model.transition, "transition_duration": model.transition_duration, "audio_path": _relative(project_dir, audio_path) if audio_path else None, "subtitle_path": _relative(project_dir, subtitle_path) if subtitle_path else None, "tool": stitch_data})
        _write_stage_checkpoint(
            project_dir,
            "compose",
            "completed",
            artifacts={"composition_manifest": "artifacts/composition_manifest.json"},
            metadata={"output": _relative(project_dir, output), "transition": model.transition},
        )
        emit_event(project_dir, {"event": "compose", "status": "completed", "artifact": _relative(project_dir, manifest)})
        notify_project_changed(project_dir.name)
        return {"status": "completed", "project_id": model.project_id, "output": {"path": _relative(project_dir, output), "sha256": _sha256(output), "size_bytes": output.stat().st_size, "probe": probe}, "manifest": {"path": _relative(project_dir, manifest), "sha256": manifest_hash}}
    except (ValueError, FileNotFoundError) as exc:
        return {"status": "invalid_request", "project_id": model.project_id, "would_write": False, "error": str(exc)}
    except Exception as exc:
        return {"status": "failed", "project_id": model.project_id, "would_write": False, "error": str(exc)[:600]}


def _run_media_probe_command(command: list[str], *, timeout: int = 120) -> tuple[int, str, str]:
    """Run one bounded FFmpeg command and return its exit code and output.

    Quality checks are deliberately best-effort for optional diagnostics: a
    missing filter or a timeout should be recorded as ``unavailable`` rather
    than making the whole project page fail.  The core ffprobe check remains a
    hard gate below.
    """

    try:
        completed = subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False)
        return completed.returncode, completed.stdout or "", completed.stderr or ""
    except FileNotFoundError:
        return 127, "", "required command is not installed"
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout if isinstance(exc.stdout, str) else ""
        stderr = exc.stderr if isinstance(exc.stderr, str) else ""
        return 124, stdout, (stderr + "\nquality check timed out").strip()


def _parse_db_value(raw: str | None) -> float | None:
    """Convert an FFmpeg dB token into JSON-safe data."""

    if not raw or raw.strip().lower() in {"-inf", "inf", "+inf", "nan"}:
        return None
    try:
        value = float(raw.strip())
    except (TypeError, ValueError):
        return None
    return round(value, 2) if math.isfinite(value) else None


def _quality_frame_samples(
    project_dir: Path,
    path: Path,
    duration: float,
    sample_count: int,
) -> dict[str, Any]:
    """Extract a small, inspectable set of frames for the Backlot review."""

    if sample_count <= 0:
        return {"status": "skipped", "sample_count": 0, "frames": []}
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return {"status": "unavailable", "reason": "ffmpeg is not installed", "sample_count": 0, "frames": []}

    safe_stem = re.sub(r"[^A-Za-z0-9._-]", "_", path.stem)[:80] or "media"
    output_dir = project_dir / "verify" / "quality" / safe_stem
    output_dir.mkdir(parents=True, exist_ok=True)
    usable_duration = max(0.0, float(duration) - 0.1)
    if sample_count == 1:
        timestamps = [usable_duration / 2.0]
    else:
        timestamps = [usable_duration * index / (sample_count - 1) for index in range(sample_count)]

    frames: list[dict[str, Any]] = []
    for index, timestamp in enumerate(timestamps, start=1):
        output = output_dir / f"frame-{index:02d}.jpg"
        code, _, stderr = _run_media_probe_command(
            [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{timestamp:.3f}", "-i", str(path), "-frames:v", "1", "-q:v", "3", str(output)],
            timeout=60,
        )
        if code == 0 and output.is_file() and output.stat().st_size > 0:
            frames.append({
                "index": index,
                "timestamp_seconds": round(timestamp, 3),
                "path": _relative(project_dir, output),
                "sha256": _sha256(output),
                "size_bytes": output.stat().st_size,
            })
        else:
            frames.append({
                "index": index,
                "timestamp_seconds": round(timestamp, 3),
                "path": None,
                "error": (stderr.strip() or "frame extraction failed")[-300:],
            })
    valid = [frame for frame in frames if frame.get("path")]
    return {
        "status": "passed" if valid else "failed",
        "sample_count": sample_count,
        "valid_count": len(valid),
        "frames": frames,
    }


def _quality_black_frames(path: Path, duration: float) -> dict[str, Any]:
    """Use FFmpeg's blackdetect filter to catch blank/black renders."""

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return {"status": "unavailable", "reason": "ffmpeg is not installed", "segments": []}
    code, _, stderr = _run_media_probe_command(
        [ffmpeg, "-hide_banner", "-loglevel", "info", "-nostats", "-i", str(path), "-vf", "blackdetect=d=0.10:pic_th=0.98", "-an", "-f", "null", "-"],
        timeout=180,
    )
    combined = stderr
    pattern = re.compile(r"black_start:\s*([0-9.]+).*?black_end:\s*([0-9.]+).*?black_duration:\s*([0-9.]+)")
    segments = [
        {"start_seconds": round(float(start), 3), "end_seconds": round(float(end), 3), "duration_seconds": round(float(length), 3)}
        for start, end, length in pattern.findall(combined)
    ]
    if code not in {0, 1} and not segments:
        return {"status": "unavailable", "reason": (combined.strip() or "blackdetect failed")[-300:], "segments": []}
    black_duration = min(max(0.0, float(duration)), sum(item["duration_seconds"] for item in segments))
    ratio = black_duration / float(duration) if duration > 0 else 0.0
    if ratio >= 0.98:
        status = "failed"
    elif ratio >= 0.25:
        status = "warning"
    else:
        status = "passed"
    return {
        "status": status,
        "segments": segments,
        "black_duration_seconds": round(black_duration, 3),
        "black_ratio": round(ratio, 4),
    }


def _quality_audio(path: Path, duration: float) -> dict[str, Any]:
    """Measure rough loudness and silence without requiring a neural model."""

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return {"status": "unavailable", "reason": "ffmpeg is not installed"}
    code, _, stderr = _run_media_probe_command(
        [ffmpeg, "-hide_banner", "-loglevel", "info", "-nostats", "-i", str(path), "-vn", "-af", "volumedetect,silencedetect=noise=-50dB:d=0.5", "-f", "null", "-"],
        timeout=180,
    )
    if code != 0:
        return {"status": "unavailable", "reason": (stderr.strip() or "audio analysis failed")[-300:]}
    mean_match = re.search(r"mean_volume:\s*([-+0-9.inf]+)\s*dB", stderr)
    max_match = re.search(r"max_volume:\s*([-+0-9.inf]+)\s*dB", stderr)
    silence_segments: list[dict[str, Any]] = []
    open_start: float | None = None
    for line in stderr.splitlines():
        start_match = re.search(r"silence_start:\s*([0-9.]+)", line)
        if start_match:
            open_start = float(start_match.group(1))
            continue
        end_match = re.search(r"silence_end:\s*([0-9.]+).*?silence_duration:\s*([0-9.]+)", line)
        if end_match:
            end = float(end_match.group(1))
            length = float(end_match.group(2))
            silence_segments.append({"start_seconds": round(open_start if open_start is not None else max(0.0, end - length), 3), "end_seconds": round(end, 3), "duration_seconds": round(length, 3)})
            open_start = None
    if open_start is not None and duration > open_start:
        silence_segments.append({"start_seconds": round(open_start, 3), "end_seconds": round(duration, 3), "duration_seconds": round(duration - open_start, 3)})
    silent_duration = min(max(0.0, float(duration)), sum(item["duration_seconds"] for item in silence_segments))
    silence_ratio = silent_duration / float(duration) if duration > 0 else 0.0
    mean_db = _parse_db_value(mean_match.group(1) if mean_match else None)
    max_db = _parse_db_value(max_match.group(1) if max_match else None)
    warnings: list[str] = []
    if silence_ratio >= 0.8:
        warnings.append("音频大部分时间低于 -50 dB，可能是静音或旁白未写入")
    if max_db is not None and max_db >= -0.1:
        warnings.append("峰值接近 0 dB，存在削波风险")
    return {
        "status": "warning" if warnings else "passed",
        "mean_volume_db": mean_db,
        "max_volume_db": max_db,
        "silence_segments": silence_segments,
        "silence_ratio": round(silence_ratio, 4),
        "warnings": warnings,
    }


def _quality_subtitles(path: Path, duration_seconds: float | None = None) -> dict[str, Any]:
    """Validate that a subtitle sidecar contains timed cues."""

    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return {"status": "failed", "cue_count": 0, "error": str(exc)}
    suffix = path.suffix.lower()
    if suffix in {".srt", ".vtt"}:
        errors: list[str] = []
        cues = 0
        previous_start = -1.0
        previous_end = -1.0
        overlaps = 0
        def seconds(value: str) -> float:
            parts = value.replace(",", ".").split(":")
            if len(parts) not in {2, 3} or float(parts[-1]) >= 60 or float(parts[-2]) >= 60:
                raise ValueError("invalid timestamp")
            return sum(float(part) * 60 ** index for index, part in enumerate(reversed(parts)))
        for block in re.split(r"\n\s*\n", text.replace("\r\n", "\n").strip()):
            lines = block.splitlines()
            if suffix == ".vtt" and lines and lines[0].startswith(("WEBVTT", "NOTE", "STYLE", "REGION")):
                continue
            timeline = next((i for i, line in enumerate(lines) if "-->" in line), None)
            if timeline is None:
                if block.strip(): errors.append("字幕段缺少时间标记")
                continue
            cues += 1
            match = re.fullmatch(r"\s*((?:\d{2,}:)?\d{2}:\d{2}[,.]\d{3})\s*-->\s*((?:\d{2,}:)?\d{2}:\d{2}[,.]\d{3})(?:\s+.*)?", lines[timeline])
            try:
                if not match: raise ValueError("invalid timestamp")
                start, end = seconds(match[1]), seconds(match[2])
                if end <= start: errors.append(f"第 {cues} 段结束时间必须晚于开始时间")
                if start < previous_start: errors.append(f"第 {cues} 段时间顺序倒置")
                if start < previous_end: overlaps += 1
                if duration_seconds is not None and end > duration_seconds + 0.05:
                    errors.append(f"第 {cues} 段超出视频时长")
                previous_start, previous_end = start, max(previous_end, end)
            except ValueError:
                errors.append(f"第 {cues} 段时间格式无效")
            if not "".join(lines[timeline + 1:]).strip(): errors.append(f"第 {cues} 段字幕为空")
        if not cues: errors.append("未发现字幕段")
        return {"status": "failed" if errors else "passed", "format": suffix[1:], "cue_count": cues,
                "errors": errors, "overlap_count": overlaps,
                "warnings": [f"有 {overlaps} 段字幕重叠，请人工确认是否有意安排"] if overlaps else [],
                "sync_review": "not_run"}
    if suffix in {".srt", ".vtt", ".ttml", ".dfxp"}:
        cue_count = len(re.findall(r"(?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{3}\s*-->\s*", text))
    elif suffix in {".ass", ".ssa"}:
        cue_count = sum(1 for line in text.splitlines() if line.strip().lower().startswith("dialogue:"))
    elif suffix == ".json":
        try:
            payload = json.loads(text)
            if isinstance(payload, list):
                cue_count = len(payload)
            elif isinstance(payload, Mapping):
                candidates = payload.get("segments") or payload.get("cues") or payload.get("items") or []
                cue_count = len(candidates) if isinstance(candidates, list) else 0
            else:
                cue_count = 0
        except json.JSONDecodeError:
            cue_count = 0
    else:
        cue_count = 0
    return {
        "status": "passed" if cue_count else "warning",
        "format": suffix.lstrip(".") or "unknown",
        "cue_count": cue_count,
        "warning": None if cue_count else "未发现可解析的字幕时间轴",
    }


def quality_check(request: QualityRequest | Mapping[str, Any], *, project_root: str | Path = DEFAULT_PROJECT_ROOT) -> dict[str, Any]:
    model = request if isinstance(request, QualityRequest) else QualityRequest.model_validate(request)
    if not model.execute:
        return {
            "status": "dry_run",
            "project_id": model.project_id,
            "media_paths": model.media_paths,
            "sample_frames": model.sample_frames,
            "check_audio": model.check_audio,
            "check_black_frames": model.check_black_frames,
            "check_subtitles": model.check_subtitles,
            "would_write": False,
            "semantic_review": "not_run",
        }
    try:
        project_dir = _resolve_project(project_root, model.project_id)
        records: list[dict[str, Any]] = []
        failures: list[str] = []
        warnings: list[str] = []
        for raw in model.media_paths:
            path = _resolve_project_file(project_dir, raw)
            probe = _probe_media(path)
            row = {"path": _relative(project_dir, path), "exists": True, "sha256": _sha256(path), "size_bytes": path.stat().st_size, "probe": probe}
            suffix = path.suffix.lower()
            if suffix in MEDIA_VIDEO_EXTENSIONS and not probe:
                row["technical_status"] = "failed"
                failures.append(raw)
            elif suffix in MEDIA_VIDEO_EXTENSIONS:
                video = (probe or {}).get("video")
                if not video:
                    row["technical_status"] = "failed"
                    failures.append(f"{raw}: no video stream")
                else:
                    row["technical_status"] = "passed"
                    duration = float((probe or {}).get("duration_seconds") or 0)
                    if model.sample_frames:
                        row["visual_frames"] = _quality_frame_samples(project_dir, path, duration, model.sample_frames)
                        if row["visual_frames"].get("status") == "failed":
                            warnings.append(f"{raw}: representative frame extraction failed")
                    if model.check_black_frames:
                        row["black_frame_check"] = _quality_black_frames(path, duration)
                        black_status = row["black_frame_check"].get("status")
                        if black_status == "failed":
                            failures.append(f"{raw}: nearly the entire video is black")
                        elif black_status == "warning":
                            warnings.append(f"{raw}: black frames cover a substantial portion of the video")
                        elif black_status != "passed":
                            warnings.append(f"{raw}: black frame check unavailable")
                    if model.check_audio:
                        if (probe or {}).get("audio"):
                            row["audio_check"] = _quality_audio(path, duration)
                            if row["audio_check"].get("status") == "unavailable":
                                warnings.append(f"{raw}: audio analysis unavailable")
                            warnings.extend(f"{raw}: {message}" for message in row["audio_check"].get("warnings", []))
                        else:
                            row["audio_check"] = {"status": "not_present", "warning": "视频没有音频流；如需旁白/BGM，请在合成阶段加入"}
                            warnings.append(f"{raw}: no audio stream")
            elif suffix in MEDIA_AUDIO_EXTENSIONS:
                row["technical_status"] = "passed" if probe and (probe.get("audio") or probe.get("duration_seconds")) else "unavailable"
                if row["technical_status"] == "unavailable":
                    warnings.append(f"{raw}: audio probe unavailable")
                elif model.check_audio:
                    row["audio_check"] = _quality_audio(path, float((probe or {}).get("duration_seconds") or 0))
                    if row["audio_check"].get("status") == "unavailable":
                        warnings.append(f"{raw}: audio analysis unavailable")
                    warnings.extend(f"{raw}: {message}" for message in row["audio_check"].get("warnings", []))
            elif suffix in {".srt", ".vtt", ".ass", ".ssa", ".ttml", ".dfxp", ".json"}:
                row["technical_status"] = "passed"
                if model.check_subtitles:
                    row["subtitle_check"] = _quality_subtitles(path)
                    row["technical_status"] = row["subtitle_check"]["status"]
                    if row["subtitle_check"].get("status") == "failed":
                        failures.extend(f"{raw}: {error}" for error in row["subtitle_check"].get("errors", ["subtitle validation failed"]))
                    warnings.extend(f"{raw}: {warning}" for warning in row["subtitle_check"].get("warnings", []))
                    if row["subtitle_check"].get("status") != "passed":
                        warnings.append(f"{raw}: subtitle cues could not be fully parsed")
            else:
                row["technical_status"] = "unavailable"
                failures.append(f"{raw}: unsupported media type")
            records.append(row)
        total_duration = sum(
            float((row.get("probe") or {}).get("duration_seconds") or 0)
            for row in records
            if Path(str(row.get("path") or "")).suffix.lower() in MEDIA_VIDEO_EXTENSIONS
        )
        if model.expected_duration_seconds is not None and abs(total_duration - model.expected_duration_seconds) > 0.25:
            failures.append(f"duration expected {model.expected_duration_seconds:.3f}s, got {total_duration:.3f}s")
        video_rows = [row for row in records if Path(row["path"]).suffix.lower() in MEDIA_VIDEO_EXTENSIONS]
        if model.check_subtitles and len(video_rows) == 1:
            duration = float((video_rows[0].get("probe") or {}).get("duration_seconds") or 0)
            for row in records:
                if Path(row["path"]).suffix.lower() in {".srt", ".vtt"}:
                    row["subtitle_check"] = _quality_subtitles(project_dir / row["path"], duration or None)
                    row["technical_status"] = row["subtitle_check"]["status"]
                    failures.extend(f"{row['path']}: {error}" for error in row["subtitle_check"].get("errors", []))
        if model.check_subtitles and not any("subtitle_check" in row for row in records):
            warnings.append("未提供独立字幕文件，字幕检查未执行；内嵌或烧录字幕需另行审核")
        failures = list(dict.fromkeys(failures))
        status = "failed" if failures else "passed"
        report_payload = {
            "schema_version": "1.1",
            "project_id": model.project_id,
            "stage": "media_quality",
            "status": status,
            "created_at": _utc_now(),
            "technical": {
                "status": status,
                "total_duration_seconds": round(total_duration, 3),
                "failures": failures,
                "warnings": warnings,
                "checks": {"sample_frames": model.sample_frames, "audio": model.check_audio, "black_frames": model.check_black_frames, "subtitles": model.check_subtitles},
            },
            "semantic_review": {"status": "not_run", "reason": "本机技术质检已提取代表帧；仍需创作者或视觉模型检查构图、事实与审美。"},
            "media": records,
        }
        report, report_hash = _write_manifest(project_dir, "media_quality_report.json", report_payload)
        emit_event(project_dir, {"event": "media_quality", "status": status, "artifact": _relative(project_dir, report)})
        notify_project_changed(project_dir.name)
        return {"status": status, "project_id": model.project_id, "technical": {"total_duration_seconds": round(total_duration, 3), "failures": failures, "warnings": warnings}, "semantic_review": "not_run", "media": records, "report": {"path": _relative(project_dir, report), "sha256": report_hash}}
    except (ValueError, FileNotFoundError) as exc:
        return {"status": "invalid_request", "project_id": model.project_id, "error": str(exc)}
    except Exception as exc:
        return {"status": "failed", "project_id": model.project_id, "error": str(exc)[:600]}


def _publish_asset_record(project_dir: Path, raw_path: str | None, *, label: str) -> dict[str, Any] | None:
    """Return a hash/probe record for one optional publish asset."""

    if not raw_path:
        return None
    path = _resolve_project_file(project_dir, raw_path)
    return {
        "label": label,
        "path": _relative(project_dir, path),
        "sha256": _sha256(path),
        "size_bytes": path.stat().st_size,
        "probe": _probe_media(path),
    }


def _publish_plan(model: PublishRequest, *, project_root: str | Path) -> dict[str, Any]:
    """Validate a local render and describe the export without writing files."""

    try:
        project_dir = _resolve_project(project_root, model.project_id)
        video = _resolve_project_file(project_dir, model.video_path)
        if video.suffix.lower() not in MEDIA_VIDEO_EXTENSIONS:
            raise ValueError("video_path must use a supported video extension")
        subtitles = _publish_asset_record(project_dir, model.subtitles_path, label="subtitles")
        thumbnail = _publish_asset_record(project_dir, model.thumbnail_path, label="thumbnail")
    except (ValueError, FileNotFoundError) as exc:
        return {"status": "invalid_request", "project_id": model.project_id, "would_write": False, "error": str(exc)}

    planned_files = [
        "exports/video/output" + (video.suffix or ".mp4"),
        "exports/metadata/metadata.json",
        "exports/metadata/description.txt",
    ]
    if model.tags:
        planned_files.append("exports/metadata/tags.txt")
    if model.chapters:
        planned_files.append("exports/metadata/chapters.txt")
    if subtitles:
        planned_files.append("exports/video/subtitles" + Path(model.subtitles_path or "subtitles.srt").suffix)
    if thumbnail:
        planned_files.append("exports/thumbnails/thumbnail" + Path(model.thumbnail_path or "thumbnail.png").suffix)
    elif model.thumbnail_concept:
        planned_files.append("exports/thumbnails/concept.json")
    return {
        "status": "dry_run",
        "project_id": model.project_id,
        "video": {
            "path": _relative(project_dir, video),
            "sha256": _sha256(video),
            "size_bytes": video.stat().st_size,
            "probe": _probe_media(video),
        },
        "optional_assets": {"subtitles": subtitles, "thumbnail": thumbnail},
        "planned_files": planned_files,
        "platform": model.platform,
        "visibility": model.visibility,
        "upload": {"performed": False, "status": "not_configured"},
        "cost_cny": 0.0,
        "would_write": True,
        "would_upload": False,
        "message": "仅预览本机交付包；不会上传平台或产生费用。发送 execute=true 且 confirm=true 才会写入 exports/。",
    }


def publish_media(
    request: PublishRequest | Mapping[str, Any],
    *,
    project_root: str | Path = DEFAULT_PROJECT_ROOT,
) -> dict[str, Any]:
    """Create an auditable, local OpenMontage publish bundle.

    This intentionally stops at a portable export directory.  Uploads to
    Douyin/YouTube/etc. remain provider-specific and are never implied by a
    successful local export.
    """

    model = request if isinstance(request, PublishRequest) else PublishRequest.model_validate(request)
    if model.dry_run or not model.execute:
        return _publish_plan(model, project_root=project_root)
    if not model.confirm:
        return {
            "status": "confirmation_required",
            "project_id": model.project_id,
            "would_write": False,
            "would_upload": False,
            "error": "confirm=true is required before writing the local publish bundle",
        }

    try:
        project_dir = _resolve_project(project_root, model.project_id)
        video = _resolve_project_file(project_dir, model.video_path)
        if video.suffix.lower() not in MEDIA_VIDEO_EXTENSIONS:
            raise ValueError("video_path must use a supported video extension")
        subtitles = _resolve_project_file(project_dir, model.subtitles_path) if model.subtitles_path else None
        thumbnail = _resolve_project_file(project_dir, model.thumbnail_path) if model.thumbnail_path else None
        inputs: dict[str, Any] = {
            "video_path": str(video),
            "project_name": project_dir.name,
            "export_dir": str(project_dir / "exports"),
            "title": model.title,
            "description": model.description,
            "tags": model.tags,
            "hashtags": model.hashtags,
            "chapters": model.chapters,
            "platform": model.platform,
            "visibility": model.visibility,
        }
        if subtitles:
            inputs["subtitles_path"] = str(subtitles)
        if thumbnail:
            inputs["thumbnail_path"] = str(thumbnail)
        if model.thumbnail_concept:
            inputs["thumbnail_concept"] = model.thumbnail_concept

        raw = ExportBundle().execute(inputs)
        ok, data, error = _tool_result_parts(raw)
        if not ok:
            return {"status": "failed", "project_id": model.project_id, "would_write": False, "error": error or "export bundle failed"}

        publish_log = data.get("publish_log") if isinstance(data.get("publish_log"), Mapping) else {"version": "1.0", "entries": []}
        publish_log = json.loads(json.dumps(_safe_json(publish_log), ensure_ascii=False))
        # Avoid leaking an absolute local path into an artifact that may be
        # shared with the competition submission.
        for entry in publish_log.get("entries", []):
            if not isinstance(entry, dict):
                continue
            raw_export = entry.get("export_path")
            if isinstance(raw_export, str):
                try:
                    entry["export_path"] = _relative(project_dir, Path(raw_export))
                except ValueError:
                    pass
        log_path, log_hash = _write_manifest(project_dir, "publish_log.json", publish_log)
        checkpoint = _write_stage_checkpoint(
            project_dir,
            "publish",
            "completed",
            artifacts={"publish_log": "artifacts/publish_log.json"},
            human_approval_required=True,
            human_approved=True,
            metadata={"platform": model.platform, "visibility": model.visibility, "upload_performed": False},
        )
        files_written: list[str] = []
        for raw_file in data.get("files_written", []) if isinstance(data.get("files_written"), list) else []:
            try:
                files_written.append(_relative(project_dir, Path(str(raw_file))))
            except ValueError:
                files_written.append(str(raw_file))
        export_path = data.get("export_path")
        try:
            export_path = _relative(project_dir, Path(str(export_path))) if export_path else "exports"
        except ValueError:
            export_path = str(export_path or "exports")
        emit_event(project_dir, {
            "event": "publish",
            "status": "completed",
            "artifact": _relative(project_dir, log_path),
            "export_path": export_path,
            "platform": model.platform,
            "upload_performed": False,
        })
        notify_project_changed(project_dir.name)
        return {
            "status": "completed",
            "project_id": model.project_id,
            "export_path": export_path,
            "files_written": files_written,
            "publish_log": publish_log,
            "manifest": {"path": _relative(project_dir, log_path), "sha256": log_hash},
            "checkpoint": {"path": _relative(project_dir, checkpoint)},
            "upload": {"performed": False, "status": "not_configured", "platform": model.platform},
            "cost_cny": 0.0,
            "message": "本机交付包已生成；未上传任何平台。",
        }
    except (ValueError, FileNotFoundError) as exc:
        return {"status": "invalid_request", "project_id": model.project_id, "would_write": False, "error": str(exc)}
    except Exception as exc:
        return {"status": "failed", "project_id": model.project_id, "would_write": False, "error": str(exc)[:600]}


def capabilities(
    *,
    selector: Any | None = None,
    image_selector: Any | None = None,
    transcriber: Any | None = None,
    frame_sampler: Any | None = None,
    face_tracker: Any | None = None,
) -> dict[str, Any]:
    chosen_tts = selector if selector is not None else None
    from tools.audio.tts_selector import TTSSelector
    from tools.audio.music_gen import MusicGen
    tts = chosen_tts or TTSSelector()
    # Keep capability reporting aligned with the selector used by the app.
    # This matters for injected test/local providers and prevents the health
    # page from reporting a different image route than the render endpoint.
    image = image_selector if image_selector is not None else ImageSelector()
    stitch = VideoStitch()
    transcription = _transcriber_snapshot(transcriber)
    sampler = frame_sampler if frame_sampler is not None else FrameSampler()
    tracker = face_tracker if face_tracker is not None else FaceTracker()
    music = MusicGen()
    frame_sampling = _analysis_tool_snapshot(sampler, fallback_name="frame_sampler", fallback_provider="ffmpeg")
    face_tracking = _analysis_tool_snapshot(tracker, fallback_name="face_tracker", fallback_provider="mediapipe")
    reference = _reference_analyzer_snapshot()
    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    tts_status = _status_name(tts.get_status())
    tts_providers = _selector_snapshot(tts, capability="tts")
    local_tts_available = _local_provider_available(tts)
    paid_tts_available = any(
        item.get("status") == "available"
        and str(item.get("runtime") or "").lower() not in {"local", "local_gpu"}
        for item in tts_providers
    )
    music_status = _status_name(music.get_status())
    try:
        music_info = music.get_info()
    except Exception:
        music_info = {}
    return {
        "status": "ok",
        "generated_at": _utc_now(),
        "capabilities": {
            "tts": {
                "status": tts_status,
                "providers": tts_providers,
                "authorization_required": not local_tts_available,
                "local_free_available": local_tts_available,
                "paid_provider_available": paid_tts_available,
            },
            "subtitle": {"status": "available", "provider": "openmontage", "local": True, "authorization_required": False},
            "transcription": transcription,
            "frame_sampling": {
                **frame_sampling,
                "status": frame_sampling.get("status", "unknown"),
                "confirmation_required": True,
                "output_directory": "analysis/frames",
            },
            "face_tracking": {
                **face_tracking,
                "status": face_tracking.get("status", "unknown"),
                "confirmation_required": True,
                "output_directory": "analysis/face_tracking",
                "fallback": "opencv_haar" if face_tracking.get("status") == "degraded" else None,
            },
            "reference_analysis": {
                **reference,
                "status": "available" if reference.get("status") == "available" and ffmpeg and ffprobe else "unavailable",
                "ffmpeg_configured": bool(ffmpeg),
                "ffprobe_configured": bool(ffprobe),
                "url_download": False,
            },
            "stock_media": {
                "status": "available" if (sources := _stock_source_snapshot()).get("summary", {}).get("available_source_names") else "unavailable",
                "provider": "openmontage",
                "runtime": "hybrid",
                "network_required": True,
                "free_tier": True,
                "authorization_required": False,
                "confirmation_required": True,
                "source_catalog": sources.get("catalog", []),
                "source_summary": sources.get("summary", {}),
                "semantic_ranking": False,
                "message": "可从公共素材源检索候选素材；执行前仍需明确确认并遵守来源许可证。",
            },
            "image_generation": {"status": _status_name(image.get_status()), "providers": _selector_snapshot(image, capability="image_generation"), "authorization_required": True},
            "video_post": {"status": _status_name(stitch.get_status()), "provider": "ffmpeg", "ffmpeg_configured": bool(ffmpeg), "ffprobe_configured": bool(ffprobe), "authorization_required": False},
            "video_trim": {
                "status": "available" if ffmpeg and ffprobe else "unavailable",
                "provider": "video_trimmer",
                "local": True,
                "ffmpeg_configured": bool(ffmpeg),
                "ffprobe_configured": bool(ffprobe),
                "authorization_required": False,
                "message": "可把素材按入点/出点裁成可复用片段，再加入合成清单。",
            },
            "video_postprocess": {
                "status": "available" if ffmpeg and ffprobe else "unavailable",
                "provider": "openmontage_tools",
                "local": True,
                "ffmpeg_configured": bool(ffmpeg),
                "ffprobe_configured": bool(ffprobe),
                "operations": ["silence_cut", "scene_detect", "auto_reframe", "color_grade"],
                "authorization_required": False,
                "message": "可整理长停顿、检测场景、转换画幅并应用电影级调色；所有输出均为本机派生文件。",
            },
            "silence_cutting": {
                "status": "available" if ffmpeg and ffprobe else "unavailable",
                "provider": "silence_cutter",
                "local": True,
                "operations": ["remove", "speed_up", "mark"],
                "authorization_required": False,
            },
            "scene_detection": {
                "status": "available" if ffmpeg and ffprobe else "unavailable",
                "provider": "scene_detect",
                "local": True,
                "authorization_required": False,
            },
            "auto_reframe": {
                "status": "available" if ffmpeg and ffprobe else "unavailable",
                "provider": "auto_reframe",
                "local": True,
                "face_tracking_optional": True,
                "authorization_required": False,
            },
            "color_grading": {
                "status": "available" if ffmpeg and ffprobe else "unavailable",
                "provider": "color_grade",
                "local": True,
                "profiles": ["cinematic_warm", "cinematic_cool", "moody_dark", "bright_clean", "vintage_film", "high_contrast", "neutral"],
                "authorization_required": False,
            },
            "audio_mixing": {
                "status": "available" if ffmpeg and ffprobe else "unavailable",
                "provider": "audio_mixer",
                "local": True,
                "ffmpeg_configured": bool(ffmpeg),
                "ffprobe_configured": bool(ffprobe),
                "operations": ["mix", "duck", "extract", "full_mix", "segmented_music"],
                "authorization_required": False,
                "message": "可混合旁白、BGM 和音效、按旁白自动压低 BGM、从视频抽取音频，并按片段后置 BGM。",
            },
            "audio_enhance": {
                "status": "available" if ffmpeg and ffprobe else "unavailable",
                "provider": "audio_enhance",
                "local": True,
                "ffmpeg_configured": bool(ffmpeg),
                "ffprobe_configured": bool(ffprobe),
                "presets": ["clean_speech", "noise_reduce", "normalize_only", "podcast", "broadcast", "voice_clarity"],
                "authorization_required": False,
                "message": "可对旁白做降噪、压缩、均衡和响度规范化；不会改变原始文件。",
            },
            "composition": {"status": "available" if ffmpeg and ffprobe else "unavailable", "remotion": bool(shutil.which("remotion")), "hyperframes": bool(shutil.which("hyperframes")), "authorization_required": False},
            "still_image_video": {
                "status": "available" if ffmpeg and ffprobe else "unavailable",
                "provider": "ffmpeg",
                "local": True,
                "motion": "restrained_ken_burns_push",
                "ffmpeg_configured": bool(ffmpeg),
                "ffprobe_configured": bool(ffprobe),
                "authorization_required": False,
            },
            "publish": {"status": "available", "provider": "export_bundle", "local": True, "uploads": False, "cost_cny": 0.0, "authorization_required": False},
            # BGM is intentionally a post-video stage, but it is no longer a
            # dead-end placeholder: the workbench exposes the live provider
            # state and a separate estimate/render endpoint.
            "music_generation": {
                "status": "available" if ffmpeg and ffprobe else "unavailable",
                "provider": "local_synthesis",
                "runtime": "local",
                "post_video": True,
                "authorization_required": False,
                "dependencies": ["python:numpy", "cmd:ffmpeg"],
                "supports": {"instrumental": True, "offline": True, "trained_ai_model": False},
                "optional_cloud_provider": {"name": "elevenlabs", "status": music_status, "authorization_required": True},
                "endpoint": "/model-api/media/music",
                "message": "免费本机预设器乐合成；支持按成片时长和明确的能量段编排。云端作曲为可选服务，不会自动调用。",
            },
            "bgm": {
                "status": "available" if ffmpeg and ffprobe else "unavailable",
                "provider": "local_import",
                "post_video": True,
                "authorization_required": False,
                "endpoint": "/model-api/media/music/import",
                "reason": "免费导入本机音乐、适配时长并混音；不是文字作曲，无需 ElevenLabs。",
            },
        },
    }


def create_media_app(
    *,
    project_root: str | Path = DEFAULT_PROJECT_ROOT,
    image_selector: Any | None = None,
    tts_selector: Any | None = None,
    transcriber: Any | None = None,
    frame_sampler: Any | None = None,
    face_tracker: Any | None = None,
) -> FastAPI:
    application = FastAPI(title="OpenMontage Media API", version="0.1.0")
    application.state.project_root = Path(project_root)
    application.state.image_selector = image_selector
    application.state.tts_selector = tts_selector
    application.state.transcriber = transcriber
    application.state.frame_sampler = frame_sampler
    application.state.face_tracker = face_tracker

    @application.get("/api/media/capabilities")
    def media_capabilities() -> dict[str, Any]:
        return capabilities(
            selector=application.state.tts_selector,
            image_selector=application.state.image_selector,
            transcriber=application.state.transcriber,
            frame_sampler=application.state.frame_sampler,
            face_tracker=application.state.face_tracker,
        )

    @application.post("/api/media/subtitles/render")
    def subtitles(request: SubtitleRenderRequest) -> dict[str, Any]:
        return render_subtitles(request, project_root=application.state.project_root)

    @application.post("/api/media/transcribe")
    def transcribe(request: TranscriptRequest) -> dict[str, Any]:
        if request.execute and not request.dry_run and not request.confirm:
            raise HTTPException(status_code=400, detail="confirm=true is required before transcription")
        return transcribe_media(
            request,
            transcriber=application.state.transcriber,
            project_root=application.state.project_root,
        )

    @application.post("/api/media/frames/sample")
    def sample_frames(request: FrameSampleRequest) -> dict[str, Any]:
        if request.execute and not request.dry_run and not request.confirm:
            raise HTTPException(status_code=400, detail="confirm=true is required before frame sampling")
        return sample_frames_media(
            request,
            frame_sampler=application.state.frame_sampler,
            project_root=application.state.project_root,
        )

    @application.post("/api/media/faces/track")
    def track_faces(request: FaceTrackRequest) -> dict[str, Any]:
        if request.execute and not request.dry_run and not request.confirm:
            raise HTTPException(status_code=400, detail="confirm=true is required before face tracking")
        return track_faces_media(
            request,
            face_tracker=application.state.face_tracker,
            project_root=application.state.project_root,
        )

    @application.post("/api/media/reference/review")
    def reference_review(request: ReferenceReviewRequest) -> dict[str, Any]:
        return review_reference_video(request, project_root=application.state.project_root)

    @application.post("/api/media/stock/search")
    def stock_search(request: StockSearchRequest) -> dict[str, Any]:
        if request.execute and not request.dry_run and not request.confirm:
            raise HTTPException(status_code=400, detail="confirm=true is required before stock search")
        return search_stock_media(request, project_root=application.state.project_root)

    @application.post("/api/media/trim")
    def trim(request: TrimRequest) -> dict[str, Any]:
        return trim_media(request, project_root=application.state.project_root)

    @application.post("/api/media/video/postprocess")
    def video_postprocess(request: VideoPostprocessRequest) -> dict[str, Any]:
        return video_postprocess_media(request, project_root=application.state.project_root)

    @application.post("/api/media/audio/mix")
    def audio_mix(request: AudioMixRequest) -> dict[str, Any]:
        return mix_audio_media(request, project_root=application.state.project_root)

    @application.post("/api/media/audio/enhance")
    def audio_enhance(request: AudioEnhanceRequest) -> dict[str, Any]:
        return enhance_audio_media(request, project_root=application.state.project_root)

    @application.post("/api/media/images/estimate")
    def images_estimate(request: ImagePipelineRequest) -> dict[str, Any]:
        return estimate_images(request, selector=application.state.image_selector, project_root=application.state.project_root)

    @application.post("/api/media/images/render")
    def images_render(request: ImagePipelineRequest, x_generation_authorization: str | None = Header(default=None, alias="X-Generation-Authorization")) -> dict[str, Any]:
        if request.dry_run or not request.execute:
            return render_images(request, selector=application.state.image_selector, project_root=application.state.project_root, authorized=False)
        if not request.confirm:
            raise HTTPException(status_code=400, detail="confirm=true is required for image generation")
        _require_authorization(x_generation_authorization)
        return render_images(request, selector=application.state.image_selector, project_root=application.state.project_root, authorized=True)

    @application.post("/api/media/compose")
    def compose(request: ComposeRequest) -> dict[str, Any]:
        return compose_media(request, project_root=application.state.project_root)

    @application.post("/api/media/stills/compose")
    def compose_still_images(request: StillComposeRequest) -> dict[str, Any]:
        return compose_stills(request, project_root=application.state.project_root)

    @application.post("/api/media/quality")
    def quality(request: QualityRequest) -> dict[str, Any]:
        return quality_check(request, project_root=application.state.project_root)

    @application.post("/api/media/publish")
    def publish(request: PublishRequest) -> dict[str, Any]:
        return publish_media(request, project_root=application.state.project_root)

    return application


app = create_media_app()


__all__ = [
    "AudioEnhanceRequest", "AudioMixRequest", "AudioTrack", "ComposeRequest", "ImagePipelineRequest", "ImageShot", "QualityRequest", "PublishRequest", "ReferenceReviewRequest", "StockSearchRequest", "StillComposeRequest", "TrimRequest", "VideoPostprocessRequest",
    "SubtitleRenderRequest", "SubtitleSegment", "TranscriptRequest", "FrameSampleRequest", "FaceTrackRequest", "app", "capabilities",
    "compose_media", "compose_stills", "create_media_app", "estimate_images", "image_progress_context", "quality_check", "render_images", "review_reference_video",
    "enhance_audio_media", "mix_audio_media", "publish_media", "render_images", "render_subtitles", "search_stock_media", "trim_media", "transcribe_media", "sample_frames_media", "track_faces_media", "video_postprocess_media",
]
