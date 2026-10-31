from __future__ import annotations

import shutil
import wave
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from backlot.model_adapter import create_app
from tools.base_tool import ToolResult, ToolStatus
from web_api.app import create_app as create_task_app


class FakeAudioProvider:
    name = "fake_audio_provider"
    provider = "fake"

    def get_status(self) -> ToolStatus:
        return ToolStatus.AVAILABLE

    def get_info(self) -> dict[str, Any]:
        return {"dependencies": ["test-only"]}


class FakeAudioSelector:
    def __init__(self) -> None:
        self.provider = FakeAudioProvider()
        self.calls: list[dict[str, Any]] = []

    def get_status(self) -> ToolStatus:
        return ToolStatus.AVAILABLE

    def _providers(self) -> list[FakeAudioProvider]:
        return [self.provider]

    def estimate_cost(self, inputs: dict[str, Any]) -> float:
        return 0.1

    def execute(self, inputs: dict[str, Any]) -> ToolResult:
        self.calls.append(dict(inputs))
        if inputs.get("operation") == "rank":
            return ToolResult(success=True, data={"rankings": [{"provider": "fake"}]})
        output_path = Path(inputs["output_path"])
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(output_path), "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(8_000)
            audio.writeframes(b"\0\0" * 8_000)
        return ToolResult(
            success=True,
            data={"selected_provider": "fake", "model": "fake-narrator"},
            artifacts=[str(output_path)],
        )


def board_stub() -> FastAPI:
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
@pytest.mark.skipif(shutil.which("ffprobe") is None, reason="ffprobe is required")
async def test_adapter_exposes_audio_capabilities_estimate_and_guarded_render(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    audio = FakeAudioSelector()
    task_app = create_task_app(
        # The task endpoint is not used here; this fake only keeps adapter
        # construction independent of local provider credentials.
        tool=_FakeVideoTool(),
        db_path=tmp_path / "tasks.sqlite3",
    )
    project_root = tmp_path / "projects"
    project = project_root / "nanbeihu-demo"
    project.mkdir(parents=True)
    app = create_app(
        task_application=task_app,
        board_application=board_stub(),
        project_root=project_root,
        audio_selector=audio,
    )

    capabilities = await request(app, "GET", "/model-api/media/audio/capabilities")
    assert capabilities.status_code == 200
    assert capabilities.json()["selector_status"] == "available"
    # BGM is a real post-video capability now.  Its provider can be
    # unavailable when the developer has not configured ElevenLabs, but the
    # adapter must not report a fake/deferred placeholder.
    assert capabilities.json()["bgm"]["status"] in {"available", "unavailable", "degraded"}

    music_health = await request(app, "GET", "/model-api/media/music/health")
    assert music_health.status_code == 200
    assert music_health.json()["capability"] == "music_generation"
    assert music_health.json()["post_video"] is True

    body = {
        "project_id": "nanbeihu-demo",
        "segments": [{"id": "s1", "text": "湖光与山色，在南北湖相遇。"}],
    }
    estimate = await request(app, "POST", "/model-api/media/audio/estimate", json=body)
    assert estimate.status_code == 200
    assert estimate.json()["status"] == "available"
    assert estimate.json()["would_generate"] is False
    assert [call["operation"] for call in audio.calls] == ["rank"]

    preview = await request(app, "POST", "/model-api/media/audio/render", json=body)
    assert preview.status_code == 200
    assert preview.json()["status"] == "dry_run"
    assert not [call for call in audio.calls if call.get("operation") == "generate"]

    monkeypatch.setenv("WEB_API_PAID_AUTH_TOKEN", "test-audio-token")
    rendered = await request(
        app,
        "POST",
        "/model-api/media/audio/render",
        headers={"X-Generation-Authorization": "test-audio-token"},
        json={
            **body,
            "output_format": "wav",
            "dry_run": False,
            "execute": True,
            "confirm": True,
        },
    )
    assert rendered.status_code == 200
    assert rendered.json()["status"] == "completed"
    assert (project / "assets/audio/narration.wav").is_file()
    assert (project / "artifacts/audio_manifest.json").is_file()


class _FakeVideoTool:
    name = "fake_seedance"

    def get_status(self) -> str:
        return "available"

    def dry_run(self, inputs: dict[str, Any]) -> dict[str, Any]:
        return {
            "success": True,
            "data": {
                "valid": True,
                "estimated_cost_cny": 1,
                "estimated_cost_usd": 0.1,
            },
        }

    def execute(self, inputs: dict[str, Any]) -> dict[str, Any]:
        return {
            "success": True,
            "data": {
                "task_id": "fake-task",
                "status": "submitted",
                "provider": "fake",
            },
        }
