"""Deterministic Blender assembly and rendering for production 3D worlds."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

from tools.base_tool import (
    BaseTool,
    Determinism,
    ExecutionMode,
    ResourceProfile,
    ToolResult,
    ToolRuntime,
    ToolStability,
    ToolStatus,
    ToolTier,
)


_REPO_ROOT = Path(__file__).resolve().parents[2]
_PORTABLE_BLENDER = (
    _REPO_ROOT / ".runtime" / "blender" / "blender-4.5.10-windows-x64" / "blender.exe"
)
_RUNTIME_SCRIPT = Path(__file__).resolve().parent / "templates" / "blender-world-runtime.py"


def find_blender() -> Path | None:
    configured = os.environ.get("BLENDER_PATH")
    if configured and Path(configured).is_file():
        return Path(configured).resolve()
    if _PORTABLE_BLENDER.is_file():
        return _PORTABLE_BLENDER.resolve()
    discovered = shutil.which("blender")
    return Path(discovered).resolve() if discovered else None


def first_missing_frame(output_prefix: str | Path, start_frame: int, end_frame: int) -> int | None:
    """Return the first missing PNG in a contiguous Blender image sequence."""
    prefix = Path(output_prefix).expanduser().resolve()
    for frame in range(start_frame, end_frame + 1):
        candidate = prefix.parent / f"{prefix.name}{frame:04d}.png"
        if not candidate.is_file():
            return frame
    return None


class BlenderWorld(BaseTool):
    name = "blender_world"
    version = "0.3.0"
    tier = ToolTier.GENERATE
    capability = "3d_world_rendering"
    provider = "blender"
    stability = ToolStability.BETA
    execution_mode = ExecutionMode.SYNC
    determinism = Determinism.SEEDED
    runtime = ToolRuntime.LOCAL_GPU
    dependencies: list[str] = []
    install_instructions = (
        "Install Blender 4.5 LTS, set BLENDER_PATH, or place the portable runtime at "
        ".runtime/blender/blender-4.5.10-windows-x64/blender.exe."
    )
    agent_skills = [
        "3d-asset-generation", "threejs-world-generation", "threejs-loaders", "threejs-materials",
        "threejs-textures", "threejs-lighting", "threejs-postprocessing",
    ]
    capabilities = [
        "gltf_glb_scene_assembly", "procedural_terrain", "linked_asset_scatter",
        "pbr_materials", "eevee_next_render", "camera_flythrough", "blend_project_export",
        "asset_unit_normalization", "bounding_box_ground_contact", "semantic_scatter_exclusions",
        "terrain_following_ribbons", "visibility_windows", "title_safe_final_hold",
    ]
    supports = {
        "glb": True,
        "gltf": True,
        "pbr": True,
        "linked_instances": True,
        "still": True,
        "animation": True,
        "transparent_background": True,
    }
    best_for = [
        "Production-quality world assembly from many generated and licensed assets",
        "Dense terrain, lighting, material, camera, and contact-shadow work",
        "Rendering a final image sequence for governed video composition",
    ]
    not_good_for = ["Interactive browser delivery", "Text-to-mesh generation"]
    input_schema = {
        "type": "object",
        "required": ["operation"],
        "properties": {
            "operation": {"type": "string", "enum": ["doctor", "build", "render_still", "render_animation"]},
            "world_spec": {"type": "object"},
            "output_path": {"type": "string"},
            "blend_path": {"type": "string"},
            "width": {"type": "integer", "minimum": 320, "maximum": 7680, "default": 1920},
            "height": {"type": "integer", "minimum": 240, "maximum": 4320, "default": 1080},
            "samples": {"type": "integer", "minimum": 1, "maximum": 256, "default": 32},
            "render_engine": {
                "type": "string",
                "enum": ["BLENDER_EEVEE_NEXT", "CYCLES", "BLENDER_WORKBENCH"],
                "default": "BLENDER_EEVEE_NEXT",
                "description": "Render engine. Use CYCLES with cpu_render on Macs whose Metal driver cannot initialize.",
            },
            "cpu_render": {
                "type": "boolean",
                "default": False,
                "description": "Force Cycles to use CPU; avoids relying on a compatible GPU backend.",
            },
            "fps": {"type": "integer", "minimum": 1, "maximum": 120, "default": 30},
            "duration_seconds": {"type": "number", "minimum": 1, "maximum": 600, "default": 60},
            "start_frame": {"type": "integer", "minimum": 1},
            "end_frame": {"type": "integer", "minimum": 1},
            "frame": {"type": "integer", "minimum": 1},
            "resume": {"type": "boolean", "default": False},
        },
    }
    output_schema = {"type": "object"}
    artifact_schema = {"artifact": "3d_world"}
    resource_profile = ResourceProfile(cpu_cores=8, ram_mb=8192, vram_mb=6000, disk_mb=20000)
    idempotency_key_fields = ["operation", "world_spec", "width", "height", "samples", "fps", "duration_seconds"]
    side_effects = ["writes a .blend project", "may render an image or PNG sequence"]
    user_visible_verification = [
        "Review global, regional, and walk-height stills before an animation render",
        "Check imported mesh scale, ground contact, texture color space, shadowing, and camera clearance",
    ]
    quality_score = 0.94

    def get_status(self) -> ToolStatus:
        return ToolStatus.AVAILABLE if find_blender() and _RUNTIME_SCRIPT.is_file() else ToolStatus.UNAVAILABLE

    def estimate_runtime(self, inputs: dict[str, Any]) -> float:
        if inputs.get("operation") == "render_animation":
            return float(inputs.get("duration_seconds", 60)) * float(inputs.get("fps", 30)) * 2.0
        return 30.0

    def execute(self, inputs: dict[str, Any]) -> ToolResult:
        blender = find_blender()
        if not blender:
            return ToolResult(success=False, error="Blender not found. " + self.install_instructions)
        operation = str(inputs.get("operation") or "")
        if operation == "doctor":
            process = subprocess.run(
                [str(blender), "--background", "--python-expr", "import bpy; print('OPENMONTAGE_BLENDER=' + bpy.app.version_string)"],
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60,
            )
            ok = process.returncode == 0 and "OPENMONTAGE_BLENDER=" in process.stdout
            return ToolResult(
                success=ok,
                data={"blender_path": str(blender), "version_line": next((line for line in process.stdout.splitlines() if line.startswith("OPENMONTAGE_BLENDER=")), "")},
                error=None if ok else (process.stderr or process.stdout)[-1000:],
                model="blender-4.5-lts",
            )

        if operation not in {"build", "render_still", "render_animation"}:
            return ToolResult(success=False, error=f"Unknown operation: {operation}")
        if not isinstance(inputs.get("world_spec"), dict):
            return ToolResult(success=False, error="world_spec is required")
        output_raw = inputs.get("output_path")
        if operation != "build" and not output_raw:
            return ToolResult(success=False, error="output_path is required for rendering")
        blend_raw = inputs.get("blend_path") or (
            str(Path(str(output_raw)).with_suffix(".blend")) if output_raw else "blender-world.blend"
        )
        blend_path = Path(str(blend_raw)).expanduser().resolve()
        blend_path.parent.mkdir(parents=True, exist_ok=True)
        spec_path = blend_path.with_suffix(".world.json")
        spec_path.write_text(json.dumps(inputs["world_spec"], indent=2), encoding="utf-8")
        # Native animation output is a PNG prefix. An explicit .mp4 request
        # renders the same sequence, then encodes it with the installed FFmpeg.
        video_output = None
        render_output = output_raw
        if operation == "render_animation" and output_raw and Path(str(output_raw)).suffix.lower() == ".mp4":
            video_output = Path(str(output_raw)).expanduser().resolve()
            frame_directory = video_output.parent / (video_output.stem + "-frames")
            frame_directory.mkdir(parents=True, exist_ok=True)
            render_output = str(frame_directory / "frame-")

        command = [
            str(blender), "--background", "--python-exit-code", "1", "--python", str(_RUNTIME_SCRIPT), "--",
            "--operation", operation,
            "--spec", str(spec_path),
            "--blend", str(blend_path),
            "--width", str(int(inputs.get("width", 1920))),
            "--height", str(int(inputs.get("height", 1080))),
            "--samples", str(int(inputs.get("samples", 32))),
            "--fps", str(int(inputs.get("fps", 30))),
            "--duration", str(float(inputs.get("duration_seconds", 60))),
        ]
        render_engine = str(inputs.get("render_engine") or "BLENDER_EEVEE_NEXT").upper()
        if render_engine not in {"BLENDER_EEVEE_NEXT", "CYCLES", "BLENDER_WORKBENCH"}:
            return ToolResult(success=False, error=f"Unsupported Blender render engine: {render_engine}")
        command.extend(["--engine", render_engine])
        if inputs.get("cpu_render"):
            command.append("--cpu-render")
        requested_start = int(inputs.get("start_frame", 1))
        requested_end = int(inputs.get("end_frame") or round(
            float(inputs.get("duration_seconds", 60)) * int(inputs.get("fps", 30))
        ))
        effective_start = requested_start
        if operation == "render_animation" and inputs.get("resume"):
            if not output_raw:
                return ToolResult(success=False, error="output_path is required to resume a render")
            missing = first_missing_frame(render_output, requested_start, requested_end)
            if missing is None and (not video_output or video_output.is_file()):
                return ToolResult(
                    success=True,
                    data={
                        "blender_path": str(blender),
                        "blend_path": str(blend_path),
                        "output": str(output_raw),
                        "already_complete": True,
                        "start_frame": requested_start,
                        "end_frame": requested_end,
                    },
                    model=f"blender-4.5-lts-{render_engine.lower()}",
                )
            effective_start = missing if missing is not None else requested_start
        if inputs.get("start_frame") is not None or operation == "render_animation":
            command.extend(["--start-frame", str(effective_start)])
        if inputs.get("end_frame") is not None or operation == "render_animation":
            command.extend(["--end-frame", str(requested_end)])
        if inputs.get("frame") is not None:
            command.extend(["--frame", str(int(inputs["frame"]))])
        if output_raw:
            command.extend(["--output", str(Path(str(render_output)).expanduser().resolve())])

        started = time.time()
        try:
            process = subprocess.run(
                command, capture_output=True, text=True, encoding="utf-8", errors="replace",
                timeout=max(120, int(self.estimate_runtime(inputs) * 2.5)),
            )
        except Exception as exc:
            return ToolResult(success=False, error=f"Blender invocation failed: {exc}")
        if process.returncode != 0 or "OPENMONTAGE_WORLD_REPORT=" not in process.stdout:
            return ToolResult(success=False, error="Blender world build failed: " + (process.stderr or process.stdout)[-3000:])

        report_path = blend_path.with_suffix(".report.json")
        if not blend_path.is_file() or not blend_path.stat().st_size or not report_path.is_file():
            return ToolResult(success=False, error="Blender returned without the actual .blend project and render report")
        if operation == "render_animation":
            missing = first_missing_frame(render_output, requested_start, requested_end)
            if missing is not None:
                return ToolResult(success=False, error=f"Blender did not render requested frame {missing}; existing files preserved")
            if video_output:
                ffmpeg = shutil.which("ffmpeg")
                if not ffmpeg:
                    return ToolResult(success=False, error="FFmpeg is required for MP4 encoding; rendered PNG frames preserved")
                try:
                    encoded = subprocess.run([ffmpeg, "-n", "-hide_banner", "-loglevel", "error",
                        "-framerate", str(int(inputs.get("fps", 30))), "-start_number", str(requested_start),
                        "-i", str(render_output) + "%04d.png", "-frames:v", str(requested_end - requested_start + 1),
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(video_output)],
                        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
                except Exception as exc:
                    return ToolResult(success=False, error=f"Blender frames rendered, but MP4 encoding failed: {exc}")
                if encoded.returncode or not video_output.is_file() or not video_output.stat().st_size:
                    return ToolResult(success=False, error="Blender frames rendered, but MP4 encoding failed: " + encoded.stderr[-2000:])
        elif operation == "render_still" and (not Path(str(output_raw)).is_file() or not Path(str(output_raw)).stat().st_size):
            return ToolResult(success=False, error="Blender did not create the requested still image; existing files preserved")

        artifacts = [str(spec_path), str(blend_path)]
        if output_raw:
            output = Path(str(output_raw)).expanduser().resolve()
            if output.exists():
                artifacts.append(str(output))
        if report_path.exists():
            artifacts.append(str(report_path))
        return ToolResult(
            success=True,
            data={
                "blender_path": str(blender),
                "blend_path": str(blend_path),
                "output": str(output_raw or ""),
                "frame_prefix": str(render_output) if operation == "render_animation" else None,
                "report": str(report_path),
                "start_frame": effective_start if operation == "render_animation" else None,
                "end_frame": requested_end if operation == "render_animation" else None,
                "resumed": bool(operation == "render_animation" and inputs.get("resume") and effective_start > requested_start),
            },
            artifacts=artifacts,
            duration_seconds=round(time.time() - started, 2),
            seed=inputs["world_spec"].get("seed"),
            model=f"blender-4.5-lts-{render_engine.lower()}",
        )
