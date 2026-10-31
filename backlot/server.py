"""Backlot server — FastAPI app: board state API, SSE change feed, media.

The watcher observes ``projects/`` with watchfiles; on any change it bumps a
per-project version and wakes SSE subscribers, who tell the browser to
refetch state. The server never writes to project directories.
"""

from __future__ import annotations

import asyncio
import json
import time
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from backlot.state import (
    PROJECTS_DIR,
    REPO_ROOT,
    _hidden_project_dir,
    build_resume_payload,
    list_projects,
    load_board_state,
    summarize_project,
)

UI_DIR = Path(__file__).resolve().parent / "ui"
THUMB_CACHE_DIR = REPO_ROOT / ".backlot" / "thumbs"
THUMB_WIDTHS = (320, 640, 960)

# Paths inside a project whose changes are pure noise for the board.
_IGNORE_PARTS = {"node_modules", ".git", "__pycache__", ".cache"}

SSE_HEARTBEAT_SECONDS = 15


def _ui_html(name: str, assets: tuple[str, ...]) -> HTMLResponse:
    html = (UI_DIR / name).read_text(encoding="utf-8")
    for asset in assets:
        path = UI_DIR / asset
        if path.is_file():
            version = str(int(path.stat().st_mtime))
            html = html.replace(f"/ui/{asset}", f"/ui/{asset}?v={version}")
    return HTMLResponse(html)


class ChangeHub:
    """Fan-out of project-change notifications to SSE subscribers.

    Subscriptions are filtered: a board subscribed to one project only ever
    receives that project's ids, so unrelated-project bursts can't flood its
    queue and starve out the one notification it actually needs.
    """

    def __init__(self) -> None:
        self._subscribers: dict[asyncio.Queue, Optional[str]] = {}
        # Revisions are monotonic per project.  Browser clients use them to
        # discard an older queued notification that arrives after a newer
        # state fetch, which prevents stale responses from repainting a board.
        self._revisions: dict[str, int] = {}

    def subscribe(self, project_id: Optional[str] = None) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=64)
        self._subscribers[q] = project_id
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.pop(q, None)

    def publish(self, project_id: str) -> None:
        revision = self._revisions.get(project_id, 0) + 1
        self._revisions[project_id] = revision
        message = {"project_id": project_id, "revision": revision}
        for q, only in list(self._subscribers.items()):
            if only is not None and only != project_id:
                continue
            try:
                q.put_nowait(message)
            except asyncio.QueueFull:
                # Queue holds only THIS subscriber's relevant ids, so a full
                # queue already guarantees a pending wake-up → safe to drop.
                pass


hub = ChangeHub()

# Library summaries are expensive to derive (full state parse per project);
# cache per project and invalidate from the watcher.
_summary_cache: dict[str, dict] = {}


def _invalidate_summary(project_id: str) -> None:
    _summary_cache.pop(project_id, None)


def notify_project_changed(project_id: str) -> None:
    """Publish a same-process project change for writers outside the watcher."""

    _invalidate_summary(project_id)
    hub.publish(project_id)


def _cached_summaries() -> list[dict]:
    if not PROJECTS_DIR.is_dir():
        return []
    summaries = []
    for entry in sorted(PROJECTS_DIR.iterdir()):
        if not entry.is_dir() or _hidden_project_dir(entry.name):
            continue
        cached = _summary_cache.get(entry.name)
        if cached is None:
            try:
                cached = summarize_project(entry)
            except Exception:
                cached = {
                    "project_id": entry.name, "title": entry.name,
                    "pipeline_type": "unknown", "has_pipeline_state": False,
                    "project_kind": "legacy", "workflow_mode": None,
                    "entry_mode": None, "prompt": "",
                    "resume_phase": None,
                    "resume_url": f"/p/{quote(entry.name, safe='')}",
                    "board_url": f"/p/{quote(entry.name, safe='')}",
                    "poster": None, "live": False, "last_activity": 0,
                    "active_stage": None, "awaiting_human": False,
                    "resume_stage": None, "resume_status": None,
                    "stage_states": [], "completed_count": 0,
                    "render_count": 0, "scene_count": 0,
                    "duplicate_count": 1, "duplicate_project_ids": [entry.name],
                    "analysis_frame_count": 0, "face_tracking_count": 0,
                    "error": "unreadable",
                }
            _summary_cache[entry.name] = cached
        summaries.append(cached)
    def lineage_key(summary: dict) -> tuple[str, ...] | None:
        # Collapse only browser-created planning drafts. Production and legacy
        # projects are kept as separate cards even when their titles match.
        if summary.get("project_kind") != "draft":
            return None
        prompt = " ".join(str(summary.get("prompt") or summary.get("title") or "").split()).casefold()
        if not prompt:
            return None
        return (
            "draft",
            prompt,
            str(summary.get("workflow_mode") or "quality").casefold(),
            str(summary.get("entry_mode") or "guided").casefold(),
        )

    grouped: dict[tuple[str, ...], list[dict]] = {}
    visible: list[dict] = []
    for summary in summaries:
        key = lineage_key(summary)
        if key is None:
            visible.append(summary)
        else:
            grouped.setdefault(key, []).append(summary)
    for versions in grouped.values():
        versions.sort(
            key=lambda item: (bool(item.get("live")), item.get("last_activity") or 0),
            reverse=True,
        )
        primary = versions[0]
        primary["duplicate_count"] = len(versions)
        primary["duplicate_project_ids"] = [str(item.get("project_id")) for item in versions]
        visible.append(primary)
    visible.sort(key=lambda s: (not s["live"], -(s["last_activity"] or 0)))
    return visible


