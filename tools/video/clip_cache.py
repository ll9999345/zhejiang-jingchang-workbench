"""Shared add-only clip byte cache.

Manifest rows are appended under a process lock; last complete row wins.
Each version is an independent immutable copy. Existing destinations, older
objects and incomplete files are retained. Capacity limits skip new cache
copies instead of deleting old media. Cache bytes are not semantic/codec
acceptance: CorpusBuilder verifies media before indexing.
"""
from __future__ import annotations

import json
import hashlib
import re
import stat
import os
import shutil
import tempfile
import time
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterator, Optional

try:
    import filelock  # type: ignore
    _HAVE_FILELOCK = True
except ImportError:
    _HAVE_FILELOCK = False


# Default 20 GB cap. Overridable via OPENMONTAGE_CACHE_MAX_GB.
_DEFAULT_MAX_TOTAL_BYTES = 20 * 1024 * 1024 * 1024

# Byte storage rejects empty files only; callers must verify media contents.
_MIN_USABLE_BYTES = 1


# ----------------------------------------------------------------------
# Config resolution
# ----------------------------------------------------------------------


def default_cache_dir() -> Path:
    """Resolve the cache directory.

    Honors ``OPENMONTAGE_CACHE_DIR`` if set, else falls back to
    ``~/.openmontage/clips_cache``. Does not create the directory —
    that happens in ``ClipCache.__init__`` on first use.
    """
    override = os.environ.get("OPENMONTAGE_CACHE_DIR")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".openmontage" / "clips_cache"


def default_max_total_bytes() -> int:
    """Resolve the max-cache-size budget.

    Honors ``OPENMONTAGE_CACHE_MAX_GB`` (float or int) if set, else
    returns the default 20 GB. Invalid overrides silently fall back to
    the default rather than crashing — the cache shouldn't bring down
    a production run over a bad env var.
    """
    override = os.environ.get("OPENMONTAGE_CACHE_MAX_GB")
    if override:
        try:
            return int(float(override) * 1024 * 1024 * 1024)
        except ValueError:
            pass
    return _DEFAULT_MAX_TOTAL_BYTES


# ----------------------------------------------------------------------
# Dataclass for one manifest row
# ----------------------------------------------------------------------


@dataclass
class CacheEntry:
    """One row in the cache manifest.

    Every field except ``clip_id``/``file_name``/``size_bytes`` is
    provenance metadata that the agent may want to display or attribute
    downstream. Stored flat (no nesting) so JSONL lines stay short.
    """

    clip_id: str
    file_name: str          # relative to cache_dir, e.g. "pexels_10039002.mp4"
    size_bytes: int
    added_at: float
    last_access_at: float
    source: str = ""
    source_id: str = ""
    source_url: str = ""
    license: str = ""
    creator: str = ""
    source_tags: str = ""
    sha256: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "CacheEntry":
        # Tolerate extra fields from future schema evolution — only
        # read the ones we know about. Missing fields default.
        return cls(
            clip_id=str(d["clip_id"]),
            file_name=str(d["file_name"]),
            size_bytes=int(d.get("size_bytes", 0) or 0),
            added_at=float(d.get("added_at", 0.0) or 0.0),
            last_access_at=float(
                d.get("last_access_at", d.get("added_at", 0.0)) or 0.0
            ),
            source=str(d.get("source", "") or ""),
            source_id=str(d.get("source_id", "") or ""),
            source_url=str(d.get("source_url", "") or ""),
            license=str(d.get("license", "") or ""),
            creator=str(d.get("creator", "") or ""),
            source_tags=str(d.get("source_tags", "") or ""),
            sha256=str(d.get("sha256", "") or ""),
        )


# ----------------------------------------------------------------------
# The cache itself
# ----------------------------------------------------------------------


