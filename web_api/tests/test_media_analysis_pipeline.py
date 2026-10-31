from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from backlot.model_adapter import create_app as create_model_app
from backlot.state import load_board_state
from tools.base_tool import ToolResult, ToolStatus
from web_api.app import create_app as create_task_app
from web_api.media_pipeline import create_media_app


async def request(app: FastAPI, method: str, path: str, **kwargs: Any) -> httpx.Response:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.request(method, path, **kwargs)


class FakeFrameSampler:
    name = "fake_frame_sampler"
    provider = "fake-ffmpeg"
    dependencies = ["test:ffmpeg"]
    install_instructions = "test frame sampler"
    capabilities = ["extract_frames_count"]

    def __init__(self, *, available: bool = True) -> None:
        self.available = available
        self.calls: list[dict[str, Any]] = []

    def get_status(self) -> ToolStatus:
        return ToolStatus.AVAILABLE if self.available else ToolStatus.UNAVAILABLE

    def get_info(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "provider": self.provider,
            "status": self.get_status().value,
            "dependencies": self.dependencies,
            "install_instructions": self.install_instructions,
            "capabilities": self.capabilities,
            "runtime": "local",
        }

    def execute(self, inputs: dict[str, Any]) -> ToolResult:
        self.calls.append(dict(inputs))
        if not self.available:
            return ToolResult(success=False, error="test frame sampler unavailable")
        output_dir = Path(inputs["output_dir"])
        output_dir.mkdir(parents=True, exist_ok=True)
        frames = []
        for index, timestamp in enumerate((0.0, 1.5), start=1):
            output = output_dir / f"frame_{index:04d}.jpg"
            output.write_bytes(b"fake-jpeg-" + bytes([index]))
            frames.append({"path": str(output), "index": index - 1, "timestamp_seconds": timestamp})
        return ToolResult(success=True, data={"strategy": inputs["strategy"], "frame_count": len(frames), "frames": frames})


