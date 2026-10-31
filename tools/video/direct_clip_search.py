"""Direct clip search: lightweight provider-agnostic stock footage acquisition.

This tool replaces the heavy corpus_builder → clip_search pipeline when
you already know what you want and just need clips downloaded fast. It
uses the same StockSource adapter protocol (Pexels, Archive.org, NASA,
Wikimedia, Unsplash, ...) but skips CLIP embeddings, motion scoring,
index.jsonl, and .npy files entirely.

When to use this instead of corpus_builder
------------------------------------------
- You have a shot list and know the queries for each slot.
- You want clips downloaded in minutes, not tens of minutes.
- You plan to inspect thumbnails yourself (or via a sub-agent) rather
  than relying on CLIP similarity ranking.
- You are doing act-by-act production and can reuse clips across acts
  by pointing at previously downloaded directories.

When to use corpus_builder instead
----------------------------------
- You need CLIP-based semantic ranking (clip_search.rank_for_slot).
- You have 50+ slots and want automated diversification.
- The visual match between query text and actual footage matters more
  than speed.

What it does per query
----------------------
1. Fan out across all available (or specified) StockSource adapters.
2. Download up to `clips_per_query` clips per query.
3. Extract one thumbnail per clip via ffmpeg (for visual inspection).
4. Return full metadata: paths, durations, sources, thumbnails.

No CLIP model. No embeddings. No corpus index. Just files on disk.
"""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from concurrent.futures import ThreadPoolExecutor, as_completed, wait, FIRST_COMPLETED
import threading
import math
import queue
import subprocess
import hashlib
import shutil
import re
import time
import urllib.parse
from pathlib import Path
from typing import Any, Optional

from tools.video.stock_downloads import StockDownloadStore, DownloadDeadlineExceeded


_PROGRESS_CALLBACK = ContextVar('stock_search_progress', default=None)
_REQUEST_DEADLINE = ContextVar('stock_request_deadline', default=None)
_TRANSPORT_LOCK = threading.RLock()
_TRANSPORT_USERS = 0
_TRANSPORT_WRAPPER = None
_TRANSPORT_ORIGINAL = None


@contextmanager
def stock_progress_context(callback):
    """Route verified acquisition milestones to the current caller, not inputs.

    No callback, URL or credential is serialized into tool requests. UI failures
    must not invalidate media already acquired. Events run on the caller thread.
    """
    token = _PROGRESS_CALLBACK.set(callback)
    try:
        yield
    finally:
        _PROGRESS_CALLBACK.reset(token)


def _report_progress(phase, **values):
    callback = _PROGRESS_CALLBACK.get()
    if callback is not None:
        try:
            callback({'phase': phase, **values})
        except Exception:
            pass

from tools.base_tool import (
    BaseTool,
    Determinism,
    ExecutionMode,
    ResourceProfile,
    RetryPolicy,
    ToolResult,
    ToolRuntime,
    ToolStability,
    ToolStatus,
    ToolTier,
)


class _DeadlineExceeded(TimeoutError):
    """Raised when the direct-clip-search wall-clock deadline is exhausted."""