class ClipCache:
    """Process-safe, add-only byte cache; old versions are never evicted.

    The JSONL manifest is an append-only ledger: the last complete row for a
    clip ID is current. Interrupted last rows are ignored, older rows remain.
    Media is copied independently both into and out of this cache.
    """
    MANIFEST_NAME = "cache_manifest.jsonl"
    LOCK_NAME = "cache_manifest.lock"

    def __init__(self, cache_dir=None, max_total_bytes=None):
        self.cache_dir = (Path(cache_dir) if cache_dir else default_cache_dir()).resolve()
        self.max_total_bytes = int(max_total_bytes) if max_total_bytes is not None else default_max_total_bytes()
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.manifest_path = self.cache_dir / self.MANIFEST_NAME
        self.lock_path = self.cache_dir / self.LOCK_NAME
        self.hits = self.misses = self.evictions_count = self.bytes_evicted = 0
        self.full_skips = 0

    @contextmanager
    def _locked(self, timeout=60.0):
        if self.lock_path.is_symlink():
            raise ValueError('Cache lock must not be a symlink')
        if _HAVE_FILELOCK:
            with filelock.FileLock(str(self.lock_path), timeout=timeout):
                yield
            return
        # Persistent POSIX advisory lock: no O_EXCL stale lock or unlink.
        if os.name != 'posix':
            raise RuntimeError('Install project filelock dependency for cache locking')
        import fcntl
        with self.lock_path.open('a+b') as lock:
            deadline = time.monotonic() + timeout
            while True:
                try:
                    fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise TimeoutError('Cache lock deadline reached')
                    time.sleep(.05)
            try:
                yield
            finally:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)

    def _read_manifest(self):
        entries = {}
        if self.manifest_path.is_symlink():
            return entries
        try:
            with self.manifest_path.open(encoding='utf-8') as stream:
                for line in stream:
                    try:
                        entry = CacheEntry.from_dict(json.loads(line))
                        entries[entry.clip_id] = entry
                    except (json.JSONDecodeError, KeyError, TypeError, ValueError):
                        continue
        except (OSError, UnicodeError):
            return entries
        return entries

    def _write_manifest(self, entries):
        """Append changed rows under the lock, retaining every original byte."""
        if self.manifest_path.is_symlink():
            raise ValueError('Cache manifest must not be a symlink')
        previous = self._read_manifest()
        changed = [entry for key, entry in entries.items() if previous.get(key) != entry]
        if not changed:
            return
        # A prior interrupted row may lack a newline. Keep its bytes and begin
        # a fresh line so the new complete row remains independently readable.
        needs_newline = False
        if self.manifest_path.exists() and self.manifest_path.stat().st_size:
            with self.manifest_path.open('rb') as stream:
                stream.seek(-1, 2); needs_newline = stream.read(1) != b'\n'
        with self.manifest_path.open('a', encoding='utf-8') as stream:
            if needs_newline:
                stream.write('\n')
            for entry in changed:
                stream.write(json.dumps(entry.to_dict(), ensure_ascii=False) + '\n')
            stream.flush(); os.fsync(stream.fileno())

    def _blob_path(self, file_name):
        relative = Path(file_name)
        if relative.is_absolute() or '..' in relative.parts or '\\' in file_name:
            return None
        path = self.cache_dir
        for part in relative.parts:
            path = path / part
            if path.is_symlink():
                return None
        try:
            if not stat.S_ISREG(path.stat().st_mode):
                return None
        except OSError:
            return None
        return path

    def _disk_bytes(self):
        total = 0
        for directory, dirs, names in os.walk(self.cache_dir, followlinks=False):
            dirs[:] = [name for name in dirs if not (Path(directory)/name).is_symlink()]
            for name in names:
                if Path(directory) == self.cache_dir and (name == self.LOCK_NAME or name.startswith('cache_manifest.')):
                    continue
                path = Path(directory) / name
                try:
                    if not path.is_symlink() and path.is_file(): total += path.stat().st_size
                except OSError:
                    continue
        return total

    def try_link(self, clip_id, dest):
        """Compatibility name: copy to a fresh destination; never unlink/link."""
        dest = Path(dest)
        if dest.exists() or dest.is_symlink():
            self.misses += 1
            return False
        with self._locked():
            entries = self._read_manifest(); entry = entries.get(clip_id)
            blob = self._blob_path(entry.file_name) if entry else None
            if blob is None:
                self.misses += 1
                return False
            try:
                digest = _digest(blob)
                if entry.size_bytes != blob.stat().st_size or (entry.sha256 and entry.sha256 != digest):
                    self.misses += 1; return False
                dest.parent.mkdir(parents=True, exist_ok=True)
                if not _link_or_copy(blob, dest) or _digest(dest) != digest:
                    self.misses += 1; return False
            except OSError:
                self.misses += 1; return False
            entry.last_access_at = time.time(); entry.sha256 = digest
            entries[clip_id] = entry; self._write_manifest(entries)
            self.hits += 1
            return True

    def ingest(self, clip_id, source_path, metadata=None):
        source_path = Path(source_path)
        try:
            if source_path.is_symlink() or not source_path.is_file(): return False
            before = _signature(source_path); size_bytes = before[2]
            if size_bytes < _MIN_USABLE_BYTES: return False
            digest = _digest(source_path)
        except OSError:
            return False
        metadata = dict(metadata or {})
        with self._locked():
            entries = self._read_manifest(); existing = entries.get(clip_id)
            if existing:
                blob = self._blob_path(existing.file_name)
                if blob is not None and _digest(blob) == digest:
                    existing.last_access_at = time.time(); existing.sha256 = digest
                    entries[clip_id] = existing; self._write_manifest(entries)
                    return True
            if not self._evict_to_fit_locked(entries, size_bytes):
                self.full_skips += 1
                return False
            objects = self.cache_dir / 'objects'
            if objects.is_symlink(): return False
            objects.mkdir(exist_ok=True)
            attempt = Path(tempfile.mkdtemp(prefix=hashlib.sha256(clip_id.encode()).hexdigest()[:16]+'-', dir=objects))
            ext = source_path.suffix.lower()
            if not re.fullmatch(r'\.[a-z0-9]{1,10}', ext): ext = '.bin'
            blob = attempt / ('asset' + ext)
            if not _link_or_copy(source_path, blob): return False
            if _signature(source_path) != before or _digest(blob) != digest: return False
            stamp = time.time()
            from urllib.parse import urlsplit
            address = str(metadata.get('source_url') or '')
            try:
                parsed = urlsplit(address)
                address = parsed._replace(query='', fragment='').geturl() if parsed.scheme in {'https','http'} and parsed.hostname and not parsed.username and not parsed.password else ''
            except ValueError:
                address = ''
            entries[clip_id] = CacheEntry(clip_id=clip_id, file_name=blob.relative_to(self.cache_dir).as_posix(),
                size_bytes=size_bytes, added_at=stamp, last_access_at=stamp, sha256=digest,
                source=str(metadata.get('source') or ''), source_id=str(metadata.get('source_id') or ''),
                source_url=address, license=str(metadata.get('license') or ''),
                creator=str(metadata.get('creator') or ''), source_tags=str(metadata.get('source_tags') or ''))
            self._write_manifest(entries)
            return True

    def _evict_to_fit_locked(self, entries, needed_bytes):
        """Compatibility name: capacity check only. Never delete old objects."""
        return needed_bytes >= 0 and self._disk_bytes() + needed_bytes <= self.max_total_bytes

    def stats(self):
        with self._locked(): entries = self._read_manifest(); disk_bytes = self._disk_bytes()
        total = sum(entry.size_bytes for entry in entries.values())
        return {'cache_dir':str(self.cache_dir),'entry_count':len(entries),'total_bytes':total,
                'total_mb':round(total/(1024*1024),1),'max_total_bytes':self.max_total_bytes,
                'max_total_gb':round(self.max_total_bytes/(1024**3),2),
                'usage_fraction':round(disk_bytes/self.max_total_bytes,3) if self.max_total_bytes>0 else 0.0,
                'retained_media_bytes':disk_bytes,'retention_policy':'keep_existing_skip_new_when_full',
                'hits_this_session':self.hits,'misses_this_session':self.misses,
                'evictions_this_session':self.evictions_count,'bytes_evicted_this_session':self.bytes_evicted,
                'full_skips_this_session':self.full_skips,
                'filelock_backend':'filelock' if _HAVE_FILELOCK else 'posix_flock'}


