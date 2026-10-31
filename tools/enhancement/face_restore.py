"""Face restoration tool wrapping CodeFormer / GFPGAN.

Restores degraded or low-quality faces in images and video frames.
Fixes blur, compression artifacts, and low resolution specifically on
face regions while preserving the rest of the image.
"""

from __future__ import annotations

import time
import math
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


class FaceRestore(BaseTool):
    name = "face_restore"
    version = "0.1.0"
    tier = ToolTier.ENHANCE
    capability = "enhancement"
    provider = "local_restoration"
    stability = ToolStability.EXPERIMENTAL
    execution_mode = ExecutionMode.SYNC
    determinism = Determinism.DETERMINISTIC
    runtime = ToolRuntime.LOCAL

    dependencies = []
    install_instructions = (
        "使用项目内固定的 GFPGAN / CodeFormer、检测与解析权重，以及 .runtime/montage-ml。"
        "Intel Mac 使用 CPU，不上传人像；CodeFormer 仅按 S-Lab 非商业许可使用。"
    )
    agent_skills = ["ffmpeg"]
    fallback = None

    capabilities = [
        "face_restoration",
        "face_detection",
        "quality_enhancement",
    ]

    input_schema = {
        "type": "object",
        "required": ["input_path"],
        "properties": {
            "input_path": {
                "type": "string",
                "description": "Path to image or video frame",
            },
            "output_path": {
                "type": "string",
                "description": "Output path (defaults to {stem}_restored.{ext})",
            },
            "model": {
                "type": "string",
                "enum": ["CodeFormer", "GFPGAN"],
                "default": "GFPGAN",
                "description": "GFPGAN 为 Apache 2.0；CodeFormer 为 S-Lab 非商业许可，不能混用或静默替换",
            },
            "fidelity": {
                "type": "number",
                "default": 0.5, "minimum": 0, "maximum": 1,
                "description": (
                    "0 = max quality, 1 = max fidelity to input (CodeFormer only)"
                ),
            },
            "upscale": {
                "type": "integer",
                "default": 2, "enum": [1, 2, 4],
                "description": "Face upscale factor",
            },
            "bg_upsampler": {
                "type": "boolean",
                "default": False,
                "description": "Also upscale background with Real-ESRGAN",
            },
        },
    }

    resource_profile = ResourceProfile(
        cpu_cores=2, ram_mb=2048, vram_mb=2048, disk_mb=1000
    )
    idempotency_key_fields = ["input_path", "model", "fidelity", "upscale"]
    side_effects = ["writes restored image to output_path"]
    user_visible_verification = [
        "Compare restored face with original for natural appearance",
        "Verify face identity is preserved after restoration",
    ]

    def get_status(self) -> ToolStatus:
        from tools.enhancement._local_models import requirements
        return ToolStatus.AVAILABLE if not requirements('GFPGAN') else ToolStatus.UNAVAILABLE

    def input_requirements(self, inputs: dict[str, Any]) -> list[str]:
        from tools.enhancement._local_models import requirements
        missing = requirements(inputs.get('model', 'GFPGAN'))
        if inputs.get('bg_upsampler'):
            missing.extend(requirements('RealESRGAN_x4plus'))
        return list(dict.fromkeys(missing))

    def execute(self, inputs: dict[str, Any]) -> ToolResult:
        from tools.enhancement.upscale import IMAGE_EXTENSIONS
        input_path = Path(inputs['input_path'])
        output_path = Path(inputs.get('output_path', str(input_path.with_stem(input_path.stem + '_restored'))))
        if not input_path.is_file() or input_path.suffix.lower() not in IMAGE_EXTENSIONS:
            return ToolResult(success=False, error='请提供有效的人像图片；视频请先抽帧，不把视频当图片修复')
        if output_path.exists() or output_path.resolve() == input_path.resolve():
            return ToolResult(success=False, error='输出已存在或与原图相同，请指定新的输出路径')
        if output_path.suffix.lower() not in IMAGE_EXTENSIONS:
            return ToolResult(success=False, error='修复输出必须使用图片扩展名')
        fidelity, upscale = inputs.get('fidelity', .5), inputs.get('upscale', 2)
        if isinstance(fidelity, bool) or not isinstance(fidelity, (float, int)) or not math.isfinite(fidelity) or not 0 <= fidelity <= 1:
            return ToolResult(success=False, error='fidelity 必须在 0 到 1 之间')
        if isinstance(upscale, bool) or upscale not in (1, 2, 4):
            return ToolResult(success=False, error='upscale 必须为 1、2 或 4')
        missing = self.input_requirements(inputs)
        if missing:
            return ToolResult(success=False, error='；'.join(missing))
        from tools import local_ml_runtime
        if local_ml_runtime.needs_bridge():
            return local_ml_runtime.execute(self.name, inputs)
        start = time.monotonic()
        try:
            import cv2
            from tools.enhancement._local_models import FaceRestorer, build_upsampler
            from tools.video._shared import get_torch_device
            image = cv2.imread(str(input_path), cv2.IMREAD_COLOR)
            if image is None:
                raise ValueError('无法解码人像图片')
            if image.shape[0] * image.shape[1] > 2_100_000:
                raise ValueError('本机单次输入上限约 210 万像素，请先缩小或裁剪')
            background = build_upsampler('RealESRGAN_x4plus') if inputs.get('bg_upsampler') else None
            name = inputs.get('model', 'GFPGAN')
            restorer = FaceRestorer(name, upscale=upscale, fidelity=fidelity, background=background)
            output, count = restorer.enhance(image)
            if output is None or count < 1:
                raise ValueError('没有完成人脸修复；不把原图副本当作成功')
            output_path.parent.mkdir(parents=True, exist_ok=True)
            if not cv2.imwrite(str(output_path), output):
                raise ValueError('修复图片未写入成功')
            return ToolResult(success=True, data={
                'input': str(input_path), 'output': str(output_path), 'model': name,
                'faces_detected': count, 'faces_restored': count, 'restoration_applied': True,
                'upscale': upscale, 'fidelity': fidelity if name == 'CodeFormer' else None,
                'bg_upsampler': bool(inputs.get('bg_upsampler')), 'offline': True,
                'device': get_torch_device(), 'output_width': output.shape[1], 'output_height': output.shape[0],
                'license': 'S-Lab non-commercial' if name == 'CodeFormer' else 'Apache-2.0',
                'limitations': ['修复可能改变人物细节；请对照原片确认身份和自然度。'],
            }, artifacts=[str(output_path)], duration_seconds=round(time.monotonic() - start, 2))
        except Exception as exc:
            return ToolResult(success=False, error=f'本机人脸修复未完成：{exc}')