class FakeFaceTracker:
    name = "fake_face_tracker"
    provider = "fake-mediapipe"
    dependencies = ["test:opencv"]
    install_instructions = "test face tracker"
    capabilities = ["face_tracking"]

    def __init__(self, *, status: ToolStatus = ToolStatus.AVAILABLE) -> None:
        self.status = status
        self.calls: list[dict[str, Any]] = []

    def get_status(self) -> ToolStatus:
        return self.status

    def get_info(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "provider": self.provider,
            "status": self.status.value,
            "dependencies": self.dependencies,
            "install_instructions": self.install_instructions,
            "capabilities": self.capabilities,
            "runtime": "local",
        }

    def execute(self, inputs: dict[str, Any]) -> ToolResult:
        self.calls.append(dict(inputs))
        output = Path(inputs["output_path"])
        output.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "video_width": 1280,
            "video_height": 720,
            "fps": 24,
            "duration_seconds": 2.0,
            "frame_count": 10,
            "face_detected_count": 1,
            "faces": [{"frame_index": 1, "timestamp_seconds": 0.04, "bbox": {"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.4}}],
        }
        output.write_text(json.dumps(payload), encoding="utf-8")
        return ToolResult(success=True, data={"output": str(output), "frames_sampled": 10, "faces_detected": 1, "method": "fake"}, artifacts=[str(output)])


def make_project(root: Path, name: str = "analysis-demo") -> Path:
    project = root / name
    (project / "assets").mkdir(parents=True)
    (project / "assets" / "source.mp4").write_bytes(b"test-video")
    return project


def board_stub() -> FastAPI:
    app = FastAPI()

    @app.get("/")
    async def root() -> dict[str, bool]:
        return {"board": True}

    return app


@pytest.mark.asyncio
async def test_frame_sampling_dry_run_then_confirmed_execute_writes_hashed_artifacts(tmp_path: Path) -> None:
    sampler = FakeFrameSampler()
    app = create_media_app(project_root=tmp_path, frame_sampler=sampler)
    project = make_project(tmp_path)
    body = {"project_id": project.name, "media_path": "assets/source.mp4", "strategy": "count", "count": 2}

    preview = await request(app, "POST", "/api/media/frames/sample", json=body)
    assert preview.status_code == 200
    assert preview.json()["status"] == "dry_run"
    assert preview.json()["tool"]["status"] == "available"
    assert sampler.calls == []
    assert not (project / "analysis").exists()

    missing_confirmation = await request(app, "POST", "/api/media/frames/sample", json={**body, "dry_run": False, "execute": True})
    assert missing_confirmation.status_code == 400
    assert sampler.calls == []

    completed = await request(
        app,
        "POST",
        "/api/media/frames/sample",
        json={**body, "dry_run": False, "execute": True, "confirm": True},
    )
    assert completed.status_code == 200
    payload = completed.json()
    assert payload["status"] == "completed"
    assert payload["frame_count"] == 2
    assert len(sampler.calls) == 1
    assert all((project / frame["path"]).is_file() for frame in payload["frames"])
    for frame in payload["frames"]:
        assert frame["sha256"] == hashlib.sha256((project / frame["path"]).read_bytes()).hexdigest()
    manifest = project / "artifacts" / "frame_sampling_manifest.json"
    checkpoint = project / "checkpoint_frame_sampling.json"
    assert manifest.is_file() and checkpoint.is_file()
    manifest_payload = json.loads(manifest.read_text(encoding="utf-8"))
    assert manifest_payload["frames"][0]["sha256"] == payload["frames"][0]["sha256"]
    events = [json.loads(line) for line in (project / "events.jsonl").read_text(encoding="utf-8").splitlines()]
    assert any(event.get("event") == "frame_sampling" and event.get("status") == "completed" for event in events)

    state = load_board_state(project)
    assert state["media"]["analysis"]["frames"]


@pytest.mark.asyncio
async def test_face_tracking_degraded_status_is_explicit_and_report_is_previewable(tmp_path: Path) -> None:
    tracker = FakeFaceTracker(status=ToolStatus.DEGRADED)
    app = create_media_app(project_root=tmp_path, face_tracker=tracker)
    project = make_project(tmp_path, "face-demo")
    body = {"project_id": project.name, "media_path": "assets/source.mp4"}

    preview = await request(app, "POST", "/api/media/faces/track", json=body)
    assert preview.status_code == 200
    assert preview.json()["status"] == "dry_run"
    assert preview.json()["tool"]["status"] == "degraded"
    assert preview.json()["would_execute"] is True

    completed = await request(
        app,
        "POST",
        "/api/media/faces/track",
        json={**body, "dry_run": False, "execute": True, "confirm": True},
    )
    assert completed.status_code == 200
    payload = completed.json()
    assert payload["status"] == "completed"
    report_path = project / payload["report"]["path"]
    assert report_path.is_file()
    assert payload["report"]["sha256"] == hashlib.sha256(report_path.read_bytes()).hexdigest()
    assert payload["summary"]["face_detected_count"] == 1
    assert (project / "artifacts" / "face_tracking_manifest.json").is_file()
    assert (project / "checkpoint_face_tracking.json").is_file()
    state = load_board_state(project)
    assert state["media"]["analysis"]["face_tracking"]


@pytest.mark.asyncio
async def test_unavailable_face_tracker_does_not_write_fake_report(tmp_path: Path) -> None:
    tracker = FakeFaceTracker(status=ToolStatus.UNAVAILABLE)
    app = create_media_app(project_root=tmp_path, face_tracker=tracker)
    project = make_project(tmp_path, "unavailable-face")
    response = await request(
        app,
        "POST",
        "/api/media/faces/track",
        json={"project_id": project.name, "media_path": "assets/source.mp4", "dry_run": False, "execute": True, "confirm": True},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "unavailable"
    assert tracker.calls == []
    assert not (project / "analysis" / "face_tracking").exists()


class FakeVideoTool:
    name = "fake-video"

    def get_status(self) -> str:
        return "available"


@pytest.mark.asyncio
async def test_model_adapter_exposes_analysis_aliases_and_capabilities(tmp_path: Path) -> None:
    sampler = FakeFrameSampler()
    tracker = FakeFaceTracker()
    task_app = create_task_app(tool=FakeVideoTool(), db_path=tmp_path / "tasks.sqlite3")
    project_root = tmp_path / "projects"
    project = make_project(project_root, "adapter-analysis")
    app = create_model_app(
        task_application=task_app,
        board_application=board_stub(),
        project_root=project_root,
        frame_sampler=sampler,
        face_tracker=tracker,
    )

    capabilities = await request(app, "GET", "/model-api/media/capabilities")
    assert capabilities.status_code == 200
    assert capabilities.json()["capabilities"]["frame_sampling"]["status"] == "available"
    assert capabilities.json()["capabilities"]["face_tracking"]["status"] == "available"

    response = await request(app, "POST", "/model-api/media/frames/sample", json={"project_id": project.name, "media_path": "assets/source.mp4"})
    assert response.status_code == 200
    assert response.json()["status"] == "dry_run"
    assert sampler.calls == []

    response = await request(app, "POST", "/model-api/media/faces/track", json={"project_id": project.name, "media_path": "assets/source.mp4"})
    assert response.status_code == 200
    assert response.json()["status"] == "dry_run"
    assert tracker.calls == []


def test_model_ui_exposes_analysis_preflight_and_execute_controls() -> None:
    html = (Path(__file__).resolve().parents[2] / "backlot" / "ui" / "model.html").read_text(encoding="utf-8")
    javascript = (Path(__file__).resolve().parents[2] / "backlot" / "ui" / "model.js").read_text(encoding="utf-8")
    for control in ("mediaAnalysisPath", "mediaFrameEstimate", "mediaFrameExecute", "mediaFaceEstimate", "mediaFaceExecute"):
        assert f'id="{control}"' in html
        assert control in javascript
