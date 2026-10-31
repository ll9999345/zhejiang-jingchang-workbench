"""Closed, local workbench contracts for native OpenMontage composition.

No JavaScript, remote URL, credential, or command is accepted from the browser.
The original VideoCompose tool and Remotion scene components do the rendering;
the adapter pins a previously installed CLI/browser and local system fonts.
"""

from __future__ import annotations

import json
import math
import os
import re
import secrets
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Mapping

from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from backlot.server import notify_project_changed
from lib.events import emit_event
from tools.video.video_compose import VideoCompose
from tools.video.video_trimmer import VideoTrimmer
from web_api.media_pipeline import (
    DEFAULT_PROJECT_ROOT, MEDIA_AUDIO_EXTENSIONS, MEDIA_IMAGE_EXTENSIONS,
    MEDIA_VIDEO_EXTENSIONS, PROJECT_ID_PATTERN, _probe_media, _relative,
    _resolve_project_file, _sha256, _tool_result_parts,
)

COMPOSER = Path(__file__).resolve().parents[1] / "remotion-composer"
SCENE_TYPES = (
    "text_card", "hero_title", "stat_card", "callout", "comparison", "bar_chart",
    "line_chart", "pie_chart", "kpi_grid", "progress_bar", "image", "video",
)
SceneType = Literal[
    "text_card", "hero_title", "stat_card", "callout", "comparison", "bar_chart",
    "line_chart", "pie_chart", "kpi_grid", "progress_bar", "image", "video",
]


class ClosedModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class ChartDatum(ClosedModel):
    label: str = Field(min_length=1, max_length=80)
    value: float = Field(ge=0, le=1e12)
    prefix: str | None = Field(default=None, max_length=12)
    suffix: str | None = Field(default=None, max_length=12)
    change: float | None = Field(default=None, ge=-1e6, le=1e6)


class LinePoint(ClosedModel):
    x: float = Field(ge=-1e12, le=1e12)
    y: float = Field(ge=-1e12, le=1e12)


class ChartSeries(ClosedModel):
    label: str = Field(min_length=1, max_length=80)
    data: list[LinePoint] = Field(min_length=2, max_length=100)


class SceneProps(ClosedModel):
    text: str | None = Field(default=None, min_length=1, max_length=500)
    stat: str | None = Field(default=None, min_length=1, max_length=80)
    subtitle: str | None = Field(default=None, max_length=240)
    heroSubtitle: str | None = Field(default=None, max_length=240)
    title: str | None = Field(default=None, max_length=160)
    callout_type: Literal["info", "warning", "tip", "quote"] = "info"
    leftLabel: str | None = Field(default=None, min_length=1, max_length=80)
    rightLabel: str | None = Field(default=None, min_length=1, max_length=80)
    leftValue: str | None = Field(default=None, min_length=1, max_length=160)
    rightValue: str | None = Field(default=None, min_length=1, max_length=160)
    chartData: list[ChartDatum] | None = Field(default=None, min_length=1, max_length=20)
    chartSeries: list[ChartSeries] | None = Field(default=None, min_length=1, max_length=6)
    progress: float | None = Field(default=None, ge=0, le=1)
    progressLabel: str | None = Field(default=None, max_length=100)
    fontSize: int | None = Field(default=None, ge=18, le=160)
    columns: Literal[2, 3, 4] = 3
    donut: bool = False
    centerLabel: str | None = Field(default=None, max_length=80)
    centerValue: str | None = Field(default=None, max_length=80)
    showValues: bool = True
    showGrid: bool = True
    showLegend: bool = True
    showMarkers: bool = True
    xLabel: str | None = Field(default=None, max_length=80)
    yLabel: str | None = Field(default=None, max_length=80)
    source: str | None = Field(default=None, max_length=1024)
    source_in_seconds: float = Field(default=0, ge=0, le=86400)
    animation: Literal["none", "zoom-in", "zoom-out", "pan-left", "pan-right", "ken-burns"] = "none"


