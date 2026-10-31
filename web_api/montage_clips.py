"""Batch clip extraction from creator-selected time ranges, using VideoTrimmer."""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any, Literal, Mapping

from fastapi import FastAPI
from pydantic import Field, field_validator, model_validator

from backlot.server import notify_project_changed
from lib.events import emit_event
from tools.video.video_trimmer import VideoTrimmer
from web_api.media_pipeline import (
    DEFAULT_PROJECT_ROOT, MEDIA_VIDEO_EXTENSIONS, PROJECT_ID_PATTERN,
    _probe_media, _relative, _resolve_project_file, _sha256, _tool_result_parts,
)
from web_api.montage_composition import (
    ClosedModel, allocate_run, resolve_project, safe_destination, safe_error, write_receipt, written_files, validate_event_destination, write_failure_receipt,
)


class ClipRange(ClosedModel):
    id: str = Field(default="clip", pattern=r"^[A-Za-z0-9_-]{1,64}$")
    start_seconds: float = Field(ge=0, le=86400)
    end_seconds: float = Field(gt=0, le=86400)

    @model_validator(mode="after")
    def ordered_range(self) -> "ClipRange":
        if self.end_seconds <= self.start_seconds:
            raise ValueError("end_seconds must be greater than start_seconds")
        return self


class MontageClipsRequest(ClosedModel):
    project_id: str = Field(min_length=1, max_length=128)
    input_path: str = Field(min_length=1, max_length=1024)
    segments: list[ClipRange] = Field(min_length=1, max_length=50)
    codec: Literal["libx264", "copy"] = "libx264"
    dry_run: bool = True
    execute: bool = False
    confirm: bool = False

    @field_validator("project_id")
    @classmethod
    def project_name(cls, value: str) -> str:
        if not PROJECT_ID_PATTERN.fullmatch(value):
            raise ValueError("invalid project_id")
        return value

    @field_validator("input_path")
    @classmethod
    def relative_input(cls, value: str) -> str:
        path = Path(value)
        if path.is_absolute() or ".." in path.parts:
            raise ValueError("input_path must stay inside the project")
        return value


def clip_runtime() -> dict[str, Any]:
    ready = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
    return {"status": "available" if ready else "unavailable", "tool": "video_trimmer",
            "automatic_highlight_selection": False, "external_requests": False}


def _source(project: Path, model: MontageClipsRequest) -> tuple[Path, dict[str, Any]]:
    source = _resolve_project_file(project, model.input_path)
    if source.suffix.lower() not in MEDIA_VIDEO_EXTENSIONS:
        raise ValueError("input_path must be a project-local video")
    probe = _probe_media(source)
    if not probe or not probe.get("video") or float(probe.get("duration_seconds", 0)) <= 0:
        raise ValueError("input_path is not a decodable video")
    duration = float(probe["duration_seconds"])
    if any(segment.end_seconds > duration + 0.01 for segment in model.segments):
        raise ValueError(f"a clip range exceeds source duration ({duration:.3f} seconds)")
    return source, probe


def preflight_clips(request: MontageClipsRequest | Mapping[str, Any], *, project_root: str | Path = DEFAULT_PROJECT_ROOT) -> dict[str, Any]:
    model = request if isinstance(request, MontageClipsRequest) else MontageClipsRequest.model_validate(request)
    base = {"project_id": model.project_id, "local": True, "cost_cny": 0, "would_write": False,
            "clip_count": len(model.segments), "selection": "creator_supplied_time_ranges"}
    runtime = clip_runtime()
    if runtime["status"] != "available":
        return {**base, "status": "unavailable", "can_execute": False, "runtime": runtime}
    try:
        project = resolve_project(project_root, model.project_id)
        source, probe = _source(project, model)
        safe_destination(project, "renders/montage/clips")
        safe_destination(project, "artifacts")
        validate_event_destination(project)
        return {**base, "status": "dry_run", "can_execute": True, "runtime": runtime,
                "input": {"path": _relative(project, source), "sha256": _sha256(source), "probe": probe},
                "ranges": [segment.model_dump() for segment in model.segments],
                "planned_output": "renders/montage/clips/<new-run>/<number>-<clip-id>.mp4",
                "warnings": ["快速复制裁剪依赖原片关键帧，切点可能不精确。"] if model.codec == "copy" else [],
                "message": "将按已填写的起止时间批量裁剪，不自动判断精彩片段。预检未写文件。"}
    except (ValueError, FileNotFoundError, OSError) as exc:
        return {**base, "status": "invalid_request", "can_execute": False, "error": safe_error(exc)}