class DirectClipSearch(BaseTool):
    name = "direct_clip_search"
    version = "0.4.1"
    tier = ToolTier.SOURCE
    capability = "clip_acquisition"
    provider = "openmontage"
    stability = ToolStability.BETA
    execution_mode = ExecutionMode.SYNC
    determinism = Determinism.DETERMINISTIC
    runtime = ToolRuntime.HYBRID  # local disk + network APIs

    dependencies = [
        "python:requests", "cmd:ffmpeg", "cmd:ffprobe",
    ]
    install_instructions = (
        "Local ffmpeg and ffprobe are required for media verification.\n"
        "At least one stock source must be configured:\n"
        "  PEXELS_API_KEY for Pexels (free at https://www.pexels.com/api/)\n"
        "  UNSPLASH_ACCESS_KEY for Unsplash (see https://unsplash.com/documentation)\n"
        "  archive.org, nasa, and wikimedia work without API keys"
    )
    agent_skills = []

    capabilities = [
        "multi_source_search",
        "clip_download",
        "thumbnail_extraction",
        "bounded_download_concurrency",
        "verified_duration_coverage",
    ]
    supports = {
        "multi_source": True,
        "video_and_image": True,
        "provider_agnostic": True,
        "cross_act_reuse": True,
    }
    best_for = [
        "act-by-act documentary production with manual clip selection",
        "fast B-roll acquisition when you know what you need",
        "downloading clips from multiple providers in one call",
        "building clip libraries without CLIP embedding overhead",
    ]
    not_good_for = [
        "semantic similarity ranking (use corpus_builder + clip_search)",
        "automated slot filling without human review",
    ]
    fallback_tools = ["corpus_builder", "pexels_video"]

    input_schema = {
        "type": "object",
        "required": ["output_dir", "queries"],
        "properties": {
            "output_dir": {
                "type": "string",
                "description": (
                    "Directory where clips and thumbnails are saved. "
                    "e.g. projects/foo/assets/video/raw_act2"
                ),
            },
            "queries": {
                "type": "array",
                "minItems": 1,
                "items": {
                    "type": "object",
                    "required": ["query"],
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Search term for stock APIs",
                        },
                        "slot_id": {
                            "type": "string",
                            "description": (
                                "Optional slot reference (e.g. 'slot_03'). "
                                "Used to organize output and track provenance."
                            ),
                        },
                        "kind": {
                            "type": "string",
                            "enum": ["video", "image", "any"],
                            "default": "video",
                        },
                        "required_duration_seconds": {
                            "type": "number", "minimum": 0, "maximum": 7200, "default": 0,
                            "description": "Optional verified video-duration target for this query; clip quota remains a hard limit.",
                        },
                        "minimum_clips": {
                            "type": "integer", "minimum": 1, "maximum": 20, "default": 1,
                            "description": "Keep this many distinct clips before duration-based early stop; cannot exceed clips_per_query.",
                        },
                        "max_clip_duration_seconds": {
                            "type": "number", "exclusiveMinimum": 0, "maximum": 120, "default": 5,
                            "description": "Maximum contribution of one verified video toward the query target; not a quality or location check.",
                        },
                    },
                },
            },
            "sources": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "Source adapter names to search (e.g. ['pexels','archive_org']). "
                    "Defaults to all available sources."
                ),
            },
            "stock_engine": {
                "type": "string", "enum": ["native", "moneyprinterturbo"], "default": "native",
                "description": "Pinned MoneyPrinterTurbo stock search for supported video sources; other sources retain their native adapter.",
            },
            "clips_per_query": {
                "type": "integer",
                "default": 3,
                "minimum": 1,
                "maximum": 20,
                "description": (
                    "How many clips to download per query (across all sources). "
                    "Lower = faster. 2-3 is enough for manual selection."
                ),
            },
            "unique_across_queries": {
                "type": "boolean", "default": False,
                "description": "Avoid attempting the same source asset ID again across queries in this run. Native default preserves intentional reuse; web UI opts into unique IDs.",
            },
            "search_concurrency": {
                "type": "integer", "minimum": 1, "maximum": 4, "default": 1,
                "description": "Search this many distinct sources together; preserve source order and clip quota. Default serial avoids speculative requests.",
            },
            "download_concurrency": {
                "type": "integer", "minimum": 1, "maximum": 4, "default": 1,
                "description": "Bounded independent downloads and verification; no next batch after quota, duration target, deadline or provider stop.",
            },
            "filters": {
                "type": "object",
                "properties": {
                    "min_duration": {"type": "number"},
                    "max_duration": {"type": "number"},
                    "orientation": {
                        "type": "string",
                        "enum": ["landscape", "portrait", "square"],
                    },
                    "min_width": {"type": "integer"},
                },
            },
            "extract_thumbnails": {
                "type": "boolean",
                "default": True,
                "description": (
                    "Extract a mid-frame thumbnail from each video for visual "
                    "inspection. Uses ffmpeg, not CLIP."
                ),
            },
            "skip_existing": {
                "type": "boolean",
                "default": True,
                "description": "Reuse verified completed media; interrupted or invalid files are kept but not reused.",
            },
            "exclude_clip_ids": {
                "type": "array", "items": {"type": "string"}, "maxItems": 1000,
                "description": "Already-owned clip IDs do not consume this query's new-candidate quota.",
            },
            "metadata_groups": {
                "type": "array", "items": {"type": "array", "items": {"type": "string"}},
                "description": "Each group must match at least one metadata term before download. Does not verify visuals.",
            },
            "timeout_seconds": {
                "type": "number",
                "default": 600,
                "minimum": 1,
                "description": (
                    "Overall wall-clock deadline for search, download, and thumbnail "
                    "work. Defaults to 10 minutes. On timeout, returns partial progress "
                    "instead of relying on an external process interrupt."
                ),
            },
        },
    }

    resource_profile = ResourceProfile(
        cpu_cores=1, ram_mb=512, vram_mb=0, disk_mb=2000, network_required=True
    )
    retry_policy = RetryPolicy(max_retries=1, retryable_errors=["timeout", "rate_limit"])
    side_effects = [
        "downloads clips to <output_dir>/clips/",
        "extracts thumbnails to <output_dir>/thumbnails/",
        "calls external stock APIs",
    ]
    user_visible_verification = [
        "Browse <output_dir>/thumbnails/ to visually verify clip matches",
        "Play clips from <output_dir>/clips/ to check quality",
    ]

    def get_status(self) -> ToolStatus:
        try:
            from tools.video.stock_sources import available_sources
        except Exception:
            return ToolStatus.UNAVAILABLE
        if len(available_sources()) == 0 or not all(shutil.which(name) for name in ("ffmpeg", "ffprobe")):
            return ToolStatus.UNAVAILABLE
        return ToolStatus.AVAILABLE

    def get_info(self) -> dict[str, Any]:
        info = super().get_info()
        try:
            from tools.video.stock_sources import source_catalog, source_summary
            info["source_provider_menu"] = source_catalog()
            info["source_provider_summary"] = source_summary()
        except Exception:
            info["source_provider_menu"] = []
            info["source_provider_summary"] = {
                "configured": 0,
                "total": 0,
                "available_source_names": [],
                "unavailable_source_names": [],
            }
        return info

    def estimate_cost(self, inputs: dict[str, Any]) -> float:
        return 0.0  # all sources are free-tier

    # ------------------------------------------------------------------
    # Execute
    # ------------------------------------------------------------------

    def execute(self, inputs: dict[str, Any]) -> ToolResult:
        start = time.time()
        try:
            from tools.video.stock_sources import (
                SearchFilters,
                all_sources,
                available_sources,
                get_source,
                source_summary,
            )

            output_dir = Path(inputs["output_dir"])
            queries: list[dict] = list(inputs["queries"])
            source_names: Optional[list[str]] = inputs.get("sources")
            filters_in: dict = inputs.get("filters") or {}
            clips_per_query = int(inputs.get("clips_per_query", 3))
            concurrency = inputs.get('search_concurrency', 1)
            if isinstance(concurrency, bool) or not isinstance(concurrency, int) or not 1 <= concurrency <= 4:
                raise ValueError('search_concurrency must be an integer from 1 to 4')
            download_concurrency = inputs.get('download_concurrency', 1)
            if type(download_concurrency) is not int or not 1 <= download_concurrency <= 4:
                raise ValueError('download_concurrency must be an integer from 1 to 4')
            requirements = [_query_requirements(spec, clips_per_query) for spec in queries]
            extract_thumbs = bool(inputs.get("extract_thumbnails", True))
            skip_existing = bool(inputs.get("skip_existing", True))
            excluded_ids = set(inputs.get("exclude_clip_ids") or [])
            unique_across_queries = inputs.get('unique_across_queries', False)
            if type(unique_across_queries) is not bool:
                raise ValueError('unique_across_queries must be boolean')
            attempted_ids = set(excluded_ids)
            metadata_groups = inputs.get("metadata_groups") or []
            blocked_sources = set()
            timeout_seconds = float(inputs.get("timeout_seconds", 600))
            deadline = start + timeout_seconds
            stock_engine = inputs.get('stock_engine', 'native')
            if stock_engine not in ('native', 'moneyprinterturbo'):
                raise ValueError('Unknown stock search engine')

            clips_dir = output_dir / "clips"
            thumbs_dir = output_dir / "thumbnails"
            clips_dir.mkdir(parents=True, exist_ok=True)
            download_store = StockDownloadStore(clips_dir)
            if extract_thumbs:
                thumbs_dir.mkdir(parents=True, exist_ok=True)

            # --- Resolve sources ---
            if source_names:
                sources = []
                unavailable: list[str] = []
                known = {src.name: src for src in all_sources()}
                for name in source_names:
                    s = known.get(name)
                    if s is None:
                        try:
                            s = get_source(name)
                        except KeyError:
                            return ToolResult(
                                success=False,
                                error=f"Unknown stock source: {name!r}. "
                                      f"Available: {[src.name for src in all_sources()]}",
                            )
                    if s.is_available():
                        sources.append(s)
                    else:
                        unavailable.append(name)
                if unavailable:
                    summary = source_summary()
                    return ToolResult(
                        success=False,
                        error=(
                            f"Requested sources unavailable: {', '.join(unavailable)}. "
                            f"Available: {', '.join(summary['available_source_names']) or 'none'}."
                        ),
                    )
            else:
                sources = available_sources()

            if not sources:
                return ToolResult(
                    success=False,
                    error="No stock sources available. " + self.install_instructions,
                )

            # A source can occur only once per batch, including explicit lists.
            sources = list({s.name: s for s in sources}.values())

            # --- Search and download ---
            if stock_engine == 'moneyprinterturbo':
                from integrations.moneyprinterturbo.stock import MoneyPrinterStockSource, UPSTREAM_PROVIDERS
                sources = [MoneyPrinterStockSource(s, output_dir, deadline=deadline)
                           if s.name in UPSTREAM_PROVIDERS else s for s in sources]

            downloaded: list[dict] = []
            errors: list[dict] = []
            skipped = 0
            per_source_counts: dict[str, int] = {s.name: 0 for s in sources}
            queries_started = 0
            filtered_candidates = 0
            coverage = []

            def timeout_result(
                *,
                phase: str,
                query: str = "",
                source: str = "",
                clip_id: str = "",
            ) -> ToolResult:
                elapsed = time.time() - start
                return ToolResult(
                    success=False,
                    error=(
                        f"Direct clip search timed out after {timeout_seconds:.1f}s "
                        f"during {phase}."
                    ),
                    data={
                        "timed_out": True,
                        "phase": phase,
                        "query": query,
                        "source": source,
                        "clip_id": clip_id,
                        "output_dir": str(output_dir),
                        "clips_downloaded": len([d for d in downloaded if not d.get("skipped_existing")]),
                        "clips_reused": skipped,
                        "total_clips": len(downloaded),
                        "distinct_clip_ids": len({row['clip_id'] for row in downloaded}),
                        "unique_across_queries": unique_across_queries,
                        "queries_without_clips": sum(row['clips_ready'] == 0 for row in coverage),
                        "per_source_counts": per_source_counts,
                        "queries_run": queries_started,
                        "resolved_sources": [s.name for s in sources],
                        "candidates_filtered": filtered_candidates,
                        "clips": downloaded,
                        "coverage": coverage,
                        "errors": _reported_errors(errors),
                        "elapsed_seconds": round(elapsed, 2),
                        "timeout_seconds": timeout_seconds,
                    },
                    cost_usd=0.0,
                    duration_seconds=round(elapsed, 2),
                )

            def timed_out() -> bool:
                return time.time() >= deadline

            for q_spec in queries:
                if timed_out():
                    return timeout_result(phase="query", query=q_spec.get("query", ""))

                query = q_spec["query"]
                queries_started += 1
                slot_id = q_spec.get("slot_id", "")
                kind = q_spec.get("kind", "video")
                collected_for_query = 0
                seen_ids = attempted_ids if unique_across_queries else set(excluded_ids)
                required, minimum_clips, max_clip_duration = requirements[queries_started - 1]
                query_coverage = {'query_index': queries_started, 'slot_id': slot_id,
                                  'required_seconds': required, 'verified_usable_seconds': 0.,
                                  'max_seconds_per_clip': max_clip_duration, 'minimum_distinct_clips': minimum_clips,
                                  'clips_ready': 0, 'target_met': False, 'missing_seconds': required}
                coverage.append(query_coverage)

                def needs_more():
                    return collected_for_query < clips_per_query and not (
                        required > 0 and collected_for_query >= minimum_clips and
                        query_coverage['verified_usable_seconds'] >= required)

                filters = SearchFilters(
                    kind=kind,
                    per_page=max(clips_per_query * 2, 10),  # fetch extra for filtering
                    min_duration=filters_in.get("min_duration"),
                    max_duration=filters_in.get("max_duration"),
                    orientation=filters_in.get("orientation"),
                    min_width=filters_in.get("min_width"),
                )

                _report_progress('query_started', query_index=queries_started, queries_total=len(queries),
                                 clips_ready=len(downloaded))
                for src, candidates, search_error in _search_source_batches(
                        sources, query, filters, deadline, concurrency, blocked_sources,
                        needs_more):
                    if timed_out():
                        return timeout_result(phase="search", query=query, source=src.name)

                    if isinstance(search_error, _DeadlineExceeded):
                        return timeout_result(phase="search", query=query, source=src.name)
                    if search_error is not None:
                        failure = _source_failure(search_error)
                        if _stop_source_for_run(failure):
                            blocked_sources.add(src.name)
                        errors.append({
                            "phase": "search",
                            "source": src.name,
                            "query": query,
                            **failure,
                        })
                        continue

                    for failure in getattr(candidates, 'errors', []):
                        errors.append({'phase': 'search', 'source': src.name, 'query': query, **failure})
                        if _stop_source_for_run(failure):
                            blocked_sources.add(src.name)
                    if src.name in blocked_sources:
                        continue
                    def accepted(candidate):
                        nonlocal filtered_candidates
                        if candidate.clip_id in seen_ids or not _candidate_metadata_matches(candidate, metadata_groups):
                            filtered_candidates += 1
                            return False
                        # Reserve before scheduling: failed duplicate entries are
                        # not an implicit retry of the same provider asset.
                        seen_ids.add(candidate.clip_id)
                        return True

                    pending_timeout = None
                    fatal_error = False
                    source_records = []
                    for outcome, batch_last in _download_batches(
                            src, candidates, download_store, thumbs_dir, deadline,
                            skip_existing=skip_existing, extract_thumbs=extract_thumbs,
                            concurrency=download_concurrency, accepted=accepted,
                            needs_more=needs_more, slots=lambda: clips_per_query-collected_for_query,
                            duration_left=lambda: max(0., required-query_coverage['verified_usable_seconds']),
                            minimum_left=lambda: max(0, minimum_clips-collected_for_query),
                            max_clip_duration=max_clip_duration, use_duration=required > 0,
                            stopped=lambda: src.name in blocked_sources,
                            progress={'query_index':queries_started, 'queries_total':len(queries)}):
                        cand = outcome['candidate']
                        error = outcome.get('error')
                        if isinstance(error, (_DeadlineExceeded, DownloadDeadlineExceeded)):
                            pending_timeout = pending_timeout or (outcome['phase'], cand.clip_id)
                        elif error is not None:
                            failure = _source_failure(error)
                            errors.append({'phase':outcome['phase'], 'clip_id':cand.clip_id,
                                           'source':src.name, **failure})
                            if _stop_source_for_run(failure):
                                blocked_sources.add(src.name)
                            fatal_error = fatal_error or outcome.get('fatal',False)
                        if outcome.get('media') is not None:
                            media, clip_path = outcome['media'], outcome['path']
                            reused = outcome['reused']
                            record = {'clip_id':cand.clip_id, 'source':cand.source, 'source_id':cand.source_id,
                                      'source_url':cand.source_url, 'query':query, 'slot_id':slot_id,
                                      'kind':cand.kind, 'path':str(clip_path), 'thumbnail':outcome['thumbnail'],
                                      'duration':media['duration'], 'width':media['width'], 'height':media['height'],
                                      'creator':cand.creator, 'license':cand.license, 'source_tags':cand.source_tags,
                                      'title':(cand.extra or {}).get('title',''), 'provenance':_search_provenance(cand),
                                      'skipped_existing':reused}
                            source_records.append((outcome['index'],record))
                            # Completion order drives live progress, source order
                            # drives results consumed by the assignment algorithm.
                            downloaded[:] = [d for d in downloaded if not any(d is row for _,row in source_records)]
                            downloaded.extend(row for _,row in sorted(source_records))
                            skipped += int(reused)
                            if not reused:
                                per_source_counts[src.name] = per_source_counts.get(src.name,0)+1
                            collected_for_query += 1
                            contribution = min(max_clip_duration, media['duration']) if cand.kind == 'video' else 0.
                            query_coverage['verified_usable_seconds'] += contribution
                            query_coverage['clips_ready'] = collected_for_query
                            query_coverage['target_met'] = bool(required > 0 and collected_for_query >= minimum_clips and
                                query_coverage['verified_usable_seconds'] >= required)
                            query_coverage['missing_seconds'] = max(0.,required-query_coverage['verified_usable_seconds'])
                            _report_progress('clip_ready', source=src.name, reused=reused,
                                             query_index=queries_started, queries_total=len(queries),
                                             clips_ready=len(downloaded), coverage=dict(query_coverage))
                        if batch_last and pending_timeout:
                            phase, identity = pending_timeout
                            return timeout_result(phase=phase,query=query,source=src.name,clip_id=identity)
                        if batch_last and fatal_error:
                            return ToolResult(success=False,error='Stock media directory cannot be safely used; existing files were retained.',
                                data={'clips':downloaded,'total_clips':len(downloaded),'errors':_reported_errors(errors),'coverage':coverage})

            elapsed = time.time() - start

            return ToolResult(
                success=True,
                data={
                    "output_dir": str(output_dir),
                    "clips_downloaded": len([d for d in downloaded if not d.get("skipped_existing")]),
                    "clips_reused": skipped,
                    "total_clips": len(downloaded),
                    "distinct_clip_ids": len({row['clip_id'] for row in downloaded}),
                    "unique_across_queries": unique_across_queries,
                    "queries_without_clips": sum(row['clips_ready'] == 0 for row in coverage),
                    "per_source_counts": per_source_counts,
                    "queries_run": queries_started,
                    "resolved_sources": [s.name for s in sources],
                    "candidates_filtered": filtered_candidates,
                    "clips": downloaded,
                    "coverage": coverage,
                    "errors": _reported_errors(errors),
                },
                cost_usd=0.0,
                duration_seconds=round(elapsed, 2),
            )

        except Exception as e:
            import traceback
            return ToolResult(
                success=False,
                error=f"{type(e).__name__}: {e}\n{traceback.format_exc()[-800:]}",
            )


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------