class MontageScene(ClosedModel):
    id: str = Field(default="scene", pattern=r"^[A-Za-z0-9_-]{1,64}$")
    type: SceneType = "text_card"
    duration_seconds: float = Field(default=3, ge=0.5, le=60)
    props: SceneProps = Field(default_factory=SceneProps)

    @model_validator(mode="after")
    def required_scene_fields(self) -> "MontageScene":
        required = {
            "text_card": ["text"], "hero_title": ["text"], "callout": ["text"],
            "stat_card": ["stat"], "comparison": ["leftLabel", "rightLabel", "leftValue", "rightValue"],
            "bar_chart": ["chartData"], "pie_chart": ["chartData"], "kpi_grid": ["chartData"],
            "line_chart": ["chartSeries"], "progress_bar": ["progress"], "image": ["source"], "video": ["source"],
        }[self.type]
        if any(getattr(self.props, field) is None or getattr(self.props, field) == "" for field in required):
            raise ValueError(f"{self.type} requires {', '.join(required)}")
        if self.type == "pie_chart" and sum(row.value for row in self.props.chartData or []) <= 0:
            raise ValueError("pie chart requires a positive total")
        if self.type not in {"image", "video"} and self.props.source is not None:
            raise ValueError("source is only accepted for image/video scenes")
        return self