# Watch-loop hot path: pure string comparison, no per-path filesystem calls
# (change batches can be thousands of paths during a render).
import os as _os

_PROJECTS_ROOT_STR = _os.path.normcase(str(PROJECTS_DIR.resolve()))


def _project_of_change(path_str: str) -> Optional[str]:
    """Map a changed filesystem path to a project id (None = irrelevant)."""
    norm = _os.path.normcase(_os.path.normpath(path_str))
    if not norm.startswith(_PROJECTS_ROOT_STR):
        return None
    rel = norm[len(_PROJECTS_ROOT_STR):].lstrip("\\/")
    if not rel:
        return None
    parts = rel.replace("\\", "/").split("/")
    if _IGNORE_PARTS.intersection(parts):
        return None
    return parts[0]


def _timeline_instant(value: object) -> Optional[datetime]:
    """Parse a persisted timestamp as an aware UTC instant.

    Checkpoints/events from older runs may use naive ISO timestamps; those are
    interpreted as UTC for compatibility.  Invalid values are rejected before
    they can become an ``inf`` sort key or an unusable replay frame.
    """

    if not isinstance(value, str):
        return None
    raw = value.strip()
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        parsed = parsed.astimezone(timezone.utc)
        # datetime.timestamp() can raise for out-of-range values on some
        # platforms; evaluating it here keeps the route's filter complete.
        parsed.timestamp()
        return parsed
    except (TypeError, ValueError, OverflowError, OSError):
        return None


_REPLAY_MERGE_WINDOW_SECONDS = 0.25


