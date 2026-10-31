from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from web_api.footage_render import render_footage
from web_api.footage_pipeline import FootageOptions


FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")
pytestmark = pytest.mark.skipif(not FFMPEG or not FFPROBE, reason="ffmpeg and ffprobe required")


def _run(command: list[str]) -> None:
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


@pytest.fixture
def project(tmp_path: Path) -> Path:
    project_dir = tmp_path / "project"
    (project_dir / "assets").mkdir(parents=True)
    (project_dir / "audio").mkdir()
    _run(
        [
            FFMPEG,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=red:s=320x180:r=24",
            "-t",
            "1.4",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            str(project_dir / "assets" / "red.mp4"),
        ]
    )
    _run(
        [
            FFMPEG,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=180x320:r=24",
            "-t",
            "1.3",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            str(project_dir / "assets" / "blue.mp4"),
        ]
    )
    _run(
        [
            FFMPEG,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000",
            "-t",
            "3",
            "-c:a",
            "pcm_s16le",
            str(project_dir / "audio" / "narration.wav"),
        ]
    )
    _run(
        [
            FFMPEG,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=220:sample_rate=48000",
            "-t",
            "0.8",
            "-c:a",
            "pcm_s16le",
            str(project_dir / "audio" / "bgm.wav"),
        ]
    )
    return project_dir


def _shots() -> list[dict]:
    return [
        {
            "id": "red",
            "text": "红色湖光",
            "source_path": "assets/red.mp4",
            "start_seconds": 0,
            "duration_seconds": 1.0,
        },
        {
            "id": "blue",
            "text": "蓝色山影",
            "source_path": "assets/blue.mp4",
            "start_seconds": 0.1,
            "duration_seconds": 0.8,
        },
    ]


def test_render_footage_real_ffmpeg_portrait_crossfade_and_audio(project: Path) -> None:
    result = render_footage(
        project,
        project / "renders" / "job-001",
        _shots(),
        {
            "aspect_ratio": "9:16",
            "resolution": 480,
            "fps": 24,
            "fit": "crop",
            "transition": "crossfade",
            "transition_seconds": 0.2,
            "audio_path": "audio/narration.wav",
            "bgm_path": "audio/bgm.wav",
            "subtitles": {"enabled": False},
        },
    )

    assert result["status"] == "completed"
    assert result["width"] == 480
    assert result["height"] == 854
    assert abs(result["duration_seconds"] - 1.8) <= 0.15
    output = project / result["output_path"]
    assert output.is_file() and output.stat().st_size > 0
    probe = json.loads(
        subprocess.run(
            [FFPROBE, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(output)],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
    )
    assert any(stream.get("codec_type") == "audio" for stream in probe["streams"])
    assert (project / result["subtitle_path"]).read_text(encoding="utf-8").count("-->") == 2
    assert json.loads((project / result["edit_path"]).read_text(encoding="utf-8"))["segments"][1]["source_path"] == "assets/blue.mp4"


def test_fractional_subtitle_outline_reaches_real_renderer_without_truncation(project: Path) -> None:
    frames = []
    for outline in (3.0, 3.5):
        options = FootageOptions(resolution=480, transition="cut", narration="none",
                                 subtitles={"outline_width": outline}).model_dump()
        result = render_footage(project, project / "renders" / f"outline-{outline}", _shots()[:1], options)
        assert result["status"] == "completed"
        assert result.get("warnings", []) == []
        receipt = json.loads((project / result["edit_path"]).read_text(encoding="utf-8"))
        assert receipt["options"]["subtitles"]["outline_width"] == outline
        frame = subprocess.run([FFMPEG, "-v", "error", "-ss", "0.5", "-i", str(project / result["output_path"]),
                                "-frames:v", "1", "-vf", "crop=iw:ih/3:0:2*ih/3", "-f", "rawvideo",
                                "-pix_fmt", "rgb24", "-"], check=True, capture_output=True).stdout
        assert frame
        frames.append(frame)
    # Both clips have the same solid-colour source and subtitle. A different
    # decoded subtitle region proves the fractional width affects the pixels.
    assert frames[0] != frames[1]


@pytest.mark.parametrize("outline", [True, -0.1, 25, float("inf"), float("nan")])
def test_invalid_subtitle_outline_is_rejected_before_output(tmp_path: Path, outline: float) -> None:
    from web_api.footage_render import _validate_options
    with pytest.raises(ValueError, match="outline_width"):
        _validate_options({"subtitles": {"outline_width": outline}})


def test_render_footage_animates_still_image(project: Path) -> None:
    _run(
        [
            FFMPEG,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=green:s=200x100",
            "-frames:v",
            "1",
            str(project / "assets" / "still.png"),
        ]
    )
    result = render_footage(
        project,
        project / "renders" / "still-job",
        [
            {
                "id": "still",
                "text": "静止素材",
                "source_path": "assets/still.png",
                "start_seconds": 0,
                "duration_seconds": 1.1,
            }
        ],
        {"aspect_ratio": "16:9", "resolution": 480, "fps": 24, "fit": "contain", "ken_burns": True},
    )
    assert result["status"] == "completed"
    assert result["width"] == 854 and result["height"] == 480
    assert abs(result["duration_seconds"] - 1.1) <= 0.15


def test_render_footage_rejects_escape_and_wrong_media(project: Path) -> None:
    outside = project.parent / "outside.mp4"
    outside.write_bytes(b"outside")
    with pytest.raises(ValueError, match="inside the project"):
        render_footage(
            project,
            project / "renders" / "escape",
            [{"id": "escape", "text": "x", "source_path": "../outside.mp4", "start_seconds": 0, "duration_seconds": 1}],
            {},
        )

    bad = project / "assets" / "bad.mp4"
    bad.write_text("this is not media", encoding="utf-8")
    with pytest.raises(ValueError, match="decodable|video or image"):
        render_footage(
            project,
            project / "renders" / "bad-media",
            [{"id": "bad", "text": "x", "source_path": "assets/bad.mp4", "start_seconds": 0, "duration_seconds": 1}],
            {},
        )


def test_render_footage_rejects_symlink_and_does_not_overwrite(project: Path, tmp_path: Path) -> None:
    symlink = project / "assets" / "linked.mp4"
    symlink.symlink_to(project / "assets" / "red.mp4")
    with pytest.raises(ValueError, match="symlink"):
        render_footage(
            project,
            project / "renders" / "symlink",
            [{"id": "linked", "text": "x", "source_path": "assets/linked.mp4", "start_seconds": 0, "duration_seconds": 1}],
            {},
        )

    job = project / "renders" / "existing"
    job.mkdir(parents=True)
    original = b"accepted-output"
    (job / "final.mp4").write_bytes(original)
    with pytest.raises(FileExistsError):
        render_footage(project, job, _shots(), {})
    assert (job / "final.mp4").read_bytes() == original


def test_render_footage_cancellation_returns_no_partial_success(project: Path) -> None:
    result = render_footage(
        project,
        project / "renders" / "cancelled",
        _shots(),
        {},
        cancelled=lambda: True,
    )
    assert result["status"] == "cancelled"
    assert not (project / "renders" / "cancelled" / "final.mp4").exists()
