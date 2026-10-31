"""OpenMontage Backlot + model-entry adapter.

The upstream Backlot remains an observer of ``projects/``.  This derivative
adapter adds a small, same-origin model page without changing the upstream
server: ``/`` and ``/p/<project>`` are still Backlot, while ``/model`` is a
safe Seedance request surface.

The browser can estimate freely.  A paid request is a two-step server-side
confirmation: the browser asks for a short-lived opaque confirmation id, then
the user explicitly clicks submit.  The provider authorization token is read
only by this process and is never sent to, or embedded in, the frontend.
"""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import AsyncExitStack, asynccontextmanager
import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import quote, urlparse
from urllib.request import Request as UrlRequest
from urllib.request import urlopen

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse, Response

from backlot.server import app as backlot_app, notify_project_changed
from backlot.state import PROJECTS_DIR, WORKFLOW_STATE_FILENAME
from lib.events import emit_event
from schemas.artifacts import validate_artifact
from web_api.app import (
    EstimateResponse,
    GenerationRequest,
    TaskResponse,
    _remove_sensitive_fields,
    app as task_app,
)
from web_api.audio_pipeline import AudioPipelineRequest, create_audio_app
from web_api.music_pipeline import MusicPipelineRequest, create_music_app
from web_api.local_bgm import LocalBgmRequest, import_local_bgm
from web_api.footage_api import create_footage_router
from web_api.montage_api import create_montage_router
from web_api.canvas_bridge import create_canvas_router
from web_api.canvas_module import create_canvas_module_router
from web_api.hypit_workbench import create_hypit_workbench_router
from web_api.reference_adaptation import create_reference_router
from web_api.local_tools_pipeline import LocalToolRequest, create_local_tools_app
from web_api.media_pipeline import (
    AudioEnhanceRequest,
    AudioMixRequest,
    ComposeRequest,
    FaceTrackRequest,
    FrameSampleRequest,
    ImagePipelineRequest,
    PublishRequest,
    QualityRequest,
    ReferenceReviewRequest,
    StockSearchRequest,
    StillComposeRequest,
    SubtitleRenderRequest,
    TrimRequest,
    TranscriptRequest,
    create_media_app,
    compose_media,
    quality_check,
    VideoPostprocessRequest,
    image_progress_context,
)


UI_DIR = Path(__file__).resolve().parent / "ui"
CONFIRMATION_TTL_SECONDS = 10 * 60
WORKFLOW_MODES = {"quality", "speed"}
ENTRY_MODES = {"guided", "material", "storyboard"}
_STORYBOARD_PROJECT_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

# Storyboard image generation can take several minutes (one provider call per
# shot).  Keep it out of the request thread so the browser can reconnect and
# inspect durable progress instead of mistaking an open HTTP connection for a
# live job.  The pool is deliberately small: it protects the local machine
# and avoids accidental parallel paid submissions.
_STORYBOARD_IMAGE_EXECUTOR = ThreadPoolExecutor(
    max_workers=2,
    thread_name_prefix="storyboard-image",
)
_STORYBOARD_IMAGE_LOCK = threading.Lock()
_STORYBOARD_IMAGE_STALL_SECONDS = 180


def _workflow_topic(prompt: str) -> str:
    """Keep the creator's topic readable when it is repeated in cards."""

    value = " ".join(str(prompt or "").split()).strip()
    if len(value) < 2:
        raise HTTPException(status_code=422, detail="prompt must contain at least two characters")
    return value[:42] + ("…" if len(value) > 42 else "")


def _workflow_mode(value: Any) -> str:
    mode = str(value or "quality").strip().lower()
    if mode not in WORKFLOW_MODES:
        raise HTTPException(status_code=422, detail="mode must be quality or speed")
    return mode


def _workflow_candidates(prompt: str, mode: str) -> dict[str, Any]:
    """Build three materially different, free planning candidates.

    This is deliberately a deterministic planning layer. It does not claim
    facts and it never calls a paid provider; research and model generation
    remain later, explicitly gated stages.
    """

    topic = _workflow_topic(prompt)
    mode = _workflow_mode(mode)
    digest = hashlib.sha256(prompt.encode("utf-8")).digest()
    perturb = digest[0] % 3
    blueprints = (
        {
            "kind": "trend_forward",
            "label": "趋势叙事",
            "title": f"{topic}：一眼记住的瞬间",
            "hook": "先用一个反常识细节抓住眼睛，再让整片风景在镜头里展开。",
            "signature_motif": "一束移动的光从细节切到远景",
            "transition_strategy": "光束匹配剪辑：近景高光的运动方向延续到湖面与山脊",
            "share_trigger": "首屏三秒给出可复述的视觉记忆点",
            "shareable_line": "真正让人记住一座地方的，往往不是全景，而是那一瞬间的光。",
            "narration": "从一个可感知的细节出发，让风、光和水面把观众带进目的地。",
            "shots": (
                ("微光定场", "极近景的水面反光与叶尖露珠", "慢推，焦点由露珠转向远处亮起的湖面"),
                ("光线出走", "光束掠过岸边石阶、树影和倒影", "沿光束方向横移，保留自然运动模糊"),
                ("山湖打开", "湖湾、群山、云层与古建筑形成纵深", "无人机式缓慢升高，前景树枝擦镜转场"),
                ("人物入景", "一位游客沿栈道停下，人物只占画面小比例", "跟随两步后停住，风吹衣角作为连续性锚点"),
                ("细节回响", "手掌掠过栏杆，栏杆上的水珠映出山色", "从手部微距拉焦到倒影，避免手部夸张"),
                ("记忆落点", "夕阳落入湖湾，风把云影推向画面深处", "镜头向前漂移并淡出到干净天空，留字幕安全区"),
            ),
        },
        {
            "kind": "knowledge_first",
            "label": "知识叙事",
            "title": f"{topic}：三问三答看懂它",
            "hook": "用三个观众会问的问题组织景别变化，每个答案都落到一处可见的风景证据。",
            "signature_motif": "同一条水纹在不同景别中反复出现",
            "transition_strategy": "水纹形状匹配：微观纹理、岸线、云影之间连续变形",
            "share_trigger": "每个问句都能独立截取成一张分享卡片",
            "shareable_line": "看懂一处风景，也就看懂了它为什么值得再来一次。",
            "narration": "不堆砌资料，把可核验的事实留给后续研究，把好奇心先交给画面。",
            "shots": (
                ("问题一：从哪里看", "地图感的湖湾全景与山脊层次", "俯拍缓慢旋转，湖岸线成为下一镜的边界帧"),
                ("答案一：看水纹", "岸边风纹、芦苇和倒影的中近景", "沿水纹低机位推进，水面反光自然遮挡转场"),
                ("问题二：为什么特别", "古建屋檐、老街肌理与远山叠合", "从屋檐仰拍摇到远山，保持同一侧光方向"),
                ("答案二：看时间", "晨雾、午后金光、暮色在同一构图中递进", "固定构图的时间流逝，云影方向保持一致"),
                ("问题三：怎样抵达", "栈道、船影和林间入口汇成一条路线", "跟随人物背影进入树影，树影擦镜接结尾"),
            ),
        },
        {
            "kind": "stable_storytelling",
            "label": "故事叙事",
            "title": f"{topic}：沿着一阵风去旅行",
            "hook": "把目的地写成一次有起承转合的短途旅行，情绪从安静到开阔再回到余韵。",
            "signature_motif": "一面轻动的旗帜/树叶作为每次转场的共享边界",
            "transition_strategy": "动作连续性：风吹叶片、人物转身、船行方向贯穿全片",
            "share_trigger": "结尾留出一句有情绪的邀请，但不做生硬广告口号",
            "shareable_line": "风从湖面来，也把人带回愿意慢下来的地方。",
            "narration": "让观众跟着风走过入口、湖面、山色和夜色，最后把故事交还给真实地点。",
            "shots": (
                ("入口听风", "林间入口与远处一线湖光", "手持感极轻的前行，叶片掠过镜头左侧"),
                ("风到湖面", "开阔湖面、低云与一叶小舟", "低空横移，船行方向与前镜叶片运动一致"),
                ("山色回应", "山脊云雾、湿润岩石和层叠树林", "沿山脊弧线环绕，雾气遮挡完成自然转场"),
                ("人在景中", "人物站在观景台边缘，比例克制、环境占主导", "从背影绕到侧面，人物只出现一次且不复制"),
                ("古意一闪", "屋檐、石墙、老街灯影与雨后地面", "沿灯影滑行，反射高光接下一镜"),
                ("暮色回望", "暮色湖湾与渐亮的第一盏灯", "固定构图中光线渐变，保留完整暗部细节"),
                ("风留在身后", "远景回望整片山湖，前景树叶轻晃", "慢慢后退并停住，天空留出字幕安全区"),
            ),
        },
    )
    candidates: list[dict[str, Any]] = []
    for index, blueprint in enumerate(blueprints, start=1):
        # Small deterministic variation avoids a permanently hard-coded winner
        # while keeping the three scores explainable and reproducible.
        shift = ((perturb + index) % 3) - 1
        priority = {
            "originality": 91 + (3 if index == 1 else 0) + shift,
            "style_consistency": 90 + (4 if index == 2 else 0) - shift,
            "shareability": 89 + (5 if index == 3 else 0) + shift,
        }
        official = {
            "scenario_value": 88 + (4 if index == 2 else 0) + shift,
            "aigc_effect": 89 + (4 if index == 1 else 0) - shift,
            "technical_innovation": 88 + (5 if index == 3 else 0) + shift,
            "system_completeness": 90 + (2 if index == 2 else 0),
        }
        priority_total = round(
            priority["originality"] * 0.35
            + priority["style_consistency"] * 0.35
            + priority["shareability"] * 0.30,
            1,
        )
        official_total = round(
            official["scenario_value"] * 0.25
            + official["aigc_effect"] * 0.30
            + official["technical_innovation"] * 0.25
            + official["system_completeness"] * 0.20,
            1,
        )
        shot_outline = [
            {
                "index": shot_index,
                "title": shot_title,
                "visual": visual,
                "motion": motion,
                "duration_hint_seconds": 5 if shot_index < len(blueprint["shots"]) else 6,
            }
            for shot_index, (shot_title, visual, motion) in enumerate(blueprint["shots"], start=1)
        ]
        candidates.append(
            {
                "id": f"candidate-{index}",
                "title": blueprint["title"],
                "candidate_class": blueprint["kind"],
                "class_label": blueprint["label"],
                "concept": blueprint["hook"],
                "hook": blueprint["hook"],
                "full_narration": blueprint["narration"],
                "fact_ids": [],
                "fact_status": "needs_research",
                "proposed_shot_count": len(shot_outline),
                "shot_count_rationale": "按信息密度与镜头动作自适应拆分，避免所有镜头使用同一景别或同一节奏。",
                "structure_mode": blueprint["kind"],
                "signature_motif": blueprint["signature_motif"],
                "transition_strategy": blueprint["transition_strategy"],
                "share_trigger": blueprint["share_trigger"],
                "shareable_line": blueprint["shareable_line"],
                "scenic_visual_priority": True,
                "shot_outline": shot_outline,
                "scorecard": {
                    "priority": {**priority, "total": priority_total},
                    "official": {**official, "weighted_total": official_total},
                    "note": "系统预评估，不是评委最终分数；事实核验在分镜前补齐。",
                },
            }
        )
    winner = max(
        candidates,
        key=lambda item: (
            item["scorecard"]["official"]["weighted_total"],
            item["scorecard"]["priority"]["total"],
        ),
    )
    return {
        "workflow_id": f"wf-{hashlib.sha256((prompt + mode).encode('utf-8')).hexdigest()[:12]}",
        "mode": mode,
        "stage": "creative_selection",
        "research": {
            "status": "needs_sources",
            "source_policy": ["官方文旅/政府/博物馆等一手来源", "权威媒体或学术资料", "仅作灵感的社区内容"],
            "checks": [
                {"id": "place_identity", "label": "地点名称与行政归属", "status": "needs_source"},
                {"id": "history_claims", "label": "历史、年代、人物与数据", "status": "needs_source"},
                {"id": "visual_safety", "label": "画面以景色为主且不虚构事实", "status": "safe_by_default"},
            ],
            "note": "三案可以先规划；未通过来源核验的内容不会被标成已证实事实。",
        },
        "candidates": candidates,
        "selected_candidate_id": winner["id"] if mode == "speed" else None,
        "selection_reason": (
            f"速度优先：按官方权重预评估自动选择 {winner['title']}，"
            "将继续进入分镜规划。"
            if mode == "speed"
            else "质量优先：三案已展示，等待创作者选择；系统不会擅自替换创作者决定。"
        ),
        "approval_required": mode == "quality",
        "next_stage": "storyboard",
    }


def _workflow_storyboard(prompt: str, candidate: dict[str, Any], mode: str) -> dict[str, Any]:
    """Turn one selected candidate into a continuity-aware free storyboard."""

    topic = _workflow_topic(prompt)
    mode = _workflow_mode(mode)
    outline = candidate.get("shot_outline")
    if not isinstance(outline, list) or not outline:
        raise HTTPException(status_code=422, detail="candidate has no shot outline")
    shots: list[dict[str, Any]] = []
    for index, item in enumerate(outline, start=1):
        if not isinstance(item, dict):
            continue
        previous = shots[-1] if shots else None
        title = str(item.get("title") or f"分镜 {index}")
        visual = str(item.get("visual") or "高信息密度的目的地风景")
        motion = str(item.get("motion") or "自然、克制的电影级运镜")
        first_frame = (
            "承接开场干净天空/湖面边界，保持光线方向与色彩基调一致。"
            if previous is None
            else f"承接上一镜尾帧的{previous['continuity_anchor']}，保持主体位置、运动方向和光线不跳变。"
        )
        last_frame = f"以{visual}中的主运动方向收束，留下可被下一镜接住的{title}边界帧。"
        shots.append(
            {
                "id": f"shot-{index}",
                "title": title,
                "duration_seconds": int(item.get("duration_hint_seconds") or 5),
                "purpose": "信息密度、视觉差异与情绪推进并重",
                "visual_prompt": (
                    f"{topic}，{visual}；电影级3D写实风景，真实地域质感，"
                    "高精度材质与自然光照，画面无文字、无水印，主体细节清晰。"
                ),
                "motion_prompt": f"{motion}；运镜突出画面重点，避免静止幻灯片感。",
                "first_frame_contract": first_frame,
                "last_frame_contract": last_frame,
                "continuity_anchor": "风、光、倒影或树叶的运动方向",
                "transition_to_next": "使用共享边界帧做匹配转场，优先让景物运动自然带入下一镜。",
                "quality_checks": [
                    "保持人物/建筑/自然景观比例稳定，不复制人物，不增加无关路人",
                    "前后帧主体、光线方向和色彩连续",
                    "信息密度足够但不堆叠互相冲突的主体",
                ],
                "scenic_visual_priority": True,
            }
        )
    return {
        "stage": "storyboard",
        "status": "awaiting_human_approval" if mode == "quality" else "auto_accepted",
        "mode": mode,
        "topic": topic,
        "candidate_id": candidate.get("id"),
        "candidate_title": candidate.get("title"),
        "shots": shots,
        "approval_required": mode == "quality",
        "next_action": (
            "创作者检查并确认分镜后，才进入配音/视频生成。"
            if mode == "quality"
            else "分镜已自动接收，可进入付费模型二次确认。"
        ),
    }


def _storyboard_with_overrides(
    prompt: str,
    candidate: dict[str, Any],
    mode: str,
    raw_storyboard: Any | None = None,
) -> dict[str, Any]:
    """Merge creator edits onto the canonical storyboard without losing continuity.

    The browser sends the current storyboard back when a creator repairs one
    shot.  We only accept known shot ids and a small set of text/number fields;
    this keeps the project artifact deterministic and prevents arbitrary JSON
    from changing the workflow contract.
    """

    base = _workflow_storyboard(prompt, candidate, mode)
    if not isinstance(raw_storyboard, dict):
        return base
    raw_shots = raw_storyboard.get("shots")
    if not isinstance(raw_shots, list):
        return base
    by_id = {
        str(item.get("id")): item
        for item in raw_shots
        if isinstance(item, dict) and item.get("id")
    }
    text_fields = {
        "title", "purpose", "visual_prompt", "motion_prompt",
        "first_frame_contract", "last_frame_contract", "continuity_anchor",
        "transition_to_next",
    }
    media_fields = {"image_path", "image_sha256", "image_provider", "image_model"}
    for shot in base["shots"]:
        override = by_id.get(shot["id"])
        if not isinstance(override, dict):
            continue
        for key in text_fields:
            value = override.get(key)
            if isinstance(value, str) and value.strip() and len(value) <= 20_000:
                shot[key] = value.strip()
        for key in media_fields:
            value = override.get(key)
            if isinstance(value, str) and value.strip() and len(value) <= 1_024:
                shot[key] = value.strip()
        duration = override.get("duration_seconds")
        if isinstance(duration, (int, float)) and not isinstance(duration, bool):
            shot["duration_seconds"] = max(2, min(30, int(round(duration))))
        if isinstance(override.get("quality_checks"), list):
            shot["quality_checks"] = [
                str(item).strip()[:500]
                for item in override["quality_checks"]
                if str(item).strip()
            ][:12] or shot["quality_checks"]
        if isinstance(override.get("repair_instructions"), str):
            shot["repair_instructions"] = override["repair_instructions"].strip()[:5_000]
        if isinstance(override.get("revision"), int):
            shot["revision"] = max(0, min(99, override["revision"]))
    base["status"] = "awaiting_human_approval" if mode == "quality" else "auto_accepted"
    base["next_action"] = (
        "创作者检查并确认分镜后，才进入配音/视频生成。"
        if mode == "quality"
        else "分镜已自动接收，可进入付费模型二次确认。"
    )
    return base


def _repair_storyboard_shot(
    prompt: str,
    candidate: dict[str, Any],
    mode: str,
    shot_id: str,
    instructions: str,
    raw_storyboard: Any | None = None,
    visual_prompt: str | None = None,
    motion_prompt: str | None = None,
) -> dict[str, Any]:
    """Apply a targeted, free storyboard repair and return the full board."""

    storyboard = _storyboard_with_overrides(prompt, candidate, mode, raw_storyboard)
    target = next((shot for shot in storyboard["shots"] if shot.get("id") == shot_id), None)
    if target is None:
        raise HTTPException(status_code=422, detail="shot_id is not valid for this storyboard")
    note = " ".join(str(instructions or "").split()).strip()
    if len(note) < 2:
        raise HTTPException(status_code=422, detail="repair instructions must contain at least two characters")
    if len(note) > 5_000:
        raise HTTPException(status_code=422, detail="repair instructions are too long")
    if visual_prompt is not None:
        value = str(visual_prompt).strip()
        if value:
            target["visual_prompt"] = value[:20_000]
    else:
        target["visual_prompt"] = f"{target.get('visual_prompt', '').rstrip('。')}；返修要求：{note}。"
    if motion_prompt is not None:
        value = str(motion_prompt).strip()
        if value:
            target["motion_prompt"] = value[:20_000]
    else:
        target["motion_prompt"] = f"{target.get('motion_prompt', '').rstrip('。')}；镜头动作同步落实：{note}。"
    target["repair_instructions"] = note
    target["revision"] = int(target.get("revision") or 0) + 1
    target["quality_checks"] = list(dict.fromkeys([
        *(target.get("quality_checks") or []),
        "已记录创作者定点返修；返修后需重新检查人物/景物比例、信息密度与共享边界帧。",
    ]))
    storyboard["repaired_shot_id"] = shot_id
    storyboard["repair_revision"] = target["revision"]
    storyboard["repair_instructions"] = note
    return storyboard


def _utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _write_json(path: Path, value: dict[str, Any]) -> None:
    """Write a project artifact atomically so the board never reads half JSON."""

    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def _resolve_storyboard_project(root: Path, project_id: str) -> Path:
    """Resolve one storyboard project without accepting path fragments."""

    if not _STORYBOARD_PROJECT_ID_RE.fullmatch(project_id):
        raise ValueError("project_id contains unsupported path characters")
    root_path = Path(root).expanduser().resolve()
    project_dir = (root_path / project_id).resolve()
    if project_dir.parent != root_path or not project_dir.is_dir():
        raise FileNotFoundError(f"project does not exist: {project_id}")
    return project_dir


def _storyboard_image_job_path(project_dir: Path) -> Path:
    """Return the single durable image-job record for one project.

    One record per project makes a repeated browser click idempotent: an
    accepted/running job can be found after a refresh and the same request is
    never submitted to a paid provider twice.  A later failed job may be
    replaced by a new explicit creator submission.
    """

    return project_dir / "artifacts" / "storyboard_image_job.json"


def _read_storyboard_image_job(project_dir: Path) -> dict[str, Any] | None:
    path = _storyboard_image_job_path(project_dir)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _storyboard_image_fingerprint(request: ImagePipelineRequest) -> str:
    """Hash the paid request body while excluding control flags.

    This is an idempotency key, not a secret: it only identifies equal shot
    prompts/parameters so retries can reuse the existing job receipt.
    """

    payload = request.model_dump(mode="json")
    payload.pop("dry_run", None)
    payload.pop("execute", None)
    payload.pop("confirm", None)
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()[:24]