def _semantic_replay_frames(points: list[tuple[datetime, dict, str]]) -> list[dict]:
    """Return replay nodes only when the visible workflow actually changes.

    A single draft save writes several checkpoints in quick succession.  The
    old implementation treated each filesystem write as a separate replay
    node, so one save looked like eight rapid transitions and made the UI
    appear to flicker.  We first merge writes in a short time window, then
    compare the cumulative stage/event state with the previous node.  Exact
    timestamps are still retained on each item for auditability.
    """

    if not points:
        return []

    # Group nearby writes by the beginning of the current burst rather than
    # by exact equality.  Checkpoint writers can differ by a few milliseconds,
    # while genuinely separate creator actions are normally farther apart.
    bursts: list[tuple[datetime, list[tuple[datetime, dict, str]]]] = []
    for instant, point, raw_timestamp in points:
        if bursts and (instant - bursts[-1][0]).total_seconds() <= _REPLAY_MERGE_WINDOW_SECONDS:
            bursts[-1][1].append((instant, point, raw_timestamp))
        else:
            bursts.append((instant, [(instant, point, raw_timestamp)]))

    frames: list[dict] = []
    stage_state: dict[str, str] = {}
    last_event_signature: tuple[object, ...] | None = None
    for _burst_start, burst in bursts:
        items: list[dict] = []
        stages: list[dict] = []
        events: list[dict] = []
        kinds: list[str] = []
        changes: list[str] = []
        frame_stage: str | None = None
        frame_status: str | None = None
        frame_event: str | None = None
        for _instant, point, raw_timestamp in burst:
            item = dict(point)
            item["timestamp"] = raw_timestamp
            items.append(item)
            kind = str(item.get("kind") or "event")
            if kind not in kinds:
                kinds.append(kind)
            if kind == "stage":
                stages.append(item)
                stage = str(item.get("stage") or "")
                status = str(item.get("status") or "pending")
                if stage:
                    previous = stage_state.get(stage)
                    stage_state[stage] = status
                    # A first observation of the default pending state is not
                    # a creator-visible transition; keep it in the snapshot
                    # without cluttering the change summary.
                    if previous is not None and previous != status:
                        changes.append(f"{stage}: {previous} → {status}")
                        # The last changed stage is the most useful headline
                        # for a burst (usually the gate the creator sees).
                        frame_stage = stage
                        frame_status = status
                    elif previous is None and status != "pending":
                        changes.append(f"{stage}: pending → {status}")
                        frame_stage = stage
                        frame_status = status
            else:
                events.append(item)
                signature = (
                    item.get("stage"), item.get("event"), item.get("tool"),
                    item.get("task_id"), item.get("status"),
                )
                if signature != last_event_signature:
                    label = str(item.get("event") or item.get("status") or "更新")
                    changes.append(f"event: {label}")
                    last_event_signature = signature
                    frame_stage = (str(item.get("stage") or "") or frame_stage)
                    frame_status = frame_status or (str(item.get("status") or "") or None)
                    frame_event = label

        # A repeated checkpoint burst with no changed stage or event is not a
        # useful replay boundary.  Its raw records remain available in the
        # board history; Replay should only show creator-visible transitions.
        if not changes:
            continue

        last_instant, _last_point, last_raw_timestamp = burst[-1]
        frame: dict[str, object] = {
            # Use the end of the burst so scrubbing to this node includes all
            # checkpoint writes represented by it.
            "timestamp": last_raw_timestamp,
            "instant": last_instant.isoformat().replace("+00:00", "Z"),
            "kind": "semantic_frame",
            "items": items,
            "stages": stages,
            "events": events,
            "kinds": kinds,
            "changes": changes,
            "stage_snapshot": [
                {"stage": stage, "status": status}
                for stage, status in sorted(stage_state.items())
            ],
        }
        if frame_stage:
            frame["stage"] = frame_stage
        if frame_status:
            frame["status"] = frame_status
        if frame_event:
            frame["event"] = frame_event
        subject = frame_stage or (str(events[0].get("tool") or "制作") if events else "制作")
        outcome = frame_event or frame_status or "更新"
        frame["label"] = f"{subject} · {outcome}"
        frame["point_count"] = len(items)
        frame["stage_count"] = len(stages)
        frame["event_count"] = len(events)
        # These aliases make the contract useful to both the original board
        # (which calls them timeline points) and newer consumers that speak in
        # terms of semantic frames/entries.
        frame["entries"] = items
        frames.append(frame)
    return frames


async def _watch_projects() -> None:
    """Background task: watch projects/ and publish debounced changes."""
    try:
        from watchfiles import awatch
    except ImportError:
        return  # watcher unavailable → board still works via manual refresh
    if not PROJECTS_DIR.is_dir():
        return
    async for changes in awatch(PROJECTS_DIR, recursive=True, step=400):
        touched: set[str] = set()
        for _change, path_str in changes:
            pid = _project_of_change(path_str)
            if pid:
                touched.add(pid)
        for pid in touched:
            _invalidate_summary(pid)
            hub.publish(pid)


@asynccontextmanager
async def _lifespan(app: FastAPI):
    """Own and cleanly stop the project watcher with FastAPI's lifespan API."""

    task = asyncio.create_task(_watch_projects())
    app.state.watch_task = task
    try:
        yield
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task