def _signature(path):
    info = path.stat()
    return (info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns)


def _digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda:stream.read(1024*1024),b''):result.update(block)
    return result.hexdigest()


def _link_or_copy(src, dst):
    """Compatibility name: exclusive independent copy, retaining partials."""
    src, dst = Path(src), Path(dst)
    try:
        with src.open('rb') as source, dst.open('xb') as output:
            shutil.copyfileobj(source, output, length=1024*1024)
        return True
    except OSError:
        return False


_DEFAULT_CACHE: Optional[ClipCache] = None


def get_default_cache() -> ClipCache:
    """Return a process-level default ``ClipCache`` at the default path.

    Lazily constructed on first call. Tests that want a pristine cache
    should instantiate ``ClipCache(cache_dir=tmp_path)`` directly
    rather than going through this accessor.
    """
    global _DEFAULT_CACHE
    if _DEFAULT_CACHE is None:
        _DEFAULT_CACHE = ClipCache()
    return _DEFAULT_CACHE


def reset_default_cache() -> None:
    """Drop the cached singleton so a subsequent ``get_default_cache()``
    re-reads env vars. Useful for tests that mutate ``OPENMONTAGE_CACHE_DIR``.
    """
    global _DEFAULT_CACHE
    _DEFAULT_CACHE = None