def _storyboard_image_job_update(project_dir: Path, **updates: Any) -> dict[str, Any]:
    """Merge and atomically persist a job update, then wake Backlot."""

    with _STORYBOARD_IMAGE_LOCK:
        current = _read_storyboard_image_job(project_dir) or {}
        # A watchdog/status poll may arrive after the worker has written its
        # terminal result.  Never let that late, stale update reopen a failed
        # or completed job as ``running``/``stalled``.  The worker is still
        # allowed to move a non-terminal job to a terminal state.
        current_status = str(current.get("status") or "")
        incoming_status = updates.get("status")
        if current_status in {"completed", "failed"} and incoming_status not in {None, current_status}:
            return current
        current.update(updates)
        _write_json(_storyboard_image_job_path(project_dir), current)
    notify_project_changed(project_dir.name)
    return current


def _storyboard_image_progress(project_dir: Path, job: dict[str, Any]) -> tuple[int, list[str], str | None]:
    """Count outputs written by this job, avoiding stale files from old runs."""

    output_paths = job.get("shot_outputs")
    shot_ids = job.get("shot_ids")
    if not isinstance(output_paths, list):
        output_paths = []
    if not isinstance(shot_ids, list):
        shot_ids = []
    started_epoch = job.get("started_epoch")
    try:
        started_epoch = float(started_epoch)
    except (TypeError, ValueError):
        started_epoch = None
    completed_ids: list[str] = []
    latest_artifact_at: str | None = None
    for index, raw_path in enumerate(output_paths):
        if not isinstance(raw_path, str) or not raw_path:
            continue
        candidate = (project_dir / raw_path).resolve()
        try:
            candidate.relative_to(project_dir.resolve())
        except ValueError:
            continue
        try:
            stat = candidate.stat()
        except OSError:
            continue
        if stat.st_size <= 0 or (started_epoch is not None and stat.st_mtime + 0.01 < started_epoch):
            continue
        shot_id = str(shot_ids[index]) if index < len(shot_ids) else candidate.stem
        completed_ids.append(shot_id)
        latest_artifact_at = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat()
    return len(completed_ids), completed_ids, latest_artifact_at


def _storyboard_image_items(value: Any) -> list[dict[str, Any]]:
    """Extract the durable per-shot image records from a job or provider result."""

    if isinstance(value, dict):
        for key in ("images_written", "images"):
            items = value.get(key)
            if isinstance(items, list):
                return [item for item in items if isinstance(item, dict)]
        nested = value.get("result")
        if isinstance(nested, dict):
            return _storyboard_image_items(nested)
    return []


def _safe_storyboard_image_items(value: Any) -> list[dict[str, Any]]:
    """Keep only non-sensitive metadata needed to paint a storyboard card."""

    allowed = ("shot_id", "path", "sha256", "size_bytes", "provider", "model", "prompt_sha256")
    return [
        {key: item.get(key) for key in allowed if item.get(key) is not None}
        for item in _storyboard_image_items(value)
    ]


def _storyboard_image_job_snapshot(project_dir: Path, *, mutate_stall: bool = False) -> dict[str, Any] | None:
    """Read live progress and report a stalled worker without auto-retrying."""

    job = _read_storyboard_image_job(project_dir)
    if not job:
        return None
    completed, completed_ids, latest_artifact_at = _storyboard_image_progress(project_dir, job)
    # The worker records the artifact immediately after each provider call.
    # Merge that durable list with the filesystem check so a status poll can
    # never move a truthful 4/5 heartbeat backwards while the file timestamp
    # is still being observed by the OS.
    persisted_items = _safe_storyboard_image_items(job)
    persisted_ids = [str(item.get("shot_id")) for item in persisted_items if item.get("shot_id")]
    if persisted_ids:
        completed_ids = list(dict.fromkeys([*completed_ids, *persisted_ids]))
        completed = max(completed, len(completed_ids))
    updates: dict[str, Any] = {
        "completed_shots": completed,
        "completed_shot_ids": completed_ids,
    }
    if latest_artifact_at:
        updates["last_artifact_at"] = latest_artifact_at
    status = str(job.get("status") or "unknown")
    # Older jobs could be left as ``stalled`` when a watchdog write raced the
    # worker's final failure write.  The persisted result is authoritative, so
    # repair that historical state on read instead of making the UI look stuck.
    result = job.get("result")
    if status == "stalled" and isinstance(result, dict) and result.get("status") == "failed":
        error = job.get("error") or result.get("error")
        status = "failed"
        updates.update({
            "status": "failed",
            "state": "failed",
            "error": error,
            "message": error or "图片生成未完成。",
        })
    elif status in {"accepted", "running"}:
        raw_heartbeat = job.get("last_heartbeat_at") or job.get("accepted_at")
        stale = False
        if isinstance(raw_heartbeat, str):
            try:
                heartbeat_at = datetime.fromisoformat(raw_heartbeat.replace("Z", "+00:00"))
                stale = (datetime.now(timezone.utc) - heartbeat_at).total_seconds() > _STORYBOARD_IMAGE_STALL_SECONDS
            except ValueError:
                stale = False
        if stale:
            status = "stalled"
            updates.update({
                "status": "stalled",
                "state": "stalled",
                "message": "图片任务超过 3 分钟没有心跳；为避免重复扣费，系统未自动重试。请检查 provider 后重新提交。",
            })
    if updates != {key: job.get(key) for key in updates}:
        if mutate_stall:
            job = _storyboard_image_job_update(project_dir, **updates)
        else:
            job = {**job, **updates}
    else:
        job = {**job, **updates}
    # A terminal-state guard can reject a stale update and return the newer
    # job.  Always derive the response status from that persisted value.
    status = str(job.get("status") or status)
    job["status"] = status
    job["state"] = job.get("state") or status
    return job


def _run_storyboard_image_job(
    *,
    project_root: Path,
    request_payload: dict[str, Any],
    job_id: str,
    image_render_endpoint: Any,
    authorization: str,
) -> None:
    """Execute one accepted image batch and persist real per-shot heartbeats."""

    project_id = str(request_payload.get("project_id") or "")
    project_dir = _resolve_storyboard_project(Path(project_root), project_id)
    started_epoch = time.time()
    started_at = _utc_iso()
    stop_watchdog = threading.Event()
    request = ImagePipelineRequest.model_validate(request_payload)

    def on_progress(progress: dict[str, Any]) -> None:
        """Persist each committed image so the browser can render it now."""

        try:
            items = _safe_storyboard_image_items(progress)
            if not items:
                return
            completed_ids = [str(item.get("shot_id")) for item in items if item.get("shot_id")]
            completed = len(completed_ids)
            artifact_at = str(progress.get("last_artifact_at") or _utc_iso())
            _storyboard_image_job_update(
                project_dir,
                status="running",
                state="running",
                last_heartbeat_at=_utc_iso(),
                last_artifact_at=artifact_at,
                completed_shots=completed,
                completed_shot_ids=completed_ids,
                images_written=items,
                message=f"已生成 {completed}/{len(request.shots)} 张分镜图，下一张处理中。",
            )
            emit_event(project_dir, {
                "event": "storyboard_image_progress",
                "status": "running",
                "job_id": job_id,
                "completed_shots": completed,
                "total_shots": len(request.shots),
                "shot_id": completed_ids[-1] if completed_ids else None,
            })
        except Exception:
            # A progress write is best-effort and must never interrupt a
            # provider call or turn a successful image into a failed batch.
            return

    def watchdog() -> None:
        while not stop_watchdog.wait(2.0):
            current = _storyboard_image_job_snapshot(project_dir)
            if not current:
                continue
            completed = int(current.get("completed_shots") or 0)
            _storyboard_image_job_update(
                project_dir,
                status="running",
                state="running",
                last_heartbeat_at=_utc_iso(),
                heartbeat_count=int(current.get("heartbeat_count") or 0) + 1,
                completed_shots=completed,
                completed_shot_ids=current.get("completed_shot_ids") or [],
                last_artifact_at=current.get("last_artifact_at"),
            )

    _storyboard_image_job_update(
        project_dir,
        status="running",
        state="running",
        started_at=started_at,
        started_epoch=started_epoch,
        last_heartbeat_at=started_at,
        heartbeat_count=0,
    )
    watcher = threading.Thread(target=watchdog, name=f"{job_id}-watchdog", daemon=True)
    watcher.start()
    try:
        with image_progress_context(on_progress):
            result = image_render_endpoint(
                request,
                x_generation_authorization=authorization,
            )
        if not isinstance(result, dict):
            result = {"status": "failed", "error": "图片 provider 返回了无法解析的回执。"}
        status = str(result.get("status") or "failed")
        persisted_job = _read_storyboard_image_job(project_dir) or {}
        completed, completed_ids, latest_artifact_at = _storyboard_image_progress(project_dir, {
            **persisted_job,
            "started_epoch": started_epoch,
        })
        latest_artifact_at = latest_artifact_at or persisted_job.get("last_artifact_at")
        images_written = _safe_storyboard_image_items(result) or _safe_storyboard_image_items(persisted_job)
        if images_written:
            progress_ids = [str(item.get("shot_id")) for item in images_written if item.get("shot_id")]
            completed_ids = list(dict.fromkeys([*completed_ids, *progress_ids]))
            completed = max(completed, len(completed_ids))
        if status == "completed":
            _storyboard_image_job_update(
                project_dir,
                status="completed",
                state="completed",
                completed_at=_utc_iso(),
                last_heartbeat_at=_utc_iso(),
                completed_shots=completed,
                completed_shot_ids=completed_ids,
                last_artifact_at=latest_artifact_at,
                images_written=images_written,
                result=_remove_sensitive_fields(result),
                error=None,
            )
            emit_event(project_dir, {
                "event": "storyboard_image_job",
                "status": "completed",
                "job_id": job_id,
                "completed_shots": completed,
            })
        else:
            _storyboard_image_job_update(
                project_dir,
                status="failed",
                state="failed",
                failed_at=_utc_iso(),
                last_heartbeat_at=_utc_iso(),
                completed_shots=completed,
                completed_shot_ids=completed_ids,
                last_artifact_at=latest_artifact_at,
                images_written=images_written,
                result=_remove_sensitive_fields(result),
                error=str(result.get("error") or "图片生成未完成。")[:1_000],
            )
            emit_event(project_dir, {
                "event": "storyboard_image_job",
                "status": "failed",
                "job_id": job_id,
                "completed_shots": completed,
                "error": str(result.get("error") or "图片生成未完成。")[:500],
            })
    except Exception as exc:
        persisted_job = _read_storyboard_image_job(project_dir) or {}
        completed, completed_ids, latest_artifact_at = _storyboard_image_progress(project_dir, {
            **persisted_job,
            "started_epoch": started_epoch,
        })
        latest_artifact_at = latest_artifact_at or persisted_job.get("last_artifact_at")
        images_written = _safe_storyboard_image_items(persisted_job)
        if images_written:
            progress_ids = [str(item.get("shot_id")) for item in images_written if item.get("shot_id")]
            completed_ids = list(dict.fromkeys([*completed_ids, *progress_ids]))
            completed = max(completed, len(completed_ids))
        _storyboard_image_job_update(
            project_dir,
            status="failed",
            state="failed",
            failed_at=_utc_iso(),
            last_heartbeat_at=_utc_iso(),
            completed_shots=completed,
            completed_shot_ids=completed_ids,
            last_artifact_at=latest_artifact_at,
            images_written=images_written,
            error=str(exc)[:1_000],
        )
        emit_event(project_dir, {
            "event": "storyboard_image_job",
            "status": "failed",
            "job_id": job_id,
            "completed_shots": completed,
            "error": str(exc)[:500],
        })
    finally:
        stop_watchdog.set()
        watcher.join(timeout=2)


def _extract_video_url(response: TaskResponse | dict[str, Any]) -> str | None:
    data = response.data if isinstance(response, TaskResponse) else response.get("data", {})
    if not isinstance(data, dict):
        data = {}
    candidates = [
        data.get("video_url"),
        data.get("url"),
        (data.get("content") or {}).get("video_url") if isinstance(data.get("content"), dict) else None,
        (data.get("task") or {}).get("content", {}).get("video_url")
        if isinstance(data.get("task"), dict)
        and isinstance((data.get("task") or {}).get("content"), dict)
        else None,
    ]
    for value in candidates:
        if not isinstance(value, str) or not value:
            continue
        parsed = urlparse(value)
        if parsed.scheme in {"https", "http"} and parsed.netloc:
            return value
    return None