def create_app() -> FastAPI:
    app = FastAPI(title="Backlot", docs_url=None, redoc_url=None, lifespan=_lifespan)

    # ---- API ----------------------------------------------------------

    @app.get("/api/health")
    async def health() -> dict:
        return {"ok": True, "app": "backlot"}

    @app.get("/api/projects")
    async def projects() -> list:
        return await asyncio.to_thread(_cached_summaries)

    @app.get("/api/project/{project_id}/state")
    async def project_state(project_id: str) -> dict:
        project_dir = _safe_project_dir(project_id)
        return await asyncio.to_thread(load_board_state, project_dir)

    @app.get("/api/project/{project_id}/resume")
    async def project_resume(project_id: str) -> dict:
        """Return the read-only workflow hand-off for a project."""

        project_dir = _safe_project_dir(project_id)
        return await asyncio.to_thread(build_resume_payload, project_dir)

    @app.get("/api/project/{project_id}/replay")
    async def project_replay(project_id: str) -> dict:
        """Return the persisted run timeline used by the Replay Run control."""

        project_dir = _safe_project_dir(project_id)
        state = await asyncio.to_thread(load_board_state, project_dir)
        raw_points: list[tuple[datetime, dict, str]] = []
        invalid_count = 0
        for stage in state.get("stages", []):
            for entry in stage.get("history_entries", []):
                raw_timestamp = entry.get("timestamp")
                instant = _timeline_instant(raw_timestamp)
                if instant is None:
                    if raw_timestamp:
                        invalid_count += 1
                    continue
                raw_points.append((instant, {
                        "kind": "stage",
                        "stage": stage.get("name"),
                        "status": entry.get("status"),
                    }, raw_timestamp))
        for event in state.get("events", []):
            raw_timestamp = event.get("ts")
            instant = _timeline_instant(raw_timestamp)
            if instant is None:
                if raw_timestamp:
                    invalid_count += 1
                continue
            raw_points.append((instant, {
                    "kind": "event",
                    "stage": event.get("stage"),
                    "event": event.get("event"),
                    "tool": event.get("tool"),
                    "task_id": event.get("task_id"),
                    "status": event.get("status"),
                }, raw_timestamp))

        raw_points.sort(key=lambda item: item[0])
        semantic_frames = _semantic_replay_frames(raw_points)
        current_total = len(semantic_frames)
        return {
            "project_id": project_id,
            "title": state.get("title"),
            "can_replay": current_total >= 2,
            "reason": None if current_total >= 2 else "至少需要两个持久化时间点才能重放",
            # ``timeline`` remains the compatibility name used by the
            # existing board; its values are now the same merged semantic
            # frames returned by the explicit field.
            "timeline": semantic_frames,
            "semantic_frames": semantic_frames,
            "frames": semantic_frames,
            "current_total": current_total,
            "total": current_total,
            "frame_count": current_total,
            "total_frames": current_total,
            "invalid_count": invalid_count,
        }

    @app.get("/api/project/{project_id}/events")
    async def project_events(project_id: str, request: Request) -> StreamingResponse:
        _safe_project_dir(project_id)  # 404 early for unknown projects

        async def stream():
            q = hub.subscribe(project_id)
            try:
                yield _sse({"type": "hello", "project_id": project_id})
                while True:
                    if await request.is_disconnected():
                        return
                    try:
                        changed = await asyncio.wait_for(q.get(), timeout=SSE_HEARTBEAT_SECONDS)
                    except asyncio.TimeoutError:
                        yield _sse({"type": "heartbeat", "ts": time.time()})
                        continue
                    # Coalesce bursts: drain anything else queued.
                    while not q.empty():
                        try:
                            changed = q.get_nowait()
                        except asyncio.QueueEmpty:
                            break
                    revision = changed.get("revision") if isinstance(changed, dict) else None
                    yield _sse({"type": "change", "project_id": project_id, "revision": revision})
            finally:
                hub.unsubscribe(q)

        return StreamingResponse(stream(), media_type="text/event-stream", headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        })

    @app.get("/api/library/events")
    async def library_events(request: Request) -> StreamingResponse:
        async def stream():
            q = hub.subscribe()
            try:
                yield _sse({"type": "hello"})
                while True:
                    if await request.is_disconnected():
                        return
                    try:
                        changed = await asyncio.wait_for(q.get(), timeout=SSE_HEARTBEAT_SECONDS)
                    except asyncio.TimeoutError:
                        yield _sse({"type": "heartbeat", "ts": time.time()})
                        continue
                    while not q.empty():
                        try:
                            changed = q.get_nowait()
                        except asyncio.QueueEmpty:
                            break
                    if isinstance(changed, dict):
                        changed_project = changed.get("project_id")
                        revision = changed.get("revision")
                    else:  # compatibility with an older in-process publisher
                        changed_project = changed
                        revision = None
                    yield _sse({"type": "change", "project_id": changed_project, "revision": revision})
            finally:
                hub.unsubscribe(q)

        return StreamingResponse(stream(), media_type="text/event-stream", headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        })

    # ---- Thumbnails (downscaled, cached on disk) ------------------------

    @app.get("/thumb/{project_id}/{file_path:path}")
    async def thumb(project_id: str, file_path: str, w: int = 640) -> FileResponse:
        project_dir = _safe_project_dir(project_id)
        target = (project_dir / file_path).resolve()
        try:
            target.relative_to(project_dir.resolve())
        except ValueError:
            raise HTTPException(status_code=403, detail="path escapes project")
        if not target.is_file():
            raise HTTPException(status_code=404, detail="media not found")
        width = min(THUMB_WIDTHS, key=lambda x: abs(x - w))
        cached = await asyncio.to_thread(_thumbnail_for, target, width)
        if cached is None:
            # Never fall back to raw video bytes for an <img> consumer (F-03);
            # non-thumbable images are safe to serve as-is.
            if target.suffix.lower() in {".mp4", ".webm", ".mov"}:
                raise HTTPException(status_code=404, detail="no poster frame available")
            return FileResponse(target)
        return FileResponse(cached, media_type="image/jpeg")

    # ---- Media (range requests handled by FileResponse) ---------------

    @app.get("/media/{project_id}/{file_path:path}")
    async def media(project_id: str, file_path: str) -> FileResponse:
        project_dir = _safe_project_dir(project_id)
        target = (project_dir / file_path).resolve()
        try:
            target.relative_to(project_dir.resolve())
        except ValueError:
            raise HTTPException(status_code=403, detail="path escapes project")
        if not target.is_file():
            raise HTTPException(status_code=404, detail="media not found")
        return FileResponse(target)

    # ---- UI ------------------------------------------------------------

    @app.get("/p/{project_id}")
    async def board_page(project_id: str) -> HTMLResponse:
        return _ui_html("board.html", ("board.css", "board.js"))

    @app.get("/p/{project_path:path}")
    async def board_page_path(project_path: str) -> HTMLResponse:
        return _ui_html("board.html", ("board.css", "board.js"))

    @app.get("/")
    async def library_page() -> HTMLResponse:
        return _ui_html("index.html", ("board.css", "library.js"))

    if UI_DIR.is_dir():
        app.mount("/ui", StaticFiles(directory=UI_DIR), name="ui")

    # The board is a long-lived SPA: a tab keeps running whatever board.js it
    # loaded, and browsers heuristically cache /ui assets. no-cache forces a
    # conditional revalidation (cheap 304 via ETag) on every load so UI fixes
    # show up on a plain refresh. Media/thumb responses keep normal caching.
    @app.middleware("http")
    async def ui_no_cache(request, call_next):
        response = await call_next(request)
        path = request.url.path
        if path == "/" or path.startswith("/ui") or path.startswith("/p/"):
            response.headers["Cache-Control"] = "no-cache"
        return response

    return app