class MontageCompositionRequest(ClosedModel):
    project_id: str = Field(min_length=1, max_length=128)
    scenes: list[MontageScene] = Field(min_length=1, max_length=40)
    width: int = Field(default=1280, ge=320, le=1920)
    height: int = Field(default=720, ge=240, le=1920)
    # The native Explainer metadata is based on 30 fps. Keep this explicit.
    fps: Literal[30] = 30
    audio_path: str | None = Field(default=None, max_length=1024)
    output_name: str = Field(default="scene-composition.mp4", pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.mp4$")
    dry_run: bool = True
    execute: bool = False
    confirm: bool = False

    @field_validator("project_id")
    @classmethod
    def project_name(cls, value: str) -> str:
        if not PROJECT_ID_PATTERN.fullmatch(value):
            raise ValueError("invalid project_id")
        return value

    @model_validator(mode="after")
    def sane_layout(self) -> "MontageCompositionRequest":
        if self.width % 2 or self.height % 2:
            raise ValueError("width and height must be even")
        if sum(scene.duration_seconds for scene in self.scenes) > 300:
            raise ValueError("composition duration must not exceed 300 seconds")
        return self


def resolve_project(root: str | Path, project_id: str) -> Path:
    root_path = Path(root).expanduser().resolve()
    candidate = root_path / project_id
    if not PROJECT_ID_PATTERN.fullmatch(project_id) or candidate.is_symlink():
        raise ValueError("project_id must name a real project directory")
    project = candidate.resolve()
    if project.parent != root_path or not project.is_dir():
        raise FileNotFoundError(f"project does not exist: {project_id}")
    return project


def safe_destination(project: Path, relative_path: str) -> Path:
    candidate = Path(relative_path)
    if candidate.is_absolute() or ".." in candidate.parts:
        raise ValueError("output must be project-relative")
    resolved = (project / candidate).resolve()
    if not resolved.is_relative_to(project):
        raise ValueError("output escaped the project")
    return resolved


def validate_event_destination(project: Path) -> None:
    event_log = project / "events.jsonl"
    if event_log.is_symlink():
        raise ValueError("project event log must not be a symbolic link")
    safe_destination(project, "events.jsonl")
    if event_log.exists() and not event_log.is_file():
        raise ValueError("project event log must be a regular file")


def require_video_decoder(codec: str) -> None:
    """Inspect the already installed FFmpeg; do not create media in preflight."""
    binary = shutil.which("ffmpeg")
    if not binary:
        raise ValueError("本机 FFmpeg 不可用，无法兼容转换视频。")
    try:
        result = subprocess.run([binary, "-hide_banner", "-decoders"], capture_output=True, text=True, timeout=15)
    except subprocess.SubprocessError as exc:
        raise ValueError("本机视频解码条件检查超时，预检未写文件。") from exc
    if result.returncode:
        raise ValueError("无法检查本机视频解码条件。")
    for line in result.stdout.splitlines():
        match = re.match(r"\s*V[.A-Z]{5}\s+(\S+)\s+(.*)", line)
        if match and (codec == match[1] or f"(codec {codec})" in match[2]):
            return
    raise ValueError(f"本机 FFmpeg 缺少 {codec or 'unknown'} 视频解码器，预检未写文件。")


def allocate_run(project: Path, operation: str) -> tuple[str, Path]:
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + secrets.token_hex(6)
    directory = safe_destination(project, f"renders/montage/{operation}/{run_id}")
    directory.mkdir(parents=True, exist_ok=False)
    return run_id, directory


def write_receipt(project: Path, name: str, payload: Mapping[str, Any]) -> dict[str, Any]:
    path = safe_destination(project, f"artifacts/{name}")
    path.parent.mkdir(parents=True, exist_ok=True)
    # Unique names and exclusive open preserve every prior receipt.
    with path.open("x", encoding="utf-8") as handle:
        json.dump(dict(payload), handle, ensure_ascii=False, indent=2, allow_nan=False)
    return {"path": _relative(project, path), "sha256": _sha256(path)}


def write_failure_receipt(project: Path, operation: str, run_id: str, run_dir: Path,
                          payload: Mapping[str, Any]) -> dict[str, Any] | None:
    try:
        return write_receipt(project, f"montage_{operation}_{run_id}_failed.json", payload)
    except (OSError, ValueError):
        # If the shared artifacts directory is unavailable, keep an independent
        # receipt beside this run's preserved intermediates, never overwrite.
        try:
            path = safe_destination(project, _relative(project, run_dir / "failure-manifest.json"))
            with path.open("x", encoding="utf-8") as handle:
                json.dump(dict(payload), handle, ensure_ascii=False, indent=2, allow_nan=False)
            return {"path": _relative(project, path), "sha256": _sha256(path)}
        except (OSError, ValueError):
            return None


def safe_error(value: Any) -> str:
    text = str(value or "local operation failed")
    text = re.sub(r"https?://[^\s]+", "[remote address]", text)
    return re.sub(r"(?i)(bearer|api[_-]?key|token|password)\s*[:=]?\s*\S+", "[redacted]", text)[-1000:]


def written_files(project: Path, run_dir: Path | None) -> list[dict[str, Any]]:
    if run_dir is None or not run_dir.is_dir():
        return []
    records = []
    for path in sorted(run_dir.rglob("*")):
        if path.is_file() and path.resolve().is_relative_to(project):
            records.append({"path": _relative(project, path), "size_bytes": path.stat().st_size})
    return records


def installed_browser() -> Path | None:
    configured = os.environ.get("REMOTION_BROWSER_EXECUTABLE")
    candidates = [Path(configured)] if configured else []
    candidates.extend([
        Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        Path("/Applications/Chromium.app/Contents/MacOS/Chromium"),
    ])
    for directory in [COMPOSER / "node_modules/.remotion", Path.home() / ".cache/hyperframes/chrome"]:
        if directory.is_dir():
            candidates.extend(sorted(directory.glob("**/chrome-headless-shell")))
    return next((p.resolve() for p in candidates if p.is_file() and os.access(p, os.X_OK)), None)


def composition_runtime() -> dict[str, Any]:
    node = shutil.which("node")
    cli = COMPOSER / "node_modules/@remotion/cli/remotion-cli.js"
    browser = installed_browser()
    reasons = []
    if not node:
        reasons.append("Node.js is not installed")
    if not cli.is_file() or not (COMPOSER / "src/index.tsx").is_file():
        reasons.append("local Remotion composer/CLI is unavailable")
    if not browser:
        reasons.append("no previously installed Chromium browser was found; automatic download is disabled")
    if not shutil.which("ffprobe"):
        reasons.append("ffprobe is unavailable")
    if not shutil.which("ffmpeg"):
        reasons.append("ffmpeg is unavailable")
    unavailable_types = {}
    return {"status": "available" if not reasons else "unavailable", "reasons": reasons,
            "automatic_download": False, "external_requests": False, "font_mode": "local_system",
            "scene_types": [name for name in SCENE_TYPES if name not in unavailable_types],
            "unavailable_scene_types": unavailable_types,
            "encoding_path": "remotion_png_sequence_then_system_ffmpeg", "fps": 30,
            "native_canvas": {"width": 1920, "height": 1080}, "output_layout": "fit_with_padding",
            "video_decode": "remotion_browser_video", "video_render_format": {"extension": ".mp4", "codec": "h264"},
            "video_compatibility": "non_h264_mp4_selected_ranges_are_transcoded_locally_after_confirmation",
            "video_source_audio": "muted; optional project audio is muxed separately"}


def _native_props(project: Path, model: MontageCompositionRequest) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    cuts, records = [], []
    cursor = 0.0
    for scene in model.scenes:
        fields = scene.props.model_dump(exclude_none=True)
        if scene.type == "kpi_grid":
            # Native KPI cards are white. Keep their labels and optional title
            # readable without changing the shared component's global theme.
            fields.update(color="#1E293B", backgroundColor="#F1F5F9")
        if scene.type == "progress_bar":
            fields["progress"] = fields["progress"] * 100
        if scene.type in {"image", "video"}:
            source = _resolve_project_file(project, fields["source"])
            expected = MEDIA_IMAGE_EXTENSIONS if scene.type == "image" else MEDIA_VIDEO_EXTENSIONS
            if source.suffix.lower() not in expected:
                raise ValueError(f"{scene.type} scene has an unsupported media extension")
            if scene.type == "image":
                from PIL import Image
                with Image.open(source) as image:
                    image.verify()
            if scene.type == "video":
                probe = _probe_media(source)
                if not probe or not probe.get("video"):
                    raise ValueError("video scene source is not a decodable video")
                require_video_decoder(probe["video"].get("codec", ""))
                if fields["source_in_seconds"] + scene.duration_seconds > float(probe.get("duration_seconds", 0)) + 0.05:
                    raise ValueError("video scene exceeds source duration")
                # The fixed local adapter opts into Remotion's synchronized
                # HTML video decoder. This flag is not a browser input field.
                fields["browserVideoDecode"] = True
            fields["source"] = str(source)
            records.append({"path": _relative(project, source), "sha256": _sha256(source)})
        end = round(cursor + scene.duration_seconds, 6)
        cuts.append({**fields, "scene_id": scene.id, "type": scene.type if scene.type not in {"image", "video"} else None,
                     "in_seconds": cursor, "out_seconds": end})
        cursor = end
    audio = {}
    if model.audio_path:
        source = _resolve_project_file(project, model.audio_path)
        if source.suffix.lower() not in MEDIA_AUDIO_EXTENSIONS:
            raise ValueError("audio_path has an unsupported extension")
        probe = _probe_media(source)
        if not probe or not probe.get("audio"):
            raise ValueError("audio_path is not a decodable audio file")
        audio = {"narration": {"src": str(source), "volume": 1}}
        records.append({"path": _relative(project, source), "sha256": _sha256(source)})
    return {"render_runtime": "remotion", "renderer_family": "explainer-data", "composition_mode": "templated",
            "cuts": cuts, "audio": audio, "overlays": [], "captions": [],
            "themeConfig": {"headingFont": "PingFang SC, system-ui, sans-serif", "bodyFont": "PingFang SC, system-ui, sans-serif"}}, records


def prepare_browser_video_sources(project: Path, props: dict[str, Any], public_dir: Path) -> list[dict[str, Any]]:
    """Convert only selected ranges with the original local VideoTrimmer tool."""
    records = []
    for index, cut in enumerate(props["cuts"]):
        if not cut.get("browserVideoDecode"):
            continue
        source = Path(cut["source"])
        probe = _probe_media(source)
        if source.suffix.lower() == ".mp4" and probe and (probe.get("video") or {}).get("codec") == "h264":
            continue
        output = public_dir / f"compatible-video-{index + 1:02d}.mp4"
        start = float(cut.get("source_in_seconds", 0))
        duration = float(cut["out_seconds"] - cut["in_seconds"])
        result = VideoTrimmer().execute({"operation": "cut", "input_path": str(source), "output_path": str(output),
                                         "start_seconds": start, "end_seconds": start + duration, "codec": "libx264"})
        ok, _, error = _tool_result_parts(result)
        converted = _probe_media(output) if output.is_file() else None
        if not ok or not converted or not converted.get("video") or converted["video"].get("codec") != "h264":
            raise RuntimeError(error or "本机视频兼容转换未生成可解码的 H.264 MP4。")
        if abs(float(converted.get("duration_seconds", 0)) - duration) > 0.2:
            raise RuntimeError("视频兼容转换时长与所选范围不一致。")
        records.append({"input": _relative(project, source), "path": _relative(project, output),
                        "sha256": _sha256(output), "source_in_seconds": start, "duration_seconds": duration,
                        "tool": "video_trimmer", "original_preserved": True})
        cut.update(source=str(output), source_in_seconds=0)
    return records


class LocalVideoCompose(VideoCompose):
    """Retain the native render contract, pin only its process environment."""

    def __init__(self, model: MontageCompositionRequest, run_dir: Path) -> None:
        self.model = model
        self.run_dir = run_dir

    def _remotion_render(self, inputs: dict[str, Any]):
        # Remotion still owns frame timing and native scene rendering. Encode
        # with system FFmpeg because current compositor binaries require a
        # newer macOS than this host. Audio is muxed below from the same input.
        props = json.loads(json.dumps(inputs["edit_decisions"]))
        props["audio"] = {}
        return super()._remotion_render({**inputs, "edit_decisions": props})

    def run_command(self, cmd: list[str], *, timeout: int | None = None, cwd: Path | None = None):
        if cmd[:3] == ["npx", "remotion", "render"]:
            browser = installed_browser()
            node = shutil.which("node")
            if not browser or not node:
                raise RuntimeError("local browser/runtime became unavailable")
            stub = self.run_dir / "local-fonts.cjs"
            stub.write_text("exports.loadFont = () => ({fontFamily: 'PingFang SC, system-ui, sans-serif', waitUntilDone: () => Promise.resolve()});\n", encoding="utf-8")
            config = self.run_dir / "remotion.config.cjs"
            config.write_text(
                f"const {{Config}} = require({json.dumps(str(COMPOSER / 'node_modules/@remotion/cli/dist/config/index.js'))});\n"
                "Config.overrideWebpackConfig((c) => ({...c, resolve: {...c.resolve, alias: {...(c.resolve.alias || {}), "
                f"'@remotion/google-fonts/SpaceGrotesk': {json.dumps(str(stub))}, '@remotion/google-fonts/PlayfairDisplay': {json.dumps(str(stub))}"
                "}}}));\n", encoding="utf-8")
            frames = math.ceil(sum(s.duration_seconds for s in self.model.scenes) * self.model.fps)
            output = Path(cmd[5])
            frames_dir = self.run_dir / "frames"
            render_args = list(cmd[2:])
            render_args[3] = str(frames_dir)
            render_cmd = [node, str(COMPOSER / "node_modules/@remotion/cli/remotion-cli.js"), *render_args,
                   f"--config={config}", f"--browser-executable={browser}", "--width=1920",
                   "--height=1080", f"--fps={self.model.fps}", f"--frames=0-{frames - 1}",
                   "--concurrency=1", "--sequence", "--muted", "--image-format=png", "--image-sequence-pattern=frame-[frame].png", "--log=error"]
            render_result = super().run_command(render_cmd, timeout=timeout, cwd=cwd)
            images = sorted(frames_dir.glob("frame-*.png"))
            if len(images) != frames:
                raise RuntimeError(f"Remotion rendered {len(images)} of {frames} required frames")
            # The native frame padding depends on the requested frame range.
            digits = len(images[0].stem.split("-")[-1])
            encode = [shutil.which("ffmpeg") or "ffmpeg", "-v", "error", "-framerate", str(self.model.fps),
                      "-start_number", "0", "-i", str(frames_dir / f"frame-%0{digits}d.png")]
            if self.model.audio_path:
                project = self.run_dir.parents[3]
                audio = _resolve_project_file(project, self.model.audio_path)
                encode.extend(["-i", str(audio), "-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-b:a", "192k"])
            layout = (f"scale={self.model.width}:{self.model.height}:force_original_aspect_ratio=decrease,"
                      f"pad={self.model.width}:{self.model.height}:(ow-iw)/2:(oh-ih)/2:color=0x0F172A")
            encode.extend(["-t", str(frames / self.model.fps), "-vf", layout, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart", str(output)])
            super().run_command(encode, timeout=timeout, cwd=cwd)
            return render_result
        return super().run_command(cmd, timeout=timeout, cwd=cwd)


def preflight_composition(request: MontageCompositionRequest | Mapping[str, Any], *, project_root: str | Path = DEFAULT_PROJECT_ROOT) -> dict[str, Any]:
    model = request if isinstance(request, MontageCompositionRequest) else MontageCompositionRequest.model_validate(request)
    base = {"project_id": model.project_id, "local": True, "cost_cny": 0, "would_write": False,
            "scene_count": len(model.scenes), "duration_seconds": round(sum(s.duration_seconds for s in model.scenes), 3)}
    try:
        project = resolve_project(project_root, model.project_id)
        runtime = composition_runtime()
        blocked = [runtime.get("unavailable_scene_types", {}).get(scene.type) for scene in model.scenes]
        if any(blocked):
            return {**base, "status": "unavailable", "can_execute": False, "runtime": runtime,
                    "error": "；".join(dict.fromkeys(reason for reason in blocked if reason))}
        _, records = _native_props(project, model)
        safe_destination(project, "renders/montage/composition")
        safe_destination(project, "artifacts")
        validate_event_destination(project)
        return {**base, "status": "dry_run" if runtime["status"] == "available" else "unavailable",
                "can_execute": runtime["status"] == "available", "runtime": runtime, "inputs": records,
                "planned_output": f"renders/montage/composition/<new-run>/{model.output_name}",
                "message": "只检查本机条件；尚未渲染。使用 OpenMontage 原生横屏模板完整适配，竖屏或方屏保留上下留白。"}
    except (ValueError, FileNotFoundError, OSError) as exc:
        return {**base, "status": "invalid_request", "can_execute": False, "error": safe_error(exc)}


def execute_composition(request: MontageCompositionRequest | Mapping[str, Any], *, project_root: str | Path = DEFAULT_PROJECT_ROOT) -> dict[str, Any]:
    model = request if isinstance(request, MontageCompositionRequest) else MontageCompositionRequest.model_validate(request)
    plan = preflight_composition(model, project_root=project_root)
    if model.dry_run or not model.execute:
        return plan
    if not model.confirm:
        return {**plan, "status": "confirmation_required", "error": "confirm=true is required"}
    if not plan.get("can_execute"):
        return plan
    run_id = None
    run_dir = None
    output_verified = False
    try:
        project = resolve_project(project_root, model.project_id)
        validate_event_destination(project)
        props, records = _native_props(project, model)
        run_id, run_dir = allocate_run(project, "composition")
        output = run_dir / model.output_name
        # Caller-owned staging avoids global composer public-directory writes.
        public_dir = run_dir / "public"
        public_dir.mkdir()
        prepared_videos = prepare_browser_video_sources(project, props, public_dir)
        tool = LocalVideoCompose(model, run_dir)
        result = tool.execute({"operation": "remotion_render", "edit_decisions": props,
                               "output_path": str(output), "public_dir": str(public_dir)})
        ok, _, error = _tool_result_parts(result)
        probe = _probe_media(output) if output.is_file() else None
        if not ok or not probe or not probe.get("video"):
            raise RuntimeError(error or "Remotion did not produce a decodable video")
        expected = plan["duration_seconds"]
        if abs(float(probe.get("duration_seconds", 0)) - expected) > max(0.15, 2 / model.fps):
            raise RuntimeError("rendered duration differs from the scene timeline")
        if (probe["video"].get("width"), probe["video"].get("height")) != (model.width, model.height):
            raise RuntimeError("rendered dimensions differ from the requested layout")
        output_verified = True
        data = {"status": "completed", "project_id": model.project_id, "run_id": run_id,
                "local": True, "tool": "video_compose", "render_runtime": "remotion",
                "scene_count": len(model.scenes), "inputs": records,
                "prepared_video_sources": prepared_videos,
                "output": {"path": _relative(project, output), "sha256": _sha256(output), "probe": probe},
                "rendered_scenes": [scene.model_dump() for scene in model.scenes], "visual_review_required": True}
        data["manifest"] = write_receipt(project, f"montage_composition_{run_id}.json", data)
        try:
            validate_event_destination(project)
            emit_event(project, {"event": "montage_composition", "status": "completed", "artifact": data["manifest"]["path"]})
            notify_project_changed(project.name)
        except Exception:
            data["warnings"] = ["成片与回执已保存；项目更新通知未完成。"]
        return data
    except Exception as exc:
        failure = {"status": "failed", "project_id": model.project_id, "run_id": run_id, "local": True,
                   "error": safe_error(exc), "output_verified": output_verified, "writes_occurred": run_id is not None,
                   "written_files": written_files(project, run_dir) if run_id else []}
        if output_verified:
            failure["output"] = {"path": _relative(project, output), "probe": probe}
        if run_id:
            manifest = write_failure_receipt(project, "composition", run_id, run_dir, failure)
            if manifest:
                failure["manifest"] = manifest
            else:
                failure["manifest_error"] = "本次运行文件已保留，但失败记录无法写入。"
        return failure


def create_montage_composition_app(*, project_root: str | Path = DEFAULT_PROJECT_ROOT) -> FastAPI:
    app = FastAPI(title="Local OpenMontage Composition")

    @app.get("/api/montage/capabilities")
    def capabilities() -> dict[str, Any]:
        return {"composition": composition_runtime(), "local": True, "arbitrary_code": False}

    @app.post("/api/montage/composition/preflight")
    def preflight(request: MontageCompositionRequest) -> dict[str, Any]:
        return preflight_composition(request, project_root=project_root)

    @app.post("/api/montage/composition/execute")
    def execute(request: MontageCompositionRequest) -> dict[str, Any]:
        return execute_composition(request, project_root=project_root)

    return app
