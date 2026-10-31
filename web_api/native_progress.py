"""Bounded local telemetry, separate from the worker's single JSON receipt.

Only fixed phases and numeric counters leave the tool. No prompts, paths,
provider messages or stdout are persisted here. This is telemetry, not proof
of completion or a sandbox for arbitrary tool code.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import stat
import time

FORMAT = 'openmontage.native-progress@1'
FILENAME = 'native-progress.jsonl'
MAX_BYTES = 1_048_576
MAX_EVENTS = 2048
PHASES = frozenset({
    'tool_started', 'tool_completed', 'tool_failed', 'query_started',
    'search_started', 'search_completed', 'download_started', 'download_validated',
    'clip_ready', 'corpus_loaded', 'candidate_started', 'media_verified',
    'thumbnails_ready', 'embedding_images', 'embedding_text', 'clip_indexed',
    'index_saving', 'index_saved',
    'candidates_processed',
})
COUNTERS = frozenset({'query_index', 'queries_total', 'clips_ready', 'candidates',
                     'indexed', 'skipped', 'failed_count', 'frames'})
SOURCES = frozenset({'pexels', 'pixabay', 'wikimedia', 'archive_org', 'coverr',
                     'mixkit', 'pond5_pd', 'nasa', 'local'})


def sanitize(event):
    if not isinstance(event, dict) or not isinstance(event.get('phase'), str) or event['phase'] not in PHASES:
        return None
    clean = {'phase': event['phase']}
    for key in COUNTERS:
        value = event.get(key)
        if type(value) is int and 0 <= value <= 1_000_000_000:
            clean[key] = value
    for key in ('reused', 'failed'):
        if type(event.get(key)) is bool:
            clean[key] = event[key]
    if isinstance(event.get('source'), str) and event['source'] in SOURCES:
        clean['source'] = event['source']
    return clean


class ProgressWriter:
    def __init__(self, run: Path, tool: str):
        self.job_id, self.tool, self.pid = run.name, tool, os.getpid()
        self.started, self.seq, self.size = time.monotonic(), 0, 0
        self.counts = {}
        self.fd = None
        try:
            self.fd = os.open(run / FILENAME, os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                              os.O_APPEND | os.O_NOFOLLOW, 0o600)
        except OSError:
            pass  # An unavailable observer must not stop useful work.

    def __call__(self, event):
        try:
            clean = sanitize(event)
            terminal = clean and clean['phase'] in {'tool_completed', 'tool_failed'}
            if self.fd is None or clean is None:
                return
            self.counts.update({key: clean[key] for key in COUNTERS if key in clean})
            if self.seq >= MAX_EVENTS: return
            # Reserve a final record even for chatty tools.
            if not terminal and (self.seq >= MAX_EVENTS - 1 or self.size >= MAX_BYTES - 2048):
                return
            row = dict(self.counts, **clean, format=FORMAT, job_id=self.job_id, tool=self.tool,
                       pid=self.pid, seq=self.seq + 1,
                       elapsed_seconds=round(time.monotonic() - self.started, 3))
            line = (json.dumps(row, ensure_ascii=True, allow_nan=False) + '\n').encode()
            if self.size + len(line) > MAX_BYTES:
                return
            written = os.write(self.fd, line)
            self.size += written
            if written != len(line):
                self.close()
                return
            self.seq += 1
        except Exception:
            self.close()

    def close(self):
        if self.fd is not None:
            fd, self.fd = self.fd, None
            try: os.close(fd)
            except OSError: pass


def read_progress(run: Path, tool: str, pid: int | None):
    """Read a bounded regular file, bound to this run and owned worker PID.

    A partial final append is ignored. Malformed, stale or mismatched records
    cannot overwrite authoritative job status or turn a task into a failure.
    """
    if type(pid) is not int or pid <= 0:
        return None
    try:
        fd = os.open(run / FILENAME, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_BYTES:
                return None
            content = stream.read(MAX_BYTES + 1)
        if len(content) > MAX_BYTES:
            return None
        latest, seq = None, 0
        lines = content.split(b'\n')[:-1]
        if len(lines) > MAX_EVENTS:
            return None
        for line in lines:
            event = json.loads(line)
            if not isinstance(event, dict): return None
            clean = sanitize(event)
            elapsed = event.get('elapsed_seconds')
            if (clean is None or event.get('format') != FORMAT or
                    event.get('job_id') != run.name or event.get('tool') != tool or
                    type(event.get('pid')) is not int or event['pid'] != pid or
                    type(event.get('seq')) is not int or event['seq'] != seq + 1 or
                    type(elapsed) not in (int, float) or not math.isfinite(elapsed) or elapsed < 0):
                return None
            if latest and elapsed < latest['elapsed_seconds']: return None
            seq += 1
            latest = dict(clean, seq=seq, elapsed_seconds=elapsed)
        return latest
    except (OSError, ValueError, TypeError, RecursionError, OverflowError):
        return None