def _query_requirements(spec, limit):
    def number(name, default, maximum, positive=False):
        value = spec.get(name, default)
        if isinstance(value, bool) or not isinstance(value, (int,float)) or not math.isfinite(value) or value > maximum or (value <= 0 if positive else value < 0):
            raise ValueError(f'Invalid {name}')
        return float(value)
    required = number('required_duration_seconds', 0, 7200)
    maximum = number('max_clip_duration_seconds', 5, 120, positive=True)
    minimum = spec.get('minimum_clips', 1)
    if type(minimum) is not int or not 1 <= minimum <= limit:
        raise ValueError('minimum_clips must be an integer within clips_per_query')
    return required, minimum, maximum


def _acquire_candidate(source, candidate, store, thumbs_dir, deadline, *, skip_existing, extract_thumbs, notify):
    """One independent attempt. A timeout can still carry completed media."""
    result = {'candidate':candidate, 'phase':'validation', 'media':None, 'thumbnail':'', 'reused':False, 'fatal':True}
    try:
        ext = _guess_ext(candidate)
        cached = store.find(candidate.clip_id,ext,candidate.kind,deadline) if skip_existing else None
        if cached:
            path, media = cached
            result.update(path=path,media=media,reused=True,fatal=False)
            thumbnail = _thumbnail_path(thumbs_dir,path,candidate.clip_id)
            if thumbnail.exists(): result['thumbnail'] = str(thumbnail)
            return result
        path = store.allocate(candidate.clip_id,ext)
        result.update(path=path,phase='download',fatal=False)
        notify({'phase':'download_started','source':source.name})
        with _requests_deadline(deadline):
            source.download(candidate,path)
        result['phase'] = 'validation'
        media = store.complete(path,candidate.clip_id,candidate.kind,deadline)
        result['media'] = media
        if extract_thumbs and candidate.kind == 'video':
            result['phase'] = 'thumbnail'
            thumbnail = _thumbnail_path(thumbs_dir,path,candidate.clip_id)
            try:
                _extract_mid_thumbnail(path,thumbnail,timeout_seconds=remaining_seconds(deadline))
                if thumbnail.exists(): result['thumbnail'] = str(thumbnail)
            except (_DeadlineExceeded, DownloadDeadlineExceeded): raise
            except subprocess.TimeoutExpired:
                if time.time() >= deadline:
                    raise _DeadlineExceeded('Thumbnail exceeded the acquisition deadline')
            except Exception: pass
    except Exception as error:
        result['error'] = error
    return result


