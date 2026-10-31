"""Truthful, project-scoped BGM generation for the OpenMontage workbench.

The music stage deliberately comes after the no-BGM picture and narration are
available.  A local reference video is inspected with ``ffprobe`` and reduced
to a small cue sheet; the direct ElevenLabs Music endpoint receives that cue
sheet as text, not the video bytes.  This keeps the workflow useful today while
being explicit about the provider's current boundary.
"""

from __future__ import annotations

import os
import hashlib
import tempfile
from pathlib import Path
from typing import Any, Mapping, Literal

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator

from backlot.server import notify_project_changed
from lib.events import emit_event
from tools.audio.music_gen import MusicGen

from web_api.media_pipeline import (
    DEFAULT_PROJECT_ROOT,
    PROJECT_ID_PATTERN,
    SAFE_FILE_PATTERN,
    _probe_media,
    _relative,
    _require_authorization,
    _resolve_project,
    _resolve_project_file,
    _safe_json,
    _sha256,
    _status_name,
    _tool_result_parts,
    _utc_now,
    _write_manifest,
    _write_stage_checkpoint,
)


MUSIC_OUTPUT_DIR = Path("assets") / "music"
MUSIC_EXTENSIONS = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"}


class MusicCue(BaseModel):
    """One bounded cue in the textual timing plan sent to a music model."""

    model_config = ConfigDict(extra="forbid")

    start_seconds: float = Field(ge=0, le=86_400)
    end_seconds: float = Field(gt=0, le=86_400)
    energy: str = Field(default="medium", max_length=32)
    focus: str = Field(default="scenic atmosphere", max_length=240)
    instrumentation: str = Field(default="", max_length=240)
    transition: str = Field(default="", max_length=240)

    @field_validator("energy", "focus", "instrumentation", "transition")
    @classmethod
    def _trim_text(cls, value: str) -> str:
        return " ".join(value.split()).strip()