def execute_clips(request: MontageClipsRequest | Mapping[str, Any], *, project_root: str | Path = DEFAULT_PROJECT_ROOT) -> dict[str, Any]:
    model = request if isinstance(request, MontageClipsRequest) else MontageClipsRequest.model_validate(request)
    plan = preflight_clips(model, project_root=project_root)
    if model.dry_run or not model.execute:
        return plan
    if not model.confirm:
        return {**plan, "status": "confirmation_required", "error": "confirm=true is required"}
    if not plan.get("can_execute"):
        return plan
    outputs: list[dict[str, Any]] = []
    run_id = None
    directory = None
    try:
        project = resolve_project(project_root, model.project_id)
        validate_event_destination(project)
        source, source_probe = _source(project, model)
        input_record = {"path": _relative(project, source), "sha256": _sha256(source), "probe": source_probe}
        run_id, directory = allocate_run(project, "clips")
        tool = VideoTrimmer()
        for index, segment in enumerate(model.segments):
            output = directory / f"{index + 1:02d}-{segment.id}.mp4"
            result = tool.execute({"operation": "cut", "input_path": str(source), "output_path": str(output),
                                   "start_seconds": segment.start_seconds, "end_seconds": segment.end_seconds,
                                   "codec": model.codec})
            ok, _, error = _tool_result_parts(result)
            probe = _probe_media(output) if output.is_file() else None
            if not ok or not probe or not probe.get("video"):
                raise RuntimeError(error or f"clip {index + 1} is not a decodable video")
            expected = segment.end_seconds - segment.start_seconds
            if model.codec == "libx264" and abs(float(probe.get("duration_seconds", 0)) - expected) > 0.2:
                raise RuntimeError(f"clip {index + 1} duration differs from its requested range")
            outputs.append({"id": segment.id, "path": _relative(project, output), "sha256": _sha256(output),
                            "start_seconds": segment.start_seconds, "end_seconds": segment.end_seconds, "probe": probe})
        data = {"status": "completed", "project_id": model.project_id, "run_id": run_id, "local": True,
                "tool": "video_trimmer", "selection": "creator_supplied_time_ranges", "input": input_record,
                "clips": outputs, "clip_count": len(outputs), "warnings": plan.get("warnings", []), "visual_review_required": True}
        data["manifest"] = write_receipt(project, f"montage_clips_{run_id}.json", data)
        try:
            validate_event_destination(project)
            emit_event(project, {"event": "montage_clips", "status": "completed", "artifact": data["manifest"]["path"]})
            notify_project_changed(project.name)
        except Exception:
            data["warnings"].append("视频与回执已保存；项目更新通知未完成。")
        return data
    except Exception as exc:
        failure = {"status": "failed", "project_id": model.project_id, "run_id": run_id,
                   "local": True, "clips": outputs, "completed_clip_count": len(outputs), "error": safe_error(exc),
                   "writes_occurred": run_id is not None,
                   "written_files": written_files(project, directory) if run_id else []}
        if run_id:
            manifest = write_failure_receipt(project, "clips", run_id, directory, failure)
            if manifest:
                failure["manifest"] = manifest
            else:
                failure["manifest_error"] = "本次运行文件已保留，但失败记录无法写入。"
        return failure


def create_montage_clips_app(*, project_root: str | Path = DEFAULT_PROJECT_ROOT) -> FastAPI:
    app = FastAPI(title="Local OpenMontage Batch Clips")

    @app.post("/api/montage/clips/preflight")
    def preflight(request: MontageClipsRequest) -> dict[str, Any]:
        return preflight_clips(request, project_root=project_root)

    @app.post("/api/montage/clips/execute")
    def execute(request: MontageClipsRequest) -> dict[str, Any]:
        return execute_clips(request, project_root=project_root)

    return app