def _download_batches(source, candidates, store, thumbs_dir, deadline, *, skip_existing,
                      extract_thumbs, concurrency, accepted, needs_more, slots, duration_left,
                      minimum_left, max_clip_duration, use_duration, stopped, progress):
    """Never queue more than the remaining hard quota, or another batch on stop.

    Provider durations only choose a prefix of a batch. Decisions to stop use
    validated durations in the caller. All already-running siblings are drained
    before a timeout is returned, so their completed files remain in results.
    """
    iterator = iter(enumerate(candidates))
    def report(row):
        values = dict(progress, **row)
        _report_progress(values.pop('phase'), **values)
    while needs_more() and not stopped():
        batch, estimated = [], 0.
        for index, candidate in iterator:
            if not accepted(candidate): continue
            batch.append((index,candidate))
            try: duration = float(candidate.duration)
            except (TypeError,ValueError): duration = 0.
            estimated += min(max_clip_duration,duration) if math.isfinite(duration) and duration > 0 else 0.
            if len(batch) >= min(concurrency,slots()) or (use_duration and len(batch) >= max(1,minimum_left()) and estimated >= duration_left()):
                break
        if not batch: return
        if len(batch) == 1:
            index,candidate = batch[0]
            result = _acquire_candidate(source,candidate,store,thumbs_dir,deadline,
                skip_existing=skip_existing,extract_thumbs=extract_thumbs,notify=report)
            yield dict(result,index=index), True
        else:
            events = queue.Queue()
            def drain():
                while True:
                    try: report(events.get_nowait())
                    except queue.Empty: return
            with ThreadPoolExecutor(max_workers=len(batch),thread_name_prefix='stock-download') as pool:
                pending = {pool.submit(_acquire_candidate,source,candidate,store,thumbs_dir,deadline,
                    skip_existing=skip_existing,extract_thumbs=extract_thumbs,notify=events.put):index for index,candidate in batch}
                while pending:
                    done,_ = wait(pending,timeout=.05,return_when=FIRST_COMPLETED)
                    drain()
                    for future in sorted(done,key=lambda f:pending[f]):
                        index = pending.pop(future)
                        yield dict(future.result(),index=index), not pending
                drain()


