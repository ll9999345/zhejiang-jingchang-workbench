"""Bounded, local FFmpeg renderer for footage-led project timelines.

The web API owns orchestration and request validation.  This module deliberately
stays independent from the larger media pipeline so it can be used by a worker
without importing provider adapters or making network calls.  It only accepts
project-relative media, writes into a fresh render job directory, and considers
an output complete after a local ffprobe check succeeds.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import selectors
import shutil
import subprocess
import tempfile
import textwrap
import time
import uuid
from fractions import Fraction
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence


ProgressCallback = Callable[[int, str], None]
CancelCallback = Callable[[], bool]

_RATIOS = {"16:9": (16, 9), "9:16": (9, 16), "1:1": (1, 1)}
_FITS = {"crop", "contain"}
_TRANSITIONS = {"cut", "fade", "crossfade"}
_IMAGE_EXTENSIONS = {".apng", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"}
_OUTPUT_NAMES = {"final.mp4", "subtitles.srt", "edit_decisions.json", "media_probe_manifest.json"}
_HEX_COLOUR = re.compile(r"^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$")
_FONT_NAME = re.compile(r"^[^,;:'\"\[\]{}\\/\n\r]{1,128}$")


class _Cancelled(Exception):
    """Internal signal used to stop without reporting a completed render."""


def _check_cancelled(cancelled: CancelCallback | None) -> None:
    if cancelled is not None and bool(cancelled()):
        raise _Cancelled


def _notify(progress: ProgressCallback | None, percent: int, message: str) -> None:
    if progress is None:
        return
    try:
        progress(max(0, min(100, int(percent))), message)
    except Exception:
        # A status callback must not turn an otherwise valid local render into
        # a partial result.  The worker can still report the final result.
        return


def _finite_number(value: Any, name: str) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{name} must be a finite number")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be a finite number") from exc
    if not math.isfinite(number):
        raise ValueError(f"{name} must be a finite number")
    return number


def _positive_number(value: Any, name: str, *, allow_zero: bool = False) -> float:
    number = _finite_number(value, name)
    if number < 0 or (number == 0 and not allow_zero):
        comparator = "non-negative" if allow_zero else "greater than zero"
        raise ValueError(f"{name} must be {comparator}")
    return number


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, Mapping):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(item) for item in value]
    return str(value)


def _which(name: str) -> str:
    if name == 'ffmpeg':
        # The optional MPT environment ships an imageio FFmpeg with libass.
        # Prefer that project-local binary for reliable burnt-in Chinese
        # subtitles; do not replace the user's system FFmpeg.
        root = Path(__file__).resolve().parents[1]
        candidates = sorted((root / '.runtime/mpt-python/lib').glob('python*/site-packages/imageio_ffmpeg/binaries/ffmpeg-*'))
        configured = os.environ.get('FOOTAGE_FFMPEG_PATH', '')
        if configured:
            candidates.insert(0, Path(configured))
        for binary in candidates:
            if binary.is_file() and os.access(binary, os.X_OK):
                return str(binary)
    path = shutil.which(name)
    if not path:
        raise RuntimeError(f"{name} is required for local footage rendering")
    return path


def _ffmpeg_has_filter(ffmpeg: str, filter_name: str) -> bool:
    """Return whether the local FFmpeg build exposes an optional filter."""

    try:
        completed = subprocess.run(
            [ffmpeg, "-hide_banner", "-filters"],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    if completed.returncode != 0:
        return False
    return any(re.search(rf"\b{re.escape(filter_name)}\b", line) for line in completed.stdout.splitlines())


def _lexical_absolute(path: Path, *, base: Path | None = None) -> Path:
    candidate = path if path.is_absolute() else ((base or Path.cwd()) / path)
    # os.path.abspath normalises '.' and '..'.  Callers reject '..' first when
    # the path is user supplied, so this is only a lexical normalisation step.
    return Path(os.path.abspath(str(candidate)))


def _reject_parent_traversal(raw: str, label: str) -> Path:
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError(f"{label} must be a non-empty project-relative path")
    path = Path(raw.strip())
    if path.is_absolute() or ".." in path.parts:
        raise ValueError(f"{label} must stay inside the project")
    return path


def _check_no_symlink_components(path: Path, *, stop: Path | None = None) -> None:
    """Reject symlinks in an existing path chain, including the final file."""

    current = path.anchor and Path(path.anchor) or Path.cwd().anchor and Path(Path.cwd().anchor) or Path("/")
    # ``Path.parts`` keeps the drive/root component on Windows and is harmless
    # on macOS/Linux.  The renderer is local-first but this keeps path checks
    # deterministic in tests on either platform.
    parts = list(path.parts)
    if parts and parts[0] == path.anchor:
        parts = parts[1:]
    for part in parts:
        current = current / part
        try:
            info = current.lstat()
        except FileNotFoundError:
            # Remaining parents cannot be symlinks until they exist; the final
            # existence check happens at each caller.
            break
        if info and current.is_symlink():
            raise ValueError(f"symlinks are not allowed in media paths: {path}")
        # ``stop`` is retained in the signature for call-site clarity.  The
        # callers perform the lexical and resolved containment checks around
        # this helper; checking every prefix against ``stop`` would reject the
        # perfectly valid ancestors (``/tmp`` before ``/tmp/project``).


def _project_path(project_dir: Path, raw: str, label: str, *, must_exist: bool = True) -> Path:
    relative = _reject_parent_traversal(raw, label)
    project = _lexical_absolute(project_dir)
    candidate = _lexical_absolute(relative, base=project)
    try:
        candidate.relative_to(project)
    except ValueError as exc:
        raise ValueError(f"{label} escaped the project") from exc
    _check_no_symlink_components(candidate, stop=project)
    resolved_project = project.resolve()
    resolved_candidate = candidate.resolve(strict=False)
    try:
        resolved_candidate.relative_to(resolved_project)
    except ValueError as exc:
        raise ValueError(f"{label} escaped the project") from exc
    if must_exist and not candidate.is_file():
        raise FileNotFoundError(f"{label} does not exist: {raw}")
    return candidate


def _validate_project(project_dir: Path) -> Path:
    project = _lexical_absolute(Path(project_dir))
    if project.is_symlink() or not project.is_dir():
        raise ValueError("project_dir must be an existing, non-symlink directory")
    return project.resolve()


def _prepare_job_dir(project: Path, job_dir: Path) -> Path:
    raw = Path(job_dir)
    if ".." in raw.parts:
        raise ValueError("job_dir must stay inside the project")
    candidate = _lexical_absolute(raw, base=project)
    try:
        candidate.relative_to(project)
    except ValueError as exc:
        # macOS commonly exposes /tmp as a symlink to /private/tmp.  Accept a
        # caller's equivalent absolute spelling when it resolves inside the
        # project, while still rejecting symlink components that occur under
        # the project root itself below.
        resolved_alias = candidate.resolve(strict=False)
        try:
            resolved_alias.relative_to(project)
        except ValueError:
            raise ValueError("job_dir must stay inside the project") from exc
        candidate = resolved_alias
    if candidate == project:
        raise ValueError("job_dir must be a per-render directory inside the project")
    _check_no_symlink_components(candidate, stop=project)
    if candidate.exists() and candidate.is_symlink():
        raise ValueError("job_dir cannot be a symlink")
    candidate.mkdir(parents=True, exist_ok=True)
    _check_no_symlink_components(candidate, stop=project)
    if not candidate.is_dir():
        raise ValueError("job_dir must be a directory")
    for entry in candidate.iterdir():
        if entry.is_symlink():
            raise ValueError("job_dir cannot contain symlinks")
    for name in _OUTPUT_NAMES:
        target = candidate / name
        try:
            target.lstat()
        except FileNotFoundError:
            continue
        raise FileExistsError(f"render output already exists and will not be overwritten: {target}")
    return candidate


def _probe_media(path: Path, ffprobe: str) -> dict[str, Any]:
    command = [
        ffprobe,
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        str(path),
    ]
    try:
        completed = subprocess.run(command, capture_output=True, text=True, timeout=45, check=False)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"ffprobe timed out for {path.name}") from exc
    if completed.returncode != 0:
        detail = (completed.stderr or "").strip().splitlines()[-1:]
        raise ValueError(f"media is not decodable: {path.name}{': ' + detail[0] if detail else ''}")
    try:
        payload = json.loads(completed.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise ValueError(f"ffprobe returned invalid metadata for {path.name}") from exc
    streams = payload.get("streams") or []
    video = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
    if not video or not int(video.get("width") or 0) or not int(video.get("height") or 0):
        raise ValueError(f"source is not a decodable video or image: {path.name}")
    audio = next((stream for stream in streams if stream.get("codec_type") == "audio"), None)
    raw_duration = (payload.get("format") or {}).get("duration")
    if raw_duration in (None, "N/A"):
        raw_duration = video.get("duration")
    duration = None
    if raw_duration not in (None, "N/A"):
        try:
            parsed = float(raw_duration)
            if math.isfinite(parsed) and parsed >= 0:
                duration = parsed
        except (TypeError, ValueError):
            duration = None
    raw_rate = video.get("avg_frame_rate") or video.get("r_frame_rate")
    fps = None
    if raw_rate and raw_rate != "0/0":
        try:
            fps = float(Fraction(str(raw_rate)))
        except (ValueError, ZeroDivisionError):
            fps = None
    return {
        "path": path.name,
        "format": (payload.get("format") or {}).get("format_name"),
        "duration_seconds": round(duration, 6) if duration is not None else None,
        "width": int(video.get("width") or 0),
        "height": int(video.get("height") or 0),
        "fps": round(fps, 6) if fps is not None and math.isfinite(fps) else None,
        "has_audio": audio is not None,
        "audio_codec": audio.get("codec_name") if audio else None,
        "video_codec": video.get("codec_name"),
        "is_still": path.suffix.lower() in _IMAGE_EXTENSIONS,
    }


def _probe_output(path: Path, ffprobe: str) -> dict[str, Any]:
    command = [
        ffprobe,
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        str(path),
    ]
    try:
        completed = subprocess.run(command, capture_output=True, text=True, timeout=45, check=False)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("ffprobe timed out while checking the render") from exc
    if completed.returncode != 0:
        raise RuntimeError(f"ffprobe could not verify rendered media: {(completed.stderr or '').strip()[-500:]}")
    try:
        payload = json.loads(completed.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise RuntimeError("ffprobe returned invalid render metadata") from exc
    streams = payload.get("streams") or []
    video = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
    if not video:
        raise RuntimeError("rendered file has no video stream")
    audio = next((stream for stream in streams if stream.get("codec_type") == "audio"), None)
    raw_duration = (payload.get("format") or {}).get("duration")
    if raw_duration in (None, "N/A"):
        raw_duration = video.get("duration")
    try:
        duration = float(raw_duration)
    except (TypeError, ValueError) as exc:
        raise RuntimeError("rendered file has no measurable duration") from exc
    if not math.isfinite(duration) or duration <= 0:
        raise RuntimeError("rendered file has an invalid duration")
    raw_rate = video.get("avg_frame_rate") or video.get("r_frame_rate")
    fps = None
    if raw_rate and raw_rate != "0/0":
        try:
            fps = float(Fraction(str(raw_rate)))
        except (ValueError, ZeroDivisionError):
            fps = None
    return {
        "duration_seconds": round(duration, 6),
        "width": int(video.get("width") or 0),
        "height": int(video.get("height") or 0),
        "fps": round(fps, 6) if fps is not None and math.isfinite(fps) else None,
        "video_codec": video.get("codec_name"),
        "has_audio": audio is not None,
        "audio_codec": audio.get("codec_name") if audio else None,
        "format": (payload.get("format") or {}).get("format_name"),
        "streams": [
            {
                "codec_type": stream.get("codec_type"),
                "codec_name": stream.get("codec_name"),
                "duration": stream.get("duration"),
            }
            for stream in streams
        ],
    }


def _probe_audio(path: Path, ffprobe: str) -> dict[str, Any]:
    """Probe an audio-only narration/music input without requiring video."""

    command = [
        ffprobe,
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        str(path),
    ]
    try:
        completed = subprocess.run(command, capture_output=True, text=True, timeout=45, check=False)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"ffprobe timed out for audio input {path.name}") from exc
    if completed.returncode != 0:
        raise ValueError(f"audio input is not decodable: {path.name}")
    try:
        payload = json.loads(completed.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise ValueError(f"ffprobe returned invalid audio metadata for {path.name}") from exc
    streams = payload.get("streams") or []
    audio = next((stream for stream in streams if stream.get("codec_type") == "audio"), None)
    if not audio:
        raise ValueError(f"audio input has no decodable audio stream: {path.name}")
    raw_duration = (payload.get("format") or {}).get("duration") or audio.get("duration")
    duration = None
    try:
        parsed = float(raw_duration)
        if math.isfinite(parsed) and parsed >= 0:
            duration = parsed
    except (TypeError, ValueError):
        duration = None
    return {
        "duration_seconds": round(duration, 6) if duration is not None else None,
        "audio_codec": audio.get("codec_name"),
        "sample_rate": audio.get("sample_rate"),
        "channels": audio.get("channels"),
        "format": (payload.get("format") or {}).get("format_name"),
    }


def _format_float(value: float) -> str:
    return f"{value:.6f}".rstrip("0").rstrip(".") or "0"


def _target_dimensions(aspect_ratio: str, resolution: int) -> tuple[int, int]:
    numerator, denominator = _RATIOS[aspect_ratio]
    if aspect_ratio == "1:1":
        return resolution, resolution
    # ``resolution`` is the short edge, matching common 480p/720p/1080p
    # delivery profiles: 720p portrait is 720x1280, landscape is 1280x720.
    if numerator > denominator:
        width = int(round(resolution * numerator / denominator))
        height = resolution
    else:
        width = resolution
        height = int(round(resolution * denominator / numerator))
    # yuv420p/libx264 require even dimensions.  The profiles above already
    # produce even dimensions for the supported resolutions, but keep the
    # invariant for future values.
    return width + width % 2, height + height % 2


def _validate_options(options: Mapping[str, Any] | None) -> dict[str, Any]:
    raw = dict(options or {})
    aspect_ratio = str(raw.get("aspect_ratio", "16:9"))
    if aspect_ratio not in _RATIOS:
        raise ValueError("aspect_ratio must be 16:9, 9:16, or 1:1")
    resolution = raw.get("resolution", 720)
    if isinstance(resolution, bool) or int(resolution) != resolution or int(resolution) not in {480, 720, 1080}:
        raise ValueError("resolution must be 480, 720, or 1080")
    resolution = int(resolution)
    fps = raw.get("fps", 30)
    if isinstance(fps, bool) or int(fps) != fps or int(fps) not in {24, 30}:
        raise ValueError("fps must be 24 or 30")
    fps = int(fps)
    fit = str(raw.get("fit", "crop"))
    if fit not in _FITS:
        raise ValueError("fit must be crop or contain")
    transition = str(raw.get("transition", "cut"))
    if transition not in _TRANSITIONS:
        raise ValueError("transition must be cut, fade, or crossfade")
    transition_seconds = _positive_number(raw.get("transition_seconds", 0.4), "transition_seconds", allow_zero=True)
    if transition_seconds > 30:
        raise ValueError("transition_seconds is unreasonably large")
    volumes: dict[str, float] = {}
    for name, default in (("narration_volume", 1.0), ("bgm_volume", 0.18), ("source_volume", 0.0)):
        value = _positive_number(raw.get(name, default), name, allow_zero=True)
        if value > 8:
            raise ValueError(f"{name} must be no greater than 8")
        volumes[name] = value
    subtitles_raw = raw.get("subtitles", {})
    if subtitles_raw is None:
        subtitles_raw = {}
    if not isinstance(subtitles_raw, Mapping):
        raise ValueError("subtitles must be an object")
    subtitles_raw = dict(subtitles_raw)
    font = str(subtitles_raw.get("font", "PingFang SC"))
    if not _FONT_NAME.fullmatch(font):
        raise ValueError("subtitles.font contains unsupported characters")
    font_size = subtitles_raw.get("font_size", 40)
    if isinstance(font_size, bool) or int(font_size) != font_size or int(font_size) < 8 or int(font_size) > 240:
        raise ValueError("subtitles.font_size must be an integer between 8 and 240")
    font_size = int(font_size)
    for colour_name, default in (("color", "#FFFFFF"), ("outline_color", "#000000")):
        colour = str(subtitles_raw.get(colour_name, default))
        if not _HEX_COLOUR.fullmatch(colour):
            raise ValueError(f"subtitles.{colour_name} must be a hex colour")
        subtitles_raw[colour_name] = colour
    position = str(subtitles_raw.get("position", "bottom"))
    if position not in {"bottom", "center", "top"}:
        raise ValueError("subtitles.position must be bottom, center, or top")
    enabled = subtitles_raw.get("enabled", True)
    if not isinstance(enabled, bool):
        raise ValueError("subtitles.enabled must be a boolean")
    background = subtitles_raw.get("background", False)
    if not isinstance(background, bool):
        raise ValueError("subtitles.background must be a boolean")
    outline_width = _positive_number(subtitles_raw.get("outline_width", 2), "subtitles.outline_width", allow_zero=True)
    if outline_width > 24:
        raise ValueError("subtitles.outline_width must be between 0 and 24")
    ken_burns = raw.get("ken_burns", True)
    if not isinstance(ken_burns, bool):
        raise ValueError("ken_burns must be a boolean")
    duck_bgm = raw.get("duck_bgm", True)
    if not isinstance(duck_bgm, bool):
        raise ValueError("duck_bgm must be a boolean")
    subtitle_path = raw.get("subtitle_path")
    if subtitle_path is not None:
        subtitle_path = str(subtitle_path).strip()
        _reject_parent_traversal(subtitle_path, "subtitle_path")
    audio_path = raw.get("audio_path")
    if audio_path is not None:
        audio_path = str(audio_path).strip()
        _reject_parent_traversal(audio_path, "audio_path")
    bgm_path = raw.get("bgm_path")
    if bgm_path is not None:
        bgm_path = str(bgm_path).strip()
        _reject_parent_traversal(bgm_path, "bgm_path")
    return {
        "aspect_ratio": aspect_ratio,
        "resolution": resolution,
        "fps": fps,
        "fit": fit,
        "transition": transition,
        "transition_seconds": transition_seconds,
        "narration_volume": volumes["narration_volume"],
        "bgm_volume": volumes["bgm_volume"],
        "duck_bgm": duck_bgm,
        "source_volume": volumes["source_volume"],
        "subtitles": {
            "enabled": enabled,
            "font": font,
            "font_size": font_size,
            "color": str(subtitles_raw.get("color", "#FFFFFF")),
            "outline_color": str(subtitles_raw.get("outline_color", "#000000")),
            "outline_width": outline_width,
            "background": background,
            "position": position,
        },
        "subtitle_path": subtitle_path or None,
        "audio_path": audio_path or None,
        "bgm_path": bgm_path or None,
        "ken_burns": ken_burns,
    }


def _validate_shots(
    project: Path,
    shots: Sequence[Mapping[str, Any]],
    ffprobe: str,
    cancelled: CancelCallback | None,
) -> tuple[list[dict[str, Any]], float]:
    if not isinstance(shots, Sequence) or isinstance(shots, (str, bytes)) or not shots:
        raise ValueError("shots must be a non-empty list")
    validated: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    total = 0.0
    for index, shot in enumerate(shots):
        _check_cancelled(cancelled)
        if not isinstance(shot, Mapping):
            raise ValueError(f"shot {index + 1} must be an object")
        shot_id = str(shot.get("id", "")).strip()
        if not shot_id:
            raise ValueError(f"shot {index + 1} is missing id")
        if shot_id in seen_ids:
            raise ValueError(f"shot id is duplicated: {shot_id}")
        seen_ids.add(shot_id)
        text = shot.get("text", "")
        if not isinstance(text, str):
            raise ValueError(f"shot {shot_id} text must be a string")
        source_raw = shot.get("source_path")
        if not isinstance(source_raw, str):
            raise ValueError(f"shot {shot_id} is missing source_path")
        source_path = _project_path(project, source_raw, f"shot {shot_id} source_path")
        source_probe = _probe_media(source_path, ffprobe)
        start_seconds = _positive_number(shot.get("start_seconds", 0), f"shot {shot_id} start_seconds", allow_zero=True)
        duration_seconds = _positive_number(shot.get("duration_seconds"), f"shot {shot_id} duration_seconds")
        if duration_seconds > 3600:
            raise ValueError(f"shot {shot_id} duration_seconds is too large")
        source_duration = source_probe.get("duration_seconds")
        # Still images have no meaningful source timeline.  For a real video,
        # reject a trim that would silently produce a shorter shot.
        if not source_probe["is_still"] and source_duration is not None:
            if start_seconds >= float(source_duration):
                raise ValueError(f'shot {shot_id} starts after the source ends')
            if start_seconds + duration_seconds > float(source_duration) + 0.12 and not shot.get('repeat_to_fill'):
                raise ValueError(
                    f"shot {shot_id} trim exceeds source duration "
                    f"({start_seconds + duration_seconds:.3f}s > {float(source_duration):.3f}s)"
                )
        record = {
            "index": index,
            "id": shot_id,
            "text": text,
            "source_path": source_path.relative_to(project).as_posix(),
            "source_abs": source_path,
            "source_probe": source_probe,
            "source_sha256": _sha256(source_path),
            "start_seconds": start_seconds,
            "duration_seconds": duration_seconds,
            "timeline_start_seconds": total,
            "timeline_end_seconds": total + duration_seconds,
            "repeat_to_fill": bool(shot.get('repeat_to_fill')),
            "selected_source": shot.get('selected_source', {}),
        }
        validated.append(record)
        total += duration_seconds
    if total <= 0 or not math.isfinite(total):
        raise ValueError("shot timeline has no positive duration")
    return validated, total


def _fit_filter(width: int, height: int, fit: str) -> str:
    if fit == "crop":
        return (
            f"scale={width}:{height}:force_original_aspect_ratio=increase:flags=lanczos,"
            f"crop={width}:{height}:(iw-{width})/2:(ih-{height})/2"
        )
    return (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease:flags=lanczos,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black"
    )


def _run_ffmpeg(
    command: list[str],
    *,
    progress: ProgressCallback | None,
    cancelled: CancelCallback | None,
    duration_seconds: float | None,
    message: str,
    timeout_seconds: float = 300,
) -> None:
    _check_cancelled(cancelled)
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )
    assert process.stdout is not None
    assert process.stderr is not None
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ, "stdout")
    selector.register(process.stderr, selectors.EVENT_READ, "stderr")
    stderr_tail: list[str] = []
    started = time.monotonic()
    last_percent = 0
    try:
        while True:
            _check_cancelled(cancelled)
            if time.monotonic() - started > timeout_seconds:
                process.kill()
                process.wait(timeout=5)
                raise RuntimeError(f"FFmpeg timed out while {message.lower()}")
            for key, _ in selector.select(timeout=0.2):
                stream = key.fileobj
                chunk = stream.readline()
                if not chunk:
                    continue
                if key.data == "stderr":
                    stderr_tail.append(chunk.rstrip())
                    if len(stderr_tail) > 80:
                        del stderr_tail[:20]
                elif chunk.startswith("out_time_us=") or chunk.startswith("out_time_ms="):
                    try:
                        raw = float(chunk.split("=", 1)[1].strip())
                        seconds = raw / (1_000_000 if chunk.startswith("out_time_us=") else 1_000_000)
                    except (TypeError, ValueError):
                        continue
                    if duration_seconds and duration_seconds > 0:
                        percent = min(99, int(seconds / duration_seconds * 100))
                        if percent > last_percent:
                            last_percent = percent
                            _notify(progress, percent, message)
            if process.poll() is not None:
                # Drain the remaining stderr without waiting on a closed pipe.
                for line in process.stderr.readlines():
                    stderr_tail.append(line.rstrip())
                break
        return_code = process.returncode
    except _Cancelled:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        raise
    finally:
        selector.close()
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
    if return_code != 0:
        detail = "\n".join(stderr_tail[-12:])[-1600:]
        raise RuntimeError(f"FFmpeg failed while {message.lower()}: {detail}")
    _notify(progress, 100, message)


def _write_new_bytes(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        path.lstat()
    except FileNotFoundError:
        pass
    else:
        raise FileExistsError(f"render output already exists and will not be overwritten: {path}")
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.part")
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        descriptor = os.open(str(temporary), flags, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _write_new_json(path: Path, payload: Mapping[str, Any]) -> None:
    _write_new_bytes(path, (json.dumps(_json_safe(payload), ensure_ascii=False, indent=2) + "\n").encode("utf-8"))


def _srt_timestamp(seconds: float) -> str:
    milliseconds = max(0, int(round(seconds * 1000)))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds_part, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds_part:02d},{millis:03d}"


def _generate_srt(segments: Sequence[Mapping[str, Any]]) -> bytes:
    blocks: list[str] = []
    number = 1
    for segment in segments:
        text = str(segment.get("text", "")).replace("\r\n", "\n").replace("\r", "\n").strip()
        if not text:
            continue
        wrapped_lines: list[str] = []
        for line in text.split("\n"):
            wrapped_lines.extend(
                textwrap.wrap(
                    line,
                    width=24,
                    break_long_words=True,
                    break_on_hyphens=False,
                )
                or [""]
            )
        text = "\n".join(wrapped_lines)
        blocks.append(
            f"{number}\n"
            f"{_srt_timestamp(float(segment['timeline_start_seconds']))} --> "
            f"{_srt_timestamp(float(segment['timeline_end_seconds']))}\n"
            f"{text}\n"
        )
        number += 1
    return ("\n".join(blocks).rstrip() + "\n").encode("utf-8")


def _ass_colour(hex_colour: str) -> str:
    value = hex_colour.lstrip("#")
    # ASS uses &HAABBGGRR.  The accepted option colours are opaque RGB or
    # RGBA; preserve the supplied alpha when present.
    if len(value) == 6:
        alpha, rgb = "00", value
    else:
        rgb, alpha = value[:6], value[6:]
    rr, gg, bb = rgb[0:2], rgb[2:4], rgb[4:6]
    return f"&H{alpha}{bb}{gg}{rr}"


def _ffmpeg_filter_path(path: Path) -> str:
    value = str(path)
    return value.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


def _subtitle_filter(path: Path, subtitles: Mapping[str, Any], width: int = 1280, height: int = 720) -> str:
    alignment = {"bottom": 2, "center": 5, "top": 8}[str(subtitles["position"])]
    margin = max(12, int(int(subtitles["font_size"]) * 1.25))
    back_colour = "&H80000000" if subtitles["background"] else "&HFF000000"
    style = ",".join(
        [
            f"PlayResX={width}",
            f"PlayResY={height}",
            f"FontName={subtitles['font']}",
            f"FontSize={int(subtitles['font_size'])}",
            f"PrimaryColour={_ass_colour(str(subtitles['color']))}",
            f"OutlineColour={_ass_colour(str(subtitles['outline_color']))}",
            f"Outline={_format_float(subtitles['outline_width'])}",
            f"BorderStyle={4 if subtitles['background'] else 1}",
            f"BackColour={back_colour}",
            f"Alignment={alignment}",
            f"MarginV={margin}",
        ]
    )
    fonts = ":fontsdir='/System/Library/Fonts'" if Path('/System/Library/Fonts').is_dir() else ''
    return f"subtitles=filename='{_ffmpeg_filter_path(path)}'{fonts}:force_style='{style}'"


def _render_single_clip(
    record: Mapping[str, Any],
    output: Path,
    *,
    width: int,
    height: int,
    fps: int,
    fit: str,
    ken_burns: bool,
    ffmpeg: str,
    progress: ProgressCallback | None,
    cancelled: CancelCallback | None,
) -> None:
    source = Path(record["source_abs"])
    duration = float(record["duration_seconds"])
    source_probe = record["source_probe"]
    filter_chain = _fit_filter(width, height, fit)
    image = bool(source_probe["is_still"])
    command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y"]
    if image and ken_burns:
        command += ["-i", str(source)]
        frames = max(1, int(round(duration * fps)))
        filter_chain += (
            f",zoompan=z='min(zoom+0.0015,1.08)':"
            f"x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={frames}:"
            f"s={width}x{height}:fps={fps}"
        )
        command += ["-vf", filter_chain, "-frames:v", str(frames)]
    elif image:
        command += ["-loop", "1", "-framerate", str(fps), "-i", str(source), "-vf", filter_chain, "-t", _format_float(duration)]
    else:
        if record.get('repeat_to_fill'):
            command += ['-stream_loop', '-1']
        command += [
            "-ss",
            _format_float(float(record["start_seconds"])),
            "-t",
            _format_float(duration),
            "-i",
            str(source),
            "-vf",
            filter_chain,
            "-t",
            _format_float(duration),
        ]
    command += [
        "-an",
        "-r",
        str(fps),
        "-fps_mode",
        "cfr",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-progress",
        "pipe:1",
        "-nostats",
        str(output),
    ]
    _run_ffmpeg(
        command,
        progress=progress,
        cancelled=cancelled,
        duration_seconds=duration,
        message=f"rendering shot {record['id']}",
    )
    if not output.is_file() or output.stat().st_size <= 0:
        raise RuntimeError(f"FFmpeg did not create shot {record['id']}")


def _compose_video(
    clip_paths: Sequence[Path],
    output: Path,
    *,
    durations: Sequence[float],
    transition: str,
    transition_seconds: float,
    width: int,
    height: int,
    fps: int,
    ffmpeg: str,
    progress: ProgressCallback | None,
    cancelled: CancelCallback | None,
    total: float,
) -> None:
    if len(clip_paths) == 1:
        command = [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(clip_paths[0]),
            "-an",
            "-t",
            _format_float(total),
            "-c:v",
            "copy",
            "-progress",
            "pipe:1",
            "-nostats",
            str(output),
        ]
        _run_ffmpeg(command, progress=progress, cancelled=cancelled, duration_seconds=total, message="assembling footage")
        return
    effective = min(transition_seconds, *(duration / 2 for duration in durations)) if transition_seconds > 0 else 0.0
    command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y"]
    for path in clip_paths:
        command += ["-i", str(path)]
    filters: list[str] = []
    if transition == "cut":
        inputs = "".join(f"[{index}:v]" for index in range(len(clip_paths)))
        filters.append(f"{inputs}concat=n={len(clip_paths)}:v=1:a=0,format=yuv420p[vout]")
    elif transition == "fade":
        faded_labels: list[str] = []
        for index, duration in enumerate(durations):
            label = f"f{index}"
            chain = f"[{index}:v]setpts=PTS-STARTPTS"
            if index > 0 and effective > 0:
                chain += f",fade=t=in:st=0:d={_format_float(effective)}"
            if index < len(durations) - 1 and effective > 0:
                start = max(0.0, duration - effective)
                chain += f",fade=t=out:st={_format_float(start)}:d={_format_float(effective)}"
            chain += f"[{label}]"
            filters.append(chain)
            faded_labels.append(f"[{label}]")
        filters.append(f"{''.join(faded_labels)}concat=n={len(clip_paths)}:v=1:a=0,format=yuv420p[vout]")
    else:
        # xfade overlaps the previous stream by ``effective``.  Padding the
        # previous stream with a clone of its last frame restores each
        # transition's overlap to the requested timeline length, so output
        # duration remains sum(durations) instead of shrinking.
        labels = []
        for index in range(len(clip_paths)):
            label = f"v{index}"
            filters.append(f"[{index}:v]format=yuv444p,setpts=PTS-STARTPTS,fps={fps},settb=AVTB[{label}]")
            labels.append(label)
        current = "v0"
        cumulative = float(durations[0])
        for index in range(1, len(clip_paths)):
            padded = f"p{index}"
            joined = f"x{index}"
            filters.append(
                f"[{current}]tpad=stop_mode=clone:stop_duration={_format_float(effective)},fps={fps},settb=AVTB[{padded}]"
            )
            filters.append(
                f"[{padded}][v{index}]xfade=transition=fade:duration={_format_float(effective)}:"
                f"offset={_format_float(cumulative)}[{joined}]"
            )
            current = joined
            cumulative += float(durations[index])
        filters.append(f"[{current}]format=yuv420p[vout]")
    command += [
        "-filter_complex",
        ";".join(filters),
        "-map",
        "[vout]",
        "-an",
        "-r",
        str(fps),
        "-t",
        _format_float(total),
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-progress",
        "pipe:1",
        "-nostats",
        str(output),
    ]
    _run_ffmpeg(command, progress=progress, cancelled=cancelled, duration_seconds=total, message="assembling footage")


def _normalize_video_duration(
    source: Path,
    output: Path,
    *,
    expected: float,
    ffmpeg: str,
    ffprobe: str,
    progress: ProgressCallback | None,
    cancelled: CancelCallback | None,
) -> None:
    probe = _probe_output(source, ffprobe)
    difference = expected - float(probe["duration_seconds"])
    if abs(difference) <= 0.02:
        shutil.copy2(source, output)
        return
    # A clone pad handles the crossfade rounding edge where the last PTS is a
    # frame short.  A normal output -t trims an overlong graph accurately.
    filter_chain = "setpts=PTS-STARTPTS"
    if difference > 0:
        filter_chain += f",tpad=stop_mode=clone:stop_duration={_format_float(difference)}"
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(source),
        "-vf",
        filter_chain,
        "-an",
        "-t",
        _format_float(expected),
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-progress",
        "pipe:1",
        "-nostats",
        str(output),
    ]
    _run_ffmpeg(command, progress=progress, cancelled=cancelled, duration_seconds=expected, message="normalizing timeline")


def _mux_audio(
    video: Path,
    output: Path,
    *,
    project: Path,
    segments: Sequence[Mapping[str, Any]],
    total: float,
    options: Mapping[str, Any],
    audio_path: Path | None,
    bgm_path: Path | None,
    ffmpeg: str,
    progress: ProgressCallback | None,
    cancelled: CancelCallback | None,
) -> None:
    narration_volume = float(options["narration_volume"])
    bgm_volume = float(options["bgm_volume"])
    source_volume = float(options["source_volume"])
    command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(video)]
    filter_parts: list[str] = []
    labels: list[str] = []
    input_index = 1
    narration_label: str | None = None
    if audio_path is not None:
        command += ["-i", str(audio_path)]
        narration_label = "narr"
        filter_parts.append(
            f"[{input_index}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,volume={_format_float(narration_volume)},"
            f"apad=whole_dur={_format_float(total)},atrim=duration={_format_float(total)},"
            f"asetpts=PTS-STARTPTS[{narration_label}]"
        )
        labels.append(narration_label)
        input_index += 1
    bgm_label: str | None = None
    if bgm_path is not None:
        command += ["-stream_loop", "-1", "-i", str(bgm_path)]
        bgm_label = "bgm"
        fade_duration = min(1.0, total)
        fade_start = max(0.0, total - fade_duration)
        filter_parts.append(
            f"[{input_index}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,volume={_format_float(bgm_volume)},"
            f"apad=whole_dur={_format_float(total)},atrim=duration={_format_float(total)},"
            f"afade=t=out:st={_format_float(fade_start)}:d={_format_float(fade_duration)},"
            f"asetpts=PTS-STARTPTS[{bgm_label}]"
        )
        labels.append(bgm_label)
        input_index += 1
    source_label: str | None = None
    if source_volume > 0:
        source_segment_labels: list[str] = []
        for index, segment in enumerate(segments):
            probe = segment["source_probe"]
            duration = float(segment["duration_seconds"])
            if probe["has_audio"]:
                if segment.get('repeat_to_fill'):
                    command += ['-stream_loop', '-1']
                command += [
                    "-ss",
                    _format_float(float(segment["start_seconds"])),
                    "-t",
                    _format_float(duration),
                    "-i",
                    str(segment["source_abs"]),
                ]
            else:
                command += [
                    "-f",
                    "lavfi",
                    "-t",
                    _format_float(duration),
                    "-i",
                    "anullsrc=r=48000:cl=stereo",
                ]
            label = f"src{index}"
            filter_parts.append(
                f"[{input_index}:a]aresample=48000,atrim=duration={_format_float(duration)},"
                f"asetpts=PTS-STARTPTS,volume={_format_float(source_volume)}[{label}]"
            )
            source_segment_labels.append(f"[{label}]")
            input_index += 1
        source_label = "source"
        filter_parts.append(f"{''.join(source_segment_labels)}concat=n={len(source_segment_labels)}:v=0:a=1[{source_label}]")
        labels.append(source_label)
    # Negotiate both inputs explicitly as 48 kHz stereo floats. The detector
    # uses only the independent narration, never the original footage sound.
    if options["duck_bgm"] and narration_label and bgm_label and narration_volume > 0 and bgm_volume > 0:
        filter_parts.append("[narr]asplit=2[narrmix][detector]")
        filter_parts.append("[bgm][detector]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=350:makeup=1[ducked]")
        labels = ["narrmix" if label == "narr" else "ducked" if label == "bgm" else label for label in labels]
    if not labels:
        raise ValueError("audio mux requested without any audio track")
    if len(labels) == 1:
        filter_parts.append(
            f"[{labels[0]}]aresample=48000,apad=whole_dur={_format_float(total)},"
            f"atrim=duration={_format_float(total)},asetpts=PTS-STARTPTS[aout]"
        )
    else:
        filter_parts.append(
            f"{''.join('[' + label + ']' for label in labels)}amix=inputs={len(labels)}:duration=longest:"
            f"dropout_transition=0,aresample=48000,apad=whole_dur={_format_float(total)},"
            f"atrim=duration={_format_float(total)},asetpts=PTS-STARTPTS[aout]"
        )
    command += [
        "-filter_complex",
        ";".join(filter_parts),
        "-map",
        "0:v:0",
        "-map",
        "[aout]",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-t",
        _format_float(total),
        "-movflags",
        "+faststart",
        "-progress",
        "pipe:1",
        "-nostats",
        str(output),
    ]
    _run_ffmpeg(command, progress=progress, cancelled=cancelled, duration_seconds=total, message="mixing audio")


def render_footage(
    project_dir: Path,
    job_dir: Path,
    shots: list[dict],
    options: dict,
    progress: ProgressCallback | None = None,
    cancelled: CancelCallback | None = None,
) -> dict[str, Any]:
    """Render a project-relative footage timeline into a fresh local job.

    The function raises ``ValueError``/``FileNotFoundError`` for invalid input,
    returns ``status=cancelled`` when the caller requests cancellation, and
    returns ``status=completed`` only after the final MP4 and all sidecars have
    passed local validation.  No network or paid provider is involved.
    """

    ffmpeg = _which("ffmpeg")
    ffprobe = _which("ffprobe")
    project = _validate_project(Path(project_dir))
    job = _prepare_job_dir(project, Path(job_dir))
    resolved_options = _validate_options(options)
    width, height = _target_dimensions(resolved_options["aspect_ratio"], resolved_options["resolution"])
    created_files: list[Path] = []
    workdir: Path | None = None
    final_path = job / "final.mp4"
    subtitle_output = job / "subtitles.srt"
    edit_output = job / "edit_decisions.json"
    probe_output = job / "media_probe_manifest.json"
    _notify(progress, 0, "validating footage inputs")
    try:
        _check_cancelled(cancelled)
        segments, total = _validate_shots(project, shots, ffprobe, cancelled)
        audio_path = _project_path(project, resolved_options["audio_path"], "audio_path") if resolved_options["audio_path"] else None
        bgm_path = _project_path(project, resolved_options["bgm_path"], "bgm_path") if resolved_options["bgm_path"] else None
        if audio_path is not None:
            _probe_audio(audio_path, ffprobe)
        if bgm_path is not None:
            _probe_audio(bgm_path, ffprobe)
        subtitle_source = None
        if resolved_options["subtitle_path"]:
            subtitle_source = _project_path(project, resolved_options["subtitle_path"], "subtitle_path")
            try:
                subtitle_bytes = subtitle_source.read_bytes()
                subtitle_bytes.decode("utf-8")
            except UnicodeDecodeError as exc:
                raise ValueError("subtitle_path must be UTF-8 SRT text") from exc
        else:
            subtitle_bytes = _generate_srt(segments)
        _write_new_bytes(subtitle_output, subtitle_bytes)
        created_files.append(subtitle_output)
        _check_cancelled(cancelled)
        workdir = Path(tempfile.mkdtemp(prefix=".footage-work-", dir=str(job)))
        clip_paths: list[Path] = []
        for index, segment in enumerate(segments):
            _check_cancelled(cancelled)
            clip_output = workdir / f"shot-{index:04d}.mp4"
            _render_single_clip(
                segment,
                clip_output,
                width=width,
                height=height,
                fps=resolved_options["fps"],
                fit=resolved_options["fit"],
                ken_burns=resolved_options["ken_burns"],
                ffmpeg=ffmpeg,
                progress=lambda p, m, i=index: _notify(progress, int(55*(i+p/100)/len(segments)), m),
                cancelled=cancelled,
            )
            clip_paths.append(clip_output)
            _notify(progress, int((index + 1) / len(segments) * 55), f"prepared shot {segment['id']}")
        composed = workdir / "composed.mp4"
        _compose_video(
            clip_paths,
            composed,
            durations=[float(segment["duration_seconds"]) for segment in segments],
            transition=resolved_options["transition"],
            transition_seconds=resolved_options["transition_seconds"],
            width=width,
            height=height,
            fps=resolved_options["fps"],
            ffmpeg=ffmpeg,
            progress=lambda p, m: _notify(progress, 55+int(p*.18), m),
            cancelled=cancelled,
            total=total,
        )
        normalized_video = workdir / "normalized.mp4"
        _normalize_video_duration(
            composed,
            normalized_video,
            expected=total,
            ffmpeg=ffmpeg,
            ffprobe=ffprobe,
            progress=lambda p, m: _notify(progress, 73+int(p*.05), m),
            cancelled=cancelled,
        )
        ready_video = normalized_video
        subtitle_burned_in = False
        if resolved_options["subtitles"]["enabled"] and subtitle_bytes.strip() and _ffmpeg_has_filter(ffmpeg, "subtitles"):
            subtitled_video = workdir / "subtitled.mp4"
            command = [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(normalized_video),
                "-vf",
                _subtitle_filter(subtitle_output, resolved_options["subtitles"], width, height),
                "-an",
                "-t",
                _format_float(total),
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                "18",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
                "-progress",
                "pipe:1",
                "-nostats",
                str(subtitled_video),
            ]
            _run_ffmpeg(command, progress=lambda p, m: _notify(progress, 78+int(p*.1), m), cancelled=cancelled, duration_seconds=total, message="burning subtitles")
            ready_video = subtitled_video
            subtitle_burned_in = True
        elif resolved_options["subtitles"]["enabled"] and subtitle_bytes.strip():
            # Some minimal FFmpeg distributions omit libass and therefore the
            # subtitles filter.  The accurate UTF-8 SRT remains a valid,
            # editable subtitle deliverable; record that it was not burned in
            # rather than claiming an on-picture overlay that does not exist.
            raise RuntimeError('当前 FFmpeg 不支持字幕烧录，请使用已安装的项目内 FFmpeg')
        has_audio = bool(audio_path or bgm_path or resolved_options["source_volume"] > 0)
        if has_audio:
            muxed = workdir / "muxed.mp4"
            _mux_audio(
                ready_video,
                muxed,
                project=project,
                segments=segments,
                total=total,
                options=resolved_options,
                audio_path=audio_path,
                bgm_path=bgm_path,
                ffmpeg=ffmpeg,
                progress=lambda p, m: _notify(progress, 88+int(p*.1), m),
                cancelled=cancelled,
            )
            ready_video = muxed
        _check_cancelled(cancelled)
        # ``final.mp4`` was checked as absent before work started.  Use an
        # atomic rename from our private job-local file so workers never expose
        # a half-written accepted output.
        if final_path.exists() or final_path.is_symlink():
            raise FileExistsError(f"render output already exists and will not be overwritten: {final_path}")
        os.replace(ready_video, final_path)
        created_files.append(final_path)
        probe = _probe_output(final_path, ffprobe)
        if abs(float(probe["duration_seconds"]) - total) > 0.15:
            raise RuntimeError(
                f"render duration mismatch: expected {total:.3f}s, got {float(probe['duration_seconds']):.3f}s"
            )
        if probe["width"] != width or probe["height"] != height:
            raise RuntimeError(
                f"render dimensions mismatch: expected {width}x{height}, got {probe['width']}x{probe['height']}"
            )
        if has_audio and not probe["has_audio"]:
            raise RuntimeError("audio was requested but final render has no audio stream")
        output_hash = _sha256(final_path)
        public_segments = []
        for segment in segments:
            public_segments.append(
                {
                    "id": segment["id"],
                    "text": segment["text"],
                    "source_path": segment["source_path"],
                    "source_sha256": segment["source_sha256"],
                    "in_seconds": segment["start_seconds"],
                    "out_seconds": min(segment["start_seconds"] + segment["duration_seconds"], segment['source_probe'].get('duration_seconds') or float('inf')),
                    "repeat_to_fill": segment['repeat_to_fill'],
                    "selected_source": segment['selected_source'],
                    "start_seconds": segment["start_seconds"],
                    "duration_seconds": segment["duration_seconds"],
                    "timeline_start_seconds": segment["timeline_start_seconds"],
                    "timeline_end_seconds": segment["timeline_end_seconds"],
                }
            )
        edit_payload = {
            "schema_version": "1.0",
            "status": "completed",
            "render": {
                "output_path": final_path.relative_to(project).as_posix(),
                "duration_seconds": probe["duration_seconds"],
                "width": width,
                "height": height,
                "fps": resolved_options["fps"],
            },
            "options": resolved_options,
            "segments": public_segments,
            "transition": {
                "type": resolved_options["transition"],
                "requested_seconds": resolved_options["transition_seconds"],
                "effective_seconds": min(
                    resolved_options["transition_seconds"],
                    *(float(item["duration_seconds"]) / 2 for item in segments),
                ),
            },
            "subtitle_path": subtitle_output.relative_to(project).as_posix(),
            "audio_path": audio_path.relative_to(project).as_posix() if audio_path else None,
            "bgm_path": bgm_path.relative_to(project).as_posix() if bgm_path else None,
            "subtitle_burned_in": subtitle_burned_in,
            "bgm_ducked": bool(resolved_options["duck_bgm"] and audio_path and bgm_path
                               and resolved_options["narration_volume"] > 0 and resolved_options["bgm_volume"] > 0),
        }
        _write_new_json(edit_output, edit_payload)
        created_files.append(edit_output)
        probe_payload = {
            "schema_version": "1.0",
            "status": "completed",
            "output": {
                "path": final_path.relative_to(project).as_posix(),
                "sha256": output_hash,
                "size_bytes": final_path.stat().st_size,
                "probe": probe,
            },
            "sources": [
                {
                    "id": segment["id"],
                    "path": segment["source_path"],
                    "sha256": segment["source_sha256"],
                    "probe": segment["source_probe"],
                    "in_seconds": segment["start_seconds"],
                    "out_seconds": min(segment["start_seconds"] + segment["duration_seconds"], segment['source_probe'].get('duration_seconds') or float('inf')),
                }
                for segment in segments
            ],
            "segments": public_segments,
            "options": resolved_options,
            "subtitle_burned_in": subtitle_burned_in,
        }
        _write_new_json(probe_output, probe_payload)
        created_files.append(probe_output)
        _notify(progress, 100, "footage render verified")
        return {
            "status": "completed",
            "output_path": final_path.relative_to(project).as_posix(),
            "subtitle_path": subtitle_output.relative_to(project).as_posix(),
            "edit_path": edit_output.relative_to(project).as_posix(),
            "probe_path": probe_output.relative_to(project).as_posix(),
            "duration_seconds": probe["duration_seconds"],
            "width": probe["width"],
            "height": probe["height"],
            "sha256": output_hash,
            "bgm_ducked": edit_payload["bgm_ducked"],
            "segments": public_segments,
        }
    except _Cancelled:
        _notify(progress, 0, "footage render cancelled")
        return {"status": "cancelled", "output_path": None, "subtitle_path": None, "edit_path": None, "segments": []}
    except Exception:
        # Retain diagnostic files and partial outputs; never confuse them
        # with a completed job or delete user-visible work automatically.
        raise
    finally:
        if workdir is not None:
            pass  # Retained for local inspection; cleanup is a separate user action.


__all__ = ["render_footage"]