def _safe_project_dir(project_id: str) -> Path:
    # ':' rejects Windows drive-relative ids like "C:" (PROJECTS_DIR / "C:"
    # collapses back to PROJECTS_DIR itself).
    if any(c in project_id for c in "/\\:") or project_id in (".", ".."):
        raise HTTPException(status_code=400, detail="invalid project id")
    project_dir = PROJECTS_DIR / project_id
    if not project_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"unknown project: {project_id}")
    return project_dir


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"


def _thumbnail_for(source: Path, width: int) -> Optional[Path]:
    """Downscale an image (or extract a video poster frame) to a cached JPEG."""
    suffix = source.suffix.lower()
    is_image = suffix in {".png", ".jpg", ".jpeg", ".webp", ".gif"}
    is_video = suffix in {".mp4", ".webm", ".mov"}
    if not (is_image or is_video):
        return None
    try:
        import hashlib
        stat = source.stat()
        key = hashlib.sha1(
            f"{source}|{stat.st_mtime_ns}|{stat.st_size}|{width}".encode()
        ).hexdigest()[:20]
        cached = THUMB_CACHE_DIR / f"{key}.jpg"
        if cached.is_file():
            return cached
        THUMB_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        # Unique temp per request — concurrent misses for the same source
        # must not write (and replace from) the same temp file.
        import uuid
        tmp = THUMB_CACHE_DIR / f"{key}.{uuid.uuid4().hex[:8]}.tmp.jpg"
        if is_video:
            import subprocess
            result = subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-ss", "1.5",
                 "-i", str(source), "-frames:v", "1",
                 "-vf", f"scale={width}:-2", str(tmp)],
                capture_output=True, timeout=30,
            )
            if result.returncode != 0 or not tmp.is_file():
                return None
        else:
            from PIL import Image
            with Image.open(source) as img:
                img = img.convert("RGB")
                img.thumbnail((width, width * 3))
                img.save(tmp, "JPEG", quality=82)
        tmp.replace(cached)
        return cached
    except Exception:
        return None


app = create_app()
