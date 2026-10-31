"""Image and video upscaling tool using Real-ESRGAN.

Takes low-resolution images or video and produces higher-resolution output
(2x or 4x). For video, frames are extracted via FFmpeg, upscaled individually,
and reassembled into the output file.
"""

from __future__ import annotations

import shutil
import json
import math
import uuid
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


VIDEO_EXTENSIONS = {".mp4", ".mov", ".avi", ".webm", ".mkv"}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}

MODELS = {
    "RealESRGAN_x4plus": {
        "description": "General-purpose photo/video upscaler (default)",
        "scale": 4,
    },
    "RealESRGAN_x4plus_anime_6B": {
        "description": "Optimised for anime/illustration content",
        "scale": 4,
    },
    "RealESRNet_x4plus": {
        "description": "PSNR-oriented RRDB network; same 23-block architecture",
        "scale": 4,
    },
    "realesr-general-x4v3": {"description": "Compact general network with genuine adjustable denoising", "scale": 4},
}


class Upscale(BaseTool):
    name = "upscale"
    version = "0.1.0"
    tier = ToolTier.ENHANCE
    capability = "enhancement"
    provider = "realesrgan"
    stability = ToolStability.EXPERIMENTAL
    execution_mode = ExecutionMode.SYNC
    determinism = Determinism.DETERMINISTIC
    runtime = ToolRuntime.LOCAL

    dependencies = ["cmd:ffmpeg", "cmd:ffprobe"]
    install_instructions = (
        "使用项目内 .runtime/montage-ml 与固定本机 Real-ESRGAN 权重。Intel Mac 使用 CPU，"
        "逐帧视频会较慢；可先测试短片。推理时不下载模型或覆盖原素材。"
    )
    agent_skills = ["ffmpeg"]

    capabilities = [
        "image_upscale",
        "video_upscale",
        "face_aware_upscale",
    ]

    input_schema = {
        "type": "object",
        "required": ["input_path"],
        "properties": {
            "input_path": {"type": "string"},
            "output_path": {"type": "string"},
            "scale": {
                "type": "integer",
                "enum": [2, 4],
                "default": 4,
            },
            "model": {
                "type": "string",
                "enum": list(MODELS.keys()),
                "default": "RealESRGAN_x4plus",
            },
            "face_enhance": {
                "type": "boolean",
                "default": False,
                "description": "Use GFPGAN for face regions",
            },
            "denoise_strength": {
                "type": "number",
                "minimum": 0.0,
                "maximum": 1.0,
                "default": 0.5,
                "description": "仅 realesr-general-x4v3 支持可调降噪（0–1）；其余模型使用自身固定降噪",
            },
            "tile_size": {"type": "integer", "minimum": 16, "maximum": 512, "default": 128,
                "description": "分块推理边长；小块节省内存。Intel CPU 建议 128"},
            "max_video_frames": {"type": "integer", "minimum": 1, "maximum": 1000, "default": 300,
                "description": "视频处理帧数上限；超过时停止并提示分段，不截断后冒充完整视频"},
        },
    }

    resource_profile = ResourceProfile(cpu_cores=2, ram_mb=4096, vram_mb=2048, disk_mb=2000)
    idempotency_key_fields = ["input_path", "scale", "model", "face_enhance", "denoise_strength"]
    side_effects = ["writes upscaled file to output_path"]
    user_visible_verification = [
        "Compare upscaled output with original for detail and artifact quality",
        "Verify faces look natural if face_enhance was enabled",
    ]

    # ------------------------------------------------------------------
    # Status
    # ------------------------------------------------------------------

    def get_status(self) -> ToolStatus:
        from tools.enhancement._local_models import requirements
        if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
            return ToolStatus.UNAVAILABLE
        return ToolStatus.AVAILABLE if any(not requirements(name) for name in MODELS) else ToolStatus.UNAVAILABLE

    def input_requirements(self, inputs: dict[str, Any]) -> list[str]:
        from tools.enhancement._local_models import requirements
        missing = requirements(inputs.get('model', 'RealESRGAN_x4plus'))
        if inputs.get('face_enhance'):
            missing.extend(requirements('GFPGAN'))
        return list(dict.fromkeys(missing))

    # ------------------------------------------------------------------
    # Execution
    # ------------------------------------------------------------------

    def execute(self, inputs: dict[str, Any]) -> ToolResult:
        input_path = Path(inputs["input_path"])
        if not input_path.exists():
            return ToolResult(success=False, error=f"Input not found: {input_path}")
        if input_path.suffix.lower() not in VIDEO_EXTENSIONS | IMAGE_EXTENSIONS:
            return ToolResult(success=False, error="请提供支持的图片或视频；不把未知文件当作画面处理")

        is_video = input_path.suffix.lower() in VIDEO_EXTENSIONS

        default_output = str(input_path.with_stem(f"{input_path.stem}_upscaled").with_suffix(".mp4" if is_video else input_path.suffix))
        output_path = Path(inputs.get("output_path", default_output))
        if output_path.exists() or output_path.resolve() == input_path.resolve():
            return ToolResult(success=False, error="输出已存在或与原素材相同；请使用新的输出路径")
        allowed_output = {'.mp4'} if is_video else IMAGE_EXTENSIONS
        if output_path.suffix.lower() not in allowed_output:
            return ToolResult(success=False, error="视频输出请使用 MP4，图片输出请使用图片扩展名")
        for key, low, high, default in [('tile_size', 16, 512, 128), ('max_video_frames', 1, 1000, 300)]:
            value = inputs.get(key, default)
            if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
                return ToolResult(success=False, error=f"{key} 超出支持范围")
        if inputs.get('scale', 4) not in (2, 4) or isinstance(inputs.get('scale'), bool):
            return ToolResult(success=False, error="scale 只能是 2 或 4")
        denoise = inputs.get('denoise_strength', .5)
        if isinstance(denoise, bool) or not isinstance(denoise, (int, float)) or not math.isfinite(denoise) or not 0 <= denoise <= 1:
            return ToolResult(success=False, error="denoise_strength 必须在 0 到 1 之间")
        missing = self.input_requirements(inputs)
        if missing:
            return ToolResult(success=False, error='；'.join(missing))
        from tools import local_ml_runtime
        if local_ml_runtime.needs_bridge():
            return local_ml_runtime.execute(self.name, inputs)
        output_path.parent.mkdir(parents=True, exist_ok=True)

        scale = inputs.get("scale", 4)
        model_name = inputs.get("model", "RealESRGAN_x4plus")
        face_enhance = inputs.get("face_enhance", False)
        denoise_strength = inputs.get("denoise_strength", 0.5)

        start = time.time()

        try:
            if is_video:
                result = self._upscale_video(
                    input_path, output_path, scale, model_name,
                    face_enhance, denoise_strength,
                    inputs.get('tile_size', 128), inputs.get('max_video_frames', 300),
                )
            else:
                result = self._upscale_image(
                    input_path, output_path, scale, model_name,
                    face_enhance, denoise_strength,
                    inputs.get('tile_size', 128),
                )
        except Exception as e:
            return ToolResult(success=False, error=f"Upscale failed: {e}")

        elapsed = time.time() - start

        return ToolResult(
            success=True,
            data={
                "input": str(input_path),
                "output": str(output_path),
                "scale": scale,
                "model": model_name,
                "face_enhance": face_enhance,
                "denoise_strength_applied": denoise_strength if model_name == 'realesr-general-x4v3' else None,
                "device": self._device_name(), "offline": True,
                "limitations": ["神经网络放大可能产生细节幻觉；不能把补出的纹理用作史实证据。"],
                "type": "video" if is_video else "image",
                **result,
            },
            artifacts=[str(output_path)],
            duration_seconds=round(elapsed, 2),
        )

    # ------------------------------------------------------------------
    # Image upscaling
    # ------------------------------------------------------------------

    def _upscale_image(
        self,
        input_path: Path,
        output_path: Path,
        scale: int,
        model_name: str,
        face_enhance: bool,
        denoise_strength: float,
        tile_size: int = 128,
    ) -> dict[str, Any]:
        import cv2

        img = cv2.imread(str(input_path), cv2.IMREAD_UNCHANGED)
        if img is None:
            raise ValueError(f"Could not read image: {input_path}")
        if img.shape[0] * img.shape[1] > 2_100_000:
            raise ValueError('本机单次输入上限为约 210 万像素，请先缩小或裁剪；不会静默缩小原图')
        upsampler = self._build_upsampler(scale, model_name, denoise_strength, face_enhance, tile_size)

        output, faces = upsampler.enhance(img, outscale=scale)
        if not cv2.imwrite(str(output_path), output):
            raise ValueError('Failed to write upscaled image')

        h, w = output.shape[:2]
        return {"output_width": w, "output_height": h, "faces_restored": faces if face_enhance else None}

    # ------------------------------------------------------------------
    # Video upscaling
    # ------------------------------------------------------------------

    def _upscale_video(
        self,
        input_path: Path,
        output_path: Path,
        scale: int,
        model_name: str,
        face_enhance: bool,
        denoise_strength: float,
        tile_size: int = 128,
        max_frames: int = 300,
    ) -> dict[str, Any]:
        import cv2

        # Get source frame rate
        fps = self._get_video_fps(input_path)
        probe = json.loads(self.run_command(['ffprobe', '-v', 'error', '-show_streams', '-show_format',
            '-of', 'json', str(input_path)]).stdout)
        stream = next(s for s in probe['streams'] if s.get('codec_type') == 'video')
        duration = float(stream.get('duration') or probe.get('format', {}).get('duration', 0))
        if not math.isfinite(duration) or duration <= 0 or duration * fps > max_frames + 1:
            raise ValueError(f'视频超过本次 {max_frames} 帧上限或时长无效，请分段后再放大')
        if int(stream['width']) * int(stream['height']) > 2_100_000:
            raise ValueError('本机单帧输入上限约 210 万像素，请先缩小或裁剪')
        upsampler = self._build_upsampler(scale, model_name, denoise_strength, face_enhance, tile_size)
        tmpdir = output_path.parent / (output_path.stem + '-frames-' + uuid.uuid4().hex[:8])
        tmpdir.mkdir(exist_ok=False)
        # Keep intermediate frames for inspection/resume; do not remove user data.
        frames_dir = Path(tmpdir) / "frames"
        upscaled_dir = Path(tmpdir) / "upscaled"
        frames_dir.mkdir()
        upscaled_dir.mkdir()

        # Extract frames
        self.run_command([
            "ffmpeg", "-n", "-v", "error",
            "-i", str(input_path),
            '-vf', f'fps={fps}',
            str(frames_dir / "frame_%06d.png"),
        ])

        # Upscale each frame
        frame_files = sorted(frames_dir.glob("*.png"))
        total_frames = len(frame_files)
        if not 1 <= total_frames <= max_frames:
            raise ValueError('解码帧数超出上限或未解出画面，中间文件已保留')

        face_count = 0
        for frame_file in frame_files:
            img = cv2.imread(str(frame_file), cv2.IMREAD_UNCHANGED)
            if img is None: raise ValueError('Could not decode source frame')
            output, faces = upsampler.enhance(img, outscale=scale)
            if face_enhance: face_count += faces
            if not cv2.imwrite(str(upscaled_dir / frame_file.name), output):
                raise ValueError('Could not write upscaled frame')

        # Reassemble as browser-playable H.264/AAC, preserving the original source
        reassemble_cmd = [
            "ffmpeg", "-n", "-v", "error",
            "-framerate", str(fps),
            "-i", str(upscaled_dir / "frame_%06d.png"),
            "-i", str(input_path),
            "-map", "0:v",
            "-map", "1:a?",
            "-c:v", "libx264", "-crf", "18",
            "-c:a", "aac", "-b:a", "192k",
            "-pix_fmt", "yuv420p",
            '-movflags', '+faststart',
            str(output_path),
        ]
        self.run_command(reassemble_cmd)

        return {"total_frames": total_frames, "fps": fps, "intermediate_dir": str(tmpdir),
                "output_width": int(stream['width']) * scale, "output_height": int(stream['height']) * scale,
                "source_duration_seconds": duration, "face_restoration_count": face_count if face_enhance else None, "timing": "constant_frame_rate_from_source_average"}

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _build_upsampler(
        self,
        scale: int,
        model_name: str,
        denoise_strength: float,
        face_enhance: bool,
        tile_size: int = 128,
    ):
        """Build and return a RealESRGANer instance."""
        from tools.enhancement._local_models import FaceRestorer, build_upsampler
        upsampler = build_upsampler(model_name, denoise=denoise_strength, tile=tile_size)

        if face_enhance:
            face_enhancer = FaceRestorer('GFPGAN', upscale=scale, background=upsampler)
            class FaceAware:
                def enhance(self, img, outscale=scale):
                    restored, count = face_enhancer.enhance(img, require_faces=False)
                    return restored, count
            return FaceAware()

        return upsampler

    @staticmethod
    def _device_name():
        from tools.video._shared import get_torch_device
        return get_torch_device()

    def _get_video_fps(self, video_path: Path) -> float:
        """Extract frame rate from video using ffprobe."""
        import json

        proc = self.run_command([
                "ffprobe", "-v", "quiet",
                "-print_format", "json",
                "-show_streams",
                str(video_path),
            ])
        probe = json.loads(proc.stdout)
        for stream in probe.get("streams", []):
            if stream.get("codec_type") == "video":
                rate = stream.get('avg_frame_rate') or stream.get('r_frame_rate')
                num, den = rate.split('/')
                fps = int(num) / int(den)
                if math.isfinite(fps) and 0 < fps <= 240: return fps
        raise ValueError('无法读取视频帧率；不会用猜测的帧率编码')
