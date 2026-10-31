"""Server/API tests for Backlot.

These cover the deterministic eval surface in internal/evals/BACKLOT_EVAL_PLAN.md:
API shape, path safety, media/thumb serving, range requests, and loose
performance budgets.
"""

from __future__ import annotations

import io
import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backlot import server as server_mod
from backlot import state as state_mod


@pytest.fixture
def projects_root(tmp_path, monkeypatch):
    root = tmp_path / "projects"
    root.mkdir()
    monkeypatch.setattr(state_mod, "PROJECTS_DIR", root)
    monkeypatch.setattr(server_mod, "PROJECTS_DIR", root)
    monkeypatch.setattr(server_mod, "_summary_cache", {})
    monkeypatch.setattr(server_mod, "_PROJECTS_ROOT_STR", __import__("os").path.normcase(str(root.resolve())))
    monkeypatch.setattr(server_mod, "THUMB_CACHE_DIR", tmp_path / "thumbs")
    return root


@pytest.fixture
def client(projects_root, monkeypatch):
    async def no_watch():
        return None

    monkeypatch.setattr(server_mod, "_watch_projects", no_watch)
    with TestClient(server_mod.create_app()) as c:
        yield c


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")


def _make_project(root: Path, project_id: str = "film") -> Path:
    project = root / project_id
    (project / "artifacts").mkdir(parents=True)
    (project / "assets" / "images").mkdir(parents=True)
    (project / "assets" / "video").mkdir(parents=True)
    (project / "renders").mkdir(parents=True)
    _write_json(
        project / "project.json",
        {
            "project_id": project_id,
            "title": "Film",
            "pipeline_type": "cinematic",
            "created_at": "2026-07-02T00:00:00Z",
        },
    )
    _write_json(
        project / "checkpoint_script.json",
        {
            "version": "1.0",
            "project_id": project_id,
            "pipeline_type": "cinematic",
            "stage": "script",
            "status": "awaiting_human",
            "timestamp": "2026-07-02T00:01:00Z",
            "artifacts": {},
        },
    )
    return project


def _write_png(path: Path, color: tuple[int, int, int] = (200, 40, 80)) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img = Image.new("RGB", (24, 16), color)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    path.write_bytes(buf.getvalue())


