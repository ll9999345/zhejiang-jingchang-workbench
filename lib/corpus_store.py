"""Immutable corpus generations, published by one atomic metadata rename.

Old root-format files, failed attempts and committed versions are retained.
Readers validate all three files from one commit, never truncate mismatches.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time
import uuid

import numpy as np

FILES = ('index.jsonl', 'embeddings.npy', 'tag_embeddings.npy')
VERSIONS = '.corpus-generations'
COMMITS = '.corpus-commits'
COMMIT_NAME = re.compile(r'([0-9]{20})-([0-9a-f]{32})\.json')


class CorpusSnapshotError(ValueError):
    pass


class CorpusWriteConflict(RuntimeError):
    pass


@dataclass
class Snapshot:
    records: list
    visual: np.ndarray
    tags: np.ndarray
    directory: Path
    revision: object
    info: dict


def _regular(path):
    try:
        return stat.S_ISREG(path.lstat().st_mode)
    except OSError:
        return False


def _safe_directory(root, name, create=False):
    path = root / name
    if path.is_symlink():
        raise CorpusSnapshotError('Corpus storage directories must not be symlinks')
    if create:
        path.mkdir(exist_ok=True)
    if path.exists() and not path.is_dir():
        raise CorpusSnapshotError('Corpus storage directory is invalid')
    return path


def _sha(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def _commits(root):
    directory = _safe_directory(root, COMMITS)
    if not directory.exists():
        return []
    result = []
    for path in directory.iterdir():
        matched = COMMIT_NAME.fullmatch(path.name)
        if matched:
            result.append((int(matched[1]), matched[2], path))
    return sorted(result, key=lambda row: (row[0], row[2].name), reverse=True)


def _observed_revision(root, commits):
    # Bind the token to the exact head this reader enumerated. Re-scanning
    # here could attach a newer writer's revision to older snapshot data.
    if commits:
        path = commits[0][2]
        return ('commit', path.name, _sha(path) if _regular(path) else None)
    existing = [root / name for name in FILES if (root / name).exists() or (root / name).is_symlink()]
    if existing:
        return ('legacy', tuple((path.name, _sha(path) if _regular(path) else None) for path in existing))
    return None


def revision(root):
    return _observed_revision(root, _commits(root))


def _descriptor(path, generation):
    if not _regular(path) or path.stat().st_size > 32768:
        raise CorpusSnapshotError('Invalid corpus commit descriptor')
    value = json.loads(path.read_text(encoding='utf-8'))
    if (not isinstance(value, dict) or type(value.get('schema_version')) is not int or value['schema_version'] != 1 or
            value.get('generation') != generation or type(value.get('rows')) is not int or value['rows'] < 0 or
            type(value.get('embed_dim')) is not int or not isinstance(value.get('files'), dict) or set(value['files']) != set(FILES)):
        raise CorpusSnapshotError('Invalid corpus commit schema')
    for item in value['files'].values():
        if (not isinstance(item, dict) or not isinstance(item.get('sha256'), str) or
                re.fullmatch('[0-9a-f]{64}', item['sha256']) is None or
                type(item.get('bytes')) is not int or item['bytes'] < 0):
            raise CorpusSnapshotError('Invalid corpus file fingerprint')
    return value


def peek(root):
    """Cheap logical-path hint. load() performs full file validation."""
    root = Path(root)
    for _, generation, path in _commits(root):
        try:
            _descriptor(path, generation)
            return _safe_directory(_safe_directory(root, VERSIONS), generation)
        except (OSError, ValueError, TypeError, UnicodeError):
            continue
    return root


def _read_files(directory, decoder, dim, descriptor=None):
    paths = [directory / name for name in FILES]
    if not all(_regular(path) for path in paths):
        raise CorpusSnapshotError('Corpus index and both matrices must all exist')
    if descriptor is not None:
        if descriptor['embed_dim'] != dim:
            raise CorpusSnapshotError('Corpus embedding dimension changed')
        for path in paths:
            proof = descriptor['files'][path.name]
            if path.stat().st_size != proof['bytes'] or _sha(path) != proof['sha256']:
                raise CorpusSnapshotError('Corpus file fingerprint mismatch')
    records = []
    with paths[0].open(encoding='utf-8') as stream:
        for line in stream:
            if line.strip():
                records.append(decoder(**json.loads(line)))
    identities = [record.clip_id for record in records]
    if any(not isinstance(identity, str) or not identity for identity in identities) or len(set(identities)) != len(identities):
        raise CorpusSnapshotError('Corpus clip identifiers are invalid or duplicated')
    visual = np.load(paths[1], allow_pickle=False)
    tags = np.load(paths[2], allow_pickle=False)
    shape = (len(records), dim)
    if (visual.shape != shape or tags.shape != shape or not np.issubdtype(visual.dtype, np.number) or
            not np.issubdtype(tags.dtype, np.number) or np.iscomplexobj(visual) or np.iscomplexobj(tags) or not np.isfinite(visual).all() or not np.isfinite(tags).all()):
        raise CorpusSnapshotError('Corpus rows and embedding matrices do not match; originals retained')
    if descriptor is not None and descriptor['rows'] != len(records):
        raise CorpusSnapshotError('Corpus row count does not match its commit')
    return records, visual.astype(np.float32), tags.astype(np.float32)


def load(root, decoder, dim):
    root = Path(root)
    commits = _commits(root)
    base = _observed_revision(root, commits)
    rejected = 0
    for _, generation, path in commits:
        try:
            value = _descriptor(path, generation)
            directory = _safe_directory(_safe_directory(root, VERSIONS), generation)
            records, visual, tags = _read_files(directory, decoder, dim, value)
            return Snapshot(records, visual, tags, directory, base,
                {'format': 'generation_v1', 'generation': generation, 'commit': path.name,
                 'recovered': bool(rejected), 'rejected_commits': rejected,
                 'warnings': ['Loaded a previous complete corpus version; newer invalid files were retained.'] if rejected else []})
        except (OSError, ValueError, TypeError, KeyError, UnicodeError, EOFError):
            rejected += 1
    legacy_present = any((root / name).exists() or (root / name).is_symlink() for name in FILES)
    if legacy_present:
        try:
            records, visual, tags = _read_files(root, decoder, dim)
            return Snapshot(records, visual, tags, root, base,
                {'format': 'legacy', 'generation': None, 'recovered': bool(rejected),
                 'rejected_commits': rejected, 'warnings': ['Loaded retained legacy corpus after invalid commits.'] if rejected else []})
        except (OSError, ValueError, TypeError, KeyError, UnicodeError, EOFError) as error:
            raise CorpusSnapshotError('No complete corpus version is readable; original data retained') from None
    if commits:
        raise CorpusSnapshotError('No complete committed corpus version is readable; original data retained')
    return Snapshot([], np.zeros((0, dim), dtype=np.float32), np.zeros((0, dim), dtype=np.float32), root, base,
        {'format': 'empty', 'generation': None, 'recovered': False, 'warnings': []})


@contextmanager
def _locked(root):
    path = root / '.corpus-write.lock'
    if path.is_symlink():
        raise CorpusSnapshotError('Corpus lock must not be a symlink')
    try:
        from filelock import FileLock
    except ImportError:
        if os.name != 'posix':
            raise RuntimeError('Project filelock dependency is required')
        import fcntl
        with path.open('a+b') as stream:
            deadline = time.monotonic() + 60
            while True:
                try:
                    fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise TimeoutError('Corpus write lock deadline reached')
                    time.sleep(.05)
            try:
                yield
            finally:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
    else:
        with FileLock(str(path), timeout=60):
            yield


def _sync_directory(path):
    if os.name != 'posix':
        return False
    descriptor = os.open(path, os.O_RDONLY)
    try:
        try:
            os.fsync(descriptor)
            return True
        except OSError as error:
            if error.errno in {errno.EINVAL, errno.ENOTSUP}:
                return False
            raise
    finally:
        os.close(descriptor)


def publish(root, rows, visual, tags, dim, expected_revision):
    """Create a complete version and publish one new commit without overwrite."""
    root = Path(root)
    if np.iscomplexobj(visual) or np.iscomplexobj(tags):
        raise CorpusSnapshotError('Corpus embeddings must be real-valued')
    visual, tags = np.asarray(visual, dtype=np.float32).copy(), np.asarray(tags, dtype=np.float32).copy()
    shape = (len(rows), dim)
    ids = [row['clip_id'] for row in rows]
    if (visual.shape != shape or tags.shape != shape or not np.isfinite(visual).all() or not np.isfinite(tags).all() or
            any(not isinstance(identity, str) or not identity for identity in ids) or len(set(ids)) != len(ids)):
        raise CorpusSnapshotError('Cannot save an inconsistent corpus snapshot')
    root.mkdir(parents=True, exist_ok=True)
    with _locked(root):
        if revision(root) != expected_revision:
            raise CorpusWriteConflict('Corpus changed since load; stale writer must reload before saving')
        versions = _safe_directory(root, VERSIONS, create=True)
        commits_dir = _safe_directory(root, COMMITS, create=True)
        generation = uuid.uuid4().hex
        directory = versions / generation
        directory.mkdir(exist_ok=False)
        with (directory / FILES[0]).open('x', encoding='utf-8') as stream:
            for row in rows:
                stream.write(json.dumps(row, ensure_ascii=False, allow_nan=False) + '\n')
            stream.flush(); os.fsync(stream.fileno())
        for name, values in zip(FILES[1:], (visual, tags)):
            with (directory / name).open('xb') as stream:
                np.save(stream, values, allow_pickle=False)
                stream.flush(); os.fsync(stream.fileno())
        body = {'schema_version': 1, 'generation': generation, 'rows': len(rows), 'embed_dim': dim,
                'files': {name: {'sha256': _sha(directory / name), 'bytes': (directory / name).stat().st_size} for name in FILES}}
        pending = directory / 'commit.pending.json'
        with pending.open('x', encoding='utf-8') as stream:
            json.dump(body, stream, ensure_ascii=False, allow_nan=False, indent=2)
            stream.flush(); os.fsync(stream.fileno())
        synced = _sync_directory(directory) and _sync_directory(versions)
        if revision(root) != expected_revision:
            raise CorpusWriteConflict('Corpus changed during staging; no new commit was published')
        previous = _commits(root)
        sequence = previous[0][0] + 1 if previous else 1
        if sequence >= 10 ** 20:
            raise CorpusSnapshotError('Corpus sequence limit reached')
        destination = commits_dir / f'{sequence:020d}-{generation}.json'
        if destination.exists() or destination.is_symlink():
            raise CorpusWriteConflict('Corpus commit destination already exists')
        # Atomic rename of this attempt's own fully synced metadata. No old
        # commit, index, vector file or failed generation is removed/replaced.
        os.rename(pending, destination)
        warnings = []
        try:
            synced = _sync_directory(commits_dir) and _sync_directory(root) and synced
        except OSError:
            synced = False
            warnings.append('Complete commit is visible; directory durability sync was not confirmed.')
        return directory, revision(root), {'format': 'generation_v1', 'generation': generation,
            'commit': destination.name, 'recovered': False, 'warnings': warnings,
            'directory_sync_confirmed': synced}
