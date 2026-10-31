"""Music generation tool via ElevenLabs Music API.

Generates background music and sound effects for video production.
Reports unavailable when no API key is configured.
"""

from __future__ import annotations

import os
import math
import time
from pathlib import Path
from typing import Any

from tools.base_tool import (
    BaseTool,
    Determinism,
    ExecutionMode,
    ResourceProfile,
    RetryPolicy,
    ToolResult,
    ToolRuntime,
    ToolStability,
    ToolStatus,
    ToolTier,
)


class MusicGen(BaseTool):
    name = "music_gen"
    version = "0.1.0"
    tier = ToolTier.GENERATE
    capability = "music_generation"
    provider = "elevenlabs"
    stability = ToolStability.EXPERIMENTAL
    execution_mode = ExecutionMode.SYNC
    determinism = Determinism.STOCHASTIC
    runtime = ToolRuntime.API

    # Keep the credential as a declared dependency as well as a runtime
    # check.  The registry and the workbench can therefore explain why this
    # provider is unavailable without ever exposing the key itself.
    dependencies = ["env:ELEVENLABS_API_KEY"]
    install_instructions = (
        "Set the ELEVENLABS_API_KEY environment variable:\n"
        "  export ELEVENLABS_API_KEY=your_key_here\n"
        "Get a key at https://elevenlabs.io"
    )

    agent_skills = ["music", "sound-effects", "elevenlabs"]

    capabilities = [
        "generate_background_music",
        "generate_sfx",
    ]

    supports = {
        "instrumental": True,
        "style_control": True,
        "exact_duration": True,
        # The direct ElevenLabs Music endpoint accepts a text prompt.  A
        # local reference video is analysed by the workbench into a cue sheet
        # and then described in that prompt; the video bytes are not uploaded
        # to ElevenLabs by this provider.
        "video_reference_textualized": True,
    }
    best_for = [
        "后置生成与成片节奏匹配的器乐 BGM",
        "按情绪、配器、速度和段落提示控制音乐风格",
        "与旁白混音前的精确时长音乐",
    ]
    not_good_for = [
        "没有 ELEVENLABS_API_KEY 时的离线生成",
        "直接把视频文件上传给 ElevenLabs 做视觉条件控制",
    ]

    input_schema = {
        "type": "object",
        "required": ["prompt"],
        "properties": {
            "prompt": {
                "type": "string",
                "maxLength": 4100,
                "description": "Music description (mood, genre, instruments, tempo)",
            },
            "duration_seconds": {
                "type": "number",
                "minimum": 3,
                "maximum": 600,
                "description": (
                    "Target duration in seconds (API supports 3-600s). "
                    "Should match the target video duration from the script/proposal. "
                    "Omitting this defaults to 60s which may not match your video."
                ),
            },
            "output_path": {"type": "string"},
            "model_id": {"type": "string", "enum": ["music_v1", "music_v2", "music_v2_5"], "default": "music_v1"},
            "force_instrumental": {
                "type": "boolean",
                "default": True,
                "description": (
                    "Whether to generate instrumental-only music (no vocals). "
                    "Defaults to True — the music-gen-usage mandate is to always "
                    "set force_instrumental=true for video background music, since "
                    "vocals collide with narration/dialogue. Set False only for "
                    "explicitly vocal-led pieces."
                ),
            },
        },
    }

    resource_profile = ResourceProfile(
        cpu_cores=1, ram_mb=256, vram_mb=0, disk_mb=50, network_required=True
    )
    retry_policy = RetryPolicy(max_retries=2, retryable_errors=["rate_limit", "timeout"])
    idempotency_key_fields = ["prompt", "duration_seconds", "model_id"]
    side_effects = ["writes audio file to output_path", "calls ElevenLabs API"]
    user_visible_verification = [
        "Listen to generated music for mood and quality",
    ]

    def get_status(self) -> ToolStatus:
        if os.environ.get("ELEVENLABS_API_KEY"):
            return ToolStatus.AVAILABLE
        return ToolStatus.UNAVAILABLE

    def estimate_cost(self, inputs: dict[str, Any]) -> float:
        # ElevenLabs music generation pricing is per generation
        duration = inputs.get("duration_seconds")
        if duration is None:
            raise ValueError(
                "music_gen.estimate_cost: duration_seconds is required. "
                "Derive it from the approved target runtime in the script/proposal. "
                "Silent defaults are not permitted."
            )
        # Approximate: ~$0.05 per 30 seconds
        return round(duration / 30 * 0.05, 4)

    def execute(self, inputs: dict[str, Any]) -> ToolResult:
        api_key = os.environ.get("ELEVENLABS_API_KEY")
        if not api_key:
            return ToolResult(
                success=False,
                error="No ElevenLabs API key. " + self.install_instructions,
            )

        start = time.time()

        try:
            result = self._generate(inputs, api_key)
        except Exception as e:
            # Never let an HTTP client include request headers or a key in a
            # user-visible error.  This is deliberately conservative because
            # third-party exception strings vary by SDK/version.
            message = str(e)
            if api_key:
                message = message.replace(api_key, "[REDACTED_API_KEY]")
            return ToolResult(success=False, error=f"Music generation failed: {message[:500]}")

        result.duration_seconds = round(time.time() - start, 2)
        if not result.success:
            return result
        result.cost_usd = self.estimate_cost(inputs)
        return result

    def _generate(self, inputs: dict[str, Any], api_key: str) -> ToolResult:
        import logging
        import requests

        logger = logging.getLogger(__name__)

        prompt = inputs["prompt"]
        duration = inputs.get("duration_seconds")
        if duration is None:
            return ToolResult(
                success=False,
                error=(
                    "music_gen: duration_seconds is required. "
                    "Derive it from the approved target runtime in the script/proposal. "
                    "Silent defaults to 60s are not permitted — the generated music "
                    "must match the actual video duration."
                ),
            )
        model_id = inputs.get("model_id", "music_v1")
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 4100:
            return ToolResult(success=False, error="music_gen: prompt must contain 1—4100 characters")
        if isinstance(duration, bool) or not isinstance(duration, (float, int)) or not math.isfinite(duration) or not 3 <= duration <= 600:
            return ToolResult(success=False, error="music_gen: duration_seconds must be finite and between 3 and 600")
        if model_id not in {"music_v1", "music_v2", "music_v2_5"}:
            return ToolResult(success=False, error="music_gen: unsupported model_id")

        url = "https://api.elevenlabs.io/v1/music"

        headers = {
            "xi-api-key": api_key,
            "Content-Type": "application/json",
        }

        payload = {
            "prompt": prompt,
            "model_id": model_id,
            "music_length_ms": int(duration * 1000),
            # music-gen-usage mandate: always set force_instrumental=true for
            # video background music (vocals collide with narration). The input
            # schema defaults this to True, so callers get the mandate by
            # default; they may opt out only by passing force_instrumental=False.
            "force_instrumental": bool(inputs.get("force_instrumental", True)),
        }

        response = requests.post(
            url, headers=headers, json=payload, timeout=180
        )
        response.raise_for_status()

        output_path = Path(inputs.get("output_path", "music_output.mp3"))
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(response.content)

        return ToolResult(
            success=True,
            data={
                "provider": "elevenlabs",
                "model_id": model_id,
                "prompt": prompt,
                "duration_seconds": duration,
                "output": str(output_path),
                "format": "mp3",
            },
            artifacts=[str(output_path)],
        )
