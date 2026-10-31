"""BoardState derivation — turn a project directory into renderable state.

Everything here is read-only and defensive: a malformed JSON file, a missing
artifact, or a half-written checkpoint must degrade the board, never crash it
(design principle: "never block, never break").
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional
from urllib.parse import quote

from lib.events import read_events
from lib.paths import PROJECTS_DIR, REPO_ROOT  # single source of truth (env-overridable)

MEDIA_IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"}
MEDIA_VIDEO_EXT = {".mp4", ".webm", ".mov"}
# Keep the board's media inventory in step with the OpenMontage media API.
# AAC and FLAC are common exports from phone recorders and transcription
# tools; omitting them made real files invisible in the project board.
MEDIA_AUDIO_EXT = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"}
# Subtitle files are first-class project outputs.  They used to be written by
# the media pipeline but were invisible in the Backlot inventory, which made a
# completed narration/subtitle stage look unfinished to the creator.
MEDIA_SUBTITLE_EXT = {".srt", ".vtt", ".ass", ".ssa", ".ttml", ".dfxp"}

# Directories inside a project we never scan for media (build noise).
SCAN_EXCLUDE = {"node_modules", ".git", "__pycache__", "history", ".cache"}

# Stages every pipeline shares (fallback rail when the manifest is unknown).
FALLBACK_STAGES = [
    "research", "proposal", "idea", "script", "scene_plan",
    "assets", "edit", "compose", "publish",
]

# How long (seconds) without filesystem activity before a board reads "idle".
LIVE_WINDOW_SECONDS = 5 * 60

# An in_progress stage with no filesystem activity for this long is flagged
# as possibly stalled (F-05: a wedged agent must be visible, not silent —
# heartbeat checkpoints and tool events both reset the clock).
STALL_WINDOW_SECONDS = 10 * 60

# ``workflow_state.json`` is the durable hand-off contract for the newer
# creator workflow.  Older OpenMontage projects pre-date that artifact and
# only have a marker/checkpoints, so the helpers below deliberately keep the
# fallback small and truthful instead of pretending that every legacy run is
# fully resumable.
WORKFLOW_STATE_FILENAME = "workflow_state.json"
_WORKFLOW_STATE_REQUIRED_FIELDS = ("project_kind", "workflow_mode", "resume_phase")
_ACTIVE_STAGE_STATUSES = {
    "in_progress", "awaiting_human", "awaiting_human_approval", "running",
    "needs_sources", "awaiting_local_assets", "blocked", "failed",
}


def _hidden_project_dir(name: str) -> bool:
    """Return whether a top-level directory is internal build/test noise.

    Older browser sessions created user drafts under ``_draft-*``.  Treating
    every underscore-prefixed directory as hidden made those real projects
    disappear from the library even though their artifacts were complete.
    Keep the internal fixture/live directories private while allowing legacy
    draft folders to be indexed and opened normally.
    """

    if name.startswith("."):
        return True
    return name.startswith("_") and not name.startswith("_draft-")


def _read_json(path: Path) -> Optional[dict]:
    """Read a JSON file, returning None on any failure."""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except (OSError, json.JSONDecodeError, UnicodeError):
        return None


def _safe_text(value: Any, *, limit: int = 200) -> Optional[str]:
    """Return a bounded, printable text value suitable for board metadata."""

    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text or any(ord(char) < 32 or ord(char) == 127 for char in text):
        return None
    return text[:limit]


def _mapping_value(mapping: Any, *paths: str) -> Any:
    """Read the first present dotted path from a JSON mapping."""

    if not isinstance(mapping, dict):
        return None
    for path in paths:
        value: Any = mapping
        for key in path.split("."):
            if not isinstance(value, dict) or key not in value:
                value = None
                break
            value = value[key]
        if value is not None:
            return value
    return None


def _first_text(*values: Any) -> Optional[str]:
    for value in values:
        text = _safe_text(value)
        if text is not None:
            return text
    return None


def _safe_local_url(value: Any) -> Optional[str]:
    """Accept only same-origin path URLs for resume links.

    A project artifact is local input, but it can still be stale or malformed.
    Rejecting absolute/external and protocol-relative URLs keeps a bad artifact
    from turning a board link into an unexpected navigation target.
    """

    text = _safe_text(value, limit=2048)
    if text is None or not text.startswith("/") or text.startswith("//"):
        return None
    if "://" in text or text.startswith(("/\\", "\\")):
        return None
    return text


def _project_url(project_id: str) -> str:
    return f"/p/{quote(project_id, safe='')}"


def _rel(project_dir: Path, path: Path) -> str:
    """Project-relative POSIX path for media URLs."""
    try:
        return path.resolve().relative_to(Path(project_dir).resolve()).as_posix()
    except (ValueError, OSError):
        return path.name


# ---------------------------------------------------------------------------
# Pipeline / stages
# ---------------------------------------------------------------------------

@lru_cache(maxsize=32)
def _load_pipeline_meta(pipeline_type: Optional[str]) -> dict[str, Any]:
    """Stage order + gate flags from the manifest; graceful fallback."""
    if pipeline_type and pipeline_type != "unknown":
        try:
            from lib.pipeline_loader import load_pipeline
            manifest = load_pipeline(pipeline_type)
            stages = [
                {
                    "name": s["name"],
                    "gated": bool(s.get("human_approval_default", False)),
                    "produces": [
                        str(name) for name in (s.get("produces") or [])
                        if isinstance(name, str) and name
                    ],
                }
                for s in manifest.get("stages", [])
                if isinstance(s, dict) and s.get("name")
            ]
            if stages:
                return {
                    "pipeline_type": pipeline_type,
                    "stages": stages,
                    "known": True,
                }
        except Exception:
            pass
    return {
        "pipeline_type": pipeline_type or "unknown",
        "stages": [{"name": s, "gated": False, "produces": []} for s in FALLBACK_STAGES],
        "known": False,
    }


def _resolve_artifact(project_dir: Path, value: Any) -> Optional[dict]:
    """Checkpoint artifacts may be inline dicts or path strings — resolve both.

    Path references are only followed INSIDE the project directory: a
    checkpoint must not be able to pull arbitrary JSON from elsewhere on
    disk onto the board (F-04).
    """
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value:
        p = Path(value)
        if not p.is_absolute():
            p = project_dir / value
        try:
            p.resolve().relative_to(Path(project_dir).resolve())
        except (ValueError, OSError):
            return None
        return _read_json(p)
    return None


def _collect_checkpoints(project_dir: Path) -> dict[str, dict]:
    """Current checkpoint per stage (raw dicts, unvalidated by design)."""
    out: dict[str, dict] = {}
    for path in sorted(project_dir.glob("checkpoint_*.json")):
        stage = path.stem[len("checkpoint_"):]
        data = _read_json(path)
        if data is not None:
            data["_mtime"] = path.stat().st_mtime
            out[stage] = data
    return out


def _collect_history(project_dir: Path) -> dict[str, list[dict]]:
    """Archived checkpoint versions per stage (oldest first)."""
    history_dir = project_dir / "history"
    out: dict[str, list[dict]] = {}
    if not history_dir.is_dir():
        return out
    for path in sorted(history_dir.glob("checkpoint_*.json")):
        m = re.match(r"checkpoint_(.+?)_\d", path.stem)
        stage = m.group(1) if m else path.stem[len("checkpoint_"):]
        data = _read_json(path)
        if data is not None:
            out.setdefault(stage, []).append(data)
    return out


def _build_stage_rail(
    pipeline_meta: dict,
    checkpoints: dict[str, dict],
    history: dict[str, list[dict]],
) -> list[dict]:
    """One entry per manifest stage with derived status + gate audit."""
    rail = []
    manifest_stage_names = {s["name"] for s in pipeline_meta["stages"]}
    for stage_def in pipeline_meta["stages"]:
        name = stage_def["name"]
        cp = checkpoints.get(name)
        versions = history.get(name, [])
        status = cp.get("status") if cp else "pending"
        entry: dict[str, Any] = {
            "name": name,
            "gated": stage_def["gated"],
            "produces": list(stage_def.get("produces") or []),
            "status": status or "pending",
            "timestamp": cp.get("timestamp") if cp else None,
            "review": cp.get("review") if cp else None,
            "cost_snapshot": cp.get("cost_snapshot") if cp else None,
            "error": cp.get("error") if cp else None,
            "human_approved": cp.get("human_approved") if cp else None,
            "partial_progress": (cp.get("metadata") or {}).get("partial_progress") if cp else None,
            "versions": len(versions) + (1 if cp else 0),
            # Chronological status trail (history + current) — powers replay.
            "history_entries": (
                [{"status": v.get("status"), "timestamp": v.get("timestamp")} for v in versions]
                + ([{"status": cp.get("status"), "timestamp": cp.get("timestamp")}] if cp else [])
            ),
        }
        # Gate audit: a gated stage that completed without ever passing
        # through awaiting_human (current or archived) was gate-skipped.
        if (
            stage_def["gated"]
            and cp is not None
            and cp.get("status") == "completed"
        ):
            saw_wait = any(v.get("status") == "awaiting_human" for v in versions)
            approved = bool(cp.get("human_approved"))
            entry["gate_skipped"] = not (saw_wait or approved)
        rail.append(entry)

    # Checkpoints for stages the manifest doesn't declare (legacy runs,
    # pipeline mismatch) still deserve a slot — at their canonical position
    # in the pipeline, not dangling after publish ("idea" belongs up front).
    canon = {name: i for i, name in enumerate(FALLBACK_STAGES)}
    for name, cp in checkpoints.items():
        if name in manifest_stage_names:
            continue
        entry = {
            "name": name,
            "gated": False,
            "produces": [
                str(artifact_name)
                for artifact_name in (cp.get("artifacts") or {})
                if isinstance(artifact_name, str) and artifact_name
            ],
            "status": cp.get("status") or "unknown",
            "timestamp": cp.get("timestamp"),
            "review": cp.get("review"),
            "cost_snapshot": cp.get("cost_snapshot"),
            "error": cp.get("error"),
            "human_approved": cp.get("human_approved"),
            "partial_progress": None,
            "versions": 1 + len(history.get(name, [])),
            "undeclared": True,
        }
        pos = canon.get(name)
        if pos is None:
            rail.append(entry)  # truly unknown name — end of rail
            continue
        insert_at = len(rail)
        for i, existing in enumerate(rail):
            existing_pos = canon.get(existing["name"])
            if existing_pos is not None and existing_pos > pos:
                insert_at = i
                break
        rail.insert(insert_at, entry)
    return rail


# ---------------------------------------------------------------------------
# Workflow resume metadata
# ---------------------------------------------------------------------------

def _text_list(value: Any, *, limit: int = 64) -> list[str]:
    """Normalize a scalar/list of ids without exposing unbounded metadata."""

    values = value if isinstance(value, list) else [value]
    result: list[str] = []
    for item in values:
        text = _safe_text(item, limit=256)
        if text and text not in result:
            result.append(text)
        if len(result) >= limit:
            break
    return result


def _work_item(value: Any, *, item_name: str, item_id: Optional[str] = None,
               item_ids: Optional[list[str]] = None, status: Optional[str] = None) -> Optional[dict]:
    """Return a compact active-task/batch object from loose legacy shapes."""

    # A stage status alone is not an active provider task or batch.  Keeping
    # this guard prevents every awaiting-human legacy project from surfacing a
    # misleading ``{"status": ...}`` handle.
    if value is None and not item_id and not item_ids:
        return None
    if isinstance(value, dict):
        item = dict(value)
    elif value is not None:
        item = {"id": _safe_text(value, limit=256)}
    else:
        item = {}
    item_id = item_id or _first_text(
        item.get("id"), item.get(f"{item_name}_id"), item.get("task_id" if item_name == "task" else "batch_id"),
    )
    if item_id:
        item.setdefault("id", item_id)
        item.setdefault(f"{item_name}_id", item_id)
    if item_ids:
        key = "task_ids" if item_name == "batch" else f"{item_name}_ids"
        item.setdefault(key, item_ids)
    if status and not item.get("status"):
        item["status"] = status
    # A dict without an id is still useful when a producer has only supplied
    # progress/status, but an entirely empty object is noise rather than an
    # active item.
    return item or None


def _derive_active_work(
    workflow_state: dict,
    marker: dict,
    artifacts: dict[str, dict],
    stages: list[dict],
    events: list[dict],
) -> tuple[Optional[dict], Optional[dict]]:
    """Derive active task/batch handles from new and legacy project shapes."""

    manifest = artifacts.get("asset_manifest") or {}
    task_value = _mapping_value(
        workflow_state,
        "active_task", "current_task", "task",
        "artifacts.active_task", "artifacts.current_task",
    )
    batch_value = _mapping_value(
        workflow_state,
        "active_batch", "current_batch", "batch",
        "artifacts.active_batch", "artifacts.current_batch",
    )
    task_id = _first_text(
        _mapping_value(workflow_state, "active_task_id", "current_task_id", "task_id"),
        _mapping_value(marker, "active_task_id", "current_task_id", "model_task_id", "task_id"),
        _mapping_value(manifest, "active_task_id", "task_id"),
    )
    batch_id = _first_text(
        _mapping_value(workflow_state, "active_batch_id", "current_batch_id", "batch_id"),
        _mapping_value(marker, "active_batch_id", "current_batch_id", "batch_id"),
        _mapping_value(manifest, "active_batch_id", "batch_id"),
    )
    task_ids = _text_list(
        _mapping_value(
            workflow_state,
            "active_task_ids", "current_task_ids", "task_ids",
            "artifacts.active_task_ids", "artifacts.current_task_ids", "artifacts.task_ids",
        )
        or _mapping_value(marker, "model_task_ids", "task_ids")
        or _mapping_value(manifest, "task_ids")
    )
    if not task_ids and isinstance(batch_value, dict):
        task_ids = _text_list(batch_value.get("task_ids"))

    # A checkpoint metadata.task_id is the durable handle used by the model
    # adapter. Prefer it only when the marker/artifact did not already expose
    # a more specific task or batch id.
    if not task_id and not batch_id:
        for stage in stages:
            metadata = stage.get("metadata") or {}
            candidate = _first_text(metadata.get("task_id"))
            if candidate:
                if candidate.startswith("batch-"):
                    batch_id = candidate
                else:
                    task_id = candidate
                break
    event_status: Optional[str] = None
    for event in reversed(events):
        if not isinstance(event, dict):
            continue
        if not task_id:
            task_id = _first_text(event.get("task_id"))
        if not batch_id:
            batch_id = _first_text(event.get("batch_id"))
        if event.get("task_id") or event.get("batch_id"):
            event_status = _first_text(event.get("status"), event.get("event"))
            break

    active_stage = next(
        (stage for stage in stages if stage.get("status") in _ACTIVE_STAGE_STATUSES),
        None,
    )
    stage_status = _first_text((active_stage or {}).get("status"))
    task = _work_item(task_value, item_name="task", item_id=task_id, status=event_status or stage_status)
    # If a batch has several task ids, surface the first task as the current
    # task while retaining the complete list on the batch object.
    if task is None and task_ids:
        task = _work_item(None, item_name="task", item_id=task_ids[0], status=event_status or stage_status)
    batch = _work_item(
        batch_value,
        item_name="batch",
        item_id=batch_id,
        item_ids=task_ids,
        status=event_status or stage_status,
    )
    return task, batch


def _derive_workflow_context(
    project_dir: Path,
    marker: dict,
    meta_json: dict,
    artifacts: dict[str, dict],
    stages: list[dict],
    events: list[dict],
) -> dict[str, Any]:
    """Build safe links and resume metadata from the newest available source."""

    workflow_state = artifacts.get("workflow_state")
    canonical = isinstance(workflow_state, dict)
    workflow_state = workflow_state if canonical else {}
    brief = artifacts.get("brief") or {}
    proposal = artifacts.get("proposal_packet") or {}
    production_plan = proposal.get("production_plan") if isinstance(proposal, dict) else {}
    production_plan = production_plan if isinstance(production_plan, dict) else {}

    project_id = project_dir.name
    source = (_first_text(marker.get("source"), brief.get("source")) or "").lower()
    explicit_kind = _first_text(
        _mapping_value(workflow_state, "project_kind", "kind"),
        _mapping_value(marker, "project_kind", "kind"),
        _mapping_value(meta_json, "project_kind", "kind"),
    )
    if explicit_kind:
        project_kind = explicit_kind
    elif (
        marker.get("draft") is True
        or workflow_state.get("draft") is True
        or _mapping_value(workflow_state, "draft_id", "draftId")
        or "draft" in source
    ):
        project_kind = "draft"
    elif (
        "model_workflow" in source
        or marker.get("model_task_id")
        or marker.get("model_task_ids")
        or marker.get("batch_id")
    ):
        project_kind = "production"
    elif marker or artifacts or stages:
        project_kind = "legacy"
    else:
        project_kind = "legacy"

    workflow_mode = _first_text(
        _mapping_value(workflow_state, "workflow_mode", "mode"),
        _mapping_value(marker, "workflow_mode", "mode"),
        _mapping_value(brief, "workflow_mode", "mode"),
        _mapping_value(production_plan, "workflow_mode", "mode"),
        _mapping_value(meta_json, "workflow_mode", "mode"),
    )
    entry_mode = _first_text(
        _mapping_value(workflow_state, "entry_mode", "entryMode"),
        _mapping_value(marker, "entry_mode", "entryMode"),
        _mapping_value(brief, "entry_mode", "entryMode"),
    )
    marker_phase = _mapping_value(marker, "resume_phase", "current_phase", "phase")
    if marker_phase is None and project_kind == "draft":
        # The current free-draft writer records its visible phase as ``stage``.
        marker_phase = marker.get("stage")
    resume_phase = _first_text(
        _mapping_value(workflow_state, "resume_phase", "current_phase", "phase", "stage"),
        marker_phase,
        _mapping_value(meta_json, "resume_phase", "current_phase", "phase", "stage"),
    )
    if resume_phase is None:
        workflow_stages = workflow_state.get("stages")
        if isinstance(workflow_stages, list):
            workflow_stage = next(
                (
                    stage for stage in workflow_stages
                    if isinstance(stage, dict)
                    and str(stage.get("status") or "").lower() in _ACTIVE_STAGE_STATUSES
                ),
                None,
            )
            resume_phase = _first_text(
                (workflow_stage or {}).get("id"),
                (workflow_stage or {}).get("name"),
            )
            if resume_phase is None:
                workflow_stage = next(
                    (
                        stage for stage in workflow_stages
                        if isinstance(stage, dict)
                        and str(stage.get("status") or "").lower() not in {"completed", "complete"}
                    ),
                    None,
                )
                resume_phase = _first_text(
                    (workflow_stage or {}).get("id"),
                    (workflow_stage or {}).get("name"),
                )
    if resume_phase is None:
        active_stage = next(
            (stage for stage in stages if stage.get("status") in _ACTIVE_STAGE_STATUSES),
            None,
        )
        resume_phase = _first_text((active_stage or {}).get("name"))
    if resume_phase is None and project_kind in {"draft", "production"}:
        # A production can have no currently-running task while still being
        # unfinished (for example, the provider clips are present but the
        # local edit/quality gate is pending).  Resume at the first stage that
        # is not terminal instead of falling back to a blank proposal page.
        terminal_statuses = {"completed", "complete", "approved"}
        next_stage = next(
            (
                stage for stage in stages
                if str(stage.get("status") or "pending").strip().lower()
                not in terminal_statuses
            ),
            None,
        )
        resume_phase = _first_text((next_stage or {}).get("name"))

    board_url = _project_url(project_id)
    explicit_resume_url = _safe_local_url(
        _mapping_value(workflow_state, "resume_url", "resumeUrl")
    )
    if explicit_resume_url:
        resume_url = explicit_resume_url
    elif canonical or project_kind in {"draft", "production"}:
        # The model workbench's stable hand-off contract is ``project`` plus
        # ``resume_stage``.  ``draft_id``/``stage`` were used by an early
        # browser-only prototype and do not restore a project on a fresh tab.
        query = f"project={quote(project_id, safe='')}"
        if resume_phase:
            query += f"&resume_stage={quote(resume_phase, safe='')}"
        resume_url = f"/model?{query}"
    elif resume_phase:
        # A legacy project has no trustworthy workbench snapshot; take the
        # creator to its read-only board and show the best inferred stage.
        resume_url = f"{board_url}?stage={quote(resume_phase, safe='')}"
    else:
        resume_url = board_url

    active_task, active_batch = _derive_active_work(
        workflow_state, marker, artifacts, stages, events,
    )
    if canonical:
        supplied_missing = workflow_state.get("missing_fields")
        missing_fields = _text_list(supplied_missing) if isinstance(supplied_missing, list) else []
        aliases = {
            "project_kind": ("project_kind", "kind"),
            "workflow_mode": ("workflow_mode", "mode"),
            "resume_phase": ("resume_phase", "current_phase", "phase", "stage"),
        }
        for field in _WORKFLOW_STATE_REQUIRED_FIELDS:
            keys = aliases[field]
            if not any(key in workflow_state for key in keys) and field not in missing_fields:
                missing_fields.append(field)
    else:
        # This is intentionally one coarse marker.  It tells the caller that
        # no canonical hand-off was available without pretending individual
        # inferred fields were persisted by the legacy producer.
        missing_fields = ["workflow_state"]
    explicit_degraded = workflow_state.get("legacy_degraded") if canonical else None
    workflow_status = str(workflow_state.get("status") or "").strip().lower() if canonical else ""
    legacy_degraded = (
        bool(explicit_degraded)
        if canonical and isinstance(explicit_degraded, bool)
        else (not canonical or bool(missing_fields) or workflow_status in {"legacy", "degraded", "legacy_degraded"})
    )
    # A producer can explicitly write ``false`` while still omitting a
    # required hand-off field. Missing contract data is authoritative for the
    # safety signal, so never advertise a partial snapshot as fully resumable.
    if canonical and missing_fields:
        legacy_degraded = True
    fallback_state = {
        "version": "legacy",
        "project_id": project_id,
        "project_kind": project_kind,
        "workflow_mode": workflow_mode,
        "resume_phase": resume_phase,
        "status": "legacy_degraded" if legacy_degraded else None,
        "source": "workflow_state_artifact" if canonical else "checkpoint_inference",
    }
    if canonical:
        resolved_workflow_state = workflow_state
    else:
        resolved_workflow_state = {
            key: value for key, value in fallback_state.items()
            if value is not None
        }
    return {
        "project_kind": project_kind,
        "entry_mode": entry_mode,
        "workflow_mode": workflow_mode,
        "resume_phase": resume_phase,
        "resume_url": resume_url,
        "board_url": board_url,
        "workflow_state": resolved_workflow_state,
        "active_task": active_task,
        "active_batch": active_batch,
        "legacy_degraded": legacy_degraded,
        "missing_fields": missing_fields,
    }


def build_resume_payload(project_dir: Path) -> dict[str, Any]:
    """Return the read-only resume contract for one project."""

    state = load_board_state(Path(project_dir))
    active_task = state.get("active_task")
    active_batch = state.get("active_batch")
    active_task_id = _first_text(
        (active_task or {}).get("task_id") if isinstance(active_task, dict) else None,
        (active_task or {}).get("id") if isinstance(active_task, dict) else None,
    )
    active_batch_id = _first_text(
        (active_batch or {}).get("batch_id") if isinstance(active_batch, dict) else None,
        (active_batch or {}).get("id") if isinstance(active_batch, dict) else None,
    )
    active_task_ids = (
        list((active_batch or {}).get("task_ids") or [])
        if isinstance(active_batch, dict) and isinstance((active_batch or {}).get("task_ids"), list)
        else ([active_task_id] if active_task_id else [])
    )
    artifacts = state.get("artifacts") or {}
    brief = artifacts.get("brief") if isinstance(artifacts, dict) else {}
    workflow_state = state.get("workflow_state") if isinstance(state.get("workflow_state"), dict) else {}
    proposal = artifacts.get("proposal_packet") if isinstance(artifacts, dict) else {}
    selected_concept = proposal.get("selected_concept") if isinstance(proposal, dict) else {}
    prompt = _first_text(
        brief.get("prompt") if isinstance(brief, dict) else None,
        workflow_state.get("prompt"),
    )
    return {
        "project_id": state.get("project_id"),
        "title": state.get("title"),
        # The board snapshot keeps restoration read-only and lets the model
        # workbench reuse already persisted planning artifacts without a
        # second request.  It is the same object returned by /state, not a
        # newly written or synthesized artifact.
        "state": state,
        "workflow_state": state.get("workflow_state") or {},
        "resume_url": state.get("resume_url"),
        "board_url": state.get("board_url"),
        "active_task": active_task,
        "active_batch": active_batch,
        "active_task_id": active_task_id,
        "active_batch_id": active_batch_id,
        # Compatibility aliases consumed by the model page's heartbeat
        # restoration code.  Keep the richer active_* objects above for new
        # callers.
        "task_id": active_task_id,
        "current_task_id": active_task_id,
        "task_status": (active_task or {}).get("status") if isinstance(active_task, dict) else None,
        "batch_id": active_batch_id,
        "task_ids": active_task_ids,
        "active_task_ids": active_task_ids,
        "prompt": prompt,
        "selected_candidate_id": (
            workflow_state.get("selected_candidate_id")
            or (selected_concept.get("concept_id") if isinstance(selected_concept, dict) else None)
        ),
        "legacy_degraded": bool(state.get("legacy_degraded")),
        "missing_fields": list(state.get("missing_fields") or []),
        "project_kind": state.get("project_kind"),
        "entry_mode": state.get("entry_mode"),
        "workflow_mode": state.get("workflow_mode"),
        "resume_phase": state.get("resume_phase"),
    }


# ---------------------------------------------------------------------------
# Artifacts
# ---------------------------------------------------------------------------

ARTIFACT_FILES = {
    "workflow_state": WORKFLOW_STATE_FILENAME,
    "research_brief": "research_brief.json",
    "source_media_review": "source_media_review.json",
    "video_analysis_brief": "video_analysis_brief.json",
    "brief": "brief.json",
    "proposal_packet": "proposal_packet.json",
    "script": "script.json",
    "scene_plan": "scene_plan.json",
    "asset_manifest": "asset_manifest.json",
    "edit_decisions": "edit_decisions.json",
    # OpenMontage media-stage manifests.  These are written only after the
    # corresponding local artifact has been verified (duration/hash/probe).
    "audio_manifest": "audio_manifest.json",
    "subtitle_manifest": "subtitle_manifest.json",
    "transcript_manifest": "transcript_manifest.json",
    "image_manifest": "image_manifest.json",
    "stock_search_manifest": "stock_search_manifest.json",
    "trim_manifest": "trim_manifest.json",
    "audio_mix_manifest": "audio_mix_manifest.json",
    "audio_enhance_manifest": "audio_enhance_manifest.json",
    "composition_manifest": "composition_manifest.json",
    "media_quality_report": "media_quality_report.json",
    "render_report": "render_report.json",
    "final_review": "final_review.json",
    "publish_log": "publish_log.json",
    "decision_log": "decision_log.json",
}


def _collect_artifacts(project_dir: Path, checkpoints: dict[str, dict]) -> dict[str, dict]:
    """Artifacts from artifacts/*.json, backfilled from checkpoint payloads."""
    artifacts: dict[str, dict] = {}
    art_dir = project_dir / "artifacts"
    for name, filename in ARTIFACT_FILES.items():
        data = _read_json(art_dir / filename)
        if data is not None:
            artifacts[name] = data
    # decision_log historically also lives at project root
    if "decision_log" not in artifacts:
        data = _read_json(project_dir / "decision_log.json")
        if data is not None:
            artifacts["decision_log"] = data
    # Backfill from checkpoint-embedded artifacts.
    for cp in checkpoints.values():
        for name, value in (cp.get("artifacts") or {}).items():
            if name not in artifacts:
                resolved = _resolve_artifact(project_dir, value)
                if resolved is not None:
                    artifacts[name] = resolved
    return artifacts


# ---------------------------------------------------------------------------
# Storyboard join
# ---------------------------------------------------------------------------

def _resolve_asset_path(project_dir: Path, raw_path: str) -> Optional[Path]:
    """Manifest paths appear in several real-world flavors — try them all.

    Observed on disk: project-relative ("assets/images/x.png"),
    repo-relative ("projects/<id>/assets/images/x.png"), and absolute.
    """
    if not raw_path:
        return None
    p = Path(raw_path)
    candidates = []
    if p.is_absolute():
        candidates.append(p)
    else:
        candidates.append(project_dir / raw_path)
        candidates.append(REPO_ROOT / raw_path)
        # repo-relative with the project prefix repeated
        parts = p.parts
        if len(parts) > 2 and parts[0] == "projects":
            candidates.append(project_dir.parent / Path(*parts[1:]))
    for c in candidates:
        try:
            if c.is_file():
                return c
        except OSError:
            continue
    return None


def _asset_entry(project_dir: Path, asset: dict) -> dict:
    """Normalize a manifest asset entry + resolve file existence.

    A file that resolves OUTSIDE the project directory is treated as
    not-servable (exists=False): /media only serves within the project, and
    a bare-filename fallback path would 404 or hit the wrong file.
    """
    raw_path = asset.get("path") or ""
    resolved = _resolve_asset_path(project_dir, raw_path)
    if resolved is not None:
        try:
            resolved.resolve().relative_to(Path(project_dir).resolve())
        except (ValueError, OSError):
            resolved = None
    file_path = resolved if resolved is not None else (project_dir / raw_path)
    exists = resolved is not None
    kind = asset.get("type") or ""
    if not kind and file_path.suffix:
        ext = file_path.suffix.lower()
        if ext in MEDIA_IMAGE_EXT:
            kind = "image"
        elif ext in MEDIA_VIDEO_EXT:
            kind = "video"
        elif ext in MEDIA_AUDIO_EXT:
            kind = "audio"
    # A visual is only *renderable* on the board if the file it points at is
    # actually a raster image or a video. Bespoke/atelier assets (type
    # "animation" pointing at a .tsx composition) exist on disk but can't be
    # thumbnailed — routing them to <img> yields a broken image. The board
    # falls back to a per-scene snapshot or the shot-spec placeholder instead.
    ext = file_path.suffix.lower()
    renderable = exists and ext in (MEDIA_IMAGE_EXT | MEDIA_VIDEO_EXT)
    return {
        "id": asset.get("id"),
        "type": kind,
        "scene_id": asset.get("scene_id"),
        "path": _rel(project_dir, file_path) if exists else raw_path,
        "exists": exists,
        "renderable": renderable,
        "prompt": asset.get("prompt"),
        "model": asset.get("model"),
        "source_tool": asset.get("source_tool"),
        "provider": asset.get("provider"),
        "cost_usd": asset.get("cost_usd"),
        "quality_score": asset.get("quality_score"),
        "duration_seconds": asset.get("duration_seconds"),
        "resolution": asset.get("resolution"),
    }


def _find_scene_snapshot(project_dir: Path, scene_id: str) -> Optional[dict]:
    """A per-scene review still, if the run wrote one.

    Atelier/animation scenes have no thumbnailable asset file, so the
    assets-stage snapshot (`snapshots/<scene_id>.png`) is what the filmstrip
    shows. Accept exact `<scene_id>.<ext>` and `<scene_id>_*.<ext>` forms.
    """
    snap_dir = project_dir / "snapshots"
    if not scene_id or not snap_dir.is_dir():
        return None
    try:
        for f in sorted(snap_dir.iterdir()):
            if not f.is_file() or f.suffix.lower() not in MEDIA_IMAGE_EXT:
                continue
            stem = f.stem
            if stem == scene_id or stem.startswith(f"{scene_id}_"):
                return {
                    "id": f"snap_{scene_id}",
                    "type": "image",
                    "scene_id": scene_id,
                    "path": _rel(project_dir, f),
                    "exists": True,
                    "renderable": True,
                    "snapshot": True,
                }
    except OSError:
        return None
    return None


def _find_script_section(scene: dict, sections: list[dict]) -> Optional[dict]:
    """Join scene → script section by id, falling back to timing overlap."""
    sid = scene.get("script_section_id")
    if sid:
        for s in sections:
            if s.get("id") == sid:
                return s
    start = scene.get("start_seconds")
    end = scene.get("end_seconds")
    if start is None or end is None:
        return None
    best, best_overlap = None, 0.0
    for s in sections:
        s0, s1 = s.get("start_seconds"), s.get("end_seconds")
        if s0 is None or s1 is None:
            continue
        overlap = min(end, s1) - max(start, s0)
        if overlap > best_overlap:
            best, best_overlap = s, overlap
    return best


def _build_storyboard(
    project_dir: Path,
    artifacts: dict[str, dict],
    events: list[dict],
) -> Optional[dict]:
    """Scene cards: scene_plan × script × asset_manifest (+ live events)."""
    scene_plan = artifacts.get("scene_plan")
    if not scene_plan or not isinstance(scene_plan.get("scenes"), list):
        return None
    sections = (artifacts.get("script") or {}).get("sections") or []
    manifest_assets = (artifacts.get("asset_manifest") or {}).get("assets") or []

    def scene_key(value: Any) -> str:
        # 0 is a legitimate scene id — only None/absent collapses to "".
        return str(value) if value is not None else ""

    assets_by_scene: dict[str, list[dict]] = {}
    for asset in manifest_assets:
        if not isinstance(asset, dict):
            continue
        entry = _asset_entry(project_dir, asset)
        assets_by_scene.setdefault(scene_key(entry.get("scene_id")), []).append(entry)

    # A scene is "generating" if its most recent top-level event is an
    # unfinished start. Nested (depth>0) provider events inside a selector
    # call are skipped — the outer call's finish is the real completion.
    generating: dict[str, dict] = {}
    for ev in events:
        sid = ev.get("scene_id")
        if sid is None or ev.get("depth"):
            continue
        sid = scene_key(sid)
        if ev.get("event") == "start":
            generating[sid] = ev
        elif ev.get("event") in ("finish", "error"):
            generating.pop(sid, None)

    cards = []
    for scene in scene_plan["scenes"]:
        if not isinstance(scene, dict):
            continue
        sid = scene_key(scene.get("id"))
        section = _find_script_section(scene, sections)
        scene_assets = assets_by_scene.get(sid, [])
        visuals = [a for a in scene_assets if a["type"] in ("image", "video", "diagram", "animation")]
        audio = [a for a in scene_assets if a["type"] in ("audio", "narration", "music", "sfx")]
        # Only files that can actually be shown (raster/video) are takes; a
        # bespoke composition asset (.tsx animation) is real but not showable.
        renderable = [a for a in visuals if a.get("renderable")]
        # A raster/video asset whose FILE is missing stays as a "file missing"
        # indicator. But an asset that EXISTS yet can't be shown (a .tsx atelier
        # composition) is dropped — it falls back to a per-scene snapshot.
        missing = [a for a in visuals if not a.get("exists") and a["type"] in ("image", "video", "diagram")]
        active_visual = (
            renderable[-1] if renderable
            else missing[-1] if missing
            else _find_scene_snapshot(project_dir, sid)
        )
        cards.append({
            "id": sid,
            "type": scene.get("type"),
            "description": scene.get("description"),
            "start_seconds": scene.get("start_seconds"),
            "end_seconds": scene.get("end_seconds"),
            "duration_seconds": (
                max(0, (scene.get("end_seconds") or 0) - (scene.get("start_seconds") or 0))
                if scene.get("end_seconds") is not None and scene.get("start_seconds") is not None
                else None
            ),
            "hero_moment": bool(scene.get("hero_moment")),
            "shot_language": scene.get("shot_language"),
            "shot_intent": scene.get("shot_intent"),
            "framing": scene.get("framing"),
            "movement": scene.get("movement"),
            "narration": (section or {}).get("text"),
            "section_label": (section or {}).get("label"),
            "required_assets": scene.get("required_assets") or [],
            "visual": active_visual,
            "takes": renderable,
            "audio": audio,
            "generating": generating.get(sid) is not None,
            "generating_tool": (generating.get(sid) or {}).get("tool"),
        })

    total = scene_plan.get("metadata", {}).get("total_duration_seconds")
    if total is None and cards:
        ends = [c["end_seconds"] for c in cards if c["end_seconds"] is not None]
        total = max(ends) if ends else None
    return {
        "scenes": cards,
        "total_duration_seconds": total,
        "style_playbook": scene_plan.get("style_playbook"),
    }


# ---------------------------------------------------------------------------
# Media discovery
# ---------------------------------------------------------------------------

def _scan_media(project_dir: Path) -> dict[str, Any]:
    """Discover project media (renders, stock, audio, subtitles, snapshots).

    Local analysis outputs are first-class media too.  Keeping extracted
    frames and face-tracking reports in a separate ``analysis`` bucket lets
    the workbench preview them without confusing them with final renders.
    """
    renders: list[dict] = []
    stock: list[dict] = []
    trimmed: list[dict] = []
    snapshots: list[dict] = []
    music: list[dict] = []
    audio: list[dict] = []
    subtitles: list[dict] = []
    analysis_frames: list[dict] = []
    face_tracking: list[dict] = []

    # Final/generated videos live in renders (and the legacy video/clips
    # folders).  Downloaded B-roll is tracked separately as stock so the
    # library never labels a candidate asset as a finished render.
    render_dirs = [
        project_dir / "renders",
        project_dir / "assets" / "video",
        project_dir / "assets" / "clips",
    ]
    seen_renders: set[str] = set()
    for render_dir in render_dirs:
        if not render_dir.is_dir():
            continue
        try:
            # Post-processing tools may keep derived videos under
            # ``renders/processed`` (or another named subfolder).  Discover
            # those files as real project renders instead of hiding them from
            # the library after a successful operation.
            entries = sorted(render_dir.rglob("*"))
        except OSError:
            continue
        for f in entries:
            if f.suffix.lower() not in MEDIA_VIDEO_EXT or not f.is_file():
                continue
            relative = _rel(project_dir, f)
            if relative in seen_renders:
                continue
            seen_renders.add(relative)
            renders.append({"path": relative, "size": f.stat().st_size,
                            "mtime": f.stat().st_mtime})
    stock_dir = project_dir / "assets" / "stock" / "clips"
    if stock_dir.is_dir():
        try:
            entries = sorted(stock_dir.iterdir())
        except OSError:
            entries = []
        for f in entries:
            if not f.is_file() or f.suffix.lower() not in (MEDIA_VIDEO_EXT | MEDIA_IMAGE_EXT):
                continue
            relative = _rel(project_dir, f)
            stock.append({
                "path": relative,
                "size": f.stat().st_size,
                "mtime": f.stat().st_mtime,
                "type": "video" if f.suffix.lower() in MEDIA_VIDEO_EXT else "image",
            })
    trimmed_dir = project_dir / "assets" / "trimmed"
    if trimmed_dir.is_dir():
        try:
            entries = sorted(trimmed_dir.iterdir())
        except OSError:
            entries = []
        for f in entries:
            if not f.is_file() or f.suffix.lower() not in MEDIA_VIDEO_EXT:
                continue
            relative = _rel(project_dir, f)
            trimmed.append({
                "path": relative,
                "size": f.stat().st_size,
                "mtime": f.stat().st_mtime,
                "type": "video",
            })
    # Atelier heuristic: deliverables at project root.
    for f in sorted(project_dir.glob("*.mp4")):
        renders.append({"path": _rel(project_dir, f), "size": f.stat().st_size,
                        "mtime": f.stat().st_mtime, "at_root": True})
    for f in sorted(project_dir.glob("*.mp3")):
        music.append({"path": _rel(project_dir, f), "at_root": True})
    music_dir = project_dir / "assets" / "music"
    if music_dir.is_dir():
        # Local composition/import preserves each run in a fresh subfolder.
        # Reloading a project must retain those tracks, not only root files.
        for f in sorted(music_dir.rglob("*")):
            if f.is_file() and not f.is_symlink() and f.suffix.lower() in MEDIA_AUDIO_EXT:
                music.append({"path": _rel(project_dir, f), "size": f.stat().st_size,
                              "mtime": f.stat().st_mtime})

    # Narration and other non-BGM tracks are kept separate from music so the
    # board can explain which file is voice, soundtrack, or an effect.
    audio_dir = project_dir / "assets" / "audio"
    if audio_dir.is_dir():
        # Processed narration/mix files live one level below
        # ``assets/audio/processed``.  A recursive scan keeps those real
        # outputs visible in the Backlot board without treating them as
        # finished video renders.
        for f in sorted(audio_dir.rglob("*")):
            if f.suffix.lower() in MEDIA_AUDIO_EXT and f.is_file():
                audio.append({"path": _rel(project_dir, f), "size": f.stat().st_size,
                              "mtime": f.stat().st_mtime})
    for f in sorted(project_dir.iterdir()):
        if f.is_file() and f.suffix.lower() in MEDIA_AUDIO_EXT and f.name not in {Path(item["path"]).name for item in music}:
            audio.append({"path": _rel(project_dir, f), "at_root": True,
                          "size": f.stat().st_size, "mtime": f.stat().st_mtime})

    # Subtitle outputs can be placed at the project root, in the canonical
    # subtitles/transcripts folders, or in an export folder.  Keep the scan
    # deliberately shallow: it is an inventory, not a recursive build scan.
    subtitle_dirs = [project_dir]
    for dirname in ("subtitles", "transcripts", "assets/subtitles", "exports"):
        candidate = project_dir / dirname
        if candidate.is_dir():
            subtitle_dirs.append(candidate)
    seen_subtitles: set[str] = set()
    for directory in subtitle_dirs:
        try:
            entries = sorted(directory.iterdir())
        except OSError:
            continue
        for f in entries:
            if not f.is_file() or f.suffix.lower() not in MEDIA_SUBTITLE_EXT:
                continue
            relative = _rel(project_dir, f)
            if relative in seen_subtitles:
                continue
            seen_subtitles.add(relative)
            subtitles.append({"path": relative, "size": f.stat().st_size,
                              "mtime": f.stat().st_mtime})

    image_dirs = [project_dir]
    for dirname in ("snapshots", "verify", "assets/images", "assets/storyboard",
                    "assets/frames", "assets/stock/thumbnails", "exports"):
        candidate = project_dir / dirname
        if candidate.is_dir():
            image_dirs.append(candidate)
    seen_snapshots: set[str] = set()
    for directory in image_dirs:
        try:
            entries = sorted(directory.iterdir())
        except OSError:
            continue
        for f in entries:
            if not f.is_file() or f.suffix.lower() not in MEDIA_IMAGE_EXT:
                continue
            relative = _rel(project_dir, f)
            if relative in seen_snapshots:
                continue
            seen_snapshots.add(relative)
            snapshots.append({"path": relative, "size": f.stat().st_size,
                              "mtime": f.stat().st_mtime})

    # Local tool images are reusable assets after a reload, not only an
    # ephemeral preview in the generating browser tab.
    local_images = project_dir / "assets" / "local-tools"
    if local_images.is_dir():
        for f in sorted(local_images.rglob("*")):
            if f.suffix.lower() not in MEDIA_IMAGE_EXT or not f.is_file():
                continue
            try:
                f.resolve().relative_to(project_dir.resolve())
                relative = _rel(project_dir, f)
            except (ValueError, OSError):
                continue
            if relative not in seen_snapshots:
                seen_snapshots.add(relative)
                snapshots.append({"path": relative, "size": f.stat().st_size, "mtime": f.stat().st_mtime})

    # FrameSampler outputs are deliberately kept under analysis/frames and
    # never folded into the storyboard-image inventory.  FaceTracker reports
    # are JSON files under analysis/face_tracking and are exposed separately
    # so the UI can offer a report preview/link instead of a broken image.
    frames_dir = project_dir / "analysis" / "frames"
    if frames_dir.is_dir():
        try:
            entries = sorted(frames_dir.rglob("*"))
        except OSError:
            entries = []
        for f in entries:
            if not f.is_file() or f.suffix.lower() not in {".jpg", ".jpeg", ".png"}:
                continue
            try:
                relative = _rel(project_dir, f)
                f.resolve().relative_to(project_dir.resolve())
            except (ValueError, OSError):
                continue
            analysis_frames.append({"path": relative, "size": f.stat().st_size, "mtime": f.stat().st_mtime})

    tracking_dir = project_dir / "analysis" / "face_tracking"
    if tracking_dir.is_dir():
        try:
            entries = sorted(tracking_dir.glob("*.json"))
        except OSError:
            entries = []
        for f in entries:
            if not f.is_file():
                continue
            try:
                relative = _rel(project_dir, f)
                f.resolve().relative_to(project_dir.resolve())
            except (ValueError, OSError):
                continue
            face_tracking.append({"path": relative, "size": f.stat().st_size, "mtime": f.stat().st_mtime})

    # Canvas handoffs are local media candidates, not accepted storyboard takes.
    # Discover their independent copies so post-production selectors can use
    # them without changing existing shot/asset manifests.
    canvas_dir = project_dir / "assets" / "canvas"
    if canvas_dir.is_dir() and not canvas_dir.is_symlink():
        for f in sorted(canvas_dir.rglob("*")):
            if not f.is_file() or f.is_symlink():
                continue
            try:
                f.resolve().relative_to(project_dir.resolve())
            except (ValueError, OSError):
                continue
            item = {"path": _rel(project_dir, f), "size": f.stat().st_size,
                    "mtime": f.stat().st_mtime, "source": "canvas"}
            if f.suffix.lower() in MEDIA_VIDEO_EXT:
                renders.append(item)
            elif f.suffix.lower() in MEDIA_IMAGE_EXT:
                snapshots.append(item)
            elif f.suffix.lower() in MEDIA_AUDIO_EXT:
                audio.append(item)

    renders.sort(key=lambda r: r.get("mtime", 0), reverse=True)
    stock.sort(key=lambda item: item.get("mtime", 0), reverse=True)
    trimmed.sort(key=lambda item: item.get("mtime", 0), reverse=True)
    audio.sort(key=lambda item: item.get("mtime", 0), reverse=True)
    subtitles.sort(key=lambda item: item.get("mtime", 0), reverse=True)
    analysis_frames.sort(key=lambda item: item.get("mtime", 0), reverse=True)
    face_tracking.sort(key=lambda item: item.get("mtime", 0), reverse=True)
    return {"renders": renders, "stock": stock, "trimmed": trimmed, "snapshots": snapshots, "music": music,
            "audio": audio, "subtitles": subtitles,
            "analysis": {"frames": analysis_frames, "face_tracking": face_tracking}}


def _find_poster(project_dir: Path, state: dict) -> Optional[str]:
    """Best poster for the library card (image path, or a video path —
    the /thumb endpoint extracts a frame from videos)."""
    board = state.get("storyboard") or {}
    for card in board.get("scenes", []):
        visual = card.get("visual")
        if visual and visual.get("exists") and visual.get("type") == "image":
            return visual["path"]
    for snap in (state.get("media") or {}).get("snapshots", []):
        return snap["path"]
    # Common image homes, in order of how representative they usually are.
    for rel_dir in ("assets/images", "assets/frames", "exports", "assets", "."):
        d = (project_dir / rel_dir) if rel_dir != "." else project_dir
        if not d.is_dir():
            continue
        try:
            for f in sorted(d.iterdir()):
                if f.is_file() and f.suffix.lower() in MEDIA_IMAGE_EXT:
                    return _rel(project_dir, f)
        except OSError:
            continue
    # Last resort: the newest render — /thumb extracts a poster frame.
    renders = (state.get("media") or {}).get("renders", [])
    if renders:
        return renders[0]["path"]
    return None


def _last_activity(project_dir: Path) -> float:
    """Most recent mtime among state-bearing files (bounded scan)."""
    latest = 0.0
    try:
        candidates = list(project_dir.glob("checkpoint_*.json"))
        candidates.append(project_dir / "events.jsonl")
        art = project_dir / "artifacts"
        if art.is_dir():
            candidates.extend(art.glob("*.json"))
        for p in candidates:
            try:
                latest = max(latest, p.stat().st_mtime)
            except OSError:
                continue
    except OSError:
        pass
    return latest


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def load_board_state(project_dir: Path, *, include_history: bool = True) -> dict[str, Any]:
    """Full BoardState for one project. Never raises."""
    project_dir = Path(project_dir)
    project_id = project_dir.name

    marker = _read_json(project_dir / "project.json") or {}
    meta_json = _read_json(project_dir / "meta.json") or {}

    checkpoints = _collect_checkpoints(project_dir)
    # Only the evidence board uses archived attempts and gate audit trails.
    # Library cards need current checkpoints; loading every archived JSON here
    # made a cold project list scale with the entire production history.
    history = _collect_history(project_dir) if include_history else {}

    pipeline_type = marker.get("pipeline_type")
    if not pipeline_type:
        for cp in checkpoints.values():
            pt = cp.get("pipeline_type")
            if pt and pt != "unknown":
                pipeline_type = pt
                break
    pipeline_meta = _load_pipeline_meta(pipeline_type)

    artifacts = _collect_artifacts(project_dir, checkpoints)
    events = read_events(project_dir, limit=250)
    storyboard = _build_storyboard(project_dir, artifacts, events)
    media = _scan_media(project_dir)

    stages = _build_stage_rail(pipeline_meta, checkpoints, history)
    workflow_context = _derive_workflow_context(
        project_dir,
        marker,
        meta_json,
        artifacts,
        stages,
        events,
    )

    # Cost: latest checkpoint snapshot wins; fall back to manifest total.
    cost = None
    for cp in sorted(checkpoints.values(), key=lambda c: c.get("_mtime", 0), reverse=True):
        if cp.get("cost_snapshot"):
            cost = cp["cost_snapshot"]
            break
    if cost is None:
        total = (artifacts.get("asset_manifest") or {}).get("total_cost_usd")
        if total is not None:
            cost = {"total_spent_usd": total}

    import time
    last_activity = _last_activity(project_dir)
    now = time.time()

    # Stall detection: an in_progress stage that stopped writing anything.
    for stage_entry in stages:
        if (
            stage_entry["status"] == "in_progress"
            and last_activity
            and (now - last_activity) > STALL_WINDOW_SECONDS
        ):
            stage_entry["stalled"] = True
            stage_entry["stalled_minutes"] = int((now - last_activity) / 60)

    state: dict[str, Any] = {
        "project_id": project_id,
        "title": marker.get("title") or meta_json.get("name") or project_id.replace("-", " ").title(),
        "pipeline": pipeline_meta,
        "style_playbook": marker.get("style_playbook"),
        "created_at": marker.get("created_at"),
        "has_marker": bool(marker),
        "has_pipeline_state": bool(checkpoints),
        "stages": stages,
        "artifacts": artifacts,
        "storyboard": storyboard,
        "media": media,
        "events": events,
        "cost": cost,
        "last_activity": last_activity,
        "live": bool(last_activity and (now - last_activity) < LIVE_WINDOW_SECONDS),
        # Resume metadata is derived here so the library summary and the
        # explicit /resume endpoint consume exactly the same source order.
        **workflow_context,
    }
    state["poster"] = _find_poster(project_dir, state)
    return state


def summarize_project(project_dir: Path) -> dict[str, Any]:
    """Cheap library-card summary (no full artifact parse of big files)."""
    state = load_board_state(project_dir, include_history=False)
    active = next((s for s in state["stages"] if s["status"] in ("in_progress", "awaiting_human")), None)
    done = [s for s in state["stages"] if s["status"] == "completed"]
    return {
        "project_id": state["project_id"],
        "title": state["title"],
        "pipeline_type": state["pipeline"]["pipeline_type"],
        "project_kind": state.get("project_kind"),
        "entry_mode": state.get("entry_mode"),
        "workflow_mode": state.get("workflow_mode"),
        # Keep a bounded prompt in the library response.  It is used only for
        # conservative draft-lineage grouping; the full prompt stays in the
        # project artifact and is restored through /resume.
        "prompt": str(
            ((state.get("artifacts") or {}).get("brief") or {}).get("prompt")
            or ((state.get("workflow_state") or {}).get("prompt") or "")
        )[:2000],
        "resume_phase": state.get("resume_phase"),
        "resume_url": state.get("resume_url"),
        "board_url": state.get("board_url"),
        "has_pipeline_state": state["has_pipeline_state"],
        "poster": state["poster"],
        "live": state["live"],
        "last_activity": state["last_activity"],
        "active_stage": active["name"] if active else None,
        # A library card must be able to resume an interrupted production.
        # Keep this explicit instead of making the user infer it from the
        # coloured rail dots.  It intentionally stays null for a completed
        # project, where opening the finished board is the useful action.
        "resume_stage": active["name"] if active else None,
        "resume_status": active["status"] if active else None,
        "awaiting_human": bool(active and active["status"] == "awaiting_human"),
        "stage_states": [
            {"name": s["name"], "status": s["status"]}
            for s in state["stages"] if not s.get("undeclared")
        ],
        "completed_count": len(done),
        "render_count": len(state["media"]["renders"]),
        "stock_count": len(state["media"].get("stock", [])),
        "trimmed_count": len(state["media"].get("trimmed", [])),
        "audio_count": len(state["media"].get("audio", [])),
        "music_count": len(state["media"].get("music", [])),
        "subtitle_count": len(state["media"].get("subtitles", [])),
        "analysis_frame_count": len((state["media"].get("analysis") or {}).get("frames", [])),
        "face_tracking_count": len((state["media"].get("analysis") or {}).get("face_tracking", [])),
        "scene_count": len((state["storyboard"] or {}).get("scenes", [])),
        "duplicate_count": 1,
        "duplicate_project_ids": [state["project_id"]],
    }


def list_projects(projects_dir: Optional[Path] = None) -> list[dict[str, Any]]:
    """Library view with non-destructive grouping of repeated draft saves.

    The browser used to create one directory per stage transition when a
    session-storage draft id was missing.  Those directories are retained on
    disk for auditability, but the library shows the newest draft as one card
    and reports how many older versions belong to it.  Production projects
    are never grouped implicitly.
    """
    root = Path(projects_dir) if projects_dir else PROJECTS_DIR
    if not root.is_dir():
        return []
    summaries = []
    for entry in sorted(root.iterdir()):
        if not entry.is_dir() or _hidden_project_dir(entry.name):
            continue
        try:
            summaries.append(summarize_project(entry))
        except Exception:
            summaries.append({
                "project_id": entry.name,
                "title": entry.name.replace("-", " ").title(),
                "pipeline_type": "unknown",
                "project_kind": "legacy",
                "entry_mode": None,
                "workflow_mode": None,
                "prompt": "",
                "resume_phase": None,
                "resume_url": f"/p/{quote(entry.name, safe='')}",
                "board_url": f"/p/{quote(entry.name, safe='')}",
                "has_pipeline_state": False,
                "poster": None,
                "live": False,
                "last_activity": 0,
                "active_stage": None,
                "awaiting_human": False,
                "stage_states": [],
                "completed_count": 0,
                "render_count": 0,
                "scene_count": 0,
                "analysis_frame_count": 0,
                "face_tracking_count": 0,
                "duplicate_count": 1,
                "duplicate_project_ids": [entry.name],
                "error": "unreadable",
            })

    def _lineage_key(summary: dict[str, Any]) -> tuple[str, ...] | None:
        # Only free planning drafts are safe to collapse. A production run or
        # a legacy project may represent a genuinely separate delivery even
        # when its title happens to match another card.
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

    grouped: dict[tuple[str, ...], list[dict[str, Any]]] = {}
    ungrouped: list[dict[str, Any]] = []
    for summary in summaries:
        key = _lineage_key(summary)
        if key is None:
            ungrouped.append(summary)
        else:
            grouped.setdefault(key, []).append(summary)

    visible = list(ungrouped)
    for versions in grouped.values():
        # The newest directory is the only visible card; all older ids remain
        # attached as metadata so a future history drawer can expose them
        # without guessing or deleting anything.
        versions.sort(key=lambda item: (bool(item.get("live")), item.get("last_activity") or 0), reverse=True)
        primary = versions[0]
        primary["duplicate_count"] = len(versions)
        primary["duplicate_project_ids"] = [str(item.get("project_id")) for item in versions]
        visible.append(primary)

    visible.sort(key=lambda s: (not s["live"], -(s["last_activity"] or 0)))
    return visible
