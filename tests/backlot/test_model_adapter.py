from __future__ import annotations

import json
import os
import asyncio
import shutil
import subprocess
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from backlot.model_adapter import _local_video_url_for_task, create_app
from schemas.artifacts import validate_artifact
from web_api.app import TaskResponse
from web_api.app import create_app as create_task_app
from web_api.media_pipeline import ImagePipelineRequest, render_images


class FakeTool:
    name = "fake_seedance"

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def get_status(self) -> str:
        return "available"

    def dry_run(self, inputs: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(("dry_run", dict(inputs)))
        return {
            "success": True,
            "data": {
                "valid": True,
                "estimated_cost_cny": 2.5,
                "estimated_cost_usd": 0.35,
                "model": "fake-mini",
            },
        }

    def execute(self, inputs: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(("execute", dict(inputs)))
        return {
            "success": True,
            "data": {
                "task_id": "fake-model-task-001",
                "status": "submitted",
                "provider": "fake",
                "model": "fake-mini",
            },
        }


class FakeImageSelector:
    """Tiny provider stand-in for the durable storyboard image test."""

    name = "fake_image_selector"
    provider = "fake"
    capability = "image_generation"

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def get_status(self) -> str:
        return "available"

    def _providers(self) -> list[Any]:
        return [self]

    def get_info(self) -> dict[str, Any]:
        return {"name": self.name, "provider": self.provider}

    def execute(self, inputs: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(dict(inputs))
        if inputs.get("operation") == "rank":
            return {"success": True, "data": {"rankings": [{"provider": self.provider, "score": 1.0}]}}
        output_path = Path(str(inputs["output_path"]))
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"fake-png")
        return {"success": True, "data": {"selected_provider": self.provider, "model": "fake-image"}}


def test_render_images_reports_each_committed_shot(tmp_path: Path) -> None:
    """The image stage emits a durable callback after each written frame."""

    project_root = tmp_path / "projects"
    (project_root / "progress-demo").mkdir(parents=True)
    request = ImagePipelineRequest.model_validate({
        "project_id": "progress-demo",
        "shots": [
            {"id": "shot-1", "prompt": "晨雾湖面"},
            {"id": "shot-2", "prompt": "夕阳山色"},
        ],
        "dry_run": False,
        "execute": True,
        "confirm": True,
    })
    updates: list[dict[str, Any]] = []
    result = render_images(
        request,
        selector=FakeImageSelector(),
        project_root=project_root,
        authorized=True,
        progress_callback=updates.append,
    )

    assert result["status"] == "completed"
    assert [item["completed_shots"] for item in updates] == [1, 2]
    assert updates[-1]["completed_shot_ids"] == ["shot-1", "shot-2"]
    assert len(updates[-1]["images_written"]) == 2

def _board_stub() -> FastAPI:
    app = FastAPI()

    @app.get("/")
    async def root() -> dict[str, bool]:
        return {"board": True}

    return app


async def request(app: FastAPI, method: str, path: str, **kwargs: Any) -> httpx.Response:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.request(method, path, **kwargs)


@pytest.mark.asyncio
async def test_model_page_and_estimate_are_same_origin_and_free(tmp_path: Path) -> None:
    fake = FakeTool()
    task_app = create_task_app(fake, tmp_path / "tasks.sqlite3")
    app = create_app(task_application=task_app, board_application=_board_stub(), project_root=tmp_path / "projects")

    entry = await request(app, "GET", "/model")
    assert entry.status_code == 303
    assert entry.headers["location"] == "/create/guided"
    orphan_video_link = await request(app, "GET", "/model?workspace=video")
    assert orphan_video_link.status_code == 303
    assert orphan_video_link.headers["location"] == "/create/guided"

    page = await request(app, "GET", "/model?entry=guided")
    assert page.status_code == 200
    assert "免费估算" in page.text
    assert "已完成视频预览" in page.text
    assert "WEB_API_PAID_AUTH_TOKEN" not in page.text
    assert (await request(app, "GET", "/model?project=existing-project")).status_code == 200

    estimate = await request(
        app,
        "POST",
        "/model-api/api/tasks/estimate",
        json={"prompt": "南北湖日落", "max_cost_cny": 5},
    )
    assert estimate.status_code == 200
    assert estimate.json()["estimated_cost_cny"] == 2.5
    assert [kind for kind, _ in fake.calls] == ["dry_run"]


@pytest.mark.asyncio
async def test_storyboard_video_estimate_resolves_project_relative_images(tmp_path: Path) -> None:
    """The browser's portable frame path is resolved before provider dry-run."""

    fake = FakeTool()
    project_root = tmp_path / "projects"
    project = project_root / "draft-storyboard"
    frame = project / "assets" / "frames" / "shot-01.png"
    frame.parent.mkdir(parents=True)
    frame.write_bytes(b"placeholder")
    task_app = create_task_app(fake, tmp_path / "tasks.sqlite3")
    app = create_app(task_application=task_app, board_application=_board_stub(), project_root=project_root)

    response = await request(
        app,
        "POST",
        "/model-api/workflow/video/estimate",
        json={
            "prompt": "南北湖",
            "model_variant": "mini",
            "max_cost_cny": 50,
            "storyboard_project_id": "draft-storyboard",
            "storyboard_shots": [{
                "id": "shot-01",
                "duration_seconds": 5,
                "image_path": "assets/frames/shot-01.png",
                "prompt": "湖面晨雾，镜头缓慢前推",
            }],
        },
    )

    assert response.status_code == 200
    assert response.json()["valid"] is True
    assert fake.calls[0][0] == "dry_run"
    assert fake.calls[0][1]["reference_image_path"] == str(frame)


@pytest.mark.asyncio
async def test_storyboard_video_estimate_uses_sum_of_confirmed_shot_durations(tmp_path: Path) -> None:
    """A multi-shot video estimate is one batch total, while provider calls keep per-shot timing."""

    fake = FakeTool()
    project_root = tmp_path / "projects"
    project = project_root / "draft-duration"
    frames = project / "assets" / "frames"
    frames.mkdir(parents=True)
    for name in ("shot-01.png", "shot-02.png"):
        (frames / name).write_bytes(b"placeholder")
    task_app = create_task_app(fake, tmp_path / "tasks.sqlite3")
    app = create_app(task_application=task_app, board_application=_board_stub(), project_root=project_root)

    response = await request(
        app,
        "POST",
        "/model-api/workflow/video/estimate",
        json={
            "prompt": "南北湖",
            "model_variant": "mini",
            # This value is deliberately the sum.  The server must not replace
            # it with a legacy 5-second global default in the response.
            "duration": 11,
            "storyboard_project_id": "draft-duration",
            "storyboard_total_duration_seconds": 11,
            "storyboard_shots": [
                {
                    "id": "shot-01",
                    "title": "入口",
                    "duration_seconds": 5,
                    "image_path": "assets/frames/shot-01.png",
                    "prompt": "林间入口，镜头缓慢前推",
                },
                {
                    "id": "shot-02",
                    "title": "湖面",
                    "duration_seconds": 6,
                    "image_path": "assets/frames/shot-02.png",
                    "prompt": "湖面倒影，镜头平稳横移",
                },
            ],
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["valid"] is True
    assert payload["dry_run"]["shot_count"] == 2
    assert payload["dry_run"]["total_duration_seconds"] == 11
    assert [item["duration_seconds"] for item in payload["shot_estimates"]] == [5, 6]
    assert [call[1]["duration"] for call in fake.calls if call[0] == "dry_run"] == [5, 6]


@pytest.mark.asyncio
async def test_storyboard_video_estimate_explains_missing_project_frame(tmp_path: Path) -> None:
    fake = FakeTool()
    project_root = tmp_path / "projects"
    (project_root / "draft-storyboard").mkdir(parents=True)
    task_app = create_task_app(fake, tmp_path / "tasks.sqlite3")
    app = create_app(task_application=task_app, board_application=_board_stub(), project_root=project_root)

    response = await request(
        app,
        "POST",
        "/model-api/workflow/video/estimate",
        json={
            "model_variant": "mini",
            "storyboard_project_id": "draft-storyboard",
            "storyboard_shots": [{
                "id": "shot-01",
                "duration_seconds": 5,
                "image_path": "assets/frames/not-generated.png",
                "prompt": "湖面晨雾",
            }],
        },
    )

    assert response.status_code == 422
    assert "generate storyboard images first" in response.json()["detail"]


def test_completed_task_exposes_same_origin_local_video_url(tmp_path: Path) -> None:
    project_root = tmp_path / "projects"
    project = project_root / "zhejiang-demo"
    render = project / "renders" / "clip.mp4"
    render.parent.mkdir(parents=True)
    render.write_bytes(b"video")
    (project / "project.json").write_text(json.dumps({"model_task_id": "task-1"}), encoding="utf-8")
    (project / "artifacts").mkdir()
    (project / "artifacts" / "asset_manifest.json").write_text(
        json.dumps({"assets": [{"task_id": "task-1", "path": "renders/clip.mp4"}]}),
        encoding="utf-8",
    )

    assert _local_video_url_for_task("task-1", project_root) == "/media/zhejiang-demo/renders/clip.mp4"


@pytest.mark.asyncio
async def test_model_adapter_exposes_safe_openmontage_tool_catalog(tmp_path: Path) -> None:
    """The workbench can show real registry status without leaking secrets."""

    fake = FakeTool()
    task_app = create_task_app(fake, tmp_path / "tasks.sqlite3")
    app = create_app(task_application=task_app, board_application=_board_stub(), project_root=tmp_path / "projects")

    response = await request(app, "GET", "/model-api/tools/catalog")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] in {"ready", "unavailable"}
    assert isinstance(payload.get("tools"), list)
    if payload["status"] == "ready":
        assert payload["tool_count"] == len(payload["tools"])
        assert payload["tool_count"] > 0
        assert payload["available_count"] + payload["degraded_count"] + payload["unavailable_count"] == payload["tool_count"]
        for tool in payload["tools"]:
            assert set(tool).issubset({
                "name", "capability", "provider", "runtime", "status", "best_for",
                "dependencies", "install_instructions", "operation_statuses",
                "resource_profile_note", "remotion_note", "source_provider_summary",
            })
            serialized = json.dumps(tool, ensure_ascii=False).lower()
            assert "secret_value" not in serialized
            assert "sk-test" not in serialized


@pytest.mark.asyncio
async def test_model_adapter_exposes_validated_openmontage_pipeline_catalog(tmp_path: Path) -> None:
    fake = FakeTool()
    task_app = create_task_app(fake, tmp_path / "tasks.sqlite3")
    app = create_app(task_application=task_app, board_application=_board_stub(), project_root=tmp_path / "projects")

    response = await request(app, "GET", "/model-api/pipelines/catalog")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] in {"ready", "unavailable"}
    assert isinstance(payload.get("pipelines"), list)
    if payload["status"] == "ready":
        assert payload["pipeline_count"] == len(payload["pipelines"])
        assert payload["pipeline_count"] > 0
        for pipeline in payload["pipelines"]:
            assert pipeline["stage_count"] == len(pipeline["stages"])
            assert isinstance(pipeline["reference_input"], dict)
            assert isinstance(pipeline["orchestration"], dict)
            for stage in pipeline["stages"]:
                assert {"name", "skill", "produces", "tools_available", "checkpoint_required", "human_approval_default"} <= set(stage)


@pytest.mark.asyncio
async def test_model_adapter_exposes_confirmed_stock_search_route(tmp_path: Path) -> None:
    fake = FakeTool()
    project_root = tmp_path / "projects"
    project_root.mkdir(parents=True)
    (project_root / "stock-demo").mkdir()
    task_app = create_task_app(fake, tmp_path / "tasks.sqlite3")
    app = create_app(task_application=task_app, board_application=_board_stub(), project_root=project_root)

    preview = await request(
        app,
        "POST",
        "/model-api/media/stock/search",
        json={"project_id": "stock-demo", "queries": ["南北湖"]},
    )
    assert preview.status_code == 200
    assert preview.json()["status"] == "dry_run"
    assert preview.json()["requires_confirmation"] is True

    blocked = await request(
        app,
        "POST",
        "/model-api/media/stock/search",
        json={"project_id": "stock-demo", "queries": ["南北湖"], "dry_run": False, "execute": True},
    )
    assert blocked.status_code == 400
    assert "confirm=true" in blocked.json()["detail"]


@pytest.mark.asyncio
async def test_model_adapter_exposes_local_trim_route(tmp_path: Path) -> None:
    fake = FakeTool()
    project_root = tmp_path / "projects"
    project_root.mkdir(parents=True)
    project = project_root / "trim-demo"
    project.mkdir()
    source = project / "assets" / "source.mp4"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"not-a-real-video")
    task_app = create_task_app(fake, tmp_path / "tasks.sqlite3")
    app = create_app(task_application=task_app, board_application=_board_stub(), project_root=project_root)

    response = await request(
        app,
        "POST",
        "/model-api/media/trim",
        json={"project_id": "trim-demo", "input_path": "assets/source.mp4"},
    )
    assert response.status_code == 200
    assert response.json()["status"] in {"dry_run", "invalid_request"}


@pytest.mark.asyncio
async def test_model_adapter_exposes_audio_post_routes(tmp_path: Path) -> None:
    fake = FakeTool()
    project_root = tmp_path / "projects"
    project_root.mkdir(parents=True)
    project = project_root / "audio-demo"
    project.mkdir()
    source = project / "assets" / "audio" / "narration.wav"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"not-a-real-audio")
    task_app = create_task_app(fake, tmp_path / "tasks.sqlite3")
    app = create_app(task_application=task_app, board_application=_board_stub(), project_root=project_root)

    mix = await request(
        app,
        "POST",
        "/model-api/media/audio/mix",
        json={
            "project_id": "audio-demo",
            "operation": "extract",
            "input_path": "assets/audio/narration.wav",
        },
    )
    assert mix.status_code == 200
    assert mix.json()["status"] in {"dry_run", "invalid_request"}

    enhance = await request(
        app,
        "POST",
        "/model-api/media/audio/enhance",
        json={
            "project_id": "audio-demo",
            "input_path": "assets/audio/narration.wav",
        },
    )
    assert enhance.status_code == 200
    assert enhance.json()["status"] in {"dry_run", "invalid_request"}