def _local_video_url_for_task(task_id: str, project_root: Path) -> str | None:
    """Return a same-origin media URL when the completed clip was downloaded.

    Provider URLs are signed and temporary.  Backlot downloads the completed
    file into the project, so the browser can preview it reliably without
    depending on a provider certificate or an expiring query string.
    """

    project_dir = _project_for_task(str(task_id), project_root)
    if project_dir is None:
        return None
    try:
        manifest = json.loads((project_dir / "artifacts" / "asset_manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    assets = manifest.get("assets") if isinstance(manifest, dict) else None
    if not isinstance(assets, list):
        return None
    asset = next((item for item in assets if isinstance(item, dict) and item.get("task_id") == task_id), None)
    if asset is None and len(assets) == 1:
        asset = assets[0] if isinstance(assets[0], dict) else None
    relative = str(asset.get("path") or "") if asset else ""
    if not relative:
        return None
    target = (project_dir / relative).resolve()
    try:
        target.relative_to(project_dir.resolve())
    except ValueError:
        return None
    if not target.is_file():
        return None
    return f"/media/{quote(project_dir.name, safe='')}/{quote(str(target.relative_to(project_dir)), safe='/')}"


def _local_task_response(task_id: str, project_root: Path) -> TaskResponse | None:
    """Build a durable success receipt from a downloaded local clip.

    Ark task URLs are temporary and a later refresh can legitimately return
    404 after the file has already been downloaded.  The local Backlot render
    is then the source of truth for preview and batch progress.
    """

    local_url = _local_video_url_for_task(task_id, project_root)
    if not local_url:
        return None
    return TaskResponse(
        task_id=str(task_id),
        status="succeeded",
        provider="backlot-local",
        data={"local_video_url": local_url, "recovered_from_expired_provider_task": True},
    )


def _local_batch_video_url(batch_id: str, project_root: Path) -> str | None:
    """Return the continuous storyboard render for a completed batch."""

    if not batch_id or not project_root.is_dir():
        return None
    for project_dir in project_root.iterdir():
        if not project_dir.is_dir():
            continue
        try:
            marker = json.loads((project_dir / "project.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(marker, dict) or marker.get("batch_id") != batch_id:
            continue
        target = (project_dir / "renders" / "storyboard-final.mp4").resolve()
        try:
            target.relative_to(project_dir.resolve())
        except ValueError:
            return None
        if target.is_file() and target.stat().st_size > 0:
            return f"/media/{quote(project_dir.name, safe='')}/{quote('renders/storyboard-final.mp4', safe='/')}"
    return None


def _batch_total_duration(batch_id: str, project_root: Path) -> int | None:
    if not batch_id or not project_root.is_dir():
        return None
    for project_dir in project_root.iterdir():
        if not project_dir.is_dir():
            continue
        try:
            marker = json.loads((project_dir / "project.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(marker, dict) and marker.get("batch_id") == batch_id:
            value = marker.get("storyboard_total_duration_seconds")
            try:
                return int(value)
            except (TypeError, ValueError):
                return None
    return None


def _batch_metadata_for_task(task_id: str, project_root: Path) -> dict[str, Any] | None:
    """Find batch context when a browser only persisted the first task id."""

    project_dir = _project_for_task(str(task_id), project_root)
    if project_dir is None:
        return None
    try:
        marker = json.loads((project_dir / "project.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(marker, dict) or not marker.get("batch_id"):
        return None
    task_ids = marker.get("model_task_ids")
    if not isinstance(task_ids, list) or len(task_ids) < 2:
        return None
    return {
        "batch_id": str(marker["batch_id"]),
        "batch_task_ids": [str(value) for value in task_ids if str(value)],
        "storyboard_total_duration_seconds": marker.get("storyboard_total_duration_seconds"),
        "continuous_video_url": _local_batch_video_url(str(marker["batch_id"]), project_root),
    }


def _is_expired_provider_task_error(exc: HTTPException) -> bool:
    """Recognize provider-wrapped 404s without masking real outages."""

    if exc.status_code == 404:
        return True
    detail = str(getattr(exc, "detail", "") or "").lower()
    return "404" in detail and ("not found" in detail or "resourcenotfound" in detail)


def _project_id_for(prompt: str, task_id: str) -> str:
    digest = hashlib.sha256(f"{prompt}|{task_id}".encode("utf-8")).hexdigest()[:10]
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return f"zhejiang-{stamp}-{digest}"


def _script_from_candidate(topic: str, candidate: dict[str, Any]) -> dict[str, Any]:
    outline = candidate.get("shot_outline") or []
    sections = []
    cursor = 0
    for index, item in enumerate(outline, start=1):
        duration = int(item.get("duration_hint_seconds") or 5) if isinstance(item, dict) else 5
        title = str(item.get("title") or f"镜头 {index}") if isinstance(item, dict) else f"镜头 {index}"
        visual = str(item.get("visual") or "目的地风景") if isinstance(item, dict) else "目的地风景"
        end = cursor + max(2, duration)
        sections.append({
            "id": f"s{index}",
            "label": title,
            "text": f"{topic}，{visual}。",
            "start_seconds": cursor,
            "end_seconds": end,
            "speaker_directions": "成熟、克制、有情绪推进；停顿短而自然。",
        })
        cursor = end
    return {
        "version": "1.0",
        "title": candidate.get("title") or topic,
        "total_duration_seconds": cursor,
        "tone": "cinematic",
        "narration": candidate.get("full_narration") or "",
        "sections": sections,
        "source": "model_workflow",
    }


def _scene_plan_from_candidate(
    candidate: dict[str, Any],
    request: GenerationRequest,
    storyboard: dict[str, Any] | None = None,
) -> dict[str, Any]:
    storyboard = storyboard or _workflow_storyboard(
        str(request.prompt or ""), candidate, "speed"
    )
    scenes = []
    for shot in storyboard["shots"]:
        index = len(scenes)
        start = sum(int(item.get("duration_seconds") or 5) for item in scenes)
        end = start + int(shot.get("duration_seconds") or 5)
        scenes.append({
            "id": shot["id"],
            "type": "scenic_video",
            "description": shot["visual_prompt"],
            "start_seconds": start,
            "end_seconds": end,
            "script_section_id": f"s{index + 1}",
            "hero_moment": index in {0, len(storyboard["shots"]) - 1},
            "shot_language": "电影级风景短视频",
            "shot_intent": shot["purpose"],
            "framing": "竖屏构图，主体明确，保留字幕安全区",
            "movement": shot["motion_prompt"],
            "required_assets": [shot["id"]],
        })
    total = scenes[-1]["end_seconds"] if scenes else 0
    return {
        "version": "1.0",
        "title": candidate.get("title"),
        "style_playbook": "scenic-cinematic",
        "metadata": {
            "total_duration_seconds": total,
            "aspect_ratio": request.aspect_ratio,
            "resolution": request.resolution,
            "continuity_policy": "shared_boundary_frames",
        },
        "scenes": scenes,
    }


def _resolve_storyboard_media_ref(
    value: str,
    *,
    project_root: Path | None,
    project_id: str | None,
    label: str,
) -> str:
    """Resolve a browser-facing storyboard path to a safe local media file.

    The media pipeline intentionally stores paths relative to the Backlot
    project (for portability).  Provider adapters, however, need either a
    public URL, an asset id, or an absolute local file.  Resolve only inside
    the selected project directory; never treat an arbitrary browser path as
    a server filesystem path.
    """

    raw = str(value or "").strip()
    if not raw or raw.startswith(("data:", "http://", "https://", "asset://")):
        return raw
    candidate = Path(raw).expanduser()
    if candidate.is_absolute():
        if not candidate.is_file():
            raise HTTPException(status_code=422, detail=f"{label} reference file does not exist: {raw}")
        return str(candidate)
    if project_root is None or not project_id:
        raise HTTPException(
            status_code=422,
            detail=f"{label} uses a project-relative path but storyboard_project_id is missing; save the storyboard and retry",
        )
    try:
        project_dir = _resolve_storyboard_project(Path(project_root), str(project_id))
    except (ValueError, FileNotFoundError, OSError) as exc:
        raise HTTPException(status_code=422, detail=f"storyboard project is unavailable: {project_id}") from exc
    # Reject traversal before resolving, then enforce the resolved path stays
    # below the project directory as a second defense.
    if ".." in candidate.parts:
        raise HTTPException(status_code=422, detail=f"{label} reference must stay inside the storyboard project")
    resolved = (project_dir / candidate).resolve()
    try:
        resolved.relative_to(project_dir)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"{label} reference must stay inside the storyboard project") from exc
    if not resolved.is_file():
        raise HTTPException(
            status_code=422,
            detail=f"{label} reference file was not found in project {project_id}: {raw}; generate storyboard images first",
        )
    return str(resolved)


def _normalize_storyboard_video_shots(
    payload: Mapping[str, Any],
    *,
    project_root: Path | None = None,
) -> list[dict[str, Any]]:
    """Validate the confirmed storyboard before any video estimate/submission.

    The quality path is a batch of image-to-video clips, not one synthetic clip
    with a user-selectable global duration.  Keeping this validation server-side
    prevents the browser from accidentally dropping a confirmed still or
    silently changing its per-shot timing.
    """

    raw_shots = payload.get("storyboard_shots")
    if not isinstance(raw_shots, list) or not raw_shots:
        raise HTTPException(status_code=422, detail="storyboard_shots must contain at least one confirmed shot")
    if len(raw_shots) > 48:
        raise HTTPException(status_code=422, detail="storyboard_shots cannot exceed 48 shots")
    model_variant = str(payload.get("model_variant") or payload.get("model") or "standard").lower()
    project_id = str(payload.get("storyboard_project_id") or payload.get("project_id") or "").strip() or None
    minimum, maximum = (2, 12) if "1.5" in model_variant else (4, 15)
    normalized: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_shots, start=1):
        if not isinstance(raw, Mapping):
            raise HTTPException(status_code=422, detail=f"storyboard shot {index} is invalid")
        value = raw.get("duration_seconds", raw.get("duration_hint_seconds"))
        if isinstance(value, bool):
            raise HTTPException(status_code=422, detail=f"shot {index} duration is invalid")
        try:
            duration = int(value)
        except (TypeError, ValueError):
            raise HTTPException(status_code=422, detail=f"shot {index} duration is required") from None
        if duration < minimum or duration > maximum:
            raise HTTPException(status_code=422, detail=f"shot {index} duration must be between {minimum} and {maximum} seconds")
        image_path = str(
            raw.get("image_path") or raw.get("image_url") or raw.get("frame_path") or raw.get("preview_path") or ""
        ).strip()
        if not image_path:
            raise HTTPException(status_code=422, detail=f"shot {index} has no confirmed storyboard image")
        image_path = _resolve_storyboard_media_ref(
            image_path,
            project_root=project_root,
            project_id=project_id,
            label="image",
        )
        first_frame_path = _resolve_storyboard_media_ref(
            str(raw.get("first_frame_path") or image_path),
            project_root=project_root,
            project_id=project_id,
            label="first-frame image",
        )
        last_frame_path = _resolve_storyboard_media_ref(
            str(raw.get("last_frame_path") or image_path),
            project_root=project_root,
            project_id=project_id,
            label="last-frame image",
        )
        prompt = "；".join(
            str(raw.get(key) or "").strip()
            for key in ("prompt", "visual_prompt", "motion_prompt", "first_frame_contract", "last_frame_contract", "continuity_anchor")
            if str(raw.get(key) or "").strip()
        )
        if len(prompt) < 2:
            raise HTTPException(status_code=422, detail=f"shot {index} prompt is required")
        normalized.append({
            "id": str(raw.get("id") or f"shot-{index:02d}"),
            "title": str(raw.get("title") or f"镜头 {index}"),
            "duration_seconds": duration,
            "image_path": image_path,
            "first_frame_path": first_frame_path,
            "last_frame_path": last_frame_path,
            # Keep the structured prompt fields as well as the provider-ready
            # combined prompt.  The production snapshot uses these fields to
            # restore the exact storyboard editor instead of showing only a
            # flattened string after the creator leaves the page.
            "visual_prompt": str(raw.get("visual_prompt") or raw.get("visual") or "").strip()[:20_000],
            "motion_prompt": str(raw.get("motion_prompt") or raw.get("movement") or raw.get("motion") or "").strip()[:20_000],
            "first_frame_contract": str(raw.get("first_frame_contract") or raw.get("first_frame") or "").strip()[:20_000],
            "last_frame_contract": str(raw.get("last_frame_contract") or raw.get("last_frame") or "").strip()[:20_000],
            "continuity_anchor": str(raw.get("continuity_anchor") or raw.get("continuity") or "").strip()[:20_000],
            "prompt": prompt,
        })
    return normalized


_STORYBOARD_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif"}


def _materialize_confirmed_storyboard_shots(
    project_dir: Path,
    shots: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Copy confirmed local stills into the production project.

    The browser draft may live in another project directory (or in a user
    selected absolute path).  A production project must remain reopenable
    after that draft is renamed or removed, so copy local references into its
    own ``assets/frames`` folder and store only project-relative paths.  URLs,
    data URIs and asset ids are intentionally left untouched because they are
    provider references rather than local files.
    """

    materialized: list[dict[str, Any]] = []
    copied: dict[str, str] = {}
    frames_dir = project_dir / "assets" / "frames"
    for index, shot in enumerate(shots, start=1):
        clone = dict(shot)
        shot_id = re.sub(r"[^A-Za-z0-9_-]+", "-", str(shot.get("id") or f"shot-{index:02d}")).strip("-")
        shot_id = shot_id or f"shot-{index:02d}"
        for field in ("image_path", "first_frame_path", "last_frame_path"):
            raw = str(shot.get(field) or "").strip()
            if not raw or raw.startswith(("data:", "http://", "https://", "asset://")):
                continue
            source = Path(raw).expanduser()
            if not source.is_absolute():
                # Normalized shots normally carry absolute paths.  Keep an
                # unexpected relative value rather than guessing its origin.
                continue
            try:
                source = source.resolve()
                if not source.is_file() or source.stat().st_size <= 0:
                    continue
                key = str(source)
                relative = copied.get(key)
                if relative is None:
                    suffix = source.suffix.lower() if source.suffix.lower() in _STORYBOARD_IMAGE_SUFFIXES else ".png"
                    destination = frames_dir / f"{shot_id}-{field}{suffix}"
                    frames_dir.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source, destination)
                    relative = destination.relative_to(project_dir).as_posix()
                    copied[key] = relative
                clone[field] = relative
            except (OSError, ValueError):
                # A provider task is already submitted when this helper runs;
                # a copy failure must not erase that task.  The original path
                # remains in the request/manifest for an explicit repair.
                continue
        # ``normalizeResumeShots`` consumes visual_prompt, not provider
        # ``prompt``.  Fall back to the exact combined prompt so a restored
        # production project still has useful text when older clients sent no
        # structured fields.
        if not clone.get("visual_prompt"):
            clone["visual_prompt"] = str(clone.get("prompt") or "")
        materialized.append(clone)
    return materialized


def _write_production_workflow_state(
    project_dir: Path,
    *,
    project_id: str,
    prompt: str,
    workflow_mode: str,
    candidate_options: list[dict[str, Any]],
    selected_candidate_id: str | None,
    storyboard_shots: list[dict[str, Any]] | None,
    video_parameters: Mapping[str, Any],
    active_task: Mapping[str, Any] | None,
    active_batch: Mapping[str, Any] | None = None,
    source_draft_id: str | None = None,
    entry_mode: str = "guided",
) -> dict[str, Any]:
    """Persist the canonical hand-off snapshot for a paid production run."""

    shots = storyboard_shots or []
    storyboard = None
    if shots:
        storyboard = {
            "stage": "storyboard",
            "status": "approved",
            "mode": workflow_mode,
            "shots": shots,
            "total_duration_seconds": sum(int(shot.get("duration_seconds") or 0) for shot in shots),
            "style_playbook": "scenic-cinematic",
        }
    state = {
        "schema_version": 1,
        "project_id": project_id,
        "draft_key": source_draft_id,
        "project_kind": "production",
        "entry_mode": entry_mode,
        "workflow_mode": workflow_mode,
        "phase": "provider_running",
        "resume_phase": "provider_running",
        "prompt": prompt,
        "candidates": candidate_options,
        "selected_candidate_id": selected_candidate_id,
        "storyboard": storyboard,
        "storyboard_approved": bool(shots),
        "storyboard_images_complete": bool(shots) and all(
            bool(shot.get("image_path") or shot.get("image_url")) for shot in shots
        ),
        "image_generation_receipt": None,
        "video_parameters": dict(video_parameters),
        "active_task": dict(active_task) if isinstance(active_task, Mapping) else None,
        "active_batch": dict(active_batch) if isinstance(active_batch, Mapping) else None,
        "status": "running",
        "legacy_degraded": False,
        "updated_at": _utc_iso(),
    }
    _write_json(project_dir / "artifacts" / WORKFLOW_STATE_FILENAME, state)
    return state


def _storyboard_video_request(base_payload: Mapping[str, Any], shot: Mapping[str, Any]) -> GenerationRequest:
    """Build one provider request while binding it to a confirmed still."""

    values = {
        key: value
        for key, value in dict(base_payload).items()
        if key not in {
            "max_cost_cny", "workflow_mode", "workflow_candidate_id", "storyboard_project_id",
            "storyboard_total_duration_seconds", "storyboard_shots", "batch_mode",
        }
    }
    values.update({
        "operation": "image_to_video",
        "prompt": shot["prompt"],
        "duration": shot["duration_seconds"],
        "max_cost_cny": base_payload.get("max_cost_cny"),
        "generate_audio": False,
        "watermark": False,
        # Ark's image_to_video contract takes one singular reference_image_path
        # (plural paths are reserved for reference_to_video).
        "reference_image_path": shot["image_path"],
    })
    if shot.get("last_frame_path") and shot.get("last_frame_path") != shot.get("image_path"):
        values["end_image_path"] = shot["last_frame_path"]
    return GenerationRequest.model_validate(values)


def _estimate_storyboard_batch(
    payload: Mapping[str, Any],
    estimate_endpoint: Any,
    *,
    project_root: Path | None = None,
) -> dict[str, Any]:
    shots = _normalize_storyboard_video_shots(payload, project_root=project_root)
    requested_max = payload.get("max_cost_cny")
    estimates: list[dict[str, Any]] = []
    total = 0.0
    server_max = None
    for shot in shots:
        result = estimate_endpoint(_storyboard_video_request(payload, shot))
        if not isinstance(result, EstimateResponse):
            raise HTTPException(status_code=502, detail="invalid storyboard estimate response")
        if not result.valid or result.estimated_cost_cny is None:
            raise HTTPException(status_code=422, detail=result.error or f"shot {shot['id']} estimate unavailable")
        total += float(result.estimated_cost_cny)
        if result.server_max_cost_cny is not None:
            server_max = float(result.server_max_cost_cny) if server_max is None else min(server_max, float(result.server_max_cost_cny))
        estimates.append({
            "shot_id": shot["id"],
            "title": shot["title"],
            "duration_seconds": shot["duration_seconds"],
            "estimated_cost_cny": float(result.estimated_cost_cny),
            "model": result.dry_run.get("model") if isinstance(result.dry_run, dict) else None,
        })
    within = requested_max is None or total <= float(requested_max)
    return {
        "valid": within,
        "estimated_cost_cny": round(total, 6),
        "requested_max_cost_cny": float(requested_max) if requested_max is not None else None,
        "server_max_cost_cny": server_max,
        "within_max_cost": within,
        "error": None if within else "estimated storyboard cost exceeds the requested or server limit",
        "dry_run": {
            "mode": "storyboard_shots",
            "shot_count": len(shots),
            "total_duration_seconds": sum(shot["duration_seconds"] for shot in shots),
            "model": payload.get("model_variant") or payload.get("model"),
            "operation": "image_to_video",
            "uses_confirmed_storyboard_images": True,
        },
        "shot_estimates": estimates,
        "storyboard_shots": shots,
    }


def _create_backlot_project_batch(
    *,
    requests: list[GenerationRequest],
    responses: list[TaskResponse],
    batch_id: str,
    workflow_mode: str,
    candidate_id: str | None,
    storyboard_shots: list[dict[str, Any]],
    source_draft_id: str | None = None,
    project_root: Path = PROJECTS_DIR,
) -> Path:
    """Materialize a multi-shot submission as one navigable Backlot project."""

    prompt = str(requests[0].prompt or "浙江文旅风景短视频")
    project_id = _project_id_for(prompt, batch_id)
    project_dir = project_root / project_id
    project_dir.mkdir(parents=True, exist_ok=False)
    # Materialize the confirmed stills inside the production project before
    # writing scene_plan/manifest.  The source draft can be moved or grouped
    # later; the paid run must still open with the exact images it used.
    project_shots = _materialize_confirmed_storyboard_shots(project_dir, storyboard_shots)
    topic = _workflow_topic(prompt)
    now = _utc_iso()
    sections: list[dict[str, Any]] = []
    scenes: list[dict[str, Any]] = []
    cursor = 0
    for index, shot in enumerate(project_shots, start=1):
        duration = int(shot["duration_seconds"])
        end = cursor + duration
        sections.append({
            "id": f"s{index}", "label": shot["title"], "text": shot["prompt"],
            "start_seconds": cursor, "end_seconds": end,
            "speaker_directions": "无模型原声；旁白与BGM在后期阶段处理。",
        })
        scenes.append({
            "id": shot["id"], "type": "image_to_video", "description": shot["prompt"],
            "start_seconds": cursor, "end_seconds": end, "script_section_id": f"s{index}",
            "hero_moment": index in {1, len(project_shots)}, "shot_language": "电影级风景短视频",
            "shot_intent": "承接相邻镜头共享边界，保持主体和运动方向连续",
            "framing": "使用已确认分镜图作为首帧，保留字幕安全区",
            "movement": shot["prompt"], "required_assets": [shot["id"]],
            "storyboard_image": shot["image_path"],
        })
        cursor = end
    script = {
        "version": "1.0", "title": topic, "total_duration_seconds": cursor,
        "tone": "cinematic", "narration": "", "sections": sections,
        "source": "model_workflow_storyboard_batch",
    }
    scene_plan = {
        "version": "1.0", "title": topic, "style_playbook": "scenic-cinematic",
        "metadata": {"total_duration_seconds": cursor,
                      "aspect_ratio": requests[0].aspect_ratio,
                      "resolution": requests[0].resolution,
                      "continuity_policy": "confirmed_storyboard_images"},
        "scenes": scenes, "source": "model_workflow_storyboard_batch",
    }
    candidate_options = _workflow_candidates(prompt, workflow_mode)["candidates"]
    proposal = {
        "version": "1.0", "title": topic,
        "concept_options": [{"id": c["id"], "title": c["title"], "hook": c["hook"], "scorecard": c["scorecard"]} for c in candidate_options],
        "selected_concept": {"concept_id": candidate_id},
        "production_plan": {
            "pipeline": "cinematic",
            "render_runtime": "ffmpeg",
            "renderer_family": "cinematic-trailer",
            "workflow_mode": workflow_mode,
            "shot_count": len(project_shots),
            "total_duration_seconds": cursor,
        },
        "source": "model_workflow_storyboard_batch",
    }
    assets = []
    for shot, request, response in zip(project_shots, requests, responses, strict=True):
        assets.append({
            "id": shot["id"], "type": "video", "scene_id": shot["id"],
            "path": f"renders/{response.task_id}.mp4", "prompt": shot["prompt"],
            "model": response.model or request.model_variant, "source_tool": "seedance_ark",
            "provider": response.provider or "ark", "duration_seconds": shot["duration_seconds"],
            "resolution": request.resolution, "storyboard_image": shot["image_path"],
            "task_id": response.task_id, "status": "submitted", "quality_score": None,
        })
    manifest = {
        "version": "1.0", "assets": assets, "total_cost_usd": None,
        "status": "submitted", "task_id": responses[0].task_id,
        "task_ids": [response.task_id for response in responses],
        "batch_id": batch_id, "shot_count": len(assets), "total_duration_seconds": cursor,
    }
    edit_decisions = _build_edit_decisions_for_assets(
        assets,
        target_duration_seconds=cursor,
        continuity_policy="confirmed_storyboard_images",
    )
    validate_artifact("edit_decisions", edit_decisions)
    for path, value in {
        "brief.json": {"version": "1.0", "title": topic, "prompt": prompt, "source": "model_workflow_storyboard_batch"},
        "proposal_packet.json": proposal, "script.json": script,
        "scene_plan.json": scene_plan, "asset_manifest.json": manifest,
        "edit_decisions.json": edit_decisions,
    }.items():
        _write_json(project_dir / "artifacts" / path, value)
    _write_production_workflow_state(
        project_dir,
        project_id=project_id,
        prompt=prompt,
        workflow_mode=workflow_mode,
        candidate_options=candidate_options,
        selected_candidate_id=candidate_id,
        storyboard_shots=project_shots,
        video_parameters={
            "model_variant": requests[0].model_variant,
            "operation": "image_to_video",
            "duration": None,
            "total_duration_seconds": cursor,
            "resolution": requests[0].resolution,
            "aspect_ratio": requests[0].aspect_ratio,
            "max_cost_cny": requests[0].max_cost_cny,
        },
        active_task={"task_id": responses[0].task_id, "status": responses[0].status},
        active_batch={"batch_id": batch_id, "task_ids": manifest["task_ids"], "status": "running"},
        source_draft_id=source_draft_id,
    )
    marker = {
        "version": "1.0", "created_at": now, "updated_at": now,
        "project_id": project_id, "title": topic, "pipeline_type": "cinematic",
        "style_playbook": "scenic-cinematic", "source": "model_workflow_storyboard_batch",
        "model_task_id": responses[0].task_id, "model_task_ids": manifest["task_ids"],
        "batch_id": batch_id, "workflow_mode": workflow_mode,
        "selected_candidate_id": candidate_id, "prompt": prompt,
        "stage": "assets", "storyboard_total_duration_seconds": cursor,
        "project_kind": "production", "entry_mode": "guided",
        "source_draft_id": source_draft_id,
    }
    _write_json(project_dir / "project.json", marker)
    for stage, status, artifacts, gated, approved in [
        ("research", "completed", {}, False, False),
        ("proposal", "completed", {"proposal_packet": "artifacts/proposal_packet.json"}, True, True),
        ("script", "completed", {"script": "artifacts/script.json"}, True, True),
        ("scene_plan", "completed", {"scene_plan": "artifacts/scene_plan.json"}, True, True),
        ("assets", "in_progress", {
            "asset_manifest": "artifacts/asset_manifest.json",
            "workflow_state": f"artifacts/{WORKFLOW_STATE_FILENAME}",
        }, True, False),
        ("edit", "pending", {"edit_decisions": "artifacts/edit_decisions.json"}, False, False),
        ("compose", "pending", {}, False, False),
        ("publish", "pending_review", {}, True, False),
    ]:
        checkpoint = _make_checkpoint(project_id, stage, status, artifacts=artifacts, human_approval_required=gated, human_approved=approved, task_id=batch_id)
        _write_json(project_dir / f"checkpoint_{stage}.json", checkpoint)
        _save_history(project_dir, checkpoint)
    emit_event(project_dir, {"event": "batch_submitted", "stage": "assets", "status": "running", "batch_id": batch_id, "task_ids": manifest["task_ids"], "shot_count": len(assets)})
    notify_project_changed(project_id)
    return project_dir


def _make_checkpoint(
    project_id: str,
    stage: str,
    status: str,
    *,
    artifacts: dict[str, str] | None = None,
    human_approval_required: bool = False,
    human_approved: bool = False,
    error: str | None = None,
    task_id: str | None = None,
) -> dict[str, Any]:
    return {
        "version": "1.0",
        "project_id": project_id,
        "pipeline_type": "cinematic",
        "stage": stage,
        "status": status,
        "timestamp": _utc_iso(),
        "checkpoint_policy": "guided",
        "human_approval_required": human_approval_required,
        "human_approved": human_approved,
        "artifacts": artifacts or {},
        "metadata": {"task_id": task_id} if task_id else {},
        **({"error": error} if error else {}),
        "style_playbook": "scenic-cinematic",
    }


def _save_history(project_dir: Path, checkpoint: dict[str, Any]) -> None:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S%f")
    _write_json(project_dir / "history" / f"checkpoint_{checkpoint['stage']}_{timestamp}.json", checkpoint)


_DRAFT_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


def _draft_id(value: Any, prompt: str) -> str:
    """Return a safe, stable project id for the free workflow draft.

    The browser may keep this id in sessionStorage so repeated candidate and
    storyboard saves update one project instead of creating a new card every
    time.  Invalid or missing ids are replaced with a server-generated id;
    user input is never used as a filesystem path directly.
    """

    candidate = str(value or "").strip()
    if _DRAFT_ID_RE.fullmatch(candidate):
        return candidate
    nonce = secrets.token_hex(4)
    digest = hashlib.sha256(f"{prompt}|{nonce}".encode("utf-8")).hexdigest()[:10]
    return f"draft-{datetime.now().strftime('%Y%m%d-%H%M%S')}-{digest}"


def _draft_candidate_options(workflow: dict[str, Any]) -> list[dict[str, Any]]:
    """Keep the proposal artifact compact while retaining all three options."""

    options: list[dict[str, Any]] = []
    for item in workflow.get("candidates") or []:
        if not isinstance(item, dict):
            continue
        options.append({
            "id": item.get("id"),
            "title": item.get("title"),
            "hook": item.get("hook"),
            "description": item.get("concept"),
            "structure_mode": item.get("structure_mode"),
            "proposed_shot_count": item.get("proposed_shot_count"),
            "scorecard": item.get("scorecard"),
            "signature_motif": item.get("signature_motif"),
            "transition_strategy": item.get("transition_strategy"),
            "shareable_line": item.get("shareable_line"),
            "scenic_visual_priority": item.get("scenic_visual_priority", True),
        })
    return options


def _draft_research(workflow: dict[str, Any], topic: str) -> dict[str, Any]:
    """Create a truthful research placeholder for a free, not-yet-verified draft."""

    research = workflow.get("research") or {}
    return {
        "version": "1.0",
        "topic": topic,
        "sources": [],
        "data_points": [],
        "status": "needs_fact_check",
        "source_policy": research.get("source_policy") or [],
        "checks": research.get("checks") or [],
        "selected_candidate_id": workflow.get("selected_candidate_id"),
        "note": "这是免费规划草案；未补充一手来源前，不把地点、年代、人物或数据标成已核验事实。",
        "source": "model_workflow_draft",
    }


def _draft_checkpoint_statuses(
    stage: str,
    mode: str,
    *,
    storyboard_images_complete: bool = False,
) -> list[tuple[str, str, bool, bool]]:
    """Map the visible workflow stage to canonical Backlot checkpoint states.

    ``video`` is a planning checkpoint, not a paid provider submission.  It
    records that the creator has approved the storyboard and is editing video
    parameters; the actual external task still stays behind the paid
    confirmation gate.  ``storyboard_images_complete`` is intentionally
    explicit so a client cannot make the assets checkpoint look complete just
    by changing the visible stage selector.
    """

    quality = mode == "quality"
    if stage == "input":
        return [
            ("research", "needs_sources", False, False),
            ("proposal", "pending", quality, False),
            ("script", "pending", quality, False),
            ("scene_plan", "pending", quality, False),
            ("assets", "pending", True, False),
            ("edit", "pending", False, False),
            ("compose", "pending", False, False),
            ("publish", "pending", True, False),
        ]
    if stage == "candidates":
        return [
            ("research", "needs_sources", False, False),
            ("proposal", "awaiting_human" if quality else "completed", quality, not quality),
            ("script", "pending", quality, False),
            ("scene_plan", "pending", quality, False),
            ("assets", "pending", True, False),
            ("edit", "pending", False, False),
            ("compose", "pending", False, False),
            ("publish", "pending", True, False),
        ]
    if stage == "video":
        assets_done = bool(storyboard_images_complete) if quality else True
        return [
            ("research", "needs_sources", False, False),
            ("proposal", "completed", quality, True),
            ("script", "completed", quality, True),
            ("scene_plan", "completed", quality, True),
            ("assets", "completed" if assets_done else "pending", True, assets_done),
            ("edit", "pending", False, False),
            ("compose", "pending", False, False),
            ("publish", "pending", True, False),
        ]
    return [
        ("research", "needs_sources", False, False),
        ("proposal", "completed", quality, not quality),
        ("script", "completed", quality, not quality),
        ("scene_plan", "awaiting_human" if quality else "completed", quality, not quality),
        ("assets", "pending", True, False),
        ("edit", "pending", False, False),
        ("compose", "pending", False, False),
        ("publish", "pending", True, False),
    ]


def _persist_workflow_draft(
    *,
    body: dict[str, Any],
    project_root: Path,
) -> dict[str, Any]:
    """Persist the free planning stages as a first-class Backlot project.

    This function deliberately performs no provider call.  It materializes
    only deterministic planning artifacts and can therefore run before a paid
    video confirmation.  A later paid submit creates a separate production
    project, leaving the draft auditable instead of overwriting it.
    """

    prompt = str(body.get("prompt") or "").strip()
    topic = _workflow_topic(prompt)
    mode = _workflow_mode(body.get("mode"))
    stage = str(body.get("stage") or "candidates").strip().lower()
    if stage not in {"input", "candidates", "storyboard", "video"}:
        raise HTTPException(status_code=422, detail="stage must be input, candidates, storyboard, or video")
    entry_mode = str(body.get("entry_mode") or "guided").strip().lower()
    if entry_mode not in ENTRY_MODES:
        entry_mode = "guided"

    workflow = _workflow_candidates(prompt, mode)
    selected_id = str(body.get("selected_candidate_id") or workflow.get("selected_candidate_id") or "").strip()
    if stage in {"storyboard", "video"} and not selected_id:
        raise HTTPException(status_code=422, detail="selected_candidate_id is required for storyboard or video drafts")
    candidate = next((item for item in workflow["candidates"] if item.get("id") == selected_id), None)
    if stage in {"storyboard", "video"} and candidate is None:
        raise HTTPException(status_code=422, detail="selected_candidate_id is not valid for this prompt")
    if candidate is not None:
        workflow["selected_candidate_id"] = candidate["id"]

    storyboard_approved = body.get("storyboard_approved") is True
    storyboard_images_complete = body.get("storyboard_images_complete") is True
    if stage == "video" and mode == "quality":
        if not storyboard_approved:
            raise HTTPException(status_code=422, detail="storyboard_approved is required for video drafts")
        if not storyboard_images_complete:
            raise HTTPException(status_code=422, detail="storyboard_images_complete is required for video drafts")

    storyboard = None
    if candidate is not None and stage in {"storyboard", "video"}:
        storyboard = _storyboard_with_overrides(
            prompt,
            candidate,
            mode,
            body.get("storyboard"),
        )

    # A compact, credential-free hand-off snapshot.  It is deliberately kept
    # separate from the board's derived state so reopening a project can
    # restore the exact creator choices without re-running a provider call.
    phase = (
        "proposal_review" if stage in {"input", "candidates"}
        else "video_parameters" if stage == "video" or (stage == "storyboard" and mode == "speed")
        else "storyboard_review"
    )

    def _safe_receipt(value: Any) -> dict[str, Any] | None:
        if not isinstance(value, Mapping):
            return None
        allowed = {
            "job_id", "status", "state", "completed_shots", "total_shots",
            "completed_shot_ids", "images_written", "image_count", "provider",
            "model", "started_at", "completed_at", "last_heartbeat_at",
        }
        result: dict[str, Any] = {}
        for key in allowed:
            if key not in value:
                continue
            item = value[key]
            if key in {"completed_shot_ids"}:
                result[key] = [str(v)[:128] for v in item[:64]] if isinstance(item, list) else []
            elif key == "images_written":
                result[key] = _remove_sensitive_fields(item[:64]) if isinstance(item, list) else []
            elif isinstance(item, (str, int, float, bool)) or item is None:
                result[key] = item
        return result or None

    video_parameters: dict[str, Any] = {}
    raw_video_parameters = body.get("video_parameters")
    if isinstance(raw_video_parameters, Mapping):
        for key in {
            "model_variant", "operation", "duration", "resolution", "aspect_ratio", "max_cost_cny",
        }:
            if key in raw_video_parameters:
                value = raw_video_parameters[key]
                if isinstance(value, (str, int, float, bool)) or value is None:
                    video_parameters[key] = value

    project_id = _draft_id(body.get("draft_id"), prompt)
    project_dir = Path(project_root) / project_id
    project_dir.mkdir(parents=True, exist_ok=True)
    marker_path = project_dir / "project.json"
    existing_marker: dict[str, Any] = {}
    if marker_path.is_file():
        try:
            existing_marker = json.loads(marker_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            existing_marker = {}
        if existing_marker.get("source") not in {None, "model_workflow_draft"}:
            raise HTTPException(status_code=409, detail="draft_id belongs to a non-draft project")

    now = _utc_iso()
    artifact_refs: dict[str, str] = {}
    brief = {
        "version": "1.0",
        "title": topic,
        "prompt": prompt,
        "entry_mode": entry_mode,
        "workflow_mode": mode,
        "stage": stage,
        "status": "draft",
        "source": "model_workflow_draft",
        "updated_at": now,
    }
    _write_json(project_dir / "artifacts" / "brief.json", brief)
    artifact_refs["brief"] = "artifacts/brief.json"

    research = _draft_research(workflow, topic)
    _write_json(project_dir / "artifacts" / "research_brief.json", research)
    artifact_refs["research_brief"] = "artifacts/research_brief.json"

    options = _draft_candidate_options(workflow)
    selected_concept = None
    if candidate is not None:
        selected_concept = {
            "concept_id": candidate["id"],
            "title": candidate.get("title"),
            "rationale": workflow.get("selection_reason"),
        }
    proposal = {
        "version": "1.0",
        "title": topic,
        "workflow_id": workflow.get("workflow_id"),
        "concept_options": options,
        "selected_concept": selected_concept,
        "production_plan": {
            "pipeline": "cinematic",
            "workflow_mode": mode,
            "scenic_visual_priority": True,
            "delivery_promise": "先完成可审阅的规划工件；外部视频任务仍需创作者二次确认。",
        },
        "cost_estimate": {"provider_estimate_cny": None, "total_estimated_usd": None},
        "source": "model_workflow_draft",
    }
    _write_json(project_dir / "artifacts" / "proposal_packet.json", proposal)
    artifact_refs["proposal_packet"] = "artifacts/proposal_packet.json"

    if candidate is not None:
        script = _script_from_candidate(topic, candidate)
        scene_plan = _scene_plan_from_candidate(candidate, GenerationRequest(
            prompt=prompt,
            model_variant="mini",
            operation="text_to_video",
            duration=5,
            aspect_ratio=str(body.get("aspect_ratio") or "9:16"),
            resolution=str(body.get("resolution") or "480p"),
            max_cost_cny=None,
            generate_audio=False,
            watermark=False,
        ), storyboard=storyboard)
        script["source"] = "model_workflow_draft"
        scene_plan["source"] = "model_workflow_draft"
        _write_json(project_dir / "artifacts" / "script.json", script)
        _write_json(project_dir / "artifacts" / "scene_plan.json", scene_plan)
        artifact_refs["script"] = "artifacts/script.json"
        artifact_refs["scene_plan"] = "artifacts/scene_plan.json"

    workflow_state = {
        "schema_version": 1,
        "project_id": project_id,
        "draft_key": project_id,
        "project_kind": "draft",
        "entry_mode": entry_mode,
        "workflow_mode": mode,
        "phase": phase,
        "resume_phase": phase,
        "prompt": prompt,
        "candidates": options,
        "selected_candidate_id": selected_id or None,
        "storyboard": storyboard,
        "storyboard_approved": storyboard_approved or (stage == "storyboard" and mode == "speed"),
        "storyboard_images_complete": storyboard_images_complete,
        "image_generation_receipt": _safe_receipt(body.get("image_generation_receipt")),
        "video_parameters": video_parameters,
        "status": "draft",
        "legacy_degraded": False,
        "updated_at": now,
    }
    _write_json(project_dir / "artifacts" / WORKFLOW_STATE_FILENAME, workflow_state)
    artifact_refs["workflow_state"] = f"artifacts/{WORKFLOW_STATE_FILENAME}"

    marker = {
        "version": "1.0",
        "created_at": existing_marker.get("created_at") or now,
        "updated_at": now,
        "project_id": project_id,
        "title": topic,
        "pipeline_type": "cinematic",
        "style_playbook": "scenic-cinematic",
        "source": "model_workflow_draft",
        "draft": True,
        "entry_mode": entry_mode,
        "workflow_mode": mode,
        "stage": stage,
        "selected_candidate_id": selected_id or None,
        "prompt": prompt,
        "draft_key": project_id,
        "resume_phase": phase,
        "storyboard_approved": workflow_state["storyboard_approved"],
        "storyboard_images_complete": storyboard_images_complete,
    }
    _write_json(marker_path, marker)

    for checkpoint_path in project_dir.glob("checkpoint_*.json"):
        # Current checkpoints are rewritten below; keeping old files that are
        # not in the canonical list would make stale stages look completed.
        if checkpoint_path.stem[len("checkpoint_"):] not in {
            item[0] for item in _draft_checkpoint_statuses(
                stage,
                mode,
                storyboard_images_complete=storyboard_images_complete,
            )
        }:
            checkpoint_path.unlink(missing_ok=True)
    for checkpoint_stage, status, gated, approved in _draft_checkpoint_statuses(
        stage,
        mode,
        storyboard_images_complete=storyboard_images_complete,
    ):
        artifacts = {}
        if checkpoint_stage == "research":
            artifacts = {"research_brief": artifact_refs["research_brief"]}
        elif checkpoint_stage == "proposal":
            artifacts = {"proposal_packet": artifact_refs["proposal_packet"]}
        elif checkpoint_stage == "script" and "script" in artifact_refs:
            artifacts = {"script": artifact_refs["script"]}
        elif checkpoint_stage == "scene_plan" and "scene_plan" in artifact_refs:
            artifacts = {"scene_plan": artifact_refs["scene_plan"]}
        elif checkpoint_stage == "assets" and "workflow_state" in artifact_refs:
            # The snapshot proves the planning hand-off, while a real image
            # manifest (if one exists) remains the source of truth for media.
            artifacts = {"workflow_state": artifact_refs["workflow_state"]}
        elif checkpoint_stage == "edit" and stage == "video":
            artifacts = {"workflow_state": artifact_refs["workflow_state"]}
        checkpoint = _make_checkpoint(
            project_id,
            checkpoint_stage,
            status,
            artifacts=artifacts,
            human_approval_required=gated,
            human_approved=approved,
        )
        _write_json(project_dir / f"checkpoint_{checkpoint_stage}.json", checkpoint)
        _save_history(project_dir, checkpoint)

    emit_event(project_dir, {
        "event": "draft_saved",
        "stage": stage,
        "tool": "model_workflow",
        "status": "awaiting_human" if mode == "quality" and stage != "input" else "draft",
    })
    notify_project_changed(project_id)
    return {
        "status": "saved",
        "draft_id": project_id,
        "project_id": project_id,
        "project_url": f"/p/{project_id}",
        "stage": stage,
        "workflow_mode": mode,
        "selected_candidate_id": selected_id or None,
        "artifacts": artifact_refs,
        "resume_phase": phase,
        "resume_url": f"/model?project={quote(project_id, safe='')}&resume_stage={quote(phase, safe='')}",
        "workflow_state_artifact": artifact_refs["workflow_state"],
        "message": "免费规划已保存为独立项目草案；尚未调用付费模型。",
    }


def _create_backlot_project(
    *,
    request: GenerationRequest,
    response: TaskResponse,
    workflow_mode: str,
    candidate_id: str | None,
    project_root: Path = PROJECTS_DIR,
) -> Path:
    """Materialize a submitted model run as a real Backlot project."""

    prompt = str(request.prompt or "浙江文旅风景短视频")
    workflow = _workflow_candidates(prompt, workflow_mode)
    candidate = next(
        (item for item in workflow["candidates"] if item["id"] == candidate_id),
        None,
    )
    if candidate is None:
        candidate = next(
            item for item in workflow["candidates"]
            if item["id"] == (workflow.get("selected_candidate_id") or "candidate-1")
        )
    project_id = _project_id_for(prompt, response.task_id)
    project_dir = project_root / project_id
    project_dir.mkdir(parents=True, exist_ok=False)
    topic = _workflow_topic(prompt)
    now = _utc_iso()
    script = _script_from_candidate(topic, candidate)
    scene_plan = _scene_plan_from_candidate(candidate, request)
    candidate_options = [
        {
            "id": item["id"],
            "title": item["title"],
            "hook": item["hook"],
            "description": item["concept"],
            "structure_mode": item["structure_mode"],
            "proposed_shot_count": item["proposed_shot_count"],
            "scorecard": item["scorecard"],
        }
        for item in workflow["candidates"]
    ]
    proposal = {
        "version": "1.0",
        "title": topic,
        "workflow_id": workflow["workflow_id"],
        "concept_options": candidate_options,
        "selected_concept": {
            "concept_id": candidate["id"],
            "rationale": workflow["selection_reason"],
        },
        "production_plan": {
            "pipeline": "cinematic",
            # The provider creates the source clips, but the durable Backlot
            # delivery is composed and reviewed locally with FFmpeg.  Keep
            # this runtime explicit so the edit artifact cannot silently
            # disagree with the proposal at the final-review gate.
            "render_runtime": "ffmpeg",
            "renderer_family": "cinematic-trailer",
            "workflow_mode": workflow_mode,
            "scenic_visual_priority": True,
        },
        "cost_estimate": {"total_estimated_usd": None, "provider_estimate_cny": None},
        "source": "model_workflow",
    }
    asset_path = f"renders/{response.task_id}.mp4"
    asset_manifest = {
        "version": "1.0",
        "assets": [{
            "id": "model-task-video",
            "type": "video",
            "scene_id": scene_plan["scenes"][0]["id"] if scene_plan["scenes"] else "shot-1",
            "path": asset_path,
            "prompt": request.prompt,
            "model": response.model or request.model_variant,
            "source_tool": "seedance_ark",
            "provider": response.provider or "ark",
            "duration_seconds": request.duration,
            "resolution": request.resolution,
            "quality_score": None,
        }],
        "total_cost_usd": None,
        "status": "awaiting_download",
        "task_id": response.task_id,
    }
    research = {
        "version": "1.0",
        "topic": topic,
        "sources": [],
        "data_points": [],
        "angles_discovered": [
            {"name": item["title"], "hook": item["hook"], "type": item["candidate_class"]}
            for item in workflow["candidates"]
        ],
        "status": "needs_fact_check",
        "source_policy": workflow["research"]["source_policy"],
        "checks": workflow["research"]["checks"],
        "selected_candidate_id": candidate["id"],
        "note": "模型调用器先保存创意与结构；正式交付前应补充事实来源。",
    }
    edit = {
        "version": "1.0",
        "render_runtime": "ffmpeg",
        "renderer_family": "cinematic-trailer",
        "cuts": [{
            "id": "cut-1",
            "source": asset_path,
            "in_seconds": 0,
            "out_seconds": float(request.duration or 5),
            "layer": "primary",
            "transition_in": "cut",
            "transition_out": "cut",
            "reason": "provider clip composed locally after download",
        }],
        "metadata": {
            "proposal_render_runtime": "ffmpeg",
            "continuity_policy": "shared_boundary_frames",
            "target_duration_seconds": float(request.duration or 5),
            "system_generated_preview": True,
            "needs_creator_review": True,
        },
    }
    validate_artifact("edit_decisions", edit)
    for name, value in {
        "research_brief": research,
        "proposal_packet": proposal,
        "script": script,
        "scene_plan": scene_plan,
        "asset_manifest": asset_manifest,
        "edit_decisions": edit,
    }.items():
        _write_json(project_dir / "artifacts" / f"{name}.json", value)
    _write_production_workflow_state(
        project_dir,
        project_id=project_id,
        prompt=prompt,
        workflow_mode=workflow_mode,
        candidate_options=candidate_options,
        selected_candidate_id=candidate["id"],
        storyboard_shots=None,
        video_parameters={
            "model_variant": request.model_variant,
            "operation": request.operation,
            "duration": request.duration,
            "resolution": request.resolution,
            "aspect_ratio": request.aspect_ratio,
            "max_cost_cny": request.max_cost_cny,
        },
        active_task={"task_id": response.task_id, "status": response.status},
    )
    _write_json(project_dir / "project.json", {
        "version": "1.0",
        "created_at": now,
        "updated_at": now,
        "project_id": project_id,
        "title": topic,
        "pipeline_type": "cinematic",
        "style_playbook": "scenic-cinematic",
        "source": "model_workflow",
        "model_task_id": response.task_id,
        "workflow_mode": workflow_mode,
        "project_kind": "production",
        "entry_mode": "guided",
        "selected_candidate_id": candidate["id"],
        "prompt": prompt,
        "stage": "assets",
    })
    checkpoints = [
        ("research", "completed", {"research_brief": "artifacts/research_brief.json"}, False, False),
        ("proposal", "completed", {"proposal_packet": "artifacts/proposal_packet.json"}, True, True),
        ("script", "completed", {"script": "artifacts/script.json"}, True, True),
        ("scene_plan", "completed", {"scene_plan": "artifacts/scene_plan.json"}, True, True),
        ("assets", "in_progress", {
            "asset_manifest": "artifacts/asset_manifest.json",
            "workflow_state": f"artifacts/{WORKFLOW_STATE_FILENAME}",
        }, True, False),
        ("edit", "pending", {"edit_decisions": "artifacts/edit_decisions.json"}, False, False),
        ("compose", "pending", {}, False, False),
        ("publish", "pending_review", {}, True, False),
    ]
    for stage, status, artifacts, gated, approved in checkpoints:
        checkpoint = _make_checkpoint(
            project_id, stage, status, artifacts=artifacts,
            human_approval_required=gated, human_approved=approved,
            task_id=response.task_id,
        )
        _write_json(project_dir / f"checkpoint_{stage}.json", checkpoint)
        _save_history(project_dir, checkpoint)
    emit_event(project_dir, {"event": "start", "stage": "assets", "tool": "seedance_ark", "task_id": response.task_id})
    emit_event(project_dir, {"event": "heartbeat", "stage": "assets", "tool": "seedance_ark", "task_id": response.task_id, "status": response.status})
    notify_project_changed(project_dir.name)
    return project_dir


def _project_for_task(task_id: str, project_root: Path = PROJECTS_DIR) -> Path | None:
    if not project_root.is_dir():
        return None
    for directory in project_root.iterdir():
        if not directory.is_dir() or directory.name.startswith((".", "_")):
            continue
        try:
            marker = json.loads((directory / "project.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        task_ids = marker.get("model_task_ids") or []
        if marker.get("model_task_id") == task_id or task_id in task_ids:
            return directory
    return None


def _download_video(url: str, destination: Path) -> bool:
    """Download a completed provider result into the project, never a status page."""

    parsed = urlparse(url)
    if parsed.scheme not in {"https", "http"} or not parsed.netloc:
        return False
    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix(destination.suffix + ".part")
        request = UrlRequest(url, headers={"User-Agent": "OpenMontage-Backlot/1.0"})
        with urlopen(request, timeout=60) as response, open(temporary, "wb") as output:
            total = 0
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > 512 * 1024 * 1024:
                    temporary.unlink(missing_ok=True)
                    return False
                output.write(chunk)
        temporary.replace(destination)
        return destination.is_file() and destination.stat().st_size > 0
    except Exception:
        try:
            temporary.unlink(missing_ok=True)
        except (UnboundLocalError, OSError):
            pass
        return False


_TERMINAL_PROVIDER_SUCCESS = {"succeeded", "success", "completed", "done"}
_TERMINAL_PROVIDER_FAILURE = {"failed", "error", "cancelled", "canceled"}
_TERMINAL_DELIVERY_FAILURE = {"edit_blocked", "compose_failed", "quality_failed", "review_failed"}


def _read_json_object(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None
    return value if isinstance(value, dict) else None


def _resolve_project_local_file(project_dir: Path, raw_path: str | Path) -> Path | None:
    """Resolve a project-local artifact without allowing path escape."""

    candidate = Path(str(raw_path or ""))
    if not str(candidate):
        return None
    resolved = candidate.resolve() if candidate.is_absolute() else (project_dir / candidate).resolve()
    try:
        resolved.relative_to(project_dir.resolve())
    except ValueError:
        return None
    return resolved


def _nonempty_file(path: Path | None) -> bool:
    try:
        return bool(path and path.is_file() and path.stat().st_size > 0)
    except OSError:
        return False


def _asset_path(project_dir: Path, asset: Mapping[str, Any], task_id: str) -> Path:
    raw_path = str(asset.get("path") or f"renders/{task_id}.mp4")
    resolved = _resolve_project_local_file(project_dir, raw_path)
    if resolved is not None:
        return resolved
    # A malformed provider path must never become a path traversal.  Keep the
    # task recoverable by placing the result at the normal project render path.
    return project_dir / "renders" / f"{task_id}.mp4"


def _asset_relative_path(project_dir: Path, path: Path) -> str:
    return str(path.resolve().relative_to(project_dir.resolve()))


def _build_edit_decisions_for_assets(
    assets: list[Mapping[str, Any]],
    *,
    target_duration_seconds: float | int | None = None,
    continuity_policy: str = "shared_boundary_frames",
) -> dict[str, Any]:
    """Build the smallest canonical edit artifact for downloaded provider clips."""

    cuts: list[dict[str, Any]] = []
    cursor = 0.0
    for index, asset in enumerate(assets, start=1):
        raw_duration = asset.get("duration_seconds")
        try:
            duration = float(raw_duration)
        except (TypeError, ValueError):
            duration = 0.0
        # A non-positive provider hint is not enough to make an edit cut; a
        # one-second placeholder keeps the artifact schema-valid until the
        # downloaded media is measured by the compose/quality gates.
        duration = duration if duration > 0 else 1.0
        source = str(asset.get("path") or f"renders/{asset.get('task_id') or index}.mp4")
        cuts.append({
            "id": str(asset.get("id") or f"cut-{index}"),
            "source": source,
            "in_seconds": 0,
            "out_seconds": duration,
            "layer": "primary",
            "transition_in": "cut" if index > 1 else "cut",
            "transition_out": "cut",
            "reason": "downloaded provider clip; compose remains a local gated operation",
        })
        cursor += duration
    if target_duration_seconds is not None:
        try:
            target = float(target_duration_seconds)
        except (TypeError, ValueError):
            target = cursor
    else:
        target = cursor
    return {
        "version": "1.0",
        "cuts": cuts,
        "renderer_family": "cinematic-trailer",
        "render_runtime": "ffmpeg",
        "metadata": {
            "proposal_render_runtime": "ffmpeg",
            "continuity_policy": continuity_policy,
            "target_duration_seconds": max(0.0, target),
            "system_generated_preview": True,
            "needs_creator_review": True,
        },
    }


def _edit_decisions_cover_assets(
    edit_decisions: Mapping[str, Any], assets: list[Mapping[str, Any]]
) -> bool:
    cuts = edit_decisions.get("cuts")
    if not isinstance(cuts, list) or not cuts:
        return False
    expected = {
        str(item.get("id"))
        for item in assets
        if str(item.get("id") or "")
    } | {
        str(item.get("path"))
        for item in assets
        if str(item.get("path") or "")
    }
    sources = {str(cut.get("source") or "") for cut in cuts if isinstance(cut, Mapping)}
    # A schema-valid artifact can still be semantically incomplete.  Require
    # one distinct source per downloaded asset so a stale one-cut decision
    # cannot authorize composing a multi-asset project.
    return (
        len(cuts) == len(assets)
        and len(sources) == len(cuts)
        and bool(sources)
        and sources.issubset(expected)
    )


def _load_or_create_edit_decisions(
    project_dir: Path,
    manifest: Mapping[str, Any],
    assets: list[Mapping[str, Any]],
) -> tuple[dict[str, Any] | None, str | None, bool]:
    """Validate an existing edit artifact or create a canonical local one.

    The local adapter can only compose through FFmpeg.  A valid edit artifact
    that locked Remotion/HyperFrames is therefore a real governance blocker,
    not permission to silently swap runtimes.
    """

    edit_path = project_dir / "artifacts" / "edit_decisions.json"
    existing = _read_json_object(edit_path)
    if existing is not None:
        try:
            validate_artifact("edit_decisions", existing)
        except Exception:
            existing = None
        else:
            runtime = str(existing.get("render_runtime") or "").strip().lower()
            if runtime != "ffmpeg":
                return None, f"edit_decisions locks unsupported local runtime: {runtime or 'missing'}", False
            metadata = existing.get("metadata") if isinstance(existing.get("metadata"), Mapping) else {}
            edit_checkpoint = _read_json_object(project_dir / "checkpoint_edit.json") or {}
            creator_approved = edit_checkpoint.get("human_approved") is True
            if metadata.get("needs_creator_review") is True and not creator_approved:
                return existing, "system-generated edit_decisions preview requires creator review", False
            if _edit_decisions_cover_assets(existing, assets):
                return existing, None, True
            existing = None

    proposal = _read_json_object(project_dir / "artifacts" / "proposal_packet.json") or {}
    proposal_runtime = str((proposal.get("production_plan") or {}).get("render_runtime") or "").strip().lower()
    if proposal_runtime in {"remotion", "hyperframes"}:
        return None, f"proposal locks {proposal_runtime}; local adapter cannot silently switch to ffmpeg", False

    target_duration = manifest.get("total_duration_seconds")
    continuity_policy = str(
        (manifest.get("metadata") or {}).get("continuity_policy")
        or "shared_boundary_frames"
    )
    generated = _build_edit_decisions_for_assets(
        assets,
        target_duration_seconds=target_duration,
        continuity_policy=continuity_policy,
    )
    try:
        validate_artifact("edit_decisions", generated)
    except Exception as exc:
        return None, f"generated edit_decisions failed schema validation: {exc}", False
    try:
        _write_json(edit_path, generated)
    except OSError as exc:
        return None, f"could not persist edit_decisions: {exc}", False
    return generated, "system-generated edit_decisions preview requires creator review", False


def _delivery_artifacts_are_valid(project_dir: Path) -> bool:
    """Return true only for a previously verified local report/review pair."""

    report = _read_json_object(project_dir / "artifacts" / "render_report.json")
    review = _read_json_object(project_dir / "artifacts" / "final_review.json")
    if report is None or review is None or review.get("status") != "pass":
        return False
    try:
        validate_artifact("render_report", report)
        validate_artifact("final_review", review)
    except Exception:
        return False
    outputs = report.get("outputs") or []
    if not isinstance(outputs, list) or not outputs:
        return False
    for output in outputs:
        if not isinstance(output, Mapping) or not _nonempty_file(
            _resolve_project_local_file(project_dir, str(output.get("path") or ""))
        ):
            return False
    review_output = _resolve_project_local_file(project_dir, str(review.get("output_path") or ""))
    return _nonempty_file(review_output)


def _remove_unverified_delivery_artifacts(project_dir: Path) -> None:
    """Remove stale delivery receipts that cannot prove a local render.

    Older adapter revisions wrote hand-shaped receipts before composing.  Do
    not let one of those receipts survive a failed retry and appear to be the
    current result.  A valid, independently-created publish log is retained;
    only malformed logs or this adapter's own pending placeholder are stale.
    """

    report_path = project_dir / "artifacts" / "render_report.json"
    review_path = project_dir / "artifacts" / "final_review.json"
    if (report_path.exists() or review_path.exists()) and not _delivery_artifacts_are_valid(project_dir):
        report_path.unlink(missing_ok=True)
        review_path.unlink(missing_ok=True)

    publish_path = project_dir / "artifacts" / "publish_log.json"
    publish = _read_json_object(publish_path)
    if publish is None:
        publish_path.unlink(missing_ok=True)
        return
    try:
        validate_artifact("publish_log", publish)
    except Exception:
        publish_path.unlink(missing_ok=True)
        return
    metadata = publish.get("metadata") if isinstance(publish.get("metadata"), Mapping) else {}
    if metadata.get("source") == "model_adapter_local_delivery_gate":
        publish_path.unlink(missing_ok=True)


def _local_asset_signature(project_dir: Path, assets: list[Mapping[str, Any]]) -> str | None:
    rows: list[dict[str, Any]] = []
    for asset in assets:
        path = _resolve_project_local_file(project_dir, str(asset.get("path") or ""))
        if not _nonempty_file(path):
            return None
        try:
            stat = path.stat()
        except OSError:
            return None
        rows.append({
            "id": str(asset.get("id") or ""),
            "path": str(asset.get("path") or ""),
            "size_bytes": stat.st_size,
            "mtime_ns": stat.st_mtime_ns,
            "sha256": str(asset.get("sha256") or ""),
        })
    edit_path = project_dir / "artifacts" / "edit_decisions.json"
    if _nonempty_file(edit_path):
        try:
            rows.append({"edit_decisions_sha256": hashlib.sha256(edit_path.read_bytes()).hexdigest()})
        except OSError:
            return None
    return hashlib.sha256(
        json.dumps(rows, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest() if rows else None


def _fps_number(value: Any) -> float:
    try:
        text = str(value or "")
        if "/" in text:
            numerator, denominator = text.split("/", 1)
            return float(numerator) / max(float(denominator), 1.0)
        return float(text)
    except (TypeError, ValueError, ZeroDivisionError):
        return 0.0


def _delivery_attempt_result(
    status: str,
    error: str | None,
    *,
    edit_ready: bool,
    input_signature: str | None,
) -> dict[str, Any]:
    return {
        "status": status,
        "error": error,
        "edit_ready": edit_ready,
        "input_signature": input_signature,
        "updated_at": _utc_iso(),
    }


def _finalize_local_delivery(
    *,
    project_dir: Path,
    manifest: dict[str, Any],
    assets: list[Mapping[str, Any]],
    output_name: str,
    task_id: str,
) -> dict[str, Any]:
    """Compose, quality-check, and review one local delivery exactly once.

    ``compose_media`` owns local FFmpeg composition, ``quality_check`` owns
    technical media QA, and ``VideoCompose._run_final_review`` owns the final
    artifact contract.  This function only coordinates their outputs and
    never duplicates their probing/filter logic.
    """

    input_signature = _local_asset_signature(project_dir, assets)
    previous_attempt = manifest.get("delivery_attempt")
    delivery_artifacts_valid = _delivery_artifacts_are_valid(project_dir)
    if isinstance(previous_attempt, Mapping):
        previous_status = str(previous_attempt.get("status") or "")
        if previous_status == "completed" and delivery_artifacts_valid:
            return {"status": "completed", "error": None, "edit_ready": True, "input_signature": input_signature}
        if (
            previous_status in _TERMINAL_DELIVERY_FAILURE
            and previous_attempt.get("input_signature") == input_signature
        ):
            if not delivery_artifacts_valid:
                _remove_unverified_delivery_artifacts(project_dir)
            return {
                "status": previous_status,
                "error": str(previous_attempt.get("error") or "delivery gate failed"),
                "edit_ready": bool(previous_attempt.get("edit_ready")),
                "input_signature": input_signature,
            }

    if not delivery_artifacts_valid:
        _remove_unverified_delivery_artifacts(project_dir)

    edit_decisions, edit_error, edit_ready = _load_or_create_edit_decisions(
        project_dir, manifest, assets
    )
    if edit_decisions is None:
        return {
            "status": "edit_blocked",
            "error": edit_error or "edit_decisions is not valid",
            "edit_ready": False,
            "input_signature": input_signature,
        }
    if not edit_ready:
        return {
            "status": "edit_blocked",
            "error": edit_error or "edit_decisions requires creator review",
            "edit_ready": False,
            "input_signature": input_signature,
        }

    clips = [str(item.get("path") or "") for item in assets]
    started = time.monotonic()
    try:
        composition = compose_media(
            ComposeRequest(
                project_id=project_dir.name,
                clips=clips,
                transition="cut",
                output_name=output_name,
                dry_run=False,
                execute=True,
            ),
            project_root=project_dir.parent,
        )
    except Exception as exc:
        return {
            "status": "compose_failed",
            "error": f"compose raised: {exc}",
            "edit_ready": edit_ready,
            "input_signature": input_signature,
        }
    if not isinstance(composition, Mapping) or composition.get("status") != "completed":
        return {
            "status": "compose_failed",
            "error": str((composition or {}).get("error") or "compose did not complete")[:1_000],
            "edit_ready": edit_ready,
            "input_signature": input_signature,
        }

    output_data = composition.get("output") if isinstance(composition, Mapping) else None
    output_raw = output_data.get("path") if isinstance(output_data, Mapping) else None
    output_path = _resolve_project_local_file(project_dir, str(output_raw or f"renders/{output_name}"))
    if not _nonempty_file(output_path):
        return {
            "status": "compose_failed",
            "error": "compose reported completed but the local output file is missing",
            "edit_ready": edit_ready,
            "input_signature": input_signature,
        }
    output_relative = _asset_relative_path(project_dir, output_path)
    expected_duration = manifest.get("total_duration_seconds")
    try:
        quality = quality_check(
            QualityRequest(
                project_id=project_dir.name,
                media_paths=[output_relative],
                expected_duration_seconds=float(expected_duration) if expected_duration is not None else None,
                sample_frames=4,
                check_audio=True,
                check_black_frames=True,
                # This path composes video clips only, without a subtitle
                # sidecar. Do not claim to have checked subtitles here.
                check_subtitles=False,
                execute=True,
            ),
            project_root=project_dir.parent,
        )
    except Exception as exc:
        return {
            "status": "quality_failed",
            "error": f"quality_check raised: {exc}",
            "edit_ready": edit_ready,
            "input_signature": input_signature,
        }
    if not isinstance(quality, Mapping) or quality.get("status") != "passed":
        quality_error = "quality_check did not pass"
        if isinstance(quality, Mapping):
            failures = (quality.get("technical") or {}).get("failures")
            quality_error = "; ".join(str(item) for item in (failures or [])) or str(quality.get("error") or quality_error)
        return {
            "status": "quality_failed",
            "error": quality_error[:1_000],
            "edit_ready": edit_ready,
            "input_signature": input_signature,
        }
    quality_technical = quality.get("technical") if isinstance(quality.get("technical"), Mapping) else {}
    if quality_technical.get("failures"):
        return {
            "status": "quality_failed",
            "error": "; ".join(str(item) for item in quality_technical["failures"])[:1_000],
            "edit_ready": edit_ready,
            "input_signature": input_signature,
        }

    proposal = _read_json_object(project_dir / "artifacts" / "proposal_packet.json")
    try:
        from tools.video.video_compose import VideoCompose

        final_review = VideoCompose()._run_final_review(
            output_path,
            edit_decisions,
            proposal,
        )
    except Exception as exc:
        return {
            "status": "review_failed",
            "error": f"final review raised: {exc}",
            "edit_ready": edit_ready,
            "input_signature": input_signature,
        }
    if not isinstance(final_review, dict) or final_review.get("status") != "pass":
        review_error = "final review did not pass"
        if isinstance(final_review, Mapping):
            review_error = "; ".join(str(item) for item in final_review.get("issues_found") or []) or review_error
        return {
            "status": "review_failed",
            "error": review_error[:1_000],
            "edit_ready": edit_ready,
            "input_signature": input_signature,
        }
    technical_probe = (final_review.get("checks") or {}).get("technical_probe")
    if not isinstance(technical_probe, Mapping) or technical_probe.get("valid_container") is not True:
        return {
            "status": "review_failed",
            "error": "final review did not provide a valid ffprobe container receipt",
            "edit_ready": edit_ready,
            "input_signature": input_signature,
        }

    review_to_write = json.loads(json.dumps(final_review, ensure_ascii=False))
    review_to_write.setdefault("metadata", {})
    if isinstance(review_to_write["metadata"], dict):
        quality_report = quality.get("report") if isinstance(quality.get("report"), Mapping) else {}
        if quality_report.get("path"):
            review_to_write["metadata"]["quality_report_ref"] = quality_report["path"]
    try:
        validate_artifact("final_review", review_to_write)
    except Exception as exc:
        return {
            "status": "review_failed",
            "error": f"final_review failed schema validation: {exc}",
            "edit_ready": edit_ready,
            "input_signature": input_signature,
        }

    media_rows = quality.get("media") if isinstance(quality.get("media"), list) else []
    quality_row = media_rows[0] if media_rows and isinstance(media_rows[0], Mapping) else {}
    quality_probe = quality_row.get("probe") if isinstance(quality_row.get("probe"), Mapping) else {}
    quality_video = quality_probe.get("video") if isinstance(quality_probe.get("video"), Mapping) else {}
    resolution = str(technical_probe.get("resolution") or "")
    if not resolution or resolution == "0x0":
        resolution = f"{quality_video.get('width', 0)}x{quality_video.get('height', 0)}"
    duration_value = technical_probe.get("duration_seconds")
    try:
        duration = float(duration_value)
    except (TypeError, ValueError):
        duration = float(quality_probe.get("duration_seconds") or 0.0)
    try:
        file_size = int(technical_probe.get("file_size_bytes") or output_path.stat().st_size)
    except (OSError, TypeError, ValueError):
        file_size = output_path.stat().st_size
    codec = str(technical_probe.get("codec") or quality_video.get("codec") or "unknown")
    fps = _fps_number(technical_probe.get("fps") or quality_video.get("fps"))
    audio_codec = None
    quality_audio = quality_probe.get("audio") if isinstance(quality_probe.get("audio"), Mapping) else {}
    if quality_audio.get("codec"):
        audio_codec = str(quality_audio["codec"])
    output_record: dict[str, Any] = {
        "path": output_relative,
        "format": "mp4",
        "codec": codec,
        "resolution": resolution,
        "fps": fps,
        "duration_seconds": max(0.0, duration),
        "file_size_bytes": max(0, file_size),
        "platform_target": "local_backlot",
    }
    if audio_codec:
        output_record["audio_codec"] = audio_codec
    warnings = list(quality_technical.get("warnings") or []) if isinstance(quality_technical, Mapping) else []
    warnings.extend(str(item) for item in final_review.get("issues_found") or [])
    report = {
        "version": "1.0",
        "outputs": [output_record],
        "render_time_seconds": max(0.0, round(time.monotonic() - started, 3)),
        "warnings": list(dict.fromkeys(str(item) for item in warnings)),
        "verification_notes": [
            "compose_media returned completed and wrote a local MP4",
            "quality_check returned passed with no technical failures",
            f"final_review status=pass; sha256={hashlib.sha256(output_path.read_bytes()).hexdigest()}",
        ],
        "render_grammar": str(edit_decisions.get("renderer_family") or "cinematic-trailer"),
        "final_review_ref": "artifacts/final_review.json",
        "metadata": {
            "quality_check_report_ref": ((quality.get("report") or {}).get("path") if isinstance(quality.get("report"), Mapping) else None),
            "output_sha256": hashlib.sha256(output_path.read_bytes()).hexdigest(),
            "input_signature": input_signature,
        },
    }
    # ``metadata`` accepts null values, but dropping it keeps the artifact
    # compact and avoids implying a report path when a test double omitted it.
    report["metadata"] = {key: value for key, value in report["metadata"].items() if value is not None}
    try:
        validate_artifact("render_report", report)
    except Exception as exc:
        return {
            "status": "review_failed",
            "error": f"render_report failed schema validation: {exc}",
            "edit_ready": edit_ready,
            "input_signature": input_signature,
        }

    # A provider poll may prepare a local output, but it must not publish it.
    # Keep the durable publish intent visible as a schema-valid human gate.
    publish_log = {
        "version": "1.0",
        "entries": [{
            "platform": "local_backlot",
            "status": "pending_review",
            "timestamp": _utc_iso(),
            "export_path": output_relative,
        }],
        "metadata": {
            "human_approval_required": True,
            "upload_performed": False,
            "source": "model_adapter_local_delivery_gate",
        },
    }
    try:
        validate_artifact("publish_log", publish_log)
    except Exception as exc:
        return {
            "status": "review_failed",
            "error": f"publish_log failed schema validation: {exc}",
            "edit_ready": edit_ready,
            "input_signature": input_signature,
        }

    report_path = project_dir / "artifacts" / "render_report.json"
    review_path = project_dir / "artifacts" / "final_review.json"
    publish_path = project_dir / "artifacts" / "publish_log.json"
    try:
        _write_json(review_path, review_to_write)
        _write_json(report_path, report)
        _write_json(publish_path, publish_log)
    except OSError as exc:
        # Avoid leaving a one-sided success receipt after an interrupted write.
        review_path.unlink(missing_ok=True)
        report_path.unlink(missing_ok=True)
        publish_path.unlink(missing_ok=True)
        return {
            "status": "review_failed",
            "error": f"could not persist delivery reports: {exc}",
            "edit_ready": edit_ready,
            "input_signature": input_signature,
        }
    return {
        "status": "completed",
        "error": None,
        "edit_ready": edit_ready,
        "input_signature": input_signature,
        "output_path": output_relative,
    }


def _write_checkpoint_if_changed(
    project_dir: Path,
    stage: str,
    status: str,
    *,
    artifacts: dict[str, str] | None = None,
    human_approval_required: bool = False,
    human_approved: bool = False,
    error: str | None = None,
    task_id: str | None = None,
) -> bool:
    checkpoint = _make_checkpoint(
        project_dir.name,
        stage,
        status,
        artifacts=artifacts,
        human_approval_required=human_approval_required,
        human_approved=human_approved,
        error=error,
        task_id=task_id,
    )
    path = project_dir / f"checkpoint_{stage}.json"
    previous = _read_json_object(path)
    comparable = dict(checkpoint)
    comparable.pop("timestamp", None)
    previous_comparable = dict(previous or {})
    previous_comparable.pop("timestamp", None)
    if previous_comparable == comparable:
        return False
    _write_json(path, checkpoint)
    _save_history(project_dir, checkpoint)
    return True


def _update_project_stage_if_changed(project_dir: Path, stage: str) -> bool:
    """Refresh the project marker after a checkpoint progression."""

    path = project_dir / "project.json"
    marker = _read_json_object(path)
    if marker is None:
        return False
    previous_stage = marker.get("stage")
    marker["stage"] = stage
    marker["updated_at"] = _utc_iso()
    _write_json(path, marker)
    return previous_stage != stage


def _update_production_workflow_state(
    project_dir: Path,
    *,
    assets_status: str,
    edit_status: str,
    compose_status: str,
    task_id: str,
) -> None:
    """Advance a production snapshot from provider work to local review.

    Checkpoint files remain the source of truth for the Backlot board.  This
    companion snapshot only makes the model workbench resume at the same
    phase after a refresh.  It is written only when a meaningful value
    changes, so a five-second heartbeat does not create a new replay node.
    """

    path = project_dir / "artifacts" / WORKFLOW_STATE_FILENAME
    state = _read_json_object(path)
    if not isinstance(state, dict) or state.get("project_kind") != "production":
        return
    assets_value = str(assets_status or "").strip().lower()
    edit_value = str(edit_status or "").strip().lower()
    compose_value = str(compose_status or "").strip().lower()
    if assets_value in {"failed", "error"}:
        phase, lifecycle = "provider_failed", "failed"
        batch_lifecycle = "failed"
    elif assets_value != "completed":
        phase, lifecycle = "provider_running", "running"
        batch_lifecycle = "running"
    elif compose_value == "completed":
        phase, lifecycle = "quality_review", "quality_review"
        batch_lifecycle = "succeeded"
    else:
        # Provider clips are local, but the edit/compose/quality gate still
        # needs a creator-visible hand-off before publish can advance.
        phase, lifecycle = "postproduction", "awaiting_creator_review"
        batch_lifecycle = "succeeded"

    previous = dict(state)
    state["phase"] = phase
    state["resume_phase"] = phase
    state["status"] = lifecycle
    state["delivery"] = {
        "assets": assets_value or None,
        "edit": edit_value or None,
        "compose": compose_value or None,
        "task_id": str(task_id or "") or None,
    }
    active_task = state.get("active_task")
    if isinstance(active_task, dict):
        active_task = dict(active_task)
        if assets_value in {"failed", "error"}:
            active_task["status"] = "failed"
        elif assets_value == "completed":
            active_task["status"] = "succeeded"
        state["active_task"] = active_task
    active_batch = state.get("active_batch")
    if isinstance(active_batch, dict):
        active_batch = dict(active_batch)
        active_batch["status"] = batch_lifecycle
        state["active_batch"] = active_batch
    comparable_previous = dict(previous)
    comparable_previous.pop("updated_at", None)
    comparable_state = dict(state)
    comparable_state.pop("updated_at", None)
    if comparable_previous == comparable_state:
        return
    state["updated_at"] = _utc_iso()
    _write_json(path, state)


def _write_delivery_checkpoints(
    project_dir: Path,
    *,
    manifest: Mapping[str, Any],
    assets_status: str,
    edit_status: str,
    compose_status: str,
    compose_error: str | None,
    edit_ready: bool,
    task_id: str,
) -> None:
    changed_any = _write_checkpoint_if_changed(
        project_dir,
        "assets",
        assets_status,
        artifacts={"asset_manifest": "artifacts/asset_manifest.json"},
        human_approval_required=True,
        human_approved=assets_status == "completed",
        error=None if assets_status != "failed" else compose_error,
        task_id=task_id,
    )
    edit_artifacts = {}
    if edit_ready or (project_dir / "artifacts" / "edit_decisions.json").is_file():
        edit_artifacts = {"edit_decisions": "artifacts/edit_decisions.json"}
    edit_checkpoint = _read_json_object(project_dir / "checkpoint_edit.json") or {}
    edit_human_approved = edit_status == "completed" and edit_checkpoint.get("human_approved") is True
    changed_any = _write_checkpoint_if_changed(
        project_dir,
        "edit",
        edit_status,
        artifacts=edit_artifacts,
        human_approval_required=bool(edit_artifacts) and assets_status == "completed" and edit_status != "completed",
        human_approved=edit_human_approved,
        error=None if edit_status != "failed" else compose_error,
        task_id=task_id,
    ) or changed_any
    compose_artifacts = {}
    if compose_status == "completed":
        compose_artifacts = {
            "render_report": "artifacts/render_report.json",
            "final_review": "artifacts/final_review.json",
        }
    changed_any = _write_checkpoint_if_changed(
        project_dir,
        "compose",
        compose_status,
        artifacts=compose_artifacts,
        human_approval_required=False,
        human_approved=False,
        error=compose_error if compose_status == "failed" else None,
        task_id=task_id,
    ) or changed_any
    # Publish is intentionally never advanced by a provider poll.  The local
    # export/publish endpoint remains the explicit human-review gate.
    publish_artifacts = {}
    if (project_dir / "artifacts" / "publish_log.json").is_file():
        publish_artifacts = {"publish_log": "artifacts/publish_log.json"}
    changed_any = _write_checkpoint_if_changed(
        project_dir,
        "publish",
        "pending_review",
        artifacts=publish_artifacts,
        human_approval_required=True,
        human_approved=False,
        task_id=task_id,
    ) or changed_any
    if compose_status == "completed":
        stage = "publish"
    elif edit_status == "completed":
        stage = "compose"
    elif assets_status == "completed":
        stage = "edit"
    else:
        stage = "assets"
    if changed_any:
        _update_project_stage_if_changed(project_dir, stage)
    _update_production_workflow_state(
        project_dir,
        assets_status=assets_status,
        edit_status=edit_status,
        compose_status=compose_status,
        task_id=task_id,
    )


def _update_backlot_project_assets(
    task_response: TaskResponse,
    project_dir: Path,
    *,
    output_name: str,
    checkpoint_task_id: str,
) -> None:
    """Persist one provider result and gate local delivery on real evidence."""

    manifest_path = project_dir / "artifacts" / "asset_manifest.json"
    manifest = _read_json_object(manifest_path)
    if manifest is None:
        return
    assets = [item for item in manifest.get("assets", []) if isinstance(item, dict)]
    asset = next((item for item in assets if str(item.get("task_id")) == str(task_response.task_id)), None)
    if asset is None:
        return

    # A valid report/review pair is durable.  A later provider 404/failure or
    # repeated success poll must not downgrade it or trigger another compose.
    if _delivery_artifacts_are_valid(project_dir):
        notify_project_changed(project_dir.name)
        return

    status = str(task_response.status or "unknown").strip().lower()
    success = status in _TERMINAL_PROVIDER_SUCCESS
    failure = status in _TERMINAL_PROVIDER_FAILURE
    destination = _asset_path(project_dir, asset, str(task_response.task_id))
    local = _nonempty_file(destination)
    if success:
        # Do not download the same provider object on every browser refresh.
        if not local:
            url = _extract_video_url(task_response)
            local = bool(url and _download_video(url, destination))
        # A previous poll may have downloaded the file while the signed URL
        # has expired.  Keep that local evidence authoritative.
        asset["status"] = "completed" if local else "completed_remote_pending_local_download"
        asset["provider_status"] = task_response.status
        asset["local_file"] = _asset_relative_path(project_dir, destination) if local else None
    elif failure:
        # A stale terminal provider response cannot erase a completed local
        # asset.  Otherwise preserve the exact provider status for recovery.
        if not local and str(asset.get("status") or "") != "completed":
            asset["status"] = f"provider_{status}"
        asset["provider_status"] = task_response.status
    elif not local:
        asset["status"] = f"provider_{status}"
        asset["provider_status"] = task_response.status

    if local:
        try:
            asset["sha256"] = hashlib.sha256(destination.read_bytes()).hexdigest()
            asset["size_bytes"] = destination.stat().st_size
        except OSError:
            local = False
            asset["status"] = "completed_remote_pending_local_download"
    manifest["assets"] = assets
    statuses = [str(item.get("status") or "") for item in assets]
    provider_failure = any(
        item.startswith("provider_failed")
        or item.startswith("provider_error")
        or item.startswith("provider_cancel")
        for item in statuses
    )
    all_local = bool(assets) and all(item == "completed" for item in statuses)
    if provider_failure:
        manifest["status"] = "partial_failure"
        manifest.pop("delivery_error", None)
        _write_json(manifest_path, manifest)
        _write_delivery_checkpoints(
            project_dir,
            manifest=manifest,
            assets_status="failed",
            edit_status="pending",
            compose_status="pending",
            compose_error=f"provider status: {task_response.status}",
            edit_ready=False,
            task_id=checkpoint_task_id,
        )
    elif not all_local:
        manifest["status"] = "running"
        _write_json(manifest_path, manifest)
        _write_delivery_checkpoints(
            project_dir,
            manifest=manifest,
            assets_status="in_progress",
            edit_status="pending",
            compose_status="pending",
            compose_error=None,
            edit_ready=False,
            task_id=checkpoint_task_id,
        )
    else:
        # Asset downloads are complete, but this is not yet a finished video.
        # Compose, ffprobe/quality, and final review are all required.
        manifest["status"] = "downloaded"
        delivery = _finalize_local_delivery(
            project_dir=project_dir,
            manifest=manifest,
            assets=assets,
            output_name=output_name,
            task_id=checkpoint_task_id,
        )
        delivery_status = str(delivery.get("status") or "compose_failed")
        edit_ready = bool(delivery.get("edit_ready"))
        if delivery_status == "completed":
            manifest["status"] = "downloaded"
            manifest["delivery_attempt"] = _delivery_attempt_result(
                "completed",
                None,
                edit_ready=True,
                input_signature=delivery.get("input_signature"),
            )
            if delivery.get("output_path"):
                manifest["final_output"] = delivery["output_path"]
            _write_json(manifest_path, manifest)
            _write_delivery_checkpoints(
                project_dir,
                manifest=manifest,
                assets_status="completed",
                edit_status="completed",
                compose_status="completed",
                compose_error=None,
                edit_ready=True,
                task_id=checkpoint_task_id,
            )
        else:
            manifest["status"] = "delivery_blocked"
            error = str(delivery.get("error") or "local delivery gate failed")[:1_000]
            manifest["delivery_attempt"] = _delivery_attempt_result(
                delivery_status,
                error,
                edit_ready=edit_ready,
                input_signature=delivery.get("input_signature"),
            )
            manifest["delivery_error"] = error
            _write_json(manifest_path, manifest)
            edit_status = "completed" if edit_ready else "pending"
            compose_status = "failed" if edit_ready else "pending"
            _write_delivery_checkpoints(
                project_dir,
                manifest=manifest,
                assets_status="completed",
                edit_status=edit_status,
                compose_status=compose_status,
                compose_error=error,
                edit_ready=edit_ready,
                task_id=checkpoint_task_id,
            )

    emit_event(project_dir, {
        "event": "finish" if success else "error" if failure else "heartbeat",
        "stage": "assets",
        "tool": "seedance_ark",
        "task_id": task_response.task_id,
        "status": task_response.status,
        "completed_shots": sum(item == "completed" for item in statuses),
        "shot_count": len(assets),
    })
    notify_project_changed(project_dir.name)


def _update_backlot_project_batch_task(task_response: TaskResponse, project_dir: Path) -> None:
    """Update one shot in a batch; never fake a compose/review/publish result."""

    manifest = _read_json_object(project_dir / "artifacts" / "asset_manifest.json") or {}
    _update_backlot_project_assets(
        task_response,
        project_dir,
        output_name="storyboard-final.mp4",
        checkpoint_task_id=str(manifest.get("batch_id") or task_response.task_id),
    )


def _update_backlot_project(task_response: TaskResponse, project_root: Path = PROJECTS_DIR) -> None:
    """Persist one task and gate the single-clip delivery on local QA."""

    project_dir = _project_for_task(task_response.task_id, project_root)
    if project_dir is None:
        return
    manifest = _read_json_object(project_dir / "artifacts" / "asset_manifest.json") or {}
    if manifest.get("task_ids"):
        _update_backlot_project_batch_task(task_response, project_dir)
        return
    _update_backlot_project_assets(
        task_response,
        project_dir,
        output_name="final.mp4",
        checkpoint_task_id=str(task_response.task_id),
    )


def _load_macos_keychain_secret(*, service: str, environment_name: str) -> bool:
    """Load one server-only secret from macOS Keychain when env is absent.

    Providers keep their normal environment-variable contract.  On the
    development Mac, an existing Keychain item whose service name matches
    ``service`` can bridge that contract without copying a secret into HTML,
    JavaScript, SQLite, or a command-line argument.  The lookup is opt-in by
    platform, bounded by a short timeout, and silently skipped when Keychain
    access is unavailable.  ``stdout`` is captured and never returned/logged.
    """

    current = os.environ.get(environment_name)
    if (isinstance(current, str) and current.strip()) or sys.platform != "darwin":
        return bool(isinstance(current, str) and current.strip())
    try:
        result = subprocess.run(
            ["/usr/bin/security", "find-generic-password", "-s", service, "-w"],
            check=True,
            capture_output=True,
            text=True,
            timeout=2,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    value = result.stdout.strip()
    if not value:
        return False
    os.environ[environment_name] = value
    return True


def _ensure_local_paid_gate() -> bool:
    """Create an in-memory auth gate only for an explicit local run mode."""

    if os.environ.get("WEB_API_PAID_AUTH_TOKEN"):
        return True
    if os.environ.get("WEB_API_LOCAL_MODE") != "1":
        return False
    # This token is never returned to the browser.  It only lets the
    # same-origin adapter call the existing guarded task endpoint after the
    # creator has completed the UI's one-time confirmation step.
    os.environ["WEB_API_PAID_AUTH_TOKEN"] = secrets.token_urlsafe(32)
    return True


def _media_authorization(header: str | None) -> str | None:
    """Resolve the server-only media token for the same-origin workbench.

    The standalone media app still requires the caller to send the token.  On
    the local workbench the browser must not receive that secret, so a click
    with ``execute=true`` and ``confirm=true`` can use the process-local token
    created by :func:`_ensure_local_paid_gate`.  This shortcut is deliberately
    limited to ``WEB_API_LOCAL_MODE=1``; a public deployment must add its own
    authenticated user/session boundary instead of exposing a paid endpoint.
    """

    if header:
        return header
    if os.environ.get("WEB_API_LOCAL_MODE") == "1":
        # Be tolerant of a launcher that sets local mode immediately after
        # importing the app.  The paid gate is process-local and contains no
        # provider credential, so lazily creating it here is safe and keeps a
        # browser click from being rejected merely because startup ordering
        # was unusual.
        _ensure_local_paid_gate()
        return os.environ.get("WEB_API_PAID_AUTH_TOKEN")
    return None


@dataclass(frozen=True)
class _PendingPaidRequest:
    payload: dict[str, Any]
    estimated_cost_cny: float
    expires_at: float
    workflow_mode: str = "quality"
    candidate_id: str | None = None


class _ConfirmationStore:
    """Process-local, one-time paid-confirmation store.

    It intentionally does not persist request bodies or provider credentials.
    A restart invalidates pending confirmations, which is safer than silently
    replaying a paid request after an ambiguous process restart.
    """

    def __init__(self) -> None:
        self._items: dict[str, _PendingPaidRequest] = {}
        self._lock = threading.Lock()

    def put(self, item: _PendingPaidRequest) -> str:
        token = secrets.token_urlsafe(32)
        with self._lock:
            self._purge_locked()
            self._items[token] = item
        return token

    def pop(self, token: str) -> _PendingPaidRequest | None:
        with self._lock:
            self._purge_locked()
            return self._items.pop(token, None)

    def _purge_locked(self) -> None:
        now = time.time()
        for token, item in list(self._items.items()):
            if item.expires_at <= now:
                self._items.pop(token, None)


def _endpoint(application: FastAPI, path: str, method: str = "POST"):
    """Find one existing web-api endpoint without duplicating its rules."""

    for route in application.routes:
        if getattr(route, "path", None) != path:
            continue
        methods = getattr(route, "methods", set())
        if method.upper() in methods:
            return route.endpoint
    raise RuntimeError(f"web-api endpoint not found: {method} {path}")


def _model_html() -> HTMLResponse:
    html = (UI_DIR / "model.html").read_text(encoding="utf-8")
    for asset in ("model.css", "model.js", "stock-plan.js", "montage-tools.js", "montage-studio.js", "montage-studio.css"):
        path = UI_DIR / asset
        version = str(int(path.stat().st_mtime)) if path.is_file() else "0"
        html = re.sub(r'/ui/' + re.escape(asset) + r'(?:\?[^"\s<>]*)?', f"/ui/{asset}?v={version}", html)
    return HTMLResponse(html)


def _entry_html(mode: str) -> HTMLResponse:
    """Render the first-version three-entry creation page on the same origin."""

    html = (UI_DIR / "entry.html").read_text(encoding="utf-8")
    # The mode is carried in the document rather than only in the URL so a
    # direct /create/<mode> visit still opens the matching production panel.
    html = re.sub(r"<body\b([^>]*)>", lambda match: f'<body{match.group(1)} data-entry-mode="{mode}">', html, count=1)
    for asset in ("entry.css", "entry.js"):
        path = UI_DIR / asset
        version = str(int(path.stat().st_mtime)) if path.is_file() else "0"
        html = html.replace(f"/ui/{asset}", f"/ui/{asset}?v={version}")
    return HTMLResponse(html)


def _openmontage_tool_catalog() -> dict[str, Any]:
    """Return a safe, user-facing view of the discovered OpenMontage tools.

    The registry is queried on demand instead of during app import. Discovery
    can inspect optional modules and environment variables, so the workbench
    still starts when an optional provider is not installed. Only capability
    metadata is returned; credential values and provider clients never cross
    this boundary.
    """

    try:
        from tools.tool_registry import registry

        summary = registry.provider_menu_summary()
        menu = registry.provider_menu()
        tools: list[dict[str, Any]] = []
        counts = {"available": 0, "degraded": 0, "unavailable": 0}
        for capability, bucket in menu.items():
            for raw in bucket.get("available", []) + bucket.get("unavailable", []):
                status = str(raw.get("status") or "unavailable").lower()
                if status not in counts:
                    status = "unavailable"
                counts[status] += 1
                # Keep this payload intentionally small and credential-safe.
                # Dependencies are names such as ``env:ARK_API_KEY``; actual
                # values are never read into the response.
                entry: dict[str, Any] = {
                    "name": raw.get("name"),
                    "capability": capability,
                    "provider": raw.get("provider"),
                    "runtime": raw.get("runtime"),
                    "status": status,
                    "best_for": list(raw.get("best_for") or []),
                    "dependencies": list(raw.get("dependencies") or []),
                    "install_instructions": str(raw.get("install_instructions") or ""),
                }
                for extra_key in (
                    "operation_statuses",
                    "resource_profile_note",
                    "remotion_note",
                    "source_provider_summary",
                ):
                    if raw.get(extra_key):
                        entry[extra_key] = raw[extra_key]
                tools.append(entry)

        tools.sort(
            key=lambda item: (
                str(item.get("capability") or ""),
                str(item.get("name") or ""),
            )
        )
        return {
            "status": "ready",
            "generated_at": _utc_iso(),
            "tool_count": len(tools),
            "available_count": counts["available"],
            "degraded_count": counts["degraded"],
            "unavailable_count": counts["unavailable"],
            "capabilities": summary.get("capabilities", []),
            "composition_runtimes": summary.get("composition_runtimes", {}),
            "runtime_warnings": summary.get("runtime_warnings", []),
            "setup_offers": summary.get("setup_offers", []),
            "tools": tools,
        }
    except Exception as exc:  # pragma: no cover - defensive startup boundary
        return {
            "status": "unavailable",
            "generated_at": _utc_iso(),
            "tool_count": 0,
            "available_count": 0,
            "degraded_count": 0,
            "unavailable_count": 0,
            "capabilities": [],
            "composition_runtimes": {},
            "runtime_warnings": [],
            "setup_offers": [],
            "tools": [],
            "error": f"工具目录读取失败：{str(exc)[:300]}",
        }


def _openmontage_pipeline_catalog() -> dict[str, Any]:
    """Return validated OpenMontage pipeline manifests as safe metadata.

    Backlot already renders the active project's pipeline, but the model gate
    had no way to show creators what other production paths exist. This
    endpoint exposes only manifest metadata and stage contracts; it never
    executes a pipeline or returns credentials.
    """

    try:
        from lib.pipeline_loader import list_pipelines, load_pipeline_readonly

        pipelines: list[dict[str, Any]] = []
        invalid: list[dict[str, Any]] = []
        for name in sorted(list_pipelines()):
            try:
                manifest = load_pipeline_readonly(name)
                stages: list[dict[str, Any]] = []
                for stage in manifest.get("stages", []):
                    if not isinstance(stage, dict):
                        continue
                    stages.append(
                        {
                            "name": stage.get("name"),
                            "skill": stage.get("skill"),
                            "produces": list(stage.get("produces") or []),
                            "tools_available": list(stage.get("tools_available") or []),
                            "checkpoint_required": bool(stage.get("checkpoint_required", False)),
                            "human_approval_default": bool(stage.get("human_approval_default", False)),
                        }
                    )
                orchestration = manifest.get("orchestration") or {}
                reference_input = manifest.get("reference_input") or {}
                pipelines.append(
                    {
                        "name": manifest.get("name") or name,
                        "version": manifest.get("version"),
                        "description": str(manifest.get("description") or "").strip(),
                        "category": manifest.get("category"),
                        "stability": manifest.get("stability"),
                        "default_checkpoint_policy": manifest.get("default_checkpoint_policy"),
                        "reference_input": {
                            "supported": bool(reference_input.get("supported", False)),
                            "analysis_depth": reference_input.get("analysis_depth"),
                            "analysis_tools": list(reference_input.get("analysis_tools") or []),
                        },
                        "orchestration": {
                            "mode": orchestration.get("mode"),
                            "budget_default_usd": orchestration.get("budget_default_usd"),
                            "max_revisions_per_stage": orchestration.get("max_revisions_per_stage"),
                            "max_send_backs": orchestration.get("max_send_backs"),
                        },
                        "stage_count": len(stages),
                        "stages": stages,
                    }
                )
            except Exception as exc:
                # A malformed optional manifest should be visible without
                # preventing the rest of the workbench from loading.
                invalid.append({"name": name, "error": str(exc)[:300]})
        return {
            "status": "ready",
            "generated_at": _utc_iso(),
            "pipeline_count": len(pipelines),
            "invalid_count": len(invalid),
            "pipelines": pipelines,
            "invalid": invalid,
        }
    except Exception as exc:  # pragma: no cover - defensive startup boundary
        return {
            "status": "unavailable",
            "generated_at": _utc_iso(),
            "pipeline_count": 0,
            "invalid_count": 0,
            "pipelines": [],
            "invalid": [],
            "error": f"管线目录读取失败：{str(exc)[:300]}",
        }


def create_app(
    *,
    task_application: FastAPI | None = None,
    board_application: FastAPI | None = None,
    project_root: Path | None = None,
    audio_selector: Any | None = None,
    image_selector: Any | None = None,
    transcriber: Any | None = None,
    frame_sampler: Any | None = None,
    face_tracker: Any | None = None,
    music_tool: Any | None = None,
) -> FastAPI:
    """Create the same-origin adapter, with injectable apps for tests."""

    task_application = task_application or task_app
    board_application = board_application or backlot_app
    project_root = Path(project_root) if project_root is not None else PROJECTS_DIR
    # Keep each provider's existing env-based contract, but reuse already
    # configured local Keychain entries when running on this Mac.  The helper
    # returns only a boolean; secret values stay server-side in os.environ.
    _load_macos_keychain_secret(service="ARK_API_KEY", environment_name="ARK_API_KEY")
    _load_macos_keychain_secret(
        service="DOUBAO_SPEECH_API_KEY",
        environment_name="DOUBAO_SPEECH_API_KEY",
    )
    _load_macos_keychain_secret(
        service="ELEVENLABS_API_KEY",
        environment_name="ELEVENLABS_API_KEY",
    )
    _load_macos_keychain_secret(service="PEXELS_API_KEY", environment_name="PEXELS_API_KEY")
    _load_macos_keychain_secret(service="PIXABAY_API_KEY", environment_name="PIXABAY_API_KEY")
    _load_macos_keychain_secret(service="COVERR_API_KEY", environment_name="COVERR_API_KEY")
    _ensure_local_paid_gate()
    estimate_endpoint = _endpoint(task_application, "/api/tasks/estimate")
    create_endpoint = _endpoint(task_application, "/api/tasks")
    query_endpoint = _endpoint(task_application, "/api/tasks/{task_id}", "GET")
    cancel_endpoint = _endpoint(task_application, "/api/tasks/{task_id}", "DELETE")
    audio_application = create_audio_app(
        selector=audio_selector,
        project_root=project_root,
    )
    local_tools_application = create_local_tools_app(project_root=project_root)
    local_tools_capabilities_endpoint = _endpoint(
        local_tools_application, "/api/local-tools/capabilities", "GET"
    )
    local_tools_estimate_endpoint = _endpoint(
        local_tools_application, "/api/local-tools/estimate"
    )
    local_tools_execute_endpoint = _endpoint(
        local_tools_application, "/api/local-tools/execute"
    )
    audio_health_endpoint = _endpoint(audio_application, "/api/audio/health", "GET")
    audio_estimate_endpoint = _endpoint(audio_application, "/api/audio/estimate")
    audio_render_endpoint = _endpoint(audio_application, "/api/audio/render")
    music_application = create_music_app(project_root=project_root, tool=music_tool)
    music_health_endpoint = _endpoint(music_application, "/api/music/health", "GET")
    music_estimate_endpoint = _endpoint(music_application, "/api/music/estimate")
    music_render_endpoint = _endpoint(music_application, "/api/music/render")
    media_application = create_media_app(
        project_root=project_root,
        image_selector=image_selector,
        tts_selector=audio_selector,
        transcriber=transcriber,
        frame_sampler=frame_sampler,
        face_tracker=face_tracker,
    )
    media_capabilities_endpoint = _endpoint(media_application, "/api/media/capabilities", "GET")
    subtitle_render_endpoint = _endpoint(media_application, "/api/media/subtitles/render")
    transcription_endpoint = _endpoint(media_application, "/api/media/transcribe")
    frame_sampling_endpoint = _endpoint(media_application, "/api/media/frames/sample")
    face_tracking_endpoint = _endpoint(media_application, "/api/media/faces/track")
    image_estimate_endpoint = _endpoint(media_application, "/api/media/images/estimate")
    image_render_endpoint = _endpoint(media_application, "/api/media/images/render")
    compose_endpoint = _endpoint(media_application, "/api/media/compose")
    quality_endpoint = _endpoint(media_application, "/api/media/quality")
    publish_endpoint = _endpoint(media_application, "/api/media/publish")
    reference_review_endpoint = _endpoint(media_application, "/api/media/reference/review")
    still_compose_endpoint = _endpoint(media_application, "/api/media/stills/compose")
    stock_search_endpoint = _endpoint(media_application, "/api/media/stock/search")
    trim_endpoint = _endpoint(media_application, "/api/media/trim")
    video_postprocess_endpoint = _endpoint(media_application, "/api/media/video/postprocess")
    audio_mix_endpoint = _endpoint(media_application, "/api/media/audio/mix")
    audio_enhance_endpoint = _endpoint(media_application, "/api/media/audio/enhance")
    confirmations = _ConfirmationStore()

    @asynccontextmanager
    async def mounted_lifespan(_application: FastAPI):
        # Mounted ASGI apps do not start their own lifespans automatically.
        # In particular, Backlot's file watcher must belong to this server.
        async with AsyncExitStack() as stack:
            await stack.enter_async_context(task_application.router.lifespan_context(task_application))
            await stack.enter_async_context(board_application.router.lifespan_context(board_application))
            yield

    application = FastAPI(
        title="OpenMontage Zhejiang Tourism Workbench",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        lifespan=mounted_lifespan,
    )
    application.include_router(create_footage_router(project_root))
    application.include_router(create_montage_router(project_root))
    application.include_router(create_canvas_router(project_root))
    application.include_router(create_canvas_module_router(project_root))
    application.include_router(create_reference_router(project_root))
    application.include_router(create_hypit_workbench_router(project_root))

    @application.get("/hypit", response_class=HTMLResponse)
    @application.get("/hypit/", response_class=HTMLResponse)
    async def hypit_page() -> HTMLResponse:
        html = (UI_DIR / "hypit.html").read_text(encoding="utf-8")
        for asset in ("hypit.css", "hypit.js", "studio.js"):
            path = UI_DIR / asset
            html = html.replace(f"/ui/{asset}", f"/ui/{asset}?v={path.stat().st_mtime_ns}")
        return HTMLResponse(html)

    @application.get("/canvas", response_class=HTMLResponse)
    @application.get("/canvas/", response_class=HTMLResponse)
    async def canvas_page() -> HTMLResponse:
        html = (UI_DIR / "canvas.html").read_text(encoding="utf-8")
        for asset in ("canvas.css", "canvas.js", "studio.js", "studio.css"):
            path = UI_DIR / asset
            html = html.replace(f"/ui/{asset}", f"/ui/{asset}?v={path.stat().st_mtime_ns}")
        return HTMLResponse(html)

    @application.get("/footage", response_class=HTMLResponse)
    @application.get("/footage/", response_class=HTMLResponse)
    async def footage_page() -> HTMLResponse:
        html = (UI_DIR / "footage.html").read_text(encoding="utf-8")
        for asset in ("footage.css", "footage.js"):
            path = UI_DIR / asset
            version = str(int(path.stat().st_mtime)) if path.is_file() else "0"
            html = html.replace(f"/ui/{asset}", f"/ui/{asset}?v={version}")
        return HTMLResponse(html)

    @application.get("/model", response_class=HTMLResponse)
    @application.get("/model/", response_class=HTMLResponse)
    async def model_page(request: Request) -> Response:
        # A production workspace needs either a project to resume or a draft
        # handed over by one of the creation entries.  Deep links such as
        # /model?workspace=video have neither and otherwise look like a second,
        # empty version of the three-proposal page.
        if not request.query_params.get("project") and request.query_params.get("entry") not in ENTRY_MODES:
            return RedirectResponse("/create/guided", status_code=303)
        return _model_html()

    @application.get("/create/{entry}", response_class=HTMLResponse)
    async def creation_entry(entry: str) -> HTMLResponse:
        """Open one of the three independent creator production entry pages."""

        if entry not in ENTRY_MODES:
            raise HTTPException(status_code=404, detail="unknown creation entry")
        return _entry_html(entry)

    @application.post("/model-api/workflow/candidates")
    async def workflow_candidates(body: dict[str, Any]) -> dict[str, Any]:
        """Return exactly three free creative candidates for the workbench."""

        prompt = str(body.get("prompt") or "")
        mode = _workflow_mode(body.get("mode"))
        return _workflow_candidates(prompt, mode)

    @application.post("/model-api/workflow/draft")
    async def workflow_draft(body: dict[str, Any]) -> dict[str, Any]:
        """Save free planning progress as an independent Backlot project."""

        return await asyncio.to_thread(
            _persist_workflow_draft,
            body=body,
            project_root=project_root,
        )

    @application.post("/model-api/workflow/storyboard")
    async def workflow_storyboard(body: dict[str, Any]) -> dict[str, Any]:
        """Build a free, reviewable storyboard from one candidate id."""

        prompt = str(body.get("prompt") or "")
        mode = _workflow_mode(body.get("mode"))
        candidate_id = str(body.get("candidate_id") or "")
        candidates = _workflow_candidates(prompt, mode)["candidates"]
        candidate = next((item for item in candidates if item["id"] == candidate_id), None)
        if candidate is None:
            raise HTTPException(status_code=422, detail="candidate_id is not valid for this prompt")
        return _workflow_storyboard(prompt, candidate, mode)

    @application.post("/model-api/workflow/storyboard/repair")
    async def workflow_storyboard_repair(body: dict[str, Any]) -> dict[str, Any]:
        """Apply one creator-specified storyboard repair without paid calls."""

        prompt = str(body.get("prompt") or "")
        mode = _workflow_mode(body.get("mode"))
        candidate_id = str(body.get("candidate_id") or "").strip()
        shot_id = str(body.get("shot_id") or "").strip()
        instructions = str(body.get("instructions") or "").strip()
        if not candidate_id:
            raise HTTPException(status_code=422, detail="candidate_id is required")
        if not shot_id:
            raise HTTPException(status_code=422, detail="shot_id is required")
        candidates = _workflow_candidates(prompt, mode)["candidates"]
        candidate = next((item for item in candidates if item["id"] == candidate_id), None)
        if candidate is None:
            raise HTTPException(status_code=422, detail="candidate_id is not valid for this prompt")
        storyboard = _repair_storyboard_shot(
            prompt,
            candidate,
            mode,
            shot_id,
            instructions,
            body.get("storyboard"),
            body.get("visual_prompt"),
            body.get("motion_prompt"),
        )
        return {
            "status": "repaired",
            "project_id": body.get("draft_id"),
            "candidate_id": candidate_id,
            "storyboard": storyboard,
            "repaired_shot_id": shot_id,
            "message": "已按创作者意见更新一个镜头；请重新检查该镜头及其相邻共享边界帧。",
        }

    @application.post("/model-api/workflow/storyboard/images")
    async def workflow_storyboard_images(body: dict[str, Any]) -> dict[str, Any]:
        """Check or render the images belonging to the active storyboard.

        The workflow endpoint keeps the image gate next to the storyboard
        gate.  A dry-run only ranks providers; an actual render requires both
        the creator's confirmation in the request and the server-side media
        authorization.  No image is silently generated when the provider is
        unavailable or the authorization is missing.
        """

        project_id = str(body.get("project_id") or "").strip()
        shots = body.get("shots")
        if not project_id:
            raise HTTPException(status_code=422, detail="project_id is required")
        if not isinstance(shots, list) or not shots:
            raise HTTPException(status_code=422, detail="shots must be a non-empty list")
        raw_request = {
            "project_id": project_id,
            "shots": shots,
            "preferred_provider": str(body.get("preferred_provider") or "auto"),
            "allowed_providers": body.get("allowed_providers") if isinstance(body.get("allowed_providers"), list) else None,
            "dry_run": bool(body.get("dry_run", True)),
            "execute": bool(body.get("execute", False)),
            "confirm": bool(body.get("confirm", False)),
        }
        request = ImagePipelineRequest.model_validate(raw_request)
        if request.dry_run or not request.execute:
            return await asyncio.to_thread(image_estimate_endpoint, request)
        if not request.confirm:
            raise HTTPException(status_code=400, detail="confirm=true is required for storyboard image generation")
        authorization = _media_authorization(None)
        if not authorization:
            return {
                "status": "authorization_required",
                "project_id": project_id,
                "would_generate": False,
                "authorization_required": True,
                "error": "图片生成已获创作者确认，但服务端没有可用的生成授权；未写入图片。",
            }
        # The web workbench opts into a durable background job.  We persist
        # the accepted receipt before touching the paid provider, then the
        # browser polls the status endpoint.  Keeping the old synchronous path
        # for callers that do not send ``background`` avoids breaking scripts
        # written against the original adapter contract.
        if bool(body.get("background", False)):
            try:
                project_dir = _resolve_storyboard_project(Path(project_root), project_id)
            except (ValueError, FileNotFoundError, OSError):
                raise HTTPException(status_code=404, detail="project does not exist")
            fingerprint = _storyboard_image_fingerprint(request)
            shot_ids = [shot.id for shot in request.shots]
            shot_outputs = [f"assets/frames/{re.sub(r'[^A-Za-z0-9._-]', '_', shot.id)[:96] or 'shot'}.png" for shot in request.shots]
            existing = _storyboard_image_job_snapshot(project_dir, mutate_stall=True)
            if existing and existing.get("fingerprint") == fingerprint:
                if existing.get("status") in {"accepted", "running", "stalled"}:
                    return {
                        **existing,
                        "project_id": project_id,
                        "status_url": f"/model-api/workflow/storyboard/images/status/{project_id}",
                    }
                if existing.get("status") == "completed" and isinstance(existing.get("result"), dict):
                    return {
                        "status": "completed",
                        "project_id": project_id,
                        "job_id": existing.get("job_id"),
                        "result": existing.get("result"),
                        "completed_shots": existing.get("completed_shots", len(shot_ids)),
                        "total_shots": existing.get("total_shots", len(shot_ids)),
                        "status_url": f"/model-api/workflow/storyboard/images/status/{project_id}",
                    }
            job_id = f"storyboard-image-{secrets.token_hex(8)}"
            accepted_at = _utc_iso()
            job = {
                "schema_version": "1.0",
                "job_id": job_id,
                "project_id": project_id,
                "operation": "storyboard_images",
                "status": "accepted",
                "state": "queued",
                "created_at": accepted_at,
                "accepted_at": accepted_at,
                "last_heartbeat_at": accepted_at,
                "heartbeat_count": 0,
                "total_shots": len(shot_ids),
                "completed_shots": 0,
                "completed_shot_ids": [],
                "images_written": [],
                "shot_ids": shot_ids,
                "shot_outputs": shot_outputs,
                "fingerprint": fingerprint,
                "message": "已接收图片生成任务，后台将按镜头顺序处理；可安全刷新页面。",
            }
            _write_json(_storyboard_image_job_path(project_dir), job)
            notify_project_changed(project_id)
            emit_event(project_dir, {
                "event": "storyboard_image_job",
                "status": "accepted",
                "job_id": job_id,
                "total_shots": len(shot_ids),
            })
            worker_payload = request.model_dump(mode="json")
            _STORYBOARD_IMAGE_EXECUTOR.submit(
                _run_storyboard_image_job,
                project_root=Path(project_root),
                request_payload=worker_payload,
                job_id=job_id,
                image_render_endpoint=image_render_endpoint,
                authorization=authorization,
            )
            return {
                **job,
                "status_url": f"/model-api/workflow/storyboard/images/status/{project_id}",
            }
        return await asyncio.to_thread(
            image_render_endpoint,
            request,
            x_generation_authorization=authorization,
        )

    @application.get("/model-api/workflow/storyboard/images/status/{project_id}")
    async def workflow_storyboard_images_status(project_id: str) -> dict[str, Any]:
        """Return a truthful, reload-safe image job heartbeat for a project."""

        project_id = str(project_id or "").strip()
        try:
            project_dir = _resolve_storyboard_project(Path(project_root), project_id)
        except (ValueError, FileNotFoundError, OSError):
            raise HTTPException(status_code=404, detail="project does not exist")
        job = _storyboard_image_job_snapshot(project_dir, mutate_stall=True)
        if not job:
            return {
                "status": "idle",
                "state": "idle",
                "project_id": project_id,
                "message": "当前项目没有已接受的分镜图任务。",
            }
        job["status_url"] = f"/model-api/workflow/storyboard/images/status/{project_id}"
        return job

    @application.get("/model-api/media/audio/health")
    @application.get("/model-api/media/audio/capabilities")
    async def audio_health() -> dict[str, Any]:
        """Expose safe TTS/ffprobe capability state to the workbench."""

        return await asyncio.to_thread(audio_health_endpoint)

    @application.post("/model-api/media/audio/estimate")
    async def audio_estimate(request: AudioPipelineRequest) -> dict[str, Any]:
        """Run the free TTS provider ranking and duration estimate."""

        return await asyncio.to_thread(audio_estimate_endpoint, request)

    @application.post("/model-api/media/audio/render")
    async def audio_render(
        request: AudioPipelineRequest,
        x_generation_authorization: str | None = Header(
            default=None, alias="X-Generation-Authorization"
        ),
    ) -> dict[str, Any]:
        """Render narration only after the audio service's paid gate passes."""

        return await asyncio.to_thread(
            audio_render_endpoint,
            request,
            x_generation_authorization=_media_authorization(x_generation_authorization),
        )

    @application.get("/model-api/media/music/health")
    @application.get("/model-api/media/music/capabilities")
    async def music_health() -> dict[str, Any]:
        """Expose safe BGM provider state; credentials stay server-side."""

        return await asyncio.to_thread(music_health_endpoint)

    @application.post("/model-api/media/music/import")
    async def local_bgm_import(request: LocalBgmRequest) -> dict[str, Any]:
        try:
            return await asyncio.to_thread(import_local_bgm, request, project_root=project_root)
        except (ValueError, FileNotFoundError, RuntimeError) as exc:
            return {"status": "failed", "project_id": request.project_id, "error": str(exc)[:500]}

    @application.post("/model-api/media/music/estimate")
    async def music_estimate(request: MusicPipelineRequest) -> dict[str, Any]:
        """Preview BGM timing, cue sheet and cost without writing or charging."""

        return await asyncio.to_thread(music_estimate_endpoint, request)

    @application.post("/model-api/media/music/render")
    async def music_render(
        request: MusicPipelineRequest,
        x_generation_authorization: str | None = Header(
            default=None, alias="X-Generation-Authorization"
        ),
    ) -> dict[str, Any]:
        """Generate BGM only after a fresh explicit confirmation."""

        if request.dry_run or not request.execute:
            return await asyncio.to_thread(music_render_endpoint, request)
        if not request.confirm:
            raise HTTPException(
                status_code=400,
                detail="confirm=true is required for music generation",
            )
        return await asyncio.to_thread(
            music_render_endpoint,
            request,
            x_generation_authorization=_media_authorization(x_generation_authorization),
        )

    @application.get("/model-api/media/capabilities")
    async def media_capabilities() -> dict[str, Any]:
        """Return live local/provider capability status for the workbench."""

        return await asyncio.to_thread(media_capabilities_endpoint)

    @application.get("/model-api/local-tools/capabilities")
    @application.get("/model-api/media/local-tools/capabilities")
    async def local_tools_capabilities() -> dict[str, Any]:
        """Return the installed free local-tool buttons and their live status."""

        return await asyncio.to_thread(local_tools_capabilities_endpoint)

    @application.post("/model-api/local-tools/estimate")
    @application.post("/model-api/media/local-tools/preflight")
    @application.post("/model-api/media/local-tools/estimate")
    async def local_tools_estimate(request: LocalToolRequest) -> dict[str, Any]:
        """Preflight one closed, project-scoped local operation without writing."""

        return await asyncio.to_thread(local_tools_estimate_endpoint, request)

    @application.post("/model-api/local-tools/execute")
    @application.post("/model-api/media/local-tools/execute")
    async def local_tools_execute(request: LocalToolRequest) -> dict[str, Any]:
        """Run one confirmed local operation and persist its unique manifest."""

        return await asyncio.to_thread(local_tools_execute_endpoint, request)

    @application.get("/model-api/tools/catalog")
    async def tools_catalog() -> dict[str, Any]:
        """Expose the OpenMontage registry without exposing credentials."""

        return await asyncio.to_thread(_openmontage_tool_catalog)

    @application.get("/model-api/pipelines/catalog")
    async def pipelines_catalog() -> dict[str, Any]:
        """Expose validated pipeline choices and their stage contracts."""

        return await asyncio.to_thread(_openmontage_pipeline_catalog)

    @application.post("/model-api/media/subtitles/render")
    async def media_subtitles(request: SubtitleRenderRequest) -> dict[str, Any]:
        """Render deterministic SRT/VTT/JSON subtitles inside the project."""

        return await asyncio.to_thread(subtitle_render_endpoint, request)

    @application.post("/model-api/media/transcribe")
    async def media_transcribe(request: TranscriptRequest) -> dict[str, Any]:
        """Transcribe project media locally and emit timed subtitle artifacts."""

        if request.execute and not request.dry_run and not request.confirm:
            raise HTTPException(
                status_code=400,
                detail="confirm=true is required before transcription",
            )
        return await asyncio.to_thread(transcription_endpoint, request)

    @application.post("/model-api/media/frames/sample")
    async def media_sample_frames(request: FrameSampleRequest) -> dict[str, Any]:
        """Extract real project-local frames after an explicit confirmation."""

        if request.execute and not request.dry_run and not request.confirm:
            raise HTTPException(
                status_code=400,
                detail="confirm=true is required before frame sampling",
            )
        return await asyncio.to_thread(frame_sampling_endpoint, request)

    @application.post("/model-api/media/faces/track")
    async def media_track_faces(request: FaceTrackRequest) -> dict[str, Any]:
        """Run local face tracking and persist a truthful JSON report."""

        if request.execute and not request.dry_run and not request.confirm:
            raise HTTPException(
                status_code=400,
                detail="confirm=true is required before face tracking",
            )
        return await asyncio.to_thread(face_tracking_endpoint, request)

    @application.post("/model-api/media/reference/review")
    async def media_reference_review(request: ReferenceReviewRequest) -> dict[str, Any]:
        """Analyze a local reference video and persist frames/research artifacts."""

        if request.execute and not request.dry_run and not request.confirm:
            raise HTTPException(
                status_code=400,
                detail="confirm=true is required before reference analysis",
            )
        return await asyncio.to_thread(reference_review_endpoint, request)

    @application.post("/model-api/media/stock/search")
    async def media_stock_search(request: StockSearchRequest) -> dict[str, Any]:
        """Search free stock/archival media and save it inside the project."""

        if request.execute and not request.dry_run and not request.confirm:
            raise HTTPException(
                status_code=400,
                detail="confirm=true is required before stock search",
            )
        return await asyncio.to_thread(stock_search_endpoint, request)

    @application.post("/model-api/media/trim")
    async def media_trim(request: TrimRequest) -> dict[str, Any]:
        """Cut a project-local clip before it enters the composition list."""

        return await asyncio.to_thread(trim_endpoint, request)

    @application.post("/model-api/media/video/postprocess")
    async def media_video_postprocess(request: VideoPostprocessRequest) -> dict[str, Any]:
        """Run local video finishing tools: silence, scenes, framing, or grade."""

        return await asyncio.to_thread(video_postprocess_endpoint, request)

    @application.post("/model-api/media/audio/mix")
    async def media_audio_mix(request: AudioMixRequest) -> dict[str, Any]:
        """Mix/duck/extract project audio with the local OpenMontage mixer."""

        return await asyncio.to_thread(audio_mix_endpoint, request)

    @application.post("/model-api/media/audio/enhance")
    async def media_audio_enhance(request: AudioEnhanceRequest) -> dict[str, Any]:
        """Clean and normalize a project-local narration track."""

        return await asyncio.to_thread(audio_enhance_endpoint, request)

    @application.post("/model-api/media/images/estimate")
    async def media_images_estimate(request: ImagePipelineRequest) -> dict[str, Any]:
        """Rank storyboard-image providers without writing or charging."""

        return await asyncio.to_thread(image_estimate_endpoint, request)

    @application.post("/model-api/media/images/render")
    async def media_images_render(
        request: ImagePipelineRequest,
        x_generation_authorization: str | None = Header(
            default=None, alias="X-Generation-Authorization"
        ),
    ) -> dict[str, Any]:
        """Generate storyboard images only after an explicit paid gate."""

        if request.dry_run or not request.execute:
            return await asyncio.to_thread(image_render_endpoint, request)
        if not request.confirm:
            raise HTTPException(
                status_code=400,
                detail="confirm=true is required for image generation",
            )
        return await asyncio.to_thread(
            image_render_endpoint,
            request,
            x_generation_authorization=_media_authorization(x_generation_authorization),
        )

    @application.post("/model-api/media/compose")
    async def media_compose(request: ComposeRequest) -> dict[str, Any]:
        """Assemble project-local clips with FFmpeg and persist a manifest."""

        return await asyncio.to_thread(compose_endpoint, request)

    @application.post("/model-api/media/stills/compose")
    async def media_stills_compose(request: StillComposeRequest) -> dict[str, Any]:
        """Animate clean storyboard stills locally, then use the compose path."""

        return await asyncio.to_thread(still_compose_endpoint, request)

    @application.post("/model-api/media/quality")
    async def media_quality(request: QualityRequest) -> dict[str, Any]:
        """Run technical media QA and persist a truthful report."""

        return await asyncio.to_thread(quality_endpoint, request)

    @application.post("/model-api/media/publish")
    async def media_publish(request: PublishRequest) -> dict[str, Any]:
        """Export a portable local delivery bundle; never upload silently."""

        return await asyncio.to_thread(publish_endpoint, request)

    @application.post("/model-api/workflow/video/estimate")
    async def workflow_video_estimate(request: GenerationRequest) -> dict[str, Any]:
        """Estimate every confirmed storyboard shot without creating tasks."""

        payload = request.model_dump(exclude_none=True)
        try:
            return await asyncio.to_thread(
                _estimate_storyboard_batch,
                payload,
                estimate_endpoint,
                project_root=project_root,
            )
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=502, detail="storyboard video estimate failed") from exc

    @application.post("/model-api/paid/prepare")
    async def prepare_paid(request: GenerationRequest) -> dict[str, Any]:
        """Run a free estimate and issue a short-lived confirmation id."""

        if request.max_cost_cny is None:
            raise HTTPException(
                status_code=422,
                detail="max_cost_cny is required before paid confirmation",
            )

        request_values = request.model_dump(exclude_none=True)
        workflow_mode = _workflow_mode(request_values.pop("workflow_mode", "quality"))
        candidate_id = request_values.pop("workflow_candidate_id", None)
        try:
            if request_values.get("storyboard_shots"):
                estimate = await asyncio.to_thread(
                    _estimate_storyboard_batch,
                    request_values,
                    estimate_endpoint,
                    project_root=project_root,
                )
            else:
                provider_request = GenerationRequest.model_validate(request_values)
                estimate = await asyncio.to_thread(estimate_endpoint, provider_request)
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=502, detail="estimate failed") from exc

        if isinstance(estimate, EstimateResponse):
            estimate_valid = estimate.valid
            estimate_cost = estimate.estimated_cost_cny
            estimate_within = estimate.within_max_cost
            estimate_error = estimate.error
        elif isinstance(estimate, dict):
            estimate_valid = bool(estimate.get("valid"))
            estimate_cost = estimate.get("estimated_cost_cny")
            estimate_within = estimate.get("within_max_cost")
            estimate_error = estimate.get("error")
        else:
            raise HTTPException(status_code=502, detail="invalid estimate response")
        if not estimate_valid or estimate_cost is None:
            raise HTTPException(
                status_code=422,
                detail=estimate_error or "provider estimate is unavailable",
            )
        if estimate_within is not True:
            raise HTTPException(
                status_code=400,
                detail="estimated cost exceeds the requested or server limit",
            )

        # Never keep credential-shaped extras in the pending object.  The
        # browser is not expected to send any, but this remains a safe boundary.
        # Workflow metadata is for project bookkeeping only and must never be
        # forwarded to the provider as an unknown generation parameter.
        payload = _remove_sensitive_fields(request_values)
        confirmation_id = confirmations.put(
            _PendingPaidRequest(
                payload=payload,
                estimated_cost_cny=float(estimate_cost),
                expires_at=time.time() + CONFIRMATION_TTL_SECONDS,
                workflow_mode=workflow_mode,
                candidate_id=str(candidate_id) if candidate_id else None,
            )
        )
        return {
            "confirmation_id": confirmation_id,
            "estimated_cost_cny": float(estimate_cost),
            "expires_in_seconds": CONFIRMATION_TTL_SECONDS,
            "message": "prepared; no paid provider request has been sent",
        }

    @application.post("/model-api/paid/submit-batch")
    async def submit_paid_batch(body: dict[str, Any]) -> dict[str, Any]:
        """Submit one paid task per confirmed storyboard shot after confirmation."""

        confirmation_id = str(body.get("confirmation_id") or "")
        if not confirmation_id:
            raise HTTPException(status_code=422, detail="confirmation_id is required")
        pending = confirmations.pop(confirmation_id)
        if pending is None:
            raise HTTPException(status_code=410, detail="confirmation expired, already used, or invalid")
        authorization = _internal_paid_authorization()
        payload = dict(pending.payload)
        shots = _normalize_storyboard_video_shots(payload, project_root=project_root)
        requests: list[GenerationRequest] = []
        responses: list[TaskResponse] = []
        try:
            for shot in shots:
                request = _storyboard_video_request(payload, shot)
                response = await asyncio.to_thread(create_endpoint, request, authorization)
                if not isinstance(response, TaskResponse):
                    raise HTTPException(status_code=502, detail="invalid storyboard task response")
                requests.append(request)
                responses.append(response)
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=502, detail="storyboard video task submission failed") from exc
        batch_id = f"batch-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}-{secrets.token_hex(4)}"
        project_dir = await asyncio.to_thread(
            _create_backlot_project_batch,
            requests=requests,
            responses=responses,
            batch_id=batch_id,
            workflow_mode=pending.workflow_mode,
            candidate_id=pending.candidate_id,
            storyboard_shots=shots,
            source_draft_id=str(payload.get("storyboard_project_id") or "").strip() or None,
            project_root=project_root,
        )
        return {
            "batch_id": batch_id,
            "status": "submitted",
            "task_id": responses[0].task_id,
            "task_ids": [response.task_id for response in responses],
            "shot_count": len(responses),
            "total_duration_seconds": sum(shot["duration_seconds"] for shot in shots),
            "backlot_project_id": project_dir.name,
            "backlot_project_url": f"/p/{project_dir.name}",
            "data": {"tasks": [response.model_dump() for response in responses]},
        }

    @application.post("/model-api/paid/submit", response_model=TaskResponse)
    async def submit_paid(body: dict[str, Any]) -> TaskResponse:
        """Consume a confirmation id and submit exactly one paid task."""

        confirmation_id = str(body.get("confirmation_id") or "")
        if not confirmation_id:
            raise HTTPException(status_code=422, detail="confirmation_id is required")
        pending = confirmations.pop(confirmation_id)
        if pending is None:
            raise HTTPException(
                status_code=410,
                detail="confirmation expired, already used, or invalid",
            )

        authorization = os.environ.get("WEB_API_PAID_AUTH_TOKEN")
        if not authorization:
            raise HTTPException(
                status_code=503,
                detail="paid task submission is not configured",
            )

        request = GenerationRequest.model_validate(pending.payload)
        try:
            response = await asyncio.to_thread(
                create_endpoint,
                request,
                authorization,
            )
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=502, detail="paid task submission failed") from exc
        if not isinstance(response, TaskResponse):
            raise HTTPException(status_code=502, detail="invalid task response")
        project_dir = await asyncio.to_thread(
            _create_backlot_project,
            request=request,
            response=response,
            workflow_mode=pending.workflow_mode,
            candidate_id=pending.candidate_id,
            project_root=project_root,
        )
        response.data = {
            **response.data,
            "backlot_project_id": project_dir.name,
            "backlot_project_url": f"/p/{project_dir.name}",
        }
        return response

    def _internal_paid_authorization() -> str:
        authorization = os.environ.get("WEB_API_PAID_AUTH_TOKEN")
        if not authorization:
            raise HTTPException(
                status_code=503,
                detail="paid task submission is not configured",
            )
        return authorization

    @application.post("/model-api/paid/query", response_model=TaskResponse)
    async def query_paid(body: dict[str, Any]) -> TaskResponse:
        """Refresh one provider task after the creator already submitted it."""

        task_id = str(body.get("task_id") or "")
        if not task_id or len(task_id) > 256:
            raise HTTPException(status_code=422, detail="task_id is required")
        authorization = _internal_paid_authorization()
        recovered_local = False
        try:
            response = await asyncio.to_thread(query_endpoint, task_id, authorization)
        except HTTPException as exc:
            # A provider task can expire after Backlot has already downloaded
            # its MP4.  Keep the creator's durable local result usable.
            if _is_expired_provider_task_error(exc):
                response = await asyncio.to_thread(_local_task_response, task_id, project_root)
                recovered_local = response is not None
                if not recovered_local:
                    raise
            else:
                raise
        except Exception as exc:
            raise HTTPException(status_code=502, detail="task query failed") from exc
        if not isinstance(response, TaskResponse):
            raise HTTPException(status_code=502, detail="invalid task query response")
        await asyncio.to_thread(_update_backlot_project, response, project_root)
        local_url = await asyncio.to_thread(_local_video_url_for_task, task_id, project_root)
        if local_url:
            response.data = {**response.data, "local_video_url": local_url}
        batch_meta = await asyncio.to_thread(_batch_metadata_for_task, task_id, project_root)
        if batch_meta:
            response.data = {**response.data, **batch_meta}
        return response

    @application.post("/model-api/paid/batch/query")
    async def query_paid_batch(body: dict[str, Any]) -> dict[str, Any]:
        """Refresh all tasks in a storyboard batch and return aggregate progress."""

        raw_ids = body.get("task_ids") or []
        if not isinstance(raw_ids, list) or not raw_ids:
            batch_id = str(body.get("batch_id") or "")
            if batch_id:
                project_dir = None
                if project_root.is_dir():
                    for item in project_root.iterdir():
                        if not item.is_dir() or not (item / "project.json").is_file():
                            continue
                        try:
                            marker = json.loads((item / "project.json").read_text(encoding="utf-8"))
                        except (OSError, ValueError):
                            continue
                        if isinstance(marker, dict) and marker.get("batch_id") == batch_id:
                            project_dir = item
                            break
                if project_dir:
                    try:
                        raw_ids = json.loads((project_dir / "project.json").read_text(encoding="utf-8")).get("model_task_ids") or []
                    except (OSError, ValueError):
                        raw_ids = []
        task_ids = [str(value) for value in raw_ids if str(value) and len(str(value)) <= 256]
        if not task_ids:
            raise HTTPException(status_code=422, detail="task_ids or batch_id is required")
        authorization = _internal_paid_authorization()
        responses: list[TaskResponse] = []
        for task_id in task_ids:
            recovered_local = False
            try:
                response = await asyncio.to_thread(query_endpoint, task_id, authorization)
            except HTTPException as exc:
                # Do not lose already-downloaded clips when Ark has retired a
                # temporary task record.  The local render remains previewable
                # and counts toward the batch total.
                if _is_expired_provider_task_error(exc):
                    response = await asyncio.to_thread(_local_task_response, task_id, project_root)
                    recovered_local = response is not None
                    if not recovered_local:
                        raise
                else:
                    raise
            except Exception as exc:
                raise HTTPException(status_code=502, detail="storyboard batch query failed") from exc
            if not isinstance(response, TaskResponse):
                raise HTTPException(status_code=502, detail="invalid task query response")
            await asyncio.to_thread(_update_backlot_project, response, project_root)
            local_url = await asyncio.to_thread(_local_video_url_for_task, task_id, project_root)
            if local_url:
                response.data = {**response.data, "local_video_url": local_url}
            responses.append(response)
        statuses = [str(response.status or "unknown") for response in responses]
        result = {
            "status": "completed" if statuses and all(status.lower() in {"succeeded", "success", "completed", "done"} for status in statuses) else "failed" if any(status.lower() in {"failed", "error", "cancelled", "canceled"} for status in statuses) else "running",
            "task_ids": task_ids,
            "tasks": [response.model_dump() for response in responses],
            "completed_count": sum(status.lower() in {"succeeded", "success", "completed", "done"} for status in statuses),
            "total_count": len(statuses),
        }
        combined_url = await asyncio.to_thread(_local_batch_video_url, str(body.get("batch_id") or ""), project_root)
        if combined_url:
            result["continuous_video_url"] = combined_url
        total_duration = await asyncio.to_thread(_batch_total_duration, str(body.get("batch_id") or ""), project_root)
        if total_duration is not None:
            result["total_duration_seconds"] = total_duration
        return result

    @application.post("/model-api/paid/cancel", response_model=TaskResponse)
    async def cancel_paid(body: dict[str, Any]) -> TaskResponse:
        """Cancel one provider task after an explicit creator click."""

        task_id = str(body.get("task_id") or "")
        if not task_id or len(task_id) > 256:
            raise HTTPException(status_code=422, detail="task_id is required")
        authorization = _internal_paid_authorization()
        try:
            response = await asyncio.to_thread(cancel_endpoint, task_id, authorization)
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=502, detail="task cancellation failed") from exc
        if not isinstance(response, TaskResponse):
            raise HTTPException(status_code=502, detail="invalid task cancellation response")
        return response

    # Explicit routes above must be registered before these mounts.  The
    # official apps remain unchanged and continue to own their own routes.
    application.mount("/model-api", task_application)
    application.mount("/", board_application)
    return application


app = create_app()


__all__ = ["app", "create_app"]