class TestBacklotServerApi:
    def test_health(self, client):
        response = client.get("/api/health")
        assert response.status_code == 200
        assert response.json() == {"ok": True, "app": "backlot"}

    def test_projects_shape_and_state(self, client, projects_root):
        _make_project(projects_root, "film")

        projects = client.get("/api/projects")
        assert projects.status_code == 200
        body = projects.json()
        assert len(body) == 1
        assert body[0]["project_id"] == "film"
        assert body[0]["awaiting_human"] is True
        assert "stage_states" in body[0]

        state = client.get("/api/project/film/state")
        assert state.status_code == 200
        state_body = state.json()
        assert state_body["project_id"] == "film"
        assert state_body["title"] == "Film"
        assert state_body["stages"]

    def test_resume_prefers_workflow_artifact_and_returns_active_handles(self, client, projects_root):
        project = _make_project(projects_root, "resume-api")
        _write_json(project / "project.json", {
            "project_id": "resume-api",
            "title": "Resume API",
            "pipeline_type": "cinematic",
            "source": "model_workflow_storyboard_batch",
            "workflow_mode": "speed",
            "model_task_id": "legacy-task",
            "batch_id": "legacy-batch",
        })
        workflow_state = {
            "version": "2.0",
            "project_kind": "production",
            "workflow_mode": "quality",
            "resume_phase": "video",
            "resume_url": "/model?project=resume-api",
            "active_task": {"task_id": "task-1", "status": "running"},
            "active_batch": {"batch_id": "batch-1", "task_ids": ["task-1", "task-2"]},
        }
        _write_json(project / "artifacts" / "workflow_state.json", workflow_state)

        response = client.get("/api/project/resume-api/resume")
        assert response.status_code == 200
        body = response.json()
        assert body["workflow_state"] == workflow_state
        assert body["project_kind"] == "production"
        assert body["workflow_mode"] == "quality"
        assert body["resume_phase"] == "video"
        assert body["resume_url"] == "/model?project=resume-api"
        assert body["board_url"] == "/p/resume-api"
        assert body["active_task"]["task_id"] == "task-1"
        assert body["active_batch"]["batch_id"] == "batch-1"
        assert body["task_id"] == "task-1"
        assert body["batch_id"] == "batch-1"
        assert body["task_ids"] == ["task-1", "task-2"]
        assert body["state"]["artifacts"]["workflow_state"] == workflow_state
        assert body["legacy_degraded"] is False
        assert body["missing_fields"] == []

    def test_resume_legacy_project_is_explicitly_degraded(self, client, projects_root):
        _make_project(projects_root, "legacy-resume")
        response = client.get("/api/project/legacy-resume/resume")
        assert response.status_code == 200
        body = response.json()
        assert body["legacy_degraded"] is True
        assert body["missing_fields"] == ["workflow_state"]
        assert body["workflow_state"]["source"] == "checkpoint_inference"
        assert body["board_url"] == "/p/legacy-resume"
        assert body["resume_url"] == "/p/legacy-resume?stage=script"

    def test_replay_timeline_is_chronological_across_timezone_offsets(self, client, projects_root):
        project = _make_project(projects_root, "replay-timezone")
        # The second instant is later in UTC even though its local clock uses
        # a different offset.  Lexicographic sorting (the old bug) could put
        # these in the wrong order and make scrubbed transitions jump.
        _write_json(project / "checkpoint_script.json", {
            "stage": "script", "status": "completed",
            "timestamp": "2026-07-02T03:00:00+02:00", "artifacts": {},
        })
        _write_json(project / "history" / "checkpoint_script_1.json", {
            "stage": "script", "status": "awaiting_human",
            "timestamp": "2026-07-02T00:30:00Z", "artifacts": {},
        })
        replay = client.get("/api/project/replay-timezone/replay")
        assert replay.status_code == 200
        points = replay.json()["timeline"]
        assert [p["status"] for p in points if p["stage"] == "script"] == ["awaiting_human", "completed"]

    def test_replay_drops_invalid_times_and_merges_duplicate_instants(self, client, projects_root):
        project = _make_project(projects_root, "replay-duplicates")
        timestamp = "2026-07-02T00:00:00Z"
        _write_json(project / "checkpoint_script.json", {
            "stage": "script", "status": "completed",
            "timestamp": timestamp, "artifacts": {},
        })
        _write_json(project / "history" / "checkpoint_script_1.json", {
            "stage": "script", "status": "awaiting_human",
            "timestamp": timestamp, "artifacts": {},
        })
        (project / "events.jsonl").write_text(
            json.dumps({"ts": "not-a-time", "event": "noise"}) + "\n",
            encoding="utf-8",
        )

        body = client.get("/api/project/replay-duplicates/replay").json()
        assert body["can_replay"] is False
        assert body["current_total"] == 1
        assert body["total_frames"] == 1
        assert len(body["semantic_frames"]) == 1
        assert body["semantic_frames"][0]["point_count"] == 2
        assert body["invalid_count"] == 1

    def test_replay_coalesces_checkpoint_bursts_and_reports_real_changes(self):
        base = datetime(2026, 7, 2, tzinfo=timezone.utc)
        points = [
            (base, {"kind": "stage", "stage": "research", "status": "needs_sources"}, base.isoformat()),
            (base + timedelta(milliseconds=8), {"kind": "stage", "stage": "proposal", "status": "awaiting_human"}, (base + timedelta(milliseconds=8)).isoformat()),
            (base + timedelta(milliseconds=16), {"kind": "stage", "stage": "script", "status": "pending"}, (base + timedelta(milliseconds=16)).isoformat()),
            # A second save a few seconds later is a distinct semantic node.
            (base + timedelta(seconds=3), {"kind": "stage", "stage": "proposal", "status": "completed"}, (base + timedelta(seconds=3)).isoformat()),
        ]

        frames = server_mod._semantic_replay_frames(points)

        assert len(frames) == 2
        assert frames[0]["point_count"] == 3
        assert frames[0]["stage_snapshot"][-1] == {"stage": "script", "status": "pending"}
        assert any("proposal: awaiting_human → completed" in change for change in frames[1]["changes"])
        assert frames[0]["label"] == "proposal · awaiting_human"

    @pytest.mark.parametrize(
        ("url", "status"),
        [
            ("/api/project/../state", 404),
            ("/api/project/C:/state", 400),
            ("/api/project/nope/state", 404),
        ],
    )
    def test_project_id_rejects_bad_or_unknown_ids(self, client, url, status):
        response = client.get(url)
        assert response.status_code == status

    def test_media_rejects_path_traversal(self, client, projects_root):
        _make_project(projects_root, "film")
        response = client.get("/media/film/%2E%2E/project.json")
        assert response.status_code == 403

    def test_media_serves_range_requests(self, client, projects_root):
        project = _make_project(projects_root, "film")
        media = project / "renders" / "final.mp4"
        media.write_bytes(b"0123456789")

        response = client.get("/media/film/renders/final.mp4", headers={"Range": "bytes=2-5"})

        assert response.status_code == 206
        assert response.content == b"2345"
        assert response.headers["content-range"].startswith("bytes 2-5/10")

    def test_thumb_downscales_image_and_passes_through_non_media(self, client, projects_root):
        project = _make_project(projects_root, "film")
        _write_png(project / "assets" / "images" / "sc1.png")
        text = project / "artifacts" / "note.txt"
        text.write_text("hello", encoding="utf-8")

        image = client.get("/thumb/film/assets/images/sc1.png?w=320")
        assert image.status_code == 200
        assert image.headers["content-type"] == "image/jpeg"
        assert image.content.startswith(b"\xff\xd8")

        passthrough = client.get("/thumb/film/artifacts/note.txt")
        assert passthrough.status_code == 200
        assert passthrough.content == b"hello"


