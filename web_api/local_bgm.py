"""Free, local-only BGM import and duration adaptation.

The browser sends base64 bytes to this process; no provider, credential, or
network call is involved.  Both the untouched source and the adapted MP3 are
kept under the selected project and receive UUID names so an import never
replaces an accepted asset.
"""

from __future__ import annotations

import base64
import binascii
import json
import shutil
import subprocess
import uuid
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from web_api.media_pipeline import (
    PROJECT_ID_PATTERN,
    _atomic_bytes,
    _relative,
    _resolve_project,
    _resolve_project_file,
    _sha256,
    _utc_now,
    _write_manifest,
)


MAX_DECODED_BYTES = 40 * 1024 * 1024
MUSIC_OUTPUT_DIR = Path("assets") / "music"
AUDIO_EXTENSIONS = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".aiff", ".webm"}


class LocalBgmRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1, max_length=128)
    filename: str = Field(min_length=1, max_length=255)
    audio_base64: str = Field(min_length=1)
    duration_seconds: float = Field(ge=3, le=600)
    reference_video_path: str | None = Field(default=None, max_length=1024)

    @field_validator("project_id")
    @classmethod
    def _project(cls, value: str) -> str:
        value = value.strip()
        if not PROJECT_ID_PATTERN.fullmatch(value):
            raise ValueError("project_id 含有不支持的路径字符")
        return value

    @field_validator("filename")
    @classmethod
    def _filename(cls, value: str) -> str:
        value = value.strip()
        path = Path(value)
        if not value or path.name != value or value in {".", ".."}:
            raise ValueError("filename 必须是单一文件名，不能包含路径")
        if path.suffix.lower() not in AUDIO_EXTENSIONS:
            raise ValueError("filename 必须使用受支持的音频扩展名")
        return value

    @field_validator("reference_video_path")
    @classmethod
    def _reference(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        path = Path(value)
        if not value or path.is_absolute() or ".." in path.parts:
            raise ValueError("reference_video_path 必须是项目内相对路径")
        return value


def _decode_audio(value: str) -> bytes:
    raw = value.strip()
    if raw.lower().startswith("data:"):
        try:
            raw = raw.split(",", 1)[1]
        except IndexError as exc:
            raise ValueError("audio_base64 数据 URI 格式无效") from exc
    raw = "".join(raw.split())
    try:
        decoded = base64.b64decode(raw, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("audio_base64 不是有效的 Base64 数据") from exc
    if not decoded:
        raise ValueError("audio_base64 解码后为空")
    if len(decoded) > MAX_DECODED_BYTES:
        raise ValueError("音频解码后超过 40MB 大小限制")
    return decoded


def _probe_audio(path: Path) -> dict[str, Any]:
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        raise RuntimeError("未找到 ffprobe，无法验证真实音轨")
    proc = subprocess.run(
        [ffprobe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
        capture_output=True, text=True, timeout=30,
    )
    if proc.returncode != 0:
        raise ValueError("上传文件不是可解码的音频：" + (proc.stderr.strip() or "ffprobe 解析失败")[:300])
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise ValueError("ffprobe 返回了无效的音频信息") from exc
    streams = data.get("streams") or []
    audio = next((stream for stream in streams if stream.get("codec_type") == "audio"), None)
    if not audio:
        raise ValueError("上传文件没有可解码的真实音轨")
    try:
        duration = float((data.get("format") or {}).get("duration"))
    except (TypeError, ValueError):
        duration = 0.0
    if duration <= 0:
        raise ValueError("音频没有有效时长")
    return {"duration_seconds": round(duration, 3), "format": (data.get("format") or {}).get("format_name"), "audio": {"codec": audio.get("codec_name"), "channels": audio.get("channels"), "sample_rate": audio.get("sample_rate")}}


def import_local_bgm(request: LocalBgmRequest | dict[str, Any], project_root: str | Path) -> dict[str, Any]:
    """Import and adapt a local BGM, raising clear errors on every failure."""

    model = request if isinstance(request, LocalBgmRequest) else LocalBgmRequest.model_validate(request)
    project_dir = _resolve_project(project_root, model.project_id)
    source_bytes = _decode_audio(model.audio_base64)
    import_id = uuid.uuid4().hex
    output_dir = project_dir / MUSIC_OUTPUT_DIR
    output_dir.mkdir(parents=True, exist_ok=True)
    source = output_dir / f"{import_id}_source{Path(model.filename).suffix.lower()}"
    output = output_dir / f"{import_id}.mp3"
    _atomic_bytes(source, source_bytes)
    try:
        source_probe = _probe_audio(source)
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            raise RuntimeError("未找到 ffmpeg，无法适配 BGM 时长")
        fade_start = max(0.0, float(model.duration_seconds) - 1.0)
        command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-stream_loop", "-1", "-i", str(source), "-t", f"{float(model.duration_seconds):.6f}", "-af", f"afade=t=out:st={fade_start:.6f}:d=1", "-vn", "-codec:a", "libmp3lame", "-b:a", "192k", str(output)]
        proc = subprocess.run(command, capture_output=True, text=True, timeout=300)
        if proc.returncode != 0 or not output.is_file() or output.stat().st_size <= 0:
            raise RuntimeError("ffmpeg 时长适配失败：" + (proc.stderr.strip() or "未生成有效 MP3")[:400])
        output_probe = _probe_audio(output)
        measured = float(output_probe["duration_seconds"])
        if abs(measured - float(model.duration_seconds)) > 0.15:
            raise RuntimeError(f"适配后时长校验失败：期望 {model.duration_seconds:.3f}s，实际 {measured:.3f}s")
    except Exception:
        output.unlink(missing_ok=True)
        raise

    reference: dict[str, Any] = {"path": None}
    if model.reference_video_path:
        reference_path = _resolve_project_file(project_dir, model.reference_video_path, must_exist=True)
        reference = {"path": _relative(project_dir, reference_path), "sha256": _sha256(reference_path), "size_bytes": reference_path.stat().st_size}
    manifest, manifest_hash = _write_manifest(project_dir, f"local_bgm_manifest_{import_id}.json", {"schema_version": "1.0", "project_id": model.project_id, "stage": "local_bgm_import", "status": "completed", "created_at": _utc_now(), "provider": "local_import", "source": {"path": _relative(project_dir, source), "filename": model.filename, "sha256": _sha256(source), "size_bytes": source.stat().st_size, "probe": source_probe}, "output": {"path": _relative(project_dir, output), "sha256": _sha256(output), "size_bytes": output.stat().st_size, "duration_seconds": output_probe["duration_seconds"], "probe": output_probe}, "reference": reference, "cost_cny": 0})
    output_hash = _sha256(output)
    return {"status": "completed", "project_id": model.project_id, "music": {"path": _relative(project_dir, output), "sha256": output_hash, "size_bytes": output.stat().st_size, "duration_seconds": output_probe["duration_seconds"], "format": "mp3"}, "output": {"path": _relative(project_dir, output), "kind": "audio", "sha256": output_hash}, "reference": reference, "cost_cny": 0, "provider": "local_import", "manifest": {"path": _relative(project_dir, manifest), "sha256": manifest_hash}}