def _thumbnail_path(thumbs_dir: Path, clip_path: Path, clip_id: str) -> Path:
    if clip_path.parent.name.startswith('download-'):
        token = hashlib.sha256(clip_id.encode()).hexdigest()[:16]
        return thumbs_dir / f"{token}-{clip_path.parent.name}.jpg"
    # Legacy IDs reach this branch only after the store's strict path check.
    return thumbs_dir / f"{clip_id}.jpg"


def _source_failure(exc) -> dict:
    """Persist an error kind/status, never a request URL, auth header or body."""
    from tools.video.stock_sources.base import source_failure
    return source_failure(exc)


def _stop_source_for_run(failure) -> bool:
    from tools.video.stock_sources.base import stop_source_for_run
    return stop_source_for_run(failure)


def _reported_errors(errors):
    """Bound diagnostics without hiding the reason to stop a provider.

    The footage caller starts a fresh tool execution for each keyword. It must
    still receive each provider's stop signal when earlier invalid media filled
    the display limit. Preserve original ordering among the retained entries.
    """
    if len(errors) <= 25:
        return errors
    critical = {}
    for i, failure in enumerate(errors):
        if _stop_source_for_run(failure):
            critical.setdefault(failure.get('source'), i)
    selected = set(list(critical.values())[:25])
    for i in range(len(errors)):
        if len(selected) == 25:
            break
        selected.add(i)
    return [errors[i] for i in sorted(selected)]