class TestBacklotPerformanceBudgets:
    def test_projects_and_state_stay_within_loose_budgets(self, client, projects_root):
        for i in range(25):
            project = _make_project(projects_root, f"film-{i:02d}")
            _write_json(
                project / "artifacts" / "scene_plan.json",
                {"version": "1.0", "scenes": [{"id": "sc1", "start_seconds": 0, "end_seconds": 1}]},
            )

        t0 = time.perf_counter()
        cold = client.get("/api/projects")
        cold_s = time.perf_counter() - t0
        assert cold.status_code == 200
        assert cold_s < 2.0

        t1 = time.perf_counter()
        warm = client.get("/api/projects")
        warm_s = time.perf_counter() - t1
        assert warm.status_code == 200
        assert warm_s < 0.150

        t2 = time.perf_counter()
        state = client.get("/api/project/film-00/state")
        state_s = time.perf_counter() - t2
        assert state.status_code == 200
        assert state_s < 0.400

    def test_image_thumb_generation_stays_within_budget(self, client, projects_root):
        project = _make_project(projects_root, "film")
        _write_png(project / "assets" / "images" / "sc1.png")

        t0 = time.perf_counter()
        response = client.get("/thumb/film/assets/images/sc1.png?w=640")
        elapsed = time.perf_counter() - t0

        assert response.status_code == 200
        assert elapsed < 1.5


class TestFindingsFixes:
    """Regression tests for dogfood findings F-03 (thumb video fallback)."""

    def test_thumb_never_serves_raw_video_bytes(self, client, projects_root):
        p = _make_project(projects_root, "vid")
        fake_video = p / "renders" / "final.mp4"
        fake_video.parent.mkdir(parents=True, exist_ok=True)
        # Not a real video: ffmpeg poster extraction will fail.
        fake_video.write_bytes(b"\x00" * 4096)
        res = client.get("/thumb/vid/renders/final.mp4")
        assert res.status_code == 404  # never the raw video bytes (F-03)