@pytest.mark.asyncio
async def test_model_adapter_exposes_video_postprocess_route(tmp_path: Path) -> None:
    fake = FakeTool()
    project_root = tmp_path / "projects"
    project_root.mkdir(parents=True)
    project = project_root / "video-demo"
    project.mkdir()
    source = project / "assets" / "source.mp4"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"not-a-real-video")
    task_app = create_task_app(fake, tmp_path / "tasks.sqlite3")
    app = create_app(task_application=task_app, board_application=_board_stub(), project_root=project_root)

    response = await request(
        app,
        "POST",
        "/model-api/media/video/postprocess",
        json={
            "project_id": "video-demo",
            "operation": "scene_detect",
            "input_path": "assets/source.mp4",
            "output_name": "scenes.json",
        },
    )
    assert response.status_code == 200
    assert response.json()["status"] in {"dry_run", "invalid_request"}


@pytest.mark.asyncio
async def test_new_project_has_three_mode_routes_and_mode_specific_handoff(tmp_path: Path) -> None:
    fake = FakeTool()
    task_app = create_task_app(fake, tmp_path / "tasks.sqlite3")
    app = create_app(task_application=task_app, board_application=_board_stub(), project_root=tmp_path / "projects")

    library_html = (Path(__file__).resolve().parents[2] / "backlot" / "ui" / "index.html").read_text(encoding="utf-8")
    assert "新建作品" in library_html
    assert 'id="newProjectButton"' in library_html
    assert 'id="newProjectOverlay"' not in library_html
    entry_html = (Path(__file__).resolve().parents[2] / "backlot" / "ui" / "entry.html").read_text(encoding="utf-8")
    for mode in ("guided", "material", "storyboard"):
        assert f'data-mode="{mode}"' in entry_html

    expected_titles = {
        "guided": "一句话导演",
        "material": "导入文案",
        "storyboard": "导入分镜",
    }
    for mode, title in expected_titles.items():
        page = await request(app, "GET", f"/create/{mode}")
        assert page.status_code == 200
        assert f'data-entry-mode="{mode}"' in page.text
        assert 'data-studio-page="entry"' in page.text
        assert title in page.text
        assert "/ui/entry.css?v=" in page.text
        assert "/ui/entry.js?v=" in page.text

    missing = await request(app, "GET", "/create/not-a-mode")
    assert missing.status_code == 404