class MusicPipelineRequest(BaseModel):
    """Request a safe BGM estimate or an explicitly authorised generation."""

    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1, max_length=128)
    prompt: str = Field(min_length=4, max_length=4_100)
    model_id: Literal['music_v1', 'music_v2', 'music_v2_5'] = 'music_v1'
    # If omitted, the duration is read from reference_video_path.  Requiring a
    # real duration prevents a silent 60-second default from drifting away
    # from the final cut.
    duration_seconds: float | None = Field(default=None, ge=3, le=600)
    preferred_provider: str = Field(default="elevenlabs", pattern="^(elevenlabs|auto|local)$")
    local_style: str | None = Field(default=None, pattern="^(guofeng_ambient|cinematic|documentary)$")
    local_tempo_bpm: int = Field(default=72, ge=50, le=120)
    reference_video_path: str | None = Field(default=None, max_length=1_024)
    reference_summary: str | None = Field(default=None, max_length=4_000)
    cue_sheet: list[MusicCue] = Field(default_factory=list, max_length=64)
    output_name: str = Field(default="generated-bgm.mp3", max_length=128)
    force_instrumental: bool = True
    # Kept as an explicit opt-in field for future providers.  The current
    # direct route never silently substitutes a lower-quality provider.
    allow_fallback: bool = False
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

    @field_validator("prompt")
    @classmethod
    def _trim_prompt(cls, value: str) -> str:
        value = " ".join(value.split()).strip()
        if len(value) < 4:
            raise ValueError("prompt must contain at least four non-space characters")
        return value

    @field_validator("reference_video_path")
    @classmethod
    def _safe_reference(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        path = Path(value)
        if not value or path.is_absolute() or ".." in path.parts:
            raise ValueError("reference_video_path must be project-relative")
        return value

    @field_validator("reference_summary")
    @classmethod
    def _trim_summary(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = " ".join(value.split()).strip()
        return value or None

    @field_validator("output_name")
    @classmethod
    def _safe_output(cls, value: str) -> str:
        value = value.strip()
        if not SAFE_FILE_PATTERN.fullmatch(value):
            raise ValueError("output_name must be a safe filename")
        if Path(value).suffix.lower() not in MUSIC_EXTENSIONS:
            raise ValueError("output_name must use a supported audio extension")
        return value


def _provider_snapshot(tool: Any, model_id: str = 'music_v1') -> dict[str, Any]:
    """Return credential-safe provider metadata for the UI and health checks."""

    try:
        status = _status_name(tool.get_status())
    except Exception:
        status = "unknown"
    try:
        info = tool.get_info() if callable(getattr(tool, "get_info", None)) else {}
    except Exception:
        info = {}
    if not isinstance(info, Mapping):
        info = {}
    return {
        "name": getattr(tool, "name", "music_gen"),
        "provider": getattr(tool, "provider", "elevenlabs"),
        "model": None if getattr(tool, 'provider', '') == 'local_synthesis' else model_id,
        "status": status,
        "runtime": str(getattr(getattr(tool, "runtime", ""), "value", getattr(tool, "runtime", "")) or "").lower() or "api",
        "dependencies": list(info.get("dependencies") or getattr(tool, "dependencies", []) or []),
        "install_instructions": str(info.get("install_instructions") or getattr(tool, "install_instructions", "") or ""),
        "supports": _safe_json(info.get("supports") or getattr(tool, "supports", {}) or {}),
        "best_for": list(info.get("best_for") or getattr(tool, "best_for", []) or []),
        "fallback_enabled": False,
    }


def _default_cue_sheet(duration: float) -> list[dict[str, Any]]:
    """Make a useful, deterministic arc when no creator cues were supplied."""

    duration = max(3.0, float(duration))
    points = [0.0, duration * 0.18, duration * 0.52, duration * 0.82, duration]
    labels = [
        ("low", "开场定场：湖面、山色或城市远景，留出旁白呼吸", "piano, soft pads, sparse bamboo flute", "从环境声般的低密度纹理渐入"),
        ("medium", "主体展开：风、云、水纹与栈道运动，保持清晰节拍", "warm strings, brushed percussion, bamboo flute", "以柔和的脉冲承接镜头运动"),
        ("high", "视觉高潮：开阔风景、光线变化和关键记忆点", "cinematic strings, restrained taiko, airy synth", "短暂抬升，不盖过人声"),
        ("low", "收束回望：夕阳/灯火/远景，给结尾字幕留空间", "piano, guzheng harmonics, soft pads", "渐弱并保留最后一口余韵"),
    ]
    cues: list[dict[str, Any]] = []
    for index, (energy, focus, instruments, transition) in enumerate(labels):
        cues.append({
            "start_seconds": round(points[index], 3),
            "end_seconds": round(points[index + 1], 3),
            "energy": energy,
            "focus": focus,
            "instrumentation": instruments,
            "transition": transition,
        })
    return cues


def _normalise_cues(request: MusicPipelineRequest, duration: float) -> list[dict[str, Any]]:
    if not request.cue_sheet:
        return _default_cue_sheet(duration)
    cues: list[dict[str, Any]] = []
    for cue in request.cue_sheet:
        start = float(cue.start_seconds)
        end = float(cue.end_seconds)
        if end <= start:
            raise ValueError("cue_sheet requires end_seconds greater than start_seconds")
        if end > duration + 0.25:
            raise ValueError("cue_sheet cannot extend beyond the requested music duration")
        cues.append(cue.model_dump())
    return cues


def _reference_info(project_dir: Path, request: MusicPipelineRequest) -> dict[str, Any]:
    if not request.reference_video_path:
        return {"provided": False, "support": "textualized_local_reference_only"}
    path = _resolve_project_file(project_dir, request.reference_video_path, must_exist=True)
    probe = _probe_media(path)
    return {
        "provided": True,
        "path": _relative(project_dir, path),
        "sha256": _sha256(path),
        "size_bytes": path.stat().st_size,
        "probe": probe,
        "support": "textualized_local_reference_only",
        "note": "本机只读取时长/音轨/画幅等元数据生成 cue sheet；视频字节不会上传给 ElevenLabs Music。",
    }


def _duration_for(request: MusicPipelineRequest, reference: Mapping[str, Any]) -> tuple[float, str]:
    if request.duration_seconds is not None:
        return float(request.duration_seconds), "request"
    probe = reference.get("probe") if isinstance(reference, Mapping) else None
    duration = probe.get("duration_seconds") if isinstance(probe, Mapping) else None
    try:
        value = float(duration)
    except (TypeError, ValueError):
        value = 0.0
    if not 3 <= value <= 600:
        raise ValueError("duration_seconds is required unless a valid 3—600 second reference video is provided")
    return value, "reference_video"


def _enriched_prompt(request: MusicPipelineRequest, cues: list[dict[str, Any]], reference: Mapping[str, Any]) -> str:
    lines = [
        request.prompt.strip(),
        "Instrumental background music only; no vocals, no spoken words, no lyrics.",
        "Write for a polished Zhejiang cultural-tourism short video. Keep narration intelligible and leave controlled space under speech.",
    ]
    if request.reference_summary:
        lines.append(f"Local reference summary: {request.reference_summary}")
    if reference.get("provided"):
        probe = reference.get("probe") or {}
        lines.append(
            "Reference timing metadata: "
            f"duration={probe.get('duration_seconds', 'unknown')}s, "
            f"format={probe.get('format', 'unknown')}, "
            "use its pacing as a textual guide only."
        )
    lines.append("Cue sheet:")
    for cue in cues:
        lines.append(
            f"{float(cue['start_seconds']):.1f}-{float(cue['end_seconds']):.1f}s "
            f"{cue.get('energy', 'medium')} energy; {cue.get('focus', '')}; "
            f"instruments: {cue.get('instrumentation', '')}; transition: {cue.get('transition', '')}."
        )
    prompt = "\n".join(lines)
    if len(prompt) > 4100:
        raise ValueError('音乐描述与分段提示合计最多 4100 字符；请缩短描述或减少分段，没有发送请求')
    return prompt


def estimate_music(
    request: MusicPipelineRequest | Mapping[str, Any],
    *,
    tool: Any | None = None,
    project_root: str | Path = DEFAULT_PROJECT_ROOT,
) -> dict[str, Any]:
    model = request if isinstance(request, MusicPipelineRequest) else MusicPipelineRequest.model_validate(request)
    if model.preferred_provider == 'local':
        from tools.audio.local_music import LocalMusic
        chosen = LocalMusic()
    else:
        chosen = tool or MusicGen()
    provider = _provider_snapshot(chosen, model.model_id)
    try:
        project_dir = _resolve_project(project_root, model.project_id)
        reference = _reference_info(project_dir, model)
        duration, duration_source = _duration_for(model, reference)
        cues = _normalise_cues(model, duration)
        if model.preferred_provider == 'local':
            if not model.force_instrumental:
                raise ValueError('本机配乐只支持器乐，请保持“仅生成器乐”勾选')
            if any(cue['energy'] not in {'low', 'medium', 'high'} for cue in cues):
                raise ValueError('本机配乐能量段只支持 low、medium、high')
            if any(float(cue['end_seconds']) > duration + .01 for cue in cues):
                raise ValueError('本机配乐能量段不能超出目标时长')
        prompt = _enriched_prompt(model, cues, reference)
        try:
            cost_usd = float(chosen.estimate_cost({"prompt": prompt, "duration_seconds": duration, "model_id": model.model_id}))
        except Exception:
            cost_usd = 0.0
        output = project_dir / MUSIC_OUTPUT_DIR / ('local-<new-run>' if model.preferred_provider == 'local' else '') / model.output_name
        return {
            "status": "dry_run",
            "project_id": model.project_id,
            "provider": provider,
            "duration_seconds": round(duration, 3),
            "duration_source": duration_source,
            "reference": reference,
            "reference_support": "local_metadata_and_explicit_energy_cues_only" if model.preferred_provider == 'local' else "textualized_local_reference_only",
            "cue_sheet": cues,
            "prompt_preview": prompt,
            "force_instrumental": bool(model.force_instrumental),
            "output": {"path": _relative(project_dir, output), "format": output.suffix.lstrip(".")},
            "estimated_cost_usd": round(cost_usd, 4),
            "estimated_cost_cny": round(cost_usd * float(os.environ.get("ARK_CNY_PER_USD", "7.2")), 2),
            "would_generate": provider["status"] == "available",
            "authorization_required": True,
            "requires_confirmation": True,
            "message": (
                "预检完成：将用本机预设合成器乐，不联网、不收费；不等同于音乐大模型作曲。"
                if model.preferred_provider == 'local' and provider['status'] == 'available' else
                "预检完成：BGM 将在无 BGM 成片和旁白确认后生成；执行会产生 ElevenLabs 费用。"
                if provider["status"] == "available"
                else "预检完成：ElevenLabs Music 当前不可用；没有写入文件，也没有发起请求。"
            ),
        }
    except (ValueError, FileNotFoundError) as exc:
        return {"status": "invalid_request", "project_id": model.project_id, "would_generate": False, "error": str(exc)}
    except Exception as exc:  # pragma: no cover - defensive boundary
        return {"status": "failed", "project_id": model.project_id, "would_generate": False, "error": str(exc)[:500]}


def _atomic_replace(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    source.replace(destination)


def render_music(
    request: MusicPipelineRequest | Mapping[str, Any],
    *,
    tool: Any | None = None,
    project_root: str | Path = DEFAULT_PROJECT_ROOT,
    authorized: bool = False,
) -> dict[str, Any]:
    model = request if isinstance(request, MusicPipelineRequest) else MusicPipelineRequest.model_validate(request)
    if model.dry_run or not model.execute:
        return estimate_music(model, tool=tool, project_root=project_root)
    if not model.confirm or not authorized:
        return {
            "status": "authorization_required",
            "project_id": model.project_id,
            "would_generate": False,
            "error": "confirm=true and explicit generation authorization are required",
        }
    if model.preferred_provider == 'local':
        plan = estimate_music(model, project_root=project_root)
        if plan.get('status') != 'dry_run' or not plan.get('would_generate'):
            return {**plan, 'would_write': False}
        from web_api.local_music_pipeline import render_local_music
        return render_local_music(model, project_root=project_root)
    chosen = tool or MusicGen()
    try:
        project_dir = _resolve_project(project_root, model.project_id)
        reference = _reference_info(project_dir, model)
        duration, duration_source = _duration_for(model, reference)
        cues = _normalise_cues(model, duration)
        prompt = _enriched_prompt(model, cues, reference)
        provider = _provider_snapshot(chosen, model.model_id)
        if provider["status"] != "available":
            return {
                "status": "unavailable",
                "project_id": model.project_id,
                "provider": provider,
                "would_generate": False,
                "authorization_required": True,
                "error": "ElevenLabs Music 不可用；没有写入假音频，也没有自动切换低质量后备。",
            }

        final_path = project_dir / MUSIC_OUTPUT_DIR / model.output_name
        final_path.parent.mkdir(parents=True, exist_ok=True)
        fd, raw_temp = tempfile.mkstemp(
            dir=str(final_path.parent),
            prefix=f".{final_path.stem}.",
            suffix=final_path.suffix,
        )
        os.close(fd)
        temp_path = Path(raw_temp)
        # MusicGen writes the response bytes to the path supplied below.  The
        # temporary path ensures a failed/ambiguous provider call never
        # replaces a previously accepted BGM file.
        try:
            raw = chosen.execute({
                "prompt": prompt,
                "duration_seconds": duration,
                "model_id": model.model_id,
                "force_instrumental": bool(model.force_instrumental),
                "output_path": str(temp_path),
                "project_dir": str(project_dir),
            })
            ok, data, error = _tool_result_parts(raw)
            if not ok or not temp_path.is_file() or temp_path.stat().st_size <= 0:
                return {
                    "status": "provider_error",
                    "project_id": model.project_id,
                    "provider": provider,
                    "error": (error or "provider returned success without an audio file")[:500],
                    "reconcile_required": bool(error),
                    "would_generate": False,
                }
            _atomic_replace(temp_path, final_path)
        finally:
            temp_path.unlink(missing_ok=True)

        output_hash = _sha256(final_path)
        output_probe = _probe_media(final_path)
        # Provider responses may include the temporary absolute output path
        # used during the atomic write.  Keep the manifest portable and do
        # not leak a machine-specific path; the accepted project-relative
        # output is recorded separately below.
        provider_data = {
            key: value
            for key, value in (data.items() if isinstance(data, Mapping) else [])
            if key not in {"output", "output_path"}
        }
        cost_usd = round(float(chosen.estimate_cost({"duration_seconds": duration, "prompt": prompt, "model_id": model.model_id})), 4)
        manifest, manifest_hash = _write_manifest(
            project_dir,
            "music_manifest.json",
            {
                "schema_version": "1.0",
                "project_id": model.project_id,
                "stage": "bgm_postproduction",
                "status": "completed",
                "created_at": _utc_now(),
                "provider": provider,
                "duration_seconds": round(duration, 3),
                "duration_source": duration_source,
                "force_instrumental": bool(model.force_instrumental),
                "prompt_sha256": hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
                "reference": reference,
                "cue_sheet": cues,
                "output": {"path": _relative(project_dir, final_path), "sha256": output_hash, "size_bytes": final_path.stat().st_size, "probe": output_probe},
                "provider_data": provider_data,
                "estimated_cost_usd": cost_usd,
            },
        )
        cue_path, cue_hash = _write_manifest(
            project_dir,
            "music_cue_sheet.json",
            {
                "schema_version": "1.0",
                "project_id": model.project_id,
                "source": "local_reference_metadata_and_creator_prompt",
                "reference_support": "textualized_local_reference_only",
                "duration_seconds": round(duration, 3),
                "cues": cues,
                "created_at": _utc_now(),
            },
        )
        checkpoint = _write_stage_checkpoint(
            project_dir,
            "compose",
            "completed",
            artifacts={
                "music_manifest": _relative(project_dir, manifest),
                "music_cue_sheet": _relative(project_dir, cue_path),
                "bgm": _relative(project_dir, final_path),
            },
            metadata={
                "bgm_status": "completed",
                "provider": provider.get("provider"),
                "duration_seconds": round(duration, 3),
                "output_sha256": output_hash,
            },
        )
        emit_event(project_dir, {
            "event": "music_generation",
            "status": "completed",
            "provider": provider.get("provider"),
            "artifact": _relative(project_dir, final_path),
            "manifest": _relative(project_dir, manifest),
            "duration_seconds": round(duration, 3),
            "cost_usd": cost_usd,
        })
        notify_project_changed(project_dir.name)
        return {
            "status": "completed",
            "project_id": model.project_id,
            "provider": provider,
            "reference": reference,
            "reference_support": "textualized_local_reference_only",
            "cue_sheet": {"path": _relative(project_dir, cue_path), "sha256": cue_hash, "cues": cues},
            "music": {"path": _relative(project_dir, final_path), "sha256": output_hash, "size_bytes": final_path.stat().st_size, "duration_seconds": round(duration, 3), "format": final_path.suffix.lstrip(".")},
            "output": {"path": _relative(project_dir, final_path), "kind": "audio", "sha256": output_hash},
            "manifest": {"path": _relative(project_dir, manifest), "sha256": manifest_hash},
            "checkpoint": {"path": _relative(project_dir, checkpoint)},
            "estimated_cost_usd": cost_usd,
            "estimated_cost_cny": round(cost_usd * float(os.environ.get("ARK_CNY_PER_USD", "7.2")), 2),
            "message": "BGM 已生成并完成文件、哈希和时长验证；下一步可自动带入下方混音。",
        }
    except (ValueError, FileNotFoundError) as exc:
        return {"status": "invalid_request", "project_id": model.project_id, "would_generate": False, "error": str(exc)}
    except Exception as exc:  # pragma: no cover - defensive provider boundary
        message = str(exc)
        key = os.environ.get("ELEVENLABS_API_KEY")
        if key:
            message = message.replace(key, "[REDACTED_API_KEY]")
        return {"status": "failed", "project_id": model.project_id, "would_generate": False, "reconcile_required": True, "error": message[:500]}


def provider_health(*, tool: Any | None = None) -> dict[str, Any]:
    from tools.audio.local_music import LocalMusic
    chosen = tool or LocalMusic()
    provider = _provider_snapshot(chosen)
    return {
        "status": "ok",
        "capability": "music_generation",
        "provider": provider,
        "post_video": True,
        "reference_support": "local_metadata_and_explicit_energy_cues_only",
        "authorization_required": provider['provider'] != 'local_synthesis',
        "providers": [_provider_snapshot(LocalMusic()), _provider_snapshot(MusicGen())],
        "default_web_provider": "local",
        "message": "本机预设器乐免费、无需密钥；也可导入已有音乐。ElevenLabs 为明确选择后才调用的付费选项。",
    }


def create_music_app(
    *,
    project_root: str | Path = DEFAULT_PROJECT_ROOT,
    tool: Any | None = None,
) -> FastAPI:
    application = FastAPI(title="OpenMontage Music API", version="0.1.0")
    application.state.project_root = Path(project_root)
    application.state.music_tool = tool

    @application.get("/api/music/health")
    @application.get("/api/music/capabilities")
    def music_health() -> dict[str, Any]:
        return provider_health(tool=application.state.music_tool)

    @application.post("/api/music/estimate")
    def music_estimate(request: MusicPipelineRequest) -> dict[str, Any]:
        return estimate_music(request, tool=application.state.music_tool, project_root=application.state.project_root)

    @application.post("/api/music/render")
    def music_render(
        request: MusicPipelineRequest,
        x_generation_authorization: str | None = Header(default=None, alias="X-Generation-Authorization"),
    ) -> dict[str, Any]:
        if request.dry_run or not request.execute:
            return render_music(request, tool=application.state.music_tool, project_root=application.state.project_root, authorized=False)
        if not request.confirm:
            raise HTTPException(status_code=400, detail="confirm=true is required for music generation")
        _require_authorization(x_generation_authorization)
        return render_music(request, tool=application.state.music_tool, project_root=application.state.project_root, authorized=True)

    return application


app = create_music_app()


__all__ = [
    "MusicCue",
    "MusicPipelineRequest",
    "app",
    "create_music_app",
    "estimate_music",
    "provider_health",
    "render_music",
]
