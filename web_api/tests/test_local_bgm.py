from __future__ import annotations

import base64
import json
import shutil
import subprocess
import wave
import math
import struct
from pathlib import Path

import pytest
from pydantic import ValidationError

from web_api.local_bgm import LocalBgmRequest, import_local_bgm


pytestmark = pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="本测试需要 ffmpeg 和 ffprobe",
)


def _wav_base64(path: Path, seconds: float = 1.2) -> str:
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8_000)
        audio.writeframes(b"".join(struct.pack("<h", int(8000 * math.sin(2 * math.pi * 440 * i / 8000))) for i in range(int(8000 * seconds))))
    return base64.b64encode(path.read_bytes()).decode("ascii")


def _probe_duration(path: Path) -> float:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)],
        check=True, capture_output=True, text=True,
    )
    return float(result.stdout.strip())


def test_imports_real_wav_and_adapts_to_requested_duration(tmp_path: Path) -> None:
    project = tmp_path / "demo-project"
    project.mkdir()
    source = tmp_path / "fixture.wav"
    encoded = _wav_base64(source)

    result = import_local_bgm(
        LocalBgmRequest(project_id="demo-project", filename="fixture.wav", audio_base64=encoded, duration_seconds=3),
        tmp_path,
    )

    output = project / result["music"]["path"]
    original = project / result["manifest"]["path"]
    assert result["status"] == "completed"
    assert result["provider"] == "local_import"
    assert result["cost_cny"] == 0
    assert output.suffix == ".mp3" and output.is_file()
    assert list((project / "assets/music").glob("*_source.wav"))
    assert abs(_probe_duration(output) - 3) <= 0.15
    manifest = json.loads(original.read_text(encoding="utf-8"))
    assert manifest["source"]["probe"]["audio"]["codec"] == "pcm_s16le"
    assert manifest["output"]["path"] == result["music"]["path"]


def test_rejects_invalid_base64_before_writing(tmp_path: Path) -> None:
    project = tmp_path / "demo-project"
    project.mkdir()
    request = LocalBgmRequest(project_id="demo-project", filename="bad.mp3", audio_base64="%%%", duration_seconds=3)
    with pytest.raises(ValueError, match="Base64"):
        import_local_bgm(request, tmp_path)
    assert not list((project / "assets").rglob("*")) if (project / "assets").exists() else True


def test_rejects_traversal_and_non_audio_extension() -> None:
    with pytest.raises(ValidationError, match="项目内相对路径"):
        LocalBgmRequest(project_id="demo", filename="x.mp3", audio_base64="YQ==", duration_seconds=3, reference_video_path="../outside.mp4")
    with pytest.raises(ValidationError, match="音频扩展名"):
        LocalBgmRequest(project_id="demo", filename="x.txt", audio_base64="YQ==", duration_seconds=3)