@pytest.mark.asyncio
async def test_paid_flow_requires_two_steps_and_consumes_confirmation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = FakeTool()
    task_app = create_task_app(fake, tmp_path / "tasks.sqlite3")
    app = create_app(task_application=task_app, board_application=_board_stub(), project_root=tmp_path / "projects")

    prepared = await request(
        app,
        "POST",
        "/model-api/paid/prepare",
        json={"prompt": "南北湖日落", "max_cost_cny": 5},
    )
    assert prepared.status_code == 200
    confirmation_id = prepared.json()["confirmation_id"]
    assert confirmation_id
    assert [kind for kind, _ in fake.calls] == ["dry_run"]

    monkeypatch.setenv("WEB_API_PAID_AUTH_TOKEN", "test-only-token")
    submitted = await request(
        app,
        "POST",
        "/model-api/paid/submit",
        json={"confirmation_id": confirmation_id},
    )
    assert submitted.status_code == 200
    assert submitted.json()["task_id"] == "fake-model-task-001"
    assert [kind for kind, _ in fake.calls] == ["dry_run", "dry_run", "execute"]

    replay = await request(
        app,
        "POST",
        "/model-api/paid/submit",
        json={"confirmation_id": confirmation_id},
    )
    assert replay.status_code == 410
    assert [kind for kind, _ in fake.calls] == ["dry_run", "dry_run", "execute"]

    queried = await request(
        app,
        "POST",
        "/model-api/paid/query",
        json={"task_id": "fake-model-task-001"},
    )
    assert queried.status_code == 200
    assert queried.json()["task_id"] == "fake-model-task-001"

    cancelled = await request(
        app,
        "POST",
        "/model-api/paid/cancel",
        json={"task_id": "fake-model-task-001"},
    )
    assert cancelled.status_code == 200
    assert cancelled.json()["task_id"] == "fake-model-task-001"