def _search_provenance(candidate) -> dict:
    """Fixed search attribution only; never raw provider response/config."""
    info = candidate.extra or {}
    value = {"search_engine": info.get("search_engine", "native"), "provider": candidate.source}
    if info.get("search_engine") == "moneyprinterturbo":
        value["upstream_function"] = info.get("upstream_function", "")
        if info.get('metadata_origin') in {'provider_tags', 'source_page_slug'}:
            value['metadata_origin'] = info['metadata_origin']
    return value


def _candidate_metadata_matches(candidate, groups: list[list[str]]) -> bool:
    """Gate before the quota, using provider metadata rather than input query."""
    normalize = lambda x: re.sub(r'[^a-z0-9\u3400-\u9fff]+', '', urllib.parse.unquote(str(x or '')).lower())
    value = normalize(' '.join(str(x or '') for x in
        (candidate.source_url, candidate.source_tags, (candidate.extra or {}).get('title', ''))))
    return all(group and any(normalize(term) and normalize(term) in value for term in group) for group in groups)


def _guess_ext(cand) -> str:
    """Extract a sensible file extension from a candidate's URL."""
    known = {".mp4", ".mov", ".mkv", ".webm", ".ogv", ".m4v",
             ".jpg", ".jpeg", ".png", ".tif", ".tiff"}
    path = urllib.parse.urlparse(cand.download_url).path
    ext = Path(path).suffix.lower()
    if ext in known:
        return ".jpg" if ext == ".jpeg" else ext
    return ".mp4" if cand.kind == "video" else ".jpg"


