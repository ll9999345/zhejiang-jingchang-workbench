"""Tests for the offline macOS ``say`` narration fallback.

The real command is deliberately not invoked in CI.  The test double still
checks the complete contract: a text file is handed to ``say``, the AIFF
scratch file is converted by FFmpeg, and the requested output is returned as
a verified artifact.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from tools.audio.macos_say_tts import MacOSSayTTS
from tools.base_tool import ToolStatus


def test_status_requires_macos_commands(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("tools.audio.macos_say_tts.platform.system", lambda: "Darwin")
    monkeypatch.setattr(
        "tools.audio.macos_say_tts.shutil.which",
        lambda name: "/usr/bin/" + name,
    )
    assert MacOSSayTTS().get_status() is ToolStatus.AVAILABLE

    monkeypatch.setattr("tools.audio.macos_say_tts.platform.system", lambda: "Linux")
    assert MacOSSayTTS().get_status() is ToolStatus.UNAVAILABLE


def test_voice_can_be_overridden_by_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MACOS_SAY_VOICE", "Mei-Jia (zh_TW)")
    assert MacOSSayTTS._voice_name({}) == "Mei-Jia"


def test_execute_converts_say_aiff_to_requested_audio(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    tool = MacOSSayTTS()
    monkeypatch.setattr(tool, "get_status", lambda: ToolStatus.AVAILABLE)
    calls: list[list[str]] = []

    def fake_run(command: list[str], **_: object) -> SimpleNamespace:
        calls.append(command)
        if command[0] == "say":
            output = Path(command[command.index("-o") + 1])
            output.write_bytes(b"fake-aiff")
        else:
            output = Path(command[-1])
            output.write_bytes(b"fake-mp3")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr("tools.audio.macos_say_tts.subprocess.run", fake_run)
    output = tmp_path / "narration.mp3"
    result = tool.execute(
        {
            "text": "南北湖的风，从湖面吹来。",
            "voice": "Tingting (zh_CN)",
            "speaking_rate": 0.9,
            "output_path": str(output),
        }
    )

    assert result.success is True, result.error
    assert output.read_bytes() == b"fake-mp3"
    assert result.data["provider"] == "macos"
    assert result.data["voice"] == "Tingting"
    assert result.data["instructions_applied"] is False
    assert [call[0] for call in calls] == ["say", "ffmpeg"]
    assert "-r" in calls[0]
    assert calls[0][calls[0].index("-r") + 1] == "162"
