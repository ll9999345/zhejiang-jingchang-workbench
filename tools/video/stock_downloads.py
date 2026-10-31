"""Add-only stock downloads. A validated receipt is the completion boundary.

Interrupted files stay in their unique attempt directory, without a completion
receipt. No prior media or failed attempt is deleted, replaced or promoted just
because its byte count is large. No provider response or URL is persisted here.
"""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import time


_FORMATS = 'mov,matroska,webm,ogg,image2,png_pipe,jpeg_pipe,tiff_pipe,webp_pipe,bmp_pipe,gif'


class DownloadDeadlineExceeded(TimeoutError):
    pass


class InvalidDownloadedMedia(ValueError):
    pass


def _remaining(deadline):
    value = deadline - time.time()
    if value <= 0:
        raise DownloadDeadlineExceeded('Stock media verification deadline reached')
    return value


def _regular(path):
    try:
        info = path.lstat()
    except OSError:
        return None
    return info if stat.S_ISREG(info.st_mode) and info.st_nlink == 1 else None


def _signature(path):
    info = _regular(path)
    if info is None:
        raise InvalidDownloadedMedia('Media must be a regular, independent local file')
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _sha256(path, deadline):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            _remaining(deadline)
            digest.update(block)
    return digest.hexdigest()


def _run(command, deadline):
    try:
        result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True,
                                text=True, timeout=_remaining(deadline))
    except subprocess.TimeoutExpired as error:
        raise DownloadDeadlineExceeded('Stock media verification deadline reached') from error
    except FileNotFoundError as error:
        raise InvalidDownloadedMedia('Local ffmpeg and ffprobe are required to verify stock media') from error
    if result.returncode:
        # Decoder stderr may include untrusted content/URLs. Never persist it.
        raise InvalidDownloadedMedia('Downloaded media did not pass local verification')
    return result.stdout


def validate_media(path: Path, kind: str, deadline: float) -> dict:
    """Probe and fully decode the visual stream using local-file protocols only."""
    before = _signature(path)
    if before[2] == 0 or kind not in {'image', 'video'}:
        raise InvalidDownloadedMedia('Downloaded media is empty or has an unsupported kind')
    raw = _run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', _FORMATS, '-select_streams', 'v:0',
                '-show_entries', 'stream=codec_name,width,height:format=format_name,duration',
                '-of', 'json', str(path)], deadline)
    try:
        info = json.loads(raw); stream = info['streams'][0]
        width, height = int(stream['width']), int(stream['height'])
        duration = float(info.get('format', {}).get('duration') or 0)
        image_format = any(name in info.get('format', {}).get('format_name', '').split(',')
                           for name in ('image2', 'png_pipe', 'jpeg_pipe', 'tiff_pipe', 'webp_pipe', 'bmp_pipe', 'gif'))
        if width <= 0 or height <= 0 or not math.isfinite(duration):
            raise ValueError
        if kind == 'video' and (duration <= 0 or image_format):
            raise ValueError
        if kind == 'image' and not image_format:
            raise ValueError
    except (ValueError, TypeError, KeyError, IndexError, AttributeError) as error:
        raise InvalidDownloadedMedia('Downloaded file has no valid visual stream for its requested kind') from error
    progress = _run(['ffmpeg', '-nostdin', '-hide_banner', '-v', 'error', '-xerror',
                     '-protocol_whitelist', 'file,pipe', '-format_whitelist', _FORMATS, '-threads', '1', '-i', str(path), '-map', '0:v:0', '-threads', '1',
                     '-progress', 'pipe:1', '-nostats', '-f', 'null', '-'], deadline)
    frames = [int(value) for key, separator, value in (line.partition('=') for line in progress.splitlines())
              if separator and key == 'frame' and value.strip().isdigit()]
    if not frames or max(frames) < 1 or _signature(path) != before:
        raise InvalidDownloadedMedia('Downloaded media changed or could not be completely decoded')
    return {'kind': kind, 'width': width, 'height': height, 'duration': duration,
            'decoded_frames': max(frames), 'validation': 'local_visual_stream_full_decode'}