def remaining_seconds(deadline: float) -> float:
    remaining = deadline - time.time()
    if remaining <= 0:
        raise _DeadlineExceeded("direct_clip_search deadline exceeded")
    return remaining


def _clamp_timeout(timeout: Any, remaining: float) -> Any:
    if timeout is None:
        return remaining
    if isinstance(timeout, tuple):
        return tuple(min(float(part), remaining) for part in timeout)
    try:
        return min(float(timeout), remaining)
    except (TypeError, ValueError):
        return remaining


def _search_source_batches(sources, query, filters, deadline, concurrency, blocked, needs_more):
    """Lazy bounded fan-out with priority-ordered consumption.

    Complete one small batch before yielding. The next batch is never submitted
    once quota is met. One provider has at most one request in flight; failures
    stay typed and are consumed even when a sibling already filled the quota.
    """
    from copy import copy

    def search(source):
        try:
            with _requests_deadline(deadline):
                return source.search(query, copy(filters)), None
        except Exception as exc:
            return None, exc

    eligible = [source for source in sources if source.name not in blocked]
    for offset in range(0, len(eligible), concurrency):
        if not needs_more():
            return
        batch = [s for s in eligible[offset:offset + concurrency] if s.name not in blocked]
        if not batch:
            continue
        results = {}
        for source in batch:
            _report_progress('search_started', source=source.name)
        if len(batch) == 1:
            results[0] = search(batch[0])
            _report_progress('search_completed', source=batch[0].name,
                             failed=results[0][1] is not None)
        else:
            with ThreadPoolExecutor(max_workers=len(batch), thread_name_prefix='stock-search') as pool:
                futures = {pool.submit(search, source): i for i, source in enumerate(batch)}
                for future in as_completed(futures):
                    i = futures[future]
                    results[i] = future.result()
                    _report_progress('search_completed', source=batch[i].name,
                                     failed=results[i][1] is not None)
        for i, source in enumerate(batch):
            candidates, error = results[i]
            yield source, candidates, error


