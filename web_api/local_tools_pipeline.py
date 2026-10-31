"""Safe web endpoints for the installed, free local OpenMontage tools.

The model page needs one small, predictable contract for local finishing and
graphics helpers.  This module deliberately exposes *templates* and
allow-listed operations rather than Python source or shell commands.  Every
input media path is project-relative, every output gets a fresh run id, and a
manifest is written only after the tool result has been checked on disk.

The endpoint is intentionally two-step:

``POST /api/local-tools/estimate``
    Read-only preflight.  It reports the real dependency state and the output
    that would be written.

``POST /api/local-tools/execute``
    Runs one local operation only when ``execute=true`` and ``confirm=true``.
    No cloud generation, account credential, or arbitrary command is accepted.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import secrets
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Mapping

from fastapi import FastAPI
from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator

from backlot.server import notify_project_changed
from lib.events import emit_event
from tools.base_tool import ToolResult
from tools.enhancement.bg_remove import BgRemove
from tools.enhancement.eye_enhance import EyeEnhance
from tools.graphics.blender_world import BlenderWorld
from tools.graphics.math_animate import MathAnimate
from tools.video.hyperframes_compose import HyperFramesCompose
from web_api.media_pipeline import (
    DEFAULT_PROJECT_ROOT,
    MEDIA_AUDIO_EXTENSIONS,
    MEDIA_IMAGE_EXTENSIONS,
    MEDIA_VIDEO_EXTENSIONS,
    PROJECT_ID_PATTERN,
    SAFE_FILE_PATTERN,
    _relative,
    _resolve_project,
    _sha256,
    _write_manifest,
)


LOCAL_OPERATIONS = (
    "bg_remove",
    "eye_enhance",
    "manim_title",
    "manim_flow",
    "blender_title",
    "hyperframes_render",
)
LocalOperation = Literal[
    "bg_remove",
    "eye_enhance",
    "manim_title",
    "manim_flow",
    "blender_title",
    "hyperframes_render",
]

_LOCAL_TOOL_CLASSES: dict[str, type[Any]] = {
    "bg_remove": BgRemove,
    "eye_enhance": EyeEnhance,
    "manim_title": MathAnimate,
    "manim_flow": MathAnimate,
    "blender_title": BlenderWorld,
    "hyperframes_render": HyperFramesCompose,
}

_OPERATION_LABELS = {
    "bg_remove": "图片抠图",
    "eye_enhance": "眼部增强",
    "manim_title": "Manim 中文标题卡",
    "manim_flow": "Manim 流程图动画",
    "blender_title": "Blender 三维标题场景",
    "hyperframes_render": "HyperFrames 已有工程渲染",
}

_DEFAULT_OUTPUTS = {
    "bg_remove": "cutout.png",
    "eye_enhance": "eye-enhanced.mp4",
    "manim_title": "manim-title.mp4",
    "manim_flow": "manim-flow.mp4",
    "blender_title": "blender-title.png",
    "hyperframes_render": "hyperframes-render.mp4",
}

_IMAGE_OPS = {"bg_remove"}
_VIDEO_OPS = {"eye_enhance"}
_GRAPHICS_OPS = {"manim_title", "manim_flow", "blender_title"}
_RENDER_OPS = {"eye_enhance", "manim_title", "manim_flow", "blender_title", "hyperframes_render"}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _status_name(value: Any) -> str:
    raw = getattr(value, "value", value)
    text = str(raw or "unknown").strip().lower()
    if text.endswith(".available"):
        return "available"
    if text.endswith(".degraded"):
        return "degraded"
    if text.endswith(".unavailable"):
        return "unavailable"
    return text if text in {"available", "degraded", "unavailable"} else "unknown"


def _safe_error(value: Any) -> str:
    """Keep local-tool errors useful without returning command-line noise."""

    message = str(value or "local tool failed")
    # A local tool should not need credentials, but keep the same basic
    # redaction guarantee as the other web APIs in case a dependency prints a
    # URL containing a query token.
    message = re.sub(r"(?i)(authorization\s*[:=]\s*bearer\s+)\S+", r"\1[redacted]", message)
    message = re.sub(r"https?://[^\s'\"<>]+", lambda match: match.group(0).split("?", 1)[0], message)
    return message[-1_000:]


def _tool_result_parts(raw: Any) -> tuple[bool, dict[str, Any], list[str], str | None]:
    if isinstance(raw, ToolResult):
        return bool(raw.success), dict(raw.data or {}), list(raw.artifacts or []), raw.error
    if isinstance(raw, Mapping):
        nested = raw.get("data")
        data = dict(nested) if isinstance(nested, Mapping) else dict(raw)
        artifacts = raw.get("artifacts")
        artifact_list = list(artifacts) if isinstance(artifacts, (list, tuple)) else []
        return bool(raw.get("success", data.get("valid", False))), data, artifact_list, raw.get("error")
    return False, {}, [], "local tool returned an invalid result"


def _safe_json(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, Mapping):
        return {str(key): _safe_json(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_safe_json(item) for item in value]
    return str(value)


class LocalToolRequest(BaseModel):
    """A closed request schema for the local-tool buttons.

    ``extra='forbid'`` is important here: callers cannot smuggle
    ``scene_code``, a shell command, a module path, or a provider credential
    into this boundary.  Manim source and Blender world specifications are
    generated by the fixed templates below.
    """

    model_config = ConfigDict(extra="forbid")

    operation: LocalOperation = Field(
        validation_alias=AliasChoices("operation", "tool"),
        description="Closed local operation name; `tool` is accepted as a UI alias.",
    )
    project_id: str = Field(min_length=1, max_length=128)
    input_path: str | None = Field(default=None, max_length=1_024)
    workspace_path: str = Field(default="hyperframes", max_length=256)
    output_name: str | None = Field(default=None, max_length=128)
    template: str = Field(default="title_card", pattern="^(title_card|flow_diagram)$")
    title: str = Field(default="浙江文旅", min_length=1, max_length=160)
    subtitle: str | None = Field(default=None, max_length=240)
    labels: list[str] = Field(default_factory=lambda: ["观察", "理解", "行动"], max_length=4)
    model: str = Field(default="u2net", pattern="^(u2net|u2net_human_seg|isnet-general-use)$")
    bg_color: str | None = Field(default=None, max_length=7)
    alpha_matting: bool = False
    operations: list[str] = Field(default_factory=lambda: ["dark_circles", "brighten_eyes"], min_length=1, max_length=3)
    dark_circle_intensity: float = Field(default=0.4, ge=0.0, le=1.0)
    eye_brighten_intensity: float = Field(default=0.3, ge=0.0, le=1.0)
    sharpen_intensity: float = Field(default=0.3, ge=0.0, le=1.0)
    quality: str = Field(default="low", pattern="^(low|medium|high)$")
    duration_seconds: float = Field(
        default=4.0,
        validation_alias=AliasChoices("duration_seconds", "duration"),
        ge=1.0,
        le=60.0,
    )
    width: int = Field(default=1280, ge=320, le=1920)
    height: int = Field(default=720, ge=240, le=1920)
    fps: int = Field(default=24, ge=12, le=60)
    samples: int = Field(default=8, ge=1, le=64)
    cpu_render: bool = True
    dry_run: bool = True
    execute: bool = False
    confirm: bool = False

    @field_validator("project_id")
    @classmethod
    def _project_id(cls, value: str) -> str:
        value = value.strip()
        if not PROJECT_ID_PATTERN.fullmatch(value):
            raise ValueError("project_id contains unsupported path characters")
        return value

    @field_validator("input_path", "workspace_path")
    @classmethod
    def _relative_path(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        candidate = Path(value)
        if not value or candidate.is_absolute() or ".." in candidate.parts:
            raise ValueError("paths must be project-relative and cannot contain ..")
        return value

    @field_validator("output_name")
    @classmethod
    def _output_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not SAFE_FILE_PATTERN.fullmatch(value) or Path(value).name != value:
            raise ValueError("output_name must be a simple filename")
        if Path(value).suffix.lower() not in MEDIA_IMAGE_EXTENSIONS | MEDIA_VIDEO_EXTENSIONS:
            raise ValueError("output_name must use a supported media extension")
        return value

    @field_validator("title", "subtitle")
    @classmethod
    def _text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        return value or None

    @field_validator("labels")
    @classmethod
    def _labels(cls, values: list[str]) -> list[str]:
        cleaned = [str(value).strip() for value in values]
        if not cleaned or any(not value for value in cleaned):
            raise ValueError("labels must contain non-empty text")
        return cleaned

    @field_validator("operations")
    @classmethod
    def _operations(cls, values: list[str]) -> list[str]:
        allowed = {"dark_circles", "brighten_eyes", "sharpen_eyes"}
        cleaned = list(dict.fromkeys(str(value).strip() for value in values))
        if not cleaned or any(value not in allowed for value in cleaned):
            raise ValueError("operations contains an unsupported eye operation")
        return cleaned

    @field_validator("bg_color")
    @classmethod
    def _color(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
            raise ValueError("bg_color must be a six-digit hex color")
        return value.upper()


def _resolve_relative_dir(project_dir: Path, raw_path: str) -> Path:
    candidate = Path(raw_path)
    if candidate.is_absolute() or ".." in candidate.parts:
        raise ValueError("workspace_path must stay inside the project")
    resolved = (project_dir / candidate).resolve()
    try:
        resolved.relative_to(project_dir.resolve())
    except ValueError as exc:
        raise ValueError("workspace_path escaped the project") from exc
    if not resolved.is_dir():
        raise FileNotFoundError(f"workspace does not exist: {raw_path}")
    return resolved


def _resolve_input(project_dir: Path, request: LocalToolRequest) -> Path | None:
    if request.operation in _IMAGE_OPS | _VIDEO_OPS:
        if not request.input_path:
            raise ValueError("input_path is required for this operation")
        candidate = (project_dir / request.input_path).resolve()
        try:
            candidate.relative_to(project_dir.resolve())
        except ValueError as exc:
            raise ValueError("input_path escaped the project") from exc
        if not candidate.is_file():
            raise FileNotFoundError(f"input file does not exist: {request.input_path}")
        suffix = candidate.suffix.lower()
        if request.operation in _IMAGE_OPS and suffix not in MEDIA_IMAGE_EXTENSIONS:
            raise ValueError("bg_remove requires a project-local image")
        if request.operation in _VIDEO_OPS and suffix not in MEDIA_VIDEO_EXTENSIONS:
            raise ValueError("eye_enhance requires a project-local video")
        return candidate
    if request.operation == "hyperframes_render":
        workspace = _resolve_relative_dir(project_dir, request.workspace_path)
        if not (workspace / "index.html").is_file():
            raise FileNotFoundError("workspace must contain index.html")
        return workspace
    return None


def _extension_for(request: LocalToolRequest) -> str:
    default = _DEFAULT_OUTPUTS[request.operation]
    name = request.output_name or default
    suffix = Path(name).suffix.lower()
    expected = ".png" if request.operation in {"bg_remove", "blender_title"} else ".mp4"
    if suffix != expected:
        raise ValueError(f"{request.operation} output_name must end with {expected}")
    return suffix


def _planned_output(project_dir: Path, request: LocalToolRequest) -> Path:
    extension = _extension_for(request)
    base_name = request.output_name or _DEFAULT_OUTPUTS[request.operation]
    directory = project_dir / ("assets/local-tools" if extension == ".png" else "renders/local-tools") / request.operation
    # A plan is only a human-readable location; execution adds a fresh id.
    return directory / base_name


def _tool_snapshot(operation: str) -> dict[str, Any]:
    tool_class = _LOCAL_TOOL_CLASSES[operation]
    try:
        tool = tool_class()
        status = _status_name(tool.get_status())
        info = tool.get_info() if callable(getattr(tool, "get_info", None)) else {}
    except Exception as exc:
        tool = None
        status = "unavailable"
        info = {"error": _safe_error(exc)}
    info = info if isinstance(info, Mapping) else {}
    snapshot = {
        "operation": operation,
        "label": _OPERATION_LABELS[operation],
        "tool": getattr(tool, "name", operation),
        "provider": getattr(tool, "provider", "openmontage") if tool else "openmontage",
        "runtime": str(getattr(getattr(tool, "runtime", "local"), "value", getattr(tool, "runtime", "local"))),
        "status": status,
        "free": True,
        "local": True,
        "dependencies": list(info.get("dependencies") or getattr(tool, "dependencies", []) or []),
        "capabilities": list(info.get("capabilities") or getattr(tool, "capabilities", []) or []),
        "best_for": list(info.get("best_for") or getattr(tool, "best_for", []) or []),
        "install_instructions": str(info.get("install_instructions") or getattr(tool, "install_instructions", "") or "")[:600],
        "status_detail": _safe_json(info.get("hyperframes_runtime") or info.get("optional_runtime") or info.get("setup_offer") or {}),
    }
    if operation == "blender_title":
        # The web template is deliberately pinned to a CPU-safe Cycles render
        # so a Metal-only Mac does not fail during a user-visible preview.
        snapshot["render_engine"] = "CYCLES"
        snapshot["cpu_default"] = True
    return snapshot


def local_tool_capabilities() -> dict[str, Any]:
    tools = [_tool_snapshot(operation) for operation in LOCAL_OPERATIONS]
    counts = {status: sum(1 for item in tools if item["status"] == status) for status in ("available", "degraded", "unavailable")}
    return {
        "status": "ready",
        "generated_at": _utc_now(),
        "local_free_only": True,
        "requires_confirmation": True,
        "arbitrary_code": False,
        "counts": counts,
        "tools": tools,
        "routes": {
            "capabilities": "/model-api/local-tools/capabilities",
            "estimate": "/model-api/local-tools/estimate",
            "preflight": "/model-api/media/local-tools/preflight",
            "execute": "/model-api/local-tools/execute",
        },
        "storage": {
            "rule": "所有执行结果写入当前项目，并自动追加唯一运行编号；不会覆盖旧产物。",
            "image_outputs": "assets/local-tools/<operation>/",
            "video_outputs": "renders/local-tools/<operation>/",
            "manifests": "artifacts/local_tools_<run_id>.json",
        },
    }


def estimate_local_tool(
    request: LocalToolRequest | Mapping[str, Any],
    *,
    project_root: str | Path = DEFAULT_PROJECT_ROOT,
) -> dict[str, Any]:
    model = request if isinstance(request, LocalToolRequest) else LocalToolRequest.model_validate(request)
    base = {
        "status": "dry_run",
        "operation": model.operation,
        "project_id": model.project_id,
        "cost_cny": 0.0,
        "free": True,
        "local": True,
        "requires_confirmation": True,
        "would_write": False,
    }
    try:
        project_dir = _resolve_project(project_root, model.project_id)
        input_path = _resolve_input(project_dir, model)
        output = _planned_output(project_dir, model)
    except (ValueError, FileNotFoundError, OSError) as exc:
        return {**base, "status": "invalid_request", "error": _safe_error(exc)}

    tool = _tool_snapshot(model.operation)
    can_run = tool["status"] in {"available", "degraded"}
    result = {
        **base,
        "tool": tool,
        "input": {
            "path": _relative(project_dir, input_path) if input_path and input_path.is_file() else (_relative(project_dir, input_path) if input_path else None),
            "sha256": _sha256(input_path) if input_path and input_path.is_file() else None,
        },
        "planned_output": _relative(project_dir, output),
        "would_write": can_run,
        "message": (
            "本机工具可执行；点击确认后才会写入新的项目产物。"
            if can_run
            else "依赖未满足；本次预检不会写入文件。"
        ),
    }
    if model.operation == "hyperframes_render":
        result["network_note"] = "渲染本身在本机执行；已有工程若引用远程 CDN，HyperFrames 可能按工程原配置读取。"
    return result


def _run_id() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + secrets.token_hex(4)


def _allocate_output(project_dir: Path, request: LocalToolRequest, run_id: str) -> Path:
    extension = _extension_for(request)
    requested = request.output_name or _DEFAULT_OUTPUTS[request.operation]
    output_root = project_dir / ("assets/local-tools" if extension == ".png" else "renders/local-tools") / request.operation
    output_root.mkdir(parents=True, exist_ok=True)
    candidate = output_root / f"{run_id}-{requested}"
    # The run id is already unique, but keep this guard explicit so a mocked
    # clock or a retried request can never make a tool overwrite a file.
    counter = 2
    while candidate.exists():
        candidate = output_root / f"{run_id}-{counter}-{requested}"
        counter += 1
    return candidate


def _hex_rgb(value: str) -> list[float]:
    text = value.lstrip("#")
    return [int(text[index : index + 2], 16) / 255.0 for index in (0, 2, 4)] + [1.0]


def _py_literal(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def _manim_scene_code(request: LocalToolRequest) -> str:
    title = _py_literal(request.title)
    subtitle = _py_literal(request.subtitle or "本地模板 · 免费渲染")
    labels = _py_literal(request.labels)
    duration = _py_literal(request.duration_seconds)
    portrait = request.height > request.width
    frame_width = 8.0 if portrait else 14.222222
    layout = f"config.frame_width = {frame_width}\nconfig.frame_height = {frame_width * request.height / request.width}"
    if request.operation == "manim_flow":
        return f'''from manim import *
config.background_color = {_py_literal(request.bg_color or "#081419")}
{layout}

class OpenMontageLocalTemplate(Scene):
    def construct(self):
        title = Text({title}, font="PingFang SC", weight=BOLD).scale(0.72)
        subtitle = Text({subtitle}, font="PingFang SC").scale(0.28)
        if title.width > config.frame_width - 1:
            title.scale_to_fit_width(config.frame_width - 1)
        title.to_edge(UP, buff=0.55)
        subtitle.next_to(title, DOWN, buff=0.18)
        labels = VGroup(*[Text(item, font="PingFang SC").scale(0.34) for item in {labels}])
        labels.arrange(RIGHT, buff=1.0).shift(DOWN * 0.25)
        nodes = VGroup(*[RoundedRectangle(width=2.2, height=1.0, corner_radius=0.16, color=TEAL_C).set_fill(BLACK, opacity=0.25) for _ in labels])
        nodes.arrange({"DOWN" if portrait else "RIGHT"}, buff=0.45).shift(DOWN * 0.25)
        for label, node in zip(labels, nodes):
            if label.width > node.width - 0.3:
                label.scale_to_fit_width(node.width - 0.3)
            label.move_to(node)
        arrows = VGroup(*[Arrow(nodes[index].{"get_bottom" if portrait else "get_right"}(), nodes[index + 1].{"get_top" if portrait else "get_left"}(), buff=0.12, color=GOLD_C) for index in range(len(nodes) - 1)])
        self.play(FadeIn(title, shift=UP * 0.2), FadeIn(subtitle), run_time={duration} * 0.2)
        self.play(LaggedStart(*[Create(node) for node in nodes], lag_ratio=0.18), run_time={duration} * 0.25)
        self.play(LaggedStart(*[Write(label) for label in labels], lag_ratio=0.18), run_time={duration} * 0.2)
        if len(arrows):
            self.play(LaggedStart(*[GrowArrow(arrow) for arrow in arrows], lag_ratio=0.2), run_time={duration} * 0.15)
        self.wait({duration} * (0.2 if len(arrows) else 0.35))
'''
    return f'''from manim import *
config.background_color = {_py_literal(request.bg_color or "#081419")}
{layout}

class OpenMontageLocalTemplate(Scene):
    def construct(self):
        panel = RoundedRectangle(width=config.frame_width - 1, height=config.frame_height - 1, corner_radius=0.26, color=TEAL_C).set_fill(BLACK, opacity=0.28)
        title = Text({title}, font="PingFang SC", weight=BOLD).scale(0.82)
        subtitle = Text({subtitle}, font="PingFang SC").scale(0.32)
        rule = Line(LEFT * 4.0, RIGHT * 4.0, color=GOLD_C, stroke_width=5)
        group = VGroup(title, rule, subtitle).arrange(DOWN, buff=0.3)
        if group.width > config.frame_width - 1.6:
            group.scale_to_fit_width(config.frame_width - 1.6)
        self.play(FadeIn(panel, scale=0.96), FadeIn(group, shift=UP * 0.15), run_time={duration} * 0.25)
        self.play(Indicate(rule, color=GOLD_C), run_time={duration} * 0.15)
        self.wait({duration} * 0.6)
'''


def _blender_world_spec(request: LocalToolRequest) -> dict[str, Any]:
    # This is a deliberately small, fixed world grammar.  The web request
    # controls text and palette only; it cannot submit an arbitrary Blender
    # script, asset path, or scene specification.
    accent = _hex_rgb(request.bg_color or "#2AA198")
    return {
        "version": "1.0",
        "seed": 17,
        "title_card": {
            "text": request.title,
            "size": 0.62,
            "color": _hex_rgb("#F4C56A"),
            "start_seconds": 0,
            # Keep the title in the lower third while leaving a safe margin
            # below Chinese glyph descenders in a 16:9 still.
            "camera_local_position": [0, 0.20, -5.2],
        },
        "terrain": {
            "size": 46,
            "resolution": 32,
            "height_scale": 3.4,
            "frequency": 0.06,
            "palette": [[0.04, 0.15, 0.16, 1], [0.08, 0.28, 0.25, 1], [0.18, 0.24, 0.20, 1]],
        },
        "water": {
            "points": [[-18, -7, 0.9], [-8, -3, 1.1], [3, -1, 1.0], [16, 5, 1.2]],
            "width": 4.2,
            "color": [accent[0] * 0.45, accent[1] * 0.85, accent[2] * 0.90, 0.82],
        },
        "camera": {
            "position": [30, -34, 24],
            "target": [0, 0, 2],
            "lens": 52,
        },
        "lighting": {
            "sun_energy": 2.5,
            "sun_angle_degrees": 22,
            "sun_rotation_degrees": [32, -28, -35],
            "fill_energy": 600,
            "world_color": [0.035, 0.06, 0.08, 1],
            "world_strength": 0.55,
        },
    }


def _tool_inputs(request: LocalToolRequest, *, input_path: Path | None, output_path: Path) -> dict[str, Any]:
    if request.operation == "bg_remove":
        return {
            "input_path": str(input_path),
            "output_path": str(output_path),
            "model": request.model,
            "bg_color": request.bg_color,
            "alpha_matting": request.alpha_matting,
        }
    if request.operation == "eye_enhance":
        return {
            "input_path": str(input_path),
            "output_path": str(output_path),
            "operations": request.operations,
            "dark_circle_intensity": request.dark_circle_intensity,
            "eye_brighten_intensity": request.eye_brighten_intensity,
            "sharpen_intensity": request.sharpen_intensity,
            "codec": "libx264",
            "crf": 18,
        }
    if request.operation in {"manim_title", "manim_flow"}:
        return {
            "scene_code": _manim_scene_code(request),
            "scene_name": "OpenMontageLocalTemplate",
            "quality": request.quality,
            "format": "mp4",
            "output_path": str(output_path),
            # Keep the endpoint's explicit dimensions and frame rate effective
            # while still using the selected quality preset as a safe default.
            "extra_args": [
                "--resolution", f"{request.width},{request.height}",
                "--fps", str(request.fps),
            ],
        }
    if request.operation == "blender_title":
        return {
            "operation": "render_still",
            "world_spec": _blender_world_spec(request),
            "output_path": str(output_path),
            "blend_path": str(output_path.with_suffix(".blend")),
            "width": request.width,
            "height": request.height,
            "samples": request.samples,
            "fps": request.fps,
            "frame": 1,
            # Intel macOS Metal initialization is not reliable on this host;
            # the fixed local template therefore defaults to Cycles CPU.
            "render_engine": "CYCLES",
            "cpu_render": request.cpu_render,
        }
    return {
        "operation": "render_existing",
        "workspace_path": str(input_path),
        "output_path": str(output_path),
        "quality": {"low": "draft", "medium": "standard", "high": "high"}[request.quality],
        "fps": request.fps,
        "strict_check": True,
        "snapshots": False,
    }


def _probe(path: Path) -> dict[str, Any]:
    result: dict[str, Any] = {"size_bytes": path.stat().st_size}
    if path.suffix.lower() in MEDIA_IMAGE_EXTENSIONS:
        try:
            from PIL import Image

            with Image.open(path) as image:
                result["width"], result["height"] = image.size
                result["format"] = image.format
        except Exception:
            pass
    elif path.suffix.lower() in MEDIA_VIDEO_EXTENSIONS | MEDIA_AUDIO_EXTENSIONS and shutil.which("ffprobe"):
        try:
            proc = subprocess.run(
                ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", str(path)],
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            if proc.returncode == 0:
                payload = json.loads(proc.stdout)
                fmt = payload.get("format", {})
                result["duration_seconds"] = float(fmt.get("duration", 0) or 0)
                for stream in payload.get("streams", []):
                    if stream.get("codec_type") == "video":
                        result.update({"width": stream.get("width"), "height": stream.get("height"), "codec": stream.get("codec_name")})
                        break
        except Exception:
            pass
    return result


def _artifact_record(project_dir: Path, path: Path) -> dict[str, Any] | None:
    try:
        resolved = path.resolve()
        resolved.relative_to(project_dir.resolve())
        if not resolved.is_file() or resolved.stat().st_size <= 0:
            return None
        return {
            "path": _relative(project_dir, resolved),
            "sha256": _sha256(resolved),
            "size_bytes": resolved.stat().st_size,
            "probe": _probe(resolved),
        }
    except (OSError, ValueError):
        return None


def execute_local_tool(
    request: LocalToolRequest | Mapping[str, Any],
    *,
    project_root: str | Path = DEFAULT_PROJECT_ROOT,
) -> dict[str, Any]:
    model = request if isinstance(request, LocalToolRequest) else LocalToolRequest.model_validate(request)
    if model.dry_run or not model.execute:
        return estimate_local_tool(model, project_root=project_root)
    if not model.confirm:
        return {
            "status": "confirmation_required",
            "operation": model.operation,
            "project_id": model.project_id,
            "requires_confirmation": True,
            "would_write": False,
            "error": "confirm=true is required before a local tool can write project artifacts",
        }

    try:
        project_dir = _resolve_project(project_root, model.project_id)
        input_path = _resolve_input(project_dir, model)
        _extension_for(model)
    except (ValueError, FileNotFoundError, OSError) as exc:
        return {
            "status": "invalid_request",
            "operation": model.operation,
            "project_id": model.project_id,
            "would_write": False,
            "error": _safe_error(exc),
        }

    snapshot = _tool_snapshot(model.operation)
    if snapshot["status"] not in {"available", "degraded"}:
        return {
            "status": "unavailable",
            "operation": model.operation,
            "project_id": model.project_id,
            "tool": snapshot,
            "would_write": False,
            "error": "本机依赖未满足，未写入任何产物。",
        }

    run_id = _run_id()
    output_path = _allocate_output(project_dir, model, run_id)
    tool = _LOCAL_TOOL_CLASSES[model.operation]()
    raw: Any = None
    ok = False
    data: dict[str, Any] = {}
    tool_artifacts: list[str] = []
    error: str | None = None
    try:
        raw = tool.execute(_tool_inputs(model, input_path=input_path, output_path=output_path))
        ok, data, tool_artifacts, error = _tool_result_parts(raw)
    except Exception as exc:  # defensive boundary around optional runtimes
        error = _safe_error(exc)

    records: list[dict[str, Any]] = []
    candidates = [Path(path) for path in tool_artifacts if isinstance(path, str)]
    candidates.append(output_path)
    # BlenderWorld also writes these deterministic sidecars next to its .blend.
    if model.operation == "blender_title":
        candidates.extend([output_path.with_suffix(".blend"), output_path.with_suffix(".world.json"), output_path.with_suffix(".report.json")])
    seen: set[str] = set()
    for candidate in candidates:
        try:
            key = str(candidate.resolve())
        except OSError:
            continue
        if key in seen:
            continue
        seen.add(key)
        record = _artifact_record(project_dir, candidate)
        if record:
            records.append(record)

    output_record = next((item for item in records if item["path"] == _relative(project_dir, output_path)), None)
    if ok and output_record is None:
        ok = False
        error = error or "工具返回成功，但约定输出文件不存在或为空；未报告为完成。"

    manifest_payload = {
        "schema_version": "1.0",
        "run_id": run_id,
        "project_id": model.project_id,
        "operation": model.operation,
        "tool": snapshot["tool"],
        "provider": snapshot["provider"],
        "status": "completed" if ok else "failed",
        "created_at": _utc_now(),
        "cost_cny": 0.0,
        "local": True,
        "input": {
            "path": _relative(project_dir, input_path) if input_path else None,
            "sha256": _sha256(input_path) if input_path and input_path.is_file() else None,
        },
        "artifacts": records,
        "tool_data": _safe_json(data),
        "error": _safe_error(error) if error else None,
    }
    try:
        manifest, manifest_hash = _write_manifest(project_dir, f"local_tools_{run_id}.json", manifest_payload)
    except Exception as exc:
        manifest = None
        manifest_hash = None
        if ok:
            ok = False
            error = f"本地工具已产生文件，但验收清单写入失败：{_safe_error(exc)}"

    if ok:
        emit_event(project_dir, {"event": "local_tool", "status": "completed", "operation": model.operation, "run_id": run_id})
        notify_project_changed(project_dir.name)
    else:
        emit_event(project_dir, {"event": "local_tool", "status": "failed", "operation": model.operation, "run_id": run_id, "error": _safe_error(error)})

    return {
        "status": "completed" if ok else "failed",
        "operation": model.operation,
        "project_id": model.project_id,
        "run_id": run_id,
        "tool": snapshot,
        "cost_cny": 0.0,
        "local": True,
        "output": output_record,
        "artifacts": records,
        "manifest": ({"path": _relative(project_dir, manifest), "sha256": manifest_hash} if manifest else None),
        "tool_data": _safe_json(data),
        "error": _safe_error(error) if error else None,
        "message": "本地工具已完成并通过文件、尺寸/时长与 SHA-256 检查。" if ok else "本地工具执行失败；请根据错误修复依赖或素材后重试。",
    }


def create_local_tools_app(*, project_root: str | Path = DEFAULT_PROJECT_ROOT) -> FastAPI:
    application = FastAPI(title="OpenMontage Local Tools API", version="0.1.0")
    application.state.project_root = Path(project_root)

    @application.get("/api/local-tools/capabilities")
    @application.get("/api/media/local-tools/capabilities")
    def capabilities() -> dict[str, Any]:
        return local_tool_capabilities()

    @application.post("/api/local-tools/estimate")
    @application.post("/api/media/local-tools/preflight")
    @application.post("/api/media/local-tools/estimate")
    def estimate(request: LocalToolRequest) -> dict[str, Any]:
        return estimate_local_tool(request, project_root=application.state.project_root)

    @application.post("/api/local-tools/execute")
    @application.post("/api/media/local-tools/execute")
    def execute(request: LocalToolRequest) -> dict[str, Any]:
        return execute_local_tool(request, project_root=application.state.project_root)

    return application


app = create_local_tools_app()


__all__ = [
    "LOCAL_OPERATIONS",
    "LocalToolRequest",
    "app",
    "create_local_tools_app",
    "estimate_local_tool",
    "execute_local_tool",
    "local_tool_capabilities",
]