@pytest.mark.asyncio
async def test_local_mode_generates_process_only_paid_gate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("WEB_API_PAID_AUTH_TOKEN", raising=False)
    monkeypatch.setenv("WEB_API_LOCAL_MODE", "1")
    fake = FakeTool()
    task_app = create_task_app(fake, tmp_path / "tasks.sqlite3")
    app = create_app(task_application=task_app, board_application=_board_stub(), project_root=tmp_path / "projects")

    health = await request(app, "GET", "/model-api/health")
    assert health.status_code == 200
    assert health.json()["paid_authorization_configured"] is True
    assert os.environ["WEB_API_PAID_AUTH_TOKEN"]


@pytest.mark.asyncio
async def test_workflow_quality_exposes_three_candidates_and_selected_storyboard(tmp_path: Path) -> None:
    fake = FakeTool()
    task_app = create_task_app(fake, tmp_path / "tasks.sqlite3")
    app = create_app(task_application=task_app, board_application=_board_stub(), project_root=tmp_path / "projects")

    candidates = await request(
        app, "POST", "/model-api/workflow/candidates",
        json={"prompt": "南北湖日落与山色", "mode": "quality"},
    )
    assert candidates.status_code == 200
    payload = candidates.json()
    assert len(payload["candidates"]) == 3
    assert payload["selected_candidate_id"] is None
    assert payload["research"]["status"] == "needs_sources"
    assert len({item["structure_mode"] for item in payload["candidates"]}) == 3

    selected = payload["candidates"][1]["id"]
    storyboard = await request(
        app, "POST", "/model-api/workflow/storyboard",
        json={"prompt": "南北湖日落与山色", "mode": "quality", "candidate_id": selected},
    )
    assert storyboard.status_code == 200
    assert storyboard.json()["status"] == "awaiting_human_approval"
    assert storyboard.json()["candidate_id"] == selected
    assert storyboard.json()["shots"]


@pytest.mark.asyncio
async def test_free_workflow_progress_is_saved_as_an_independent_project_draft(tmp_path: Path) -> None:
    fake = FakeTool()
    task_app = create_task_app(fake, tmp_path / "tasks.sqlite3")
    project_root = tmp_path / "projects"
    app = create_app(task_application=task_app, board_application=_board_stub(), project_root=project_root)

    saved = await request(
        app,
        "POST",
        "/model-api/workflow/draft",
        json={
            "prompt": "南北湖晨雾与山色",
            "mode": "quality",
            "stage": "candidates",
            "entry_mode": "guided",
        },
    )
    assert saved.status_code == 200
    draft = saved.json()
    assert draft["status"] == "saved"
    assert draft["project_url"] == f"/p/{draft['project_id']}"
    project_dir = project_root / draft["project_id"]
    marker = json.loads((project_dir / "project.json").read_text(encoding="utf-8"))
    assert marker["source"] == "model_workflow_draft"
    assert marker["draft"] is True
    assert marker["stage"] == "candidates"
    assert json.loads((project_dir / "artifacts" / "proposal_packet.json").read_text(encoding="utf-8"))["concept_options"]
    proposal_checkpoint = json.loads((project_dir / "checkpoint_proposal.json").read_text(encoding="utf-8"))
    assert proposal_checkpoint["status"] == "awaiting_human"

    candidates = await request(
        app,
        "POST",
        "/model-api/workflow/candidates",
        json={"prompt": "南北湖晨雾与山色", "mode": "quality"},
    )
    selected = candidates.json()["candidates"][0]["id"]
    updated = await request(
        app,
        "POST",
        "/model-api/workflow/draft",
        json={
            "prompt": "南北湖晨雾与山色",
            "mode": "quality",
            "stage": "storyboard",
            "draft_id": draft["draft_id"],
            "selected_candidate_id": selected,
        },
    )
    assert updated.status_code == 200
    assert updated.json()["project_id"] == draft["project_id"]
    assert (project_dir / "artifacts" / "script.json").is_file()
    assert (project_dir / "artifacts" / "scene_plan.json").is_file()
    scene_checkpoint = json.loads((project_dir / "checkpoint_scene_plan.json").read_text(encoding="utf-8"))
    assert scene_checkpoint["status"] == "awaiting_human"