@contextmanager
def _requests_deadline(deadline: float):
    """A task-local deadline over one refcounted, thread-safe GET dispatcher.

    Unrelated threads pass through unchanged. Nested scopes cannot extend the
    outer budget. Streaming responses retain their call's budget after exit.
    Restore only our own wrapper, never another library's replacement.
    """
    import requests

    global _TRANSPORT_USERS, _TRANSPORT_WRAPPER, _TRANSPORT_ORIGINAL
    parent = _REQUEST_DEADLINE.get()
    effective = min(parent, deadline) if parent is not None else deadline
    with _TRANSPORT_LOCK:
        if _TRANSPORT_USERS == 0:
            original = requests.get

            def dispatch(*args, **kwargs):
                budget = _REQUEST_DEADLINE.get()
                if budget is None:
                    return original(*args, **kwargs)
                remaining = remaining_seconds(budget)
                kwargs['timeout'] = _clamp_timeout(kwargs.get('timeout'), remaining)
                response = original(*args, **kwargs)
                iterator = getattr(response, 'iter_content', None)
                if callable(iterator):
                    def chunks(*iter_args, **iter_kwargs):
                        for chunk in iterator(*iter_args, **iter_kwargs):
                            remaining_seconds(budget)
                            yield chunk
                    response.iter_content = chunks
                return response

            _TRANSPORT_ORIGINAL = original
            _TRANSPORT_WRAPPER = dispatch
            requests.get = dispatch
        elif requests.get is not _TRANSPORT_WRAPPER:
            raise RuntimeError('Stock request transport changed during acquisition')
        _TRANSPORT_USERS += 1
    token = _REQUEST_DEADLINE.set(effective)
    try:
        yield
    finally:
        _REQUEST_DEADLINE.reset(token)
        with _TRANSPORT_LOCK:
            _TRANSPORT_USERS -= 1
            if _TRANSPORT_USERS == 0:
                if requests.get is _TRANSPORT_WRAPPER:
                    requests.get = _TRANSPORT_ORIGINAL
                _TRANSPORT_WRAPPER = _TRANSPORT_ORIGINAL = None


def _extract_mid_thumbnail(
    video_path: Path,
    thumb_path: Path,
    *,
    timeout_seconds: float = 15,
) -> None:
    """Extract a single frame from the middle of the video via ffmpeg.

    This is deliberately simple — one frame, no CLIP, no motion score.
    The agent or user inspects the thumbnail visually to decide if the
    clip is a good match.
    """
    thumb_path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.time() + timeout_seconds

    # Probe duration first
    probe_cmd = [
        "ffprobe", "-v", "quiet",
        "-show_entries", "format=duration",
        "-of", "csv=p=0",
        str(video_path),
    ]
    try:
        probe_timeout = min(10, remaining_seconds(deadline))
        result = subprocess.run(
            probe_cmd, capture_output=True, text=True, timeout=probe_timeout
        )
        duration = float(result.stdout.strip() or "0")
    except (ValueError, subprocess.TimeoutExpired, FileNotFoundError):
        duration = 0

    # Seek to the middle (or 2 seconds in if duration unknown)
    seek_time = max(0.5, duration / 2) if duration > 1 else 2.0

    extract_cmd = [
        "ffmpeg", "-y",
        "-ss", str(round(seek_time, 2)),
        "-threads", "1", "-i", str(video_path), "-threads", "1",
        "-frames:v", "1",
        "-q:v", "3",
        str(thumb_path),
    ]
    extract_timeout = min(15, remaining_seconds(deadline))
    subprocess.run(
        extract_cmd, capture_output=True, timeout=extract_timeout,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