class StockDownloadStore:
    """Cache completed independent attempts; keep legacy media read-only."""
    def __init__(self, clips_dir: Path):
        self.clips_dir = clips_dir.resolve()
        self.root = self.clips_dir / '.verified-stock'

    def _bucket(self, clip_id):
        return self.root / hashlib.sha256(clip_id.encode()).hexdigest()

    def _safe_parent(self, path, *, create=False):
        # Every cache parent must remain inside this store and not be a symlink.
        relative = path.relative_to(self.clips_dir)
        current = self.clips_dir
        for part in relative.parts:
            current = current / part
            if current.is_symlink():
                raise InvalidDownloadedMedia('Stock cache directory must not be a symlink')
            if create:
                current.mkdir(exist_ok=True)
            if not current.is_dir():
                return False
        return True

    @staticmethod
    def _completion_time(attempt):
        if attempt.is_symlink():
            return 0
        info = _regular(attempt / 'complete.json')
        return info.st_mtime_ns if info else 0

    def find(self, clip_id, ext, kind, deadline):
        bucket = self._bucket(clip_id)
        if self._safe_parent(bucket):
            for attempt in sorted(bucket.iterdir(), key=self._completion_time, reverse=True):
                _remaining(deadline)
                if not attempt.is_dir() or attempt.is_symlink():
                    continue
                receipt_path = attempt / 'complete.json'
                receipt_info = _regular(receipt_path)
                if receipt_info is None or receipt_info.st_size > 8192:
                    continue
                try:
                    receipt = json.loads(receipt_path.read_text())
                    if receipt.get('version') != 1 or receipt.get('clip_id') != clip_id or receipt.get('kind') != kind or receipt.get('filename') != 'asset' + ext or receipt.get('media', {}).get('validation') != 'local_visual_stream_full_decode':
                        continue
                    path = attempt / ('asset' + ext)
                    before = _signature(path)
                    if receipt.get('bytes') == before[2] and receipt.get('sha256') == _sha256(path, deadline) and _signature(path) == before:
                        return path, receipt['media']
                except DownloadDeadlineExceeded:
                    raise
                except (OSError, ValueError, TypeError, AttributeError):
                    continue
        # Legacy files have no proof of a completed call: fully verify before
        # reuse and never edit them or create replacement data at their path.
        if re.fullmatch(r'[A-Za-z0-9_-]{1,220}', clip_id):
            legacy = self.clips_dir / (clip_id + ext)
            if _regular(legacy):
                try:
                    media = validate_media(legacy, kind, deadline)
                    return legacy, media
                except InvalidDownloadedMedia:
                    pass
        return None

    def allocate(self, clip_id, ext):
        bucket = self._bucket(clip_id)
        self._safe_parent(bucket, create=True)
        attempt = Path(tempfile.mkdtemp(prefix='download-', dir=bucket))
        return attempt / ('asset' + ext)

    def complete(self, path, clip_id, kind, deadline):
        self._safe_parent(path.parent)
        before = _signature(path)
        media = validate_media(path, kind, deadline)
        sha256 = _sha256(path, deadline)
        if _signature(path) != before:
            raise InvalidDownloadedMedia('Downloaded media changed during validation')
        receipt = {'version': 1, 'clip_id': clip_id, 'kind': kind, 'filename': path.name,
                   'bytes': before[2], 'sha256': sha256, 'media': media}
        _remaining(deadline)
        # Exclusive creation: a previous receipt is never overwritten. A crash
        # during this write leaves unreadable JSON that find() ignores.
        with (path.parent / 'complete.json').open('x') as file:
            json.dump(receipt, file, ensure_ascii=False, indent=2)
        return media
