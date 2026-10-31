"""macOS built-in ``say`` text-to-speech provider.

This is intentionally a small, offline fallback for the web workbench.  It
does not claim to match ElevenLabs or a cloud neural voice: it uses the voice
installed on the Mac, writes an AIFF scratch file, and converts that file to
the requested format with FFmpeg.  Keeping it as a normal OpenMontage tool
means the selector can report it, score it, and leave the same provenance
metadata as every other narration provider.
"""

from __future__ import annotations

import os
import platform
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

from tools.base_tool import (
    Determinism,
    ExecutionMode,
    ResourceProfile,
    RetryPolicy,
    ToolResult,
    ToolRuntime,
    ToolStability,
    ToolStatus,
    ToolTier,
    BaseTool,
)


class MacOSSayTTS(BaseTool):
    """Generate a local narration with macOS's installed speech voices."""

    name = "macos_say_tts"
    version = "0.1.0"
    tier = ToolTier.VOICE
    capability = "tts"
    provider = "macos"
    stability = ToolStability.PRODUCTION
    execution_mode = ExecutionMode.SYNC
    determinism = Determinism.DETERMINISTIC
    runtime = ToolRuntime.LOCAL

    dependencies = ["cmd:say", "cmd:ffmpeg"]
    install_instructions = (
        "macOS includes the `say` command. FFmpeg is required for MP3/WAV "
        "conversion; install it with `brew install ffmpeg`. "
        "The default Chinese voice is Tingting; override it with "
        "MACOS_SAY_VOICE or the request's voice field."
    )
    agent_skills = ["text-to-speech"]

    capabilities = [
        "text_to_speech",
        "offline_generation",
        "chinese_narration",
    ]
    supports = {
        "voice_cloning": False,
        "multilingual": True,
        "offline": True,
        "native_audio": True,
        "expressive_instructions": False,
    }
    best_for = [
        "free local narration fallback",
        "Chinese timing and subtitle previews",
        "privacy-sensitive local-only workflows",
    ]
    not_good_for = [
        "best-in-class expressive voice quality",
        "voice cloning or cloud neural prosody",
    ]

    input_schema = {
        "type": "object",
        "required": ["text"],
        "properties": {
            "text": {"type": "string"},
            "voice": {
                "type": "string",
                "default": "Tingting",
                "description": "An installed macOS voice name, for example Tingting.",
            },
            "voice_id": {
                "type": "string",
                "description": "Alias for voice, kept for selector compatibility.",
            },
            "speaking_rate": {
                "type": "number",
                "minimum": 0.25,
                "maximum": 2.0,
                "default": 1.0,
                "description": "Multiplier around 180 words per minute.",
            },
            "speed": {
                "type": "number",
                "minimum": 0.25,
                "maximum": 4.0,
                "description": "Alias for speaking_rate.",
            },
            "output_path": {"type": "string"},
        },
    }

    resource_profile = ResourceProfile(
        cpu_cores=1,
        ram_mb=128,
        vram_mb=0,
        disk_mb=20,
        network_required=False,
    )
    retry_policy = RetryPolicy(max_retries=0, retryable_errors=[])
    idempotency_key_fields = ["text", "voice", "voice_id", "speaking_rate", "speed", "output_path"]
    side_effects = ["writes audio file to output_path", "runs local macOS speech synthesis"]
    user_visible_verification = [
        "Listen to the local narration for intelligibility and emotional fit",
        "Use a cloud neural voice for the final competition version when available",
    ]

    DEFAULT_VOICE = "Tingting"
    DEFAULT_RATE_WPM = 180

    def get_status(self) -> ToolStatus:
        if platform.system() != "Darwin":
            return ToolStatus.UNAVAILABLE
        if shutil.which("say") and shutil.which("ffmpeg"):
            return ToolStatus.AVAILABLE
        return ToolStatus.UNAVAILABLE

    def estimate_cost(self, inputs: dict[str, Any]) -> float:
        return 0.0

    def execute(self, inputs: dict[str, Any]) -> ToolResult:
        if self.get_status() != ToolStatus.AVAILABLE:
            return ToolResult(
                success=False,
                error="macOS local TTS is unavailable. " + self.install_instructions,
            )

        text = str(inputs.get("text") or "").strip()
        if not text:
            return ToolResult(success=False, error="macOS local TTS requires non-empty text")

        start = time.time()
        try:
            result = self._generate(inputs, text)
        except Exception as exc:
            return ToolResult(success=False, error=f"macOS local TTS failed: {exc}")
        result.duration_seconds = round(time.time() - start, 2)
        return result

    @classmethod
    def _voice_name(cls, inputs: dict[str, Any]) -> str:
        raw = inputs.get("voice") or inputs.get("voice_id") or os.environ.get("MACOS_SAY_VOICE") or cls.DEFAULT_VOICE
        voice = str(raw).strip()
        # The output of `say -v '?'` can include a locale in parentheses.  The
        # command accepts the bare installed voice name, so discard that suffix.
        if "(" in voice:
            voice = voice.split("(", 1)[0].strip()
        return voice or cls.DEFAULT_VOICE

    @classmethod
    def _rate_wpm(cls, inputs: dict[str, Any]) -> int:
        value = inputs.get("speaking_rate")
        if value is None:
            value = inputs.get("speed", 1.0)
        try:
            multiplier = min(4.0, max(0.25, float(value)))
        except (TypeError, ValueError):
            multiplier = 1.0
        return max(40, min(720, round(cls.DEFAULT_RATE_WPM * multiplier)))

    @staticmethod
    def _ffmpeg_args(
        aiff_path: Path,
        output_path: Path,
        format_hint: str | None = None,
    ) -> list[str]:
        """Build a conversion command even when the output is a ``.part`` file.

        The web pipeline writes to a same-directory temporary filename ending
        in ``.part`` before atomically renaming it.  FFmpeg cannot infer a
        muxer from that suffix, so the requested API format is passed as an
        explicit ``-f`` value whenever the filename has no known extension.
        """

        hinted = str(format_hint or "").lower().strip()
        if hinted.startswith(("wav", "riff", "pcm")):
            extension = ".wav"
            muxer = "wav"
        elif hinted.startswith("flac"):
            extension = ".flac"
            muxer = "flac"
        elif hinted.startswith("ogg"):
            extension = ".ogg"
            muxer = "ogg"
        elif hinted:
            extension = ".mp3"
            muxer = "mp3"
        else:
            extension = output_path.suffix.lower()
            muxer = extension.lstrip(".") if extension in {".wav", ".flac", ".ogg", ".mp3"} else None
        args = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(aiff_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "44100",
        ]
        if extension == ".wav":
            args += ["-c:a", "pcm_s16le"]
        elif extension == ".flac":
            args += ["-c:a", "flac"]
        elif extension == ".ogg":
            args += ["-c:a", "libvorbis", "-q:a", "4"]
        else:
            # The web API's default is mp3_44100_128.
            args += ["-c:a", "libmp3lame", "-b:a", "128k"]
        if muxer:
            args += ["-f", muxer]
        args.append(str(output_path))
        return args

    def _generate(self, inputs: dict[str, Any], text: str) -> ToolResult:
        output_path = Path(inputs.get("output_path") or "macos_say_tts.mp3").expanduser()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        voice = self._voice_name(inputs)
        rate_wpm = self._rate_wpm(inputs)

        with tempfile.TemporaryDirectory(prefix="openmontage-say-") as scratch:
            scratch_dir = Path(scratch)
            text_path = scratch_dir / "narration.txt"
            aiff_path = scratch_dir / "narration.aiff"
            text_path.write_text(text + "\n", encoding="utf-8")

            say_result = subprocess.run(
                ["say", "-v", voice, "-r", str(rate_wpm), "-f", str(text_path), "-o", str(aiff_path)],
                capture_output=True,
                text=True,
                timeout=300,
                check=False,
            )
            if say_result.returncode != 0:
                detail = say_result.stderr.strip() or say_result.stdout.strip()
                raise RuntimeError(f"say exited {say_result.returncode}: {detail[:400]}")
            if not aiff_path.is_file() or aiff_path.stat().st_size <= 0:
                raise RuntimeError("say returned success but no AIFF file was written")

            ffmpeg_result = subprocess.run(
                self._ffmpeg_args(
                    aiff_path,
                    output_path,
                    str(inputs.get("output_format") or ""),
                ),
                capture_output=True,
                text=True,
                timeout=300,
                check=False,
            )
            if ffmpeg_result.returncode != 0:
                detail = ffmpeg_result.stderr.strip() or ffmpeg_result.stdout.strip()
                raise RuntimeError(f"ffmpeg exited {ffmpeg_result.returncode}: {detail[:400]}")

        if not output_path.is_file() or output_path.stat().st_size <= 0:
            raise RuntimeError(f"converted audio file is missing: {output_path}")

        extension = output_path.suffix.lower().lstrip(".") or "mp3"
        return ToolResult(
            success=True,
            data={
                "provider": self.provider,
                "model": "macos-say",
                "voice": voice,
                "rate_wpm": rate_wpm,
                "format": extension,
                "output": str(output_path),
                "offline": True,
                "instructions_applied": False,
                "instructions_note": "macOS say does not support neural voice-performance instructions; use ElevenLabs or another cloud provider for final expressive delivery.",
            },
            artifacts=[str(output_path)],
            model="macos-say",
        )