@pytest.mark.asyncio
async def test_video_draft_persists_resume_snapshot_and_parameters(tmp_path: Path) -> None:
    """The video-parameter gate can be reopened without regenerating planning."""

    fake = FakeTool()
    task_app = create_task_app(fake, tmp_path / "tasks.sqlite3")
    project_root = tmp_path / "projects"
    app = create_app(task_application=task_app, board_application=_board_stub(), project_root=project_root)
    prompt = "南北湖晨雾与山色"

    candidates = await request(
        app,
        "POST",
        "/model-api/workflow/candidates",
        json={"prompt": prompt, "mode": "quality"},
    )
    selected = candidates.json()["candidates"][0]["id"]
    storyboard = await request(
        app,
        "POST",
        "/model-api/workflow/storyboard",
        json={"prompt": prompt, "mode": "quality", "candidate_id": selected},
    )
    assert storyboard.status_code == 200

    saved = await request(
        app,
        "POST",
        "/model-api/workflow/draft",
        json={
            "prompt": prompt,
            "mode": "quality",
            "stage": "video",
            "draft_id": "video-resume-demo",
            "selected_candidate_id": selected,
            "storyboard": storyboard.json(),
            "storyboard_approved": True,
            "storyboard_images_complete": True,
            "image_generation_receipt": {
                "job_id": "image-job-1",
                "status": "completed",
                "completed_shots": len(storyboard.json()["shots"]),
                "total_shots": len(storyboard.json()["shots"]),
            },
            "video_parameters": {
                "model_variant": "seedance-2.0-mini",
                "operation": "image_to_video",
                "duration": 26,
                "resolution": "720p",
                "aspect_ratio": "9:16",
                "max_cost_cny": 50,
            },
        },
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["resume_phase"] == "video_parameters"

    snapshot = json.loads(
        (project_root / "video-resume-demo" / "artifacts" / "workflow_state.json").read_text(encoding="utf-8")
    )
    assert snapshot["phase"] == "video_parameters"
    assert snapshot["selected_candidate_id"] == selected
    assert snapshot["storyboard_approved"] is True
    assert snapshot["storyboard_images_complete"] is True
    assert snapshot["video_parameters"]["duration"] == 26
    assert snapshot["image_generation_receipt"]["status"] == "completed"


@pytest.mark.asyncio
async def test_storyboard_repair_updates_one_shot_and_can_be_persisted(tmp_path: Path) -> None:
    fake = FakeTool()
    task_app = create_task_app(fake, tmp_path / "tasks.sqlite3")
    project_root = tmp_path / "projects"
    app = create_app(task_application=task_app, board_application=_board_stub(), project_root=project_root)
    prompt = "南北湖晨雾与山色"
    candidates = await request(
        app,
        "POST",
        "/model-api/workflow/candidates",
        json={"prompt": prompt, "mode": "quality"},
    )
    candidate = candidates.json()["candidates"][0]
    storyboard_response = await request(
        app,
        "POST",
        "/model-api/workflow/storyboard",
        json={"prompt": prompt, "mode": "quality", "candidate_id": candidate["id"]},
    )
    storyboard = storyboard_response.json()
    target_id = storyboard["shots"][1]["id"]
    original_other_prompt = storyboard["shots"][0]["visual_prompt"]
    note = "人物缩小为画面高度三分之一，突出湖面纹理，尾帧向右衔接。"
    repaired = await request(
        app,
        "POST",
        "/model-api/workflow/storyboard/repair",
        json={
            "prompt": prompt,
            "mode": "quality",
            "candidate_id": candidate["id"],
            "shot_id": target_id,
            "instructions": note,
            "draft_id": "repair-demo",
            "storyboard": storyboard,
        },
    )
    assert repaired.status_code == 200
    repaired_board = repaired.json()["storyboard"]
    repaired_target = next(item for item in repaired_board["shots"] if item["id"] == target_id)
    assert repaired_target["revision"] == 1
    assert note in repaired_target["visual_prompt"]
    assert note in repaired_target["motion_prompt"]
    assert repaired_board["shots"][0]["visual_prompt"] == original_other_prompt

    saved = await request(
        app,
        "POST",
        "/model-api/workflow/draft",
        json={
            "prompt": prompt,
            "mode": "quality",
            "stage": "storyboard",
            "draft_id": "repair-demo",
            "selected_candidate_id": candidate["id"],
            "storyboard": repaired_board,
        },
    )
    assert saved.status_code == 200
    scene_plan = json.loads((project_root / "repair-demo" / "artifacts" / "scene_plan.json").read_text(encoding="utf-8"))
    target_scene = next(item for item in scene_plan["scenes"] if item["id"] == target_id)
    assert note in target_scene["description"]


@pytest.mark.asyncio
async def test_storyboard_image_background_job_is_durable_and_idempotent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A refresh-safe image batch is accepted before provider work starts."""

    monkeypatch.setenv("WEB_API_LOCAL_MODE", "1")
    monkeypatch.setenv("WEB_API_PAID_AUTH_TOKEN", "test-image-token")
    fake_video = FakeTool()
    fake_images = FakeImageSelector()
    project_root = tmp_path / "projects"
    project = project_root / "image-demo"
    project.mkdir(parents=True)
    task_app = create_task_app(fake_video, tmp_path / "tasks.sqlite3")
    app = create_app(
        task_application=task_app,
        board_application=_board_stub(),
        project_root=project_root,
        image_selector=fake_images,
    )
    payload = {
        "project_id": "image-demo",
        "shots": [
            {"id": "shot-1", "prompt": "南北湖晨雾与山色"},
            {"id": "shot-2", "prompt": "南北湖湖面倒影"},
        ],
        "dry_run": False,
        "execute": True,
        "confirm": True,
        "background": True,
    }

    accepted = await request(app, "POST", "/model-api/workflow/storyboard/images", json=payload)
    assert accepted.status_code == 200
    first = accepted.json()
    assert first["status"] in {"accepted", "running", "completed"}
    assert first["job_id"]
    assert (project / "artifacts" / "storyboard_image_job.json").is_file()

    final: dict[str, Any] = first
    for _ in range(200):
        status = await request(app, "GET", "/model-api/workflow/storyboard/images/status/image-demo")
        assert status.status_code == 200
        final = status.json()
        if final.get("status") in {"completed", "failed", "stalled"}:
            break
        await asyncio.sleep(0.01)
    assert final["status"] == "completed", final
    assert final["completed_shots"] == 2
    assert len(final["result"]["images"]) == 2
    assert len(final["images_written"]) == 2
    assert final["completed_shot_ids"] == ["shot-1", "shot-2"]
    assert all((project / path).is_file() for path in ("assets/frames/shot-1.png", "assets/frames/shot-2.png"))
    assert len([call for call in fake_images.calls if call.get("operation") == "generate"]) == 2

    duplicate = await request(app, "POST", "/model-api/workflow/storyboard/images", json=payload)
    assert duplicate.status_code == 200
    assert duplicate.json()["status"] == "completed"
    assert duplicate.json()["job_id"] == first["job_id"]
    assert len([call for call in fake_images.calls if call.get("operation") == "generate"]) == 2


def test_storyboard_image_terminal_state_cannot_be_reopened(tmp_path: Path) -> None:
    """A late watchdog heartbeat cannot overwrite a worker failure."""

    from backlot import model_adapter as adapter

    project = tmp_path / "terminal-job"
    (project / "artifacts").mkdir(parents=True)
    adapter._storyboard_image_job_update(
        project,
        status="failed",
        state="failed",
        error="provider transport failed",
    )

    late = adapter._storyboard_image_job_update(
        project,
        status="stalled",
        state="stalled",
        message="late watchdog update",
    )

    assert late["status"] == "failed"
    assert adapter._read_storyboard_image_job(project)["status"] == "failed"


def test_storyboard_image_snapshot_repairs_raced_stalled_failure(tmp_path: Path) -> None:
    """A historical raced receipt is normalized to its persisted failure."""

    from backlot import model_adapter as adapter

    project = tmp_path / "raced-job"
    (project / "artifacts").mkdir(parents=True)
    adapter._write_json(
        project / "artifacts" / "storyboard_image_job.json",
        {
            "status": "stalled",
            "state": "stalled",
            "total_shots": 5,
            "shot_ids": [],
            "shot_outputs": [],
            "result": {"status": "failed", "error": "TLS EOF"},
        },
    )

    snapshot = adapter._storyboard_image_job_snapshot(project, mutate_stall=True)

    assert snapshot["status"] == "failed"
    assert snapshot["state"] == "failed"
    assert snapshot["error"] == "TLS EOF"


def test_batch_production_snapshot_keeps_confirmed_frames_portable(tmp_path: Path) -> None:
    """A paid storyboard run owns a copy of the stills it submitted."""

    from backlot import model_adapter as adapter

    source_project = tmp_path / "projects" / "draft-source"
    source_frame = source_project / "assets" / "frames" / "shot-1.png"
    source_frame.parent.mkdir(parents=True)
    source_frame.write_bytes(b"fake-png")
    generation = adapter.GenerationRequest(
        prompt="南北湖晨雾",
        model_variant="mini",
        operation="image_to_video",
        duration=5,
        aspect_ratio="9:16",
        resolution="480p",
        max_cost_cny=5,
        generate_audio=False,
        watermark=False,
    )
    response = TaskResponse(task_id="batch-shot-1", status="submitted", provider="fake", model="fake-mini")
    project = adapter._create_backlot_project_batch(
        requests=[generation],
        responses=[response],
        batch_id="batch-portable-1",
        workflow_mode="quality",
        candidate_id="candidate-1",
        storyboard_shots=[{
            "id": "shot-1",
            "title": "湖面",
            "duration_seconds": 5,
            "image_path": str(source_frame),
            "first_frame_path": str(source_frame),
            "last_frame_path": str(source_frame),
            "visual_prompt": "晨雾湖面",
            "motion_prompt": "缓慢推进",
            "prompt": "晨雾湖面；缓慢推进",
        }],
        source_draft_id="draft-source",
        project_root=tmp_path / "projects",
    )

    snapshot = json.loads((project / "artifacts" / "workflow_state.json").read_text(encoding="utf-8"))
    assert snapshot["project_kind"] == "production"
    assert snapshot["resume_phase"] == "provider_running"
    assert snapshot["active_batch"]["batch_id"] == "batch-portable-1"
    stored = snapshot["storyboard"]["shots"][0]["image_path"]
    assert stored.startswith("assets/frames/")
    assert (project / stored).is_file()
    scene_plan = json.loads((project / "artifacts" / "scene_plan.json").read_text(encoding="utf-8"))
    assert scene_plan["scenes"][0]["storyboard_image"] == stored


@pytest.mark.asyncio
async def test_workflow_speed_selects_highest_score_and_paid_submit_creates_project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeTool()
    task_app = create_task_app(fake, tmp_path / "tasks.sqlite3")
    app = create_app(task_application=task_app, board_application=_board_stub(), project_root=tmp_path / "projects")

    candidates = await request(
        app, "POST", "/model-api/workflow/candidates",
        json={"prompt": "嘉兴南湖晨雾", "mode": "speed"},
    )
    payload = candidates.json()
    winner = payload["selected_candidate_id"]
    assert candidates.status_code == 200
    assert winner in {item["id"] for item in payload["candidates"]}
    winner_score = next(item["scorecard"]["official"]["weighted_total"] for item in payload["candidates"] if item["id"] == winner)
    assert winner_score == max(item["scorecard"]["official"]["weighted_total"] for item in payload["candidates"])

    prepared = await request(
        app, "POST", "/model-api/paid/prepare",
        json={"prompt": "嘉兴南湖晨雾", "max_cost_cny": 5, "workflow_mode": "speed", "workflow_candidate_id": winner},
    )
    assert prepared.status_code == 200
    monkeypatch.setenv("WEB_API_PAID_AUTH_TOKEN", "test-only-token")
    submitted = await request(app, "POST", "/model-api/paid/submit", json={"confirmation_id": prepared.json()["confirmation_id"]})
    assert submitted.status_code == 200
    project_id = submitted.json()["data"]["backlot_project_id"]
    project_dir = tmp_path / "projects" / project_id
    assert (project_dir / "project.json").is_file()
    project_marker = json.loads((project_dir / "project.json").read_text(encoding="utf-8"))
    assert project_marker["model_task_id"] == "fake-model-task-001"
    assert project_marker["selected_candidate_id"] == winner
    research = json.loads((project_dir / "artifacts" / "research_brief.json").read_text(encoding="utf-8"))
    assert research["status"] == "needs_fact_check"
    assert len(research["checks"]) == 3
    assert (project_dir / "artifacts" / "proposal_packet.json").is_file()
    proposal = json.loads((project_dir / "artifacts" / "proposal_packet.json").read_text(encoding="utf-8"))
    assert len(proposal["concept_options"]) == 3
    assert proposal["selected_concept"]["concept_id"] == winner
    assert (project_dir / "artifacts" / "script.json").is_file()
    assert (project_dir / "artifacts" / "scene_plan.json").is_file()
    workflow_state = json.loads((project_dir / "artifacts" / "workflow_state.json").read_text(encoding="utf-8"))
    assert workflow_state["project_kind"] == "production"
    assert workflow_state["workflow_mode"] == "speed"
    assert workflow_state["resume_phase"] == "provider_running"
    assert workflow_state["active_task"]["task_id"] == "fake-model-task-001"
    assert (project_dir / "events.jsonl").is_file()


def _delivery_project(tmp_path: Path, *, valid_clip: bool) -> tuple[Path, str]:
    """Create a local-only batch project for delivery-gate tests."""

    project = tmp_path / "projects" / "delivery-demo"
    (project / "artifacts").mkdir(parents=True)
    (project / "renders").mkdir()
    task_id = "delivery-task-1"
    clip = project / "renders" / f"{task_id}.mp4"
    if valid_clip:
        assert shutil.which("ffmpeg"), "ffmpeg is required for this local media test"
        subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-f", "lavfi", "-i", "color=c=blue:s=320x240:d=1",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", str(clip),
            ],
            check=True,
        )
    else:
        clip.write_bytes(b"not-a-video")
    manifest = {
        "version": "1.0",
        "assets": [{
            "id": "shot-1",
            "type": "video",
            "scene_id": "shot-1",
            "path": f"renders/{task_id}.mp4",
            "task_id": task_id,
            "duration_seconds": 1,
            "status": "submitted",
        }],
        "task_ids": [task_id],
        "batch_id": "batch-delivery-demo",
        "total_duration_seconds": 1,
    }
    (project / "artifacts" / "asset_manifest.json").write_text(
        json.dumps(manifest), encoding="utf-8"
    )
    # This fixture represents an edit decision that has already passed the
    # creator-review gate.  A missing decision is covered separately by the
    # preview/pending test below.
    edit_decisions = {
        "version": "1.0",
        "render_runtime": "ffmpeg",
        "renderer_family": "cinematic-trailer",
        "cuts": [{
            "id": "shot-1",
            "source": f"renders/{task_id}.mp4",
            "in_seconds": 0,
            "out_seconds": 1,
            "layer": "primary",
            "transition_in": "cut",
            "transition_out": "cut",
        }],
        "metadata": {
            "proposal_render_runtime": "ffmpeg",
            "creator_reviewed": True,
        },
    }
    validate_artifact("edit_decisions", edit_decisions)
    (project / "artifacts" / "edit_decisions.json").write_text(
        json.dumps(edit_decisions), encoding="utf-8"
    )
    (project / "project.json").write_text(
        json.dumps({
            "project_id": project.name,
            "model_task_ids": [task_id],
            "batch_id": "batch-delivery-demo",
            "stage": "assets",
        }),
        encoding="utf-8",
    )
    return project, task_id


def test_batch_delivery_gate_does_not_fake_success_on_compose_failure(tmp_path: Path) -> None:
    from backlot import model_adapter as adapter

    project, task_id = _delivery_project(tmp_path, valid_clip=False)
    adapter._update_backlot_project_batch_task(
        TaskResponse(task_id=task_id, status="succeeded"), project
    )

    assert not (project / "artifacts" / "render_report.json").exists()
    assert not (project / "artifacts" / "final_review.json").exists()
    assert not (project / "artifacts" / "publish_log.json").exists()
    assert json.loads((project / "checkpoint_edit.json").read_text())["status"] == "completed"
    assert json.loads((project / "checkpoint_compose.json").read_text())["status"] == "failed"
    assert json.loads((project / "checkpoint_publish.json").read_text())["status"] == "pending_review"


def test_missing_edit_decisions_stays_preview_pending(tmp_path: Path) -> None:
    from backlot import model_adapter as adapter

    project, task_id = _delivery_project(tmp_path, valid_clip=True)
    (project / "artifacts" / "edit_decisions.json").unlink()

    adapter._update_backlot_project_batch_task(
        TaskResponse(task_id=task_id, status="succeeded"), project
    )

    edit = json.loads((project / "artifacts" / "edit_decisions.json").read_text())
    validate_artifact("edit_decisions", edit)
    assert edit["metadata"]["system_generated_preview"] is True
    assert edit["metadata"]["needs_creator_review"] is True
    assert json.loads((project / "checkpoint_edit.json").read_text())["status"] == "pending"
    assert json.loads((project / "checkpoint_compose.json").read_text())["status"] == "pending"
    assert json.loads((project / "checkpoint_publish.json").read_text())["status"] == "pending_review"
    assert not (project / "artifacts" / "render_report.json").exists()
    assert not (project / "artifacts" / "final_review.json").exists()


def test_batch_delivery_writes_schema_valid_reports_only_after_local_qa(tmp_path: Path) -> None:
    from backlot import model_adapter as adapter

    project, task_id = _delivery_project(tmp_path, valid_clip=True)
    adapter._update_backlot_project_batch_task(
        TaskResponse(task_id=task_id, status="succeeded"), project
    )

    edit = json.loads((project / "artifacts" / "edit_decisions.json").read_text())
    report = json.loads((project / "artifacts" / "render_report.json").read_text())
    review = json.loads((project / "artifacts" / "final_review.json").read_text())
    publish = json.loads((project / "artifacts" / "publish_log.json").read_text())
    validate_artifact("edit_decisions", edit)
    validate_artifact("render_report", report)
    validate_artifact("final_review", review)
    validate_artifact("publish_log", publish)
    assert report["outputs"][0]["path"] == "renders/storyboard-final.mp4"
    assert review["status"] == "pass"
    assert publish["entries"][0]["status"] == "pending_review"
    assert json.loads((project / "checkpoint_compose.json").read_text())["status"] == "completed"
    assert json.loads((project / "checkpoint_publish.json").read_text())["status"] == "pending_review"
    assert json.loads((project / "project.json").read_text())["stage"] == "publish"


def test_batch_delivery_repeated_success_poll_is_idempotent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from backlot import model_adapter as adapter
    from tools.video.video_compose import VideoCompose

    project, task_id = _delivery_project(tmp_path, valid_clip=True)
    compose_calls = 0
    quality_calls = 0
    review_calls = 0
    real_compose = adapter.compose_media
    real_quality = adapter.quality_check
    real_review = VideoCompose._run_final_review

    def counted_compose(*args: Any, **kwargs: Any) -> dict[str, Any]:
        nonlocal compose_calls
        compose_calls += 1
        return real_compose(*args, **kwargs)

    def counted_quality(*args: Any, **kwargs: Any) -> dict[str, Any]:
        nonlocal quality_calls
        quality_calls += 1
        return real_quality(*args, **kwargs)

    def counted_review(self: VideoCompose, *args: Any, **kwargs: Any) -> dict[str, Any]:
        nonlocal review_calls
        review_calls += 1
        return real_review(self, *args, **kwargs)

    monkeypatch.setattr(adapter, "compose_media", counted_compose)
    monkeypatch.setattr(adapter, "quality_check", counted_quality)
    monkeypatch.setattr(VideoCompose, "_run_final_review", counted_review)
    response = TaskResponse(task_id=task_id, status="succeeded")
    adapter._update_backlot_project_batch_task(response, project)
    adapter._update_backlot_project_batch_task(response, project)

    assert (compose_calls, quality_calls, review_calls) == (1, 1, 1)
    assert json.loads((project / "checkpoint_publish.json").read_text())["status"] == "pending_review"
