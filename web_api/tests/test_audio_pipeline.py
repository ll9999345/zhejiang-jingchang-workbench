from __future__ import annotations

import hashlib
import json
import shutil
import wave
from pathlib import Path
from typing import Any

import httpx
import pytest

from tools.base_tool import ToolResult, ToolRuntime, ToolStatus
from web_api.audio_pipeline import create_audio_app


class FakeProvider:
    name = "fake_tts"
    provider = "fake"

    def get_status(self) -> ToolStatus:
        return ToolStatus.AVAILABLE

    def get_info(self) -> dict[str, Any]:
        return {
            "dependencies": ["test-only"],
            "install_instructions": "Only used by the test injection provider.",
        }


class FakeSelector:
    def __init__(self, available: bool = True) -> None:
        self.available = available
        self.provider = FakeProvider()
        self.calls: list[dict[str, Any]] = []

    def get_status(self) -> ToolStatus:
        return ToolStatus.AVAILABLE if self.available else ToolStatus.UNAVAILABLE

    def _providers(self) -> list[FakeProvider]:
        return [self.provider] if self.available else []

    def estimate_cost(self, inputs: dict[str, Any]) -> float:
        return 0.42

    def execute(self, inputs: dict[str, Any]) -> ToolResult:
        self.calls.append(dict(inputs))
        if inputs.get("operation") == "rank":
            return ToolResult(
                success=True,
                data={
                    "rankings": [
                        {"provider": "fake", "tool_name": "fake_tts", "score": 100}
                    ]
                },
            )
        output_path = Path(inputs["output_path"])
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(output_path), "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(8_000)
            audio.writeframes(b"\0\0" * 16_000)
        return ToolResult(
            success=True,
            data={"selected_provider": "fake", "model": "fake-narrator"},
            artifacts=[str(output_path)],
        )


async def request(
    app: Any, method: str, url: str, **kwargs: Any
) -> httpx.Response:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.request(method, url, **kwargs)


@pytest.mark.asyncio
async def test_estimate_is_free_and_unavailable_is_explicit(tmp_path: Path) -> None:
    selector = FakeSelector(available=False)
    app = create_audio_app(selector=selector, project_root=tmp_path)

    response = await request(
        app,
        "POST",
        "/api/audio/estimate",
        json={
            "project_id": "nanbeihu-demo",
            "segments": [{"id": "s1", "text": "湖光与山色，在南北湖相遇。"}],
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "unavailable"
    assert payload["would_generate"] is False
    assert payload["authorization_required"] is True
    assert payload["error"]
    assert not list(tmp_path.rglob("*"))
    # The injected selector may be asked to rank, but it is never asked to
    # generate and no provider is called when it reports unavailable.
    assert all(call.get("operation") == "rank" for call in selector.calls)


@pytest.mark.asyncio
async def test_render_defaults_to_dry_run_and_paid_gate_is_explicit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("WEB_API_PAID_AUTH_TOKEN", raising=False)
    selector = FakeSelector()
    project = tmp_path / "nanbeihu-demo"
    project.mkdir()
    app = create_audio_app(selector=selector, project_root=tmp_path)
    body = {
        "project_id": "nanbeihu-demo",
        "segments": [{"id": "s1", "text": "湖光与山色，在南北湖相遇。"}],
    }

    preview = await request(app, "POST", "/api/audio/render", json=body)
    assert preview.status_code == 200
    assert preview.json()["status"] == "dry_run"
    assert all(call.get("operation") == "rank" for call in selector.calls)

    no_confirmation = await request(
        app,
        "POST",
        "/api/audio/render",
        json={**body, "dry_run": False, "execute": True},
    )
    assert no_confirmation.status_code == 400
    assert len([call for call in selector.calls if call.get("operation") == "generate"]) == 0

    no_auth = await request(
        app,
        "POST",
        "/api/audio/render",
        json={**body, "dry_run": False, "execute": True, "confirm": True},
    )
    assert no_auth.status_code == 503

    monkeypatch.setenv("WEB_API_PAID_AUTH_TOKEN", "test-audio-token")
    wrong_auth = await request(
        app,
        "POST",
        "/api/audio/render",
        headers={"X-Generation-Authorization": "wrong-token"},
        json={**body, "dry_run": False, "execute": True, "confirm": True},
    )
    assert wrong_auth.status_code == 403


@pytest.mark.asyncio
async def test_explicit_local_provider_does_not_require_paid_token(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A local provider still needs a deliberate click, but never a cloud key."""

    monkeypatch.delenv("WEB_API_PAID_AUTH_TOKEN", raising=False)
    selector = FakeSelector()
    selector.provider.runtime = ToolRuntime.LOCAL
    project = tmp_path / "nanbeihu-local"
    project.mkdir()
    app = create_audio_app(selector=selector, project_root=tmp_path)
    body = {
        "project_id": "nanbeihu-local",
        "segments": [{"id": "s1", "text": "湖光与山色，在南北湖相遇。"}],
        "preferred_provider": "fake",
    }

    preview = await request(app, "POST", "/api/audio/render", json=body)
    assert preview.status_code == 200
    assert preview.json()["status"] == "dry_run"
    assert preview.json()["authorization_required"] is False

    response = await request(
        app,
        "POST",
        "/api/audio/render",
        json={**body, "dry_run": False, "execute": True, "confirm": True},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "completed"
    assert payload["provider"] == "fake"
    assert (project / "assets/audio/narration.mp3").is_file()


@pytest.mark.asyncio
@pytest.mark.skipif(shutil.which("ffprobe") is None, reason="ffprobe is required")
async def test_render_uses_measured_duration_and_writes_hashed_artifacts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("WEB_API_PAID_AUTH_TOKEN", "test-audio-token")
    selector = FakeSelector()
    project = tmp_path / "nanbeihu-demo"
    project.mkdir()
    app = create_audio_app(selector=selector, project_root=tmp_path)

    response = await request(
        app,
        "POST",
        "/api/audio/render",
        headers={"X-Generation-Authorization": "test-audio-token"},
        json={
            "project_id": "nanbeihu-demo",
            "segments": [
                {"id": "s1", "text": "第一句，湖光在晨雾里展开。"},
                {"id": "s2", "text": "第二句，山色沿着湖岸慢慢醒来。"},
            ],
            "output_format": "wav",
            "dry_run": False,
            "execute": True,
            "confirm": True,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "completed"
    assert payload["duration_seconds"] == pytest.approx(2.0, abs=0.01)
    assert len([call for call in selector.calls if call.get("operation") == "generate"]) == 1

    audio = project / "assets" / "audio" / "narration.wav"
    srt = project / "subtitles.srt"
    vtt = project / "subtitles.vtt"
    timeline = project / "subtitles.json"
    manifest = project / "artifacts" / "audio_manifest.json"
    for path in (audio, srt, vtt, timeline, manifest):
        assert path.is_file()
        assert path.stat().st_size > 0

    timeline_payload = json.loads(timeline.read_text(encoding="utf-8"))
    assert timeline_payload["duration_source"] == "ffprobe"
    assert timeline_payload["cue_count"] == 2
    assert timeline_payload["cues"][-1]["end_seconds"] == pytest.approx(2.0, abs=0.01)
    assert timeline_payload["source_audio_sha256"] == hashlib.sha256(audio.read_bytes()).hexdigest()
    assert timeline_payload["bgm"]["status"] == "deferred"

    manifest_payload = json.loads(manifest.read_text(encoding="utf-8"))
    assert manifest_payload["audio"]["sha256"] == hashlib.sha256(audio.read_bytes()).hexdigest()
    assert manifest_payload["audio"]["duration_seconds"] == pytest.approx(2.0, abs=0.01)
    assert manifest_payload["subtitles"]["srt"]["sha256"] == hashlib.sha256(srt.read_bytes()).hexdigest()
    assert manifest_payload["subtitles"]["vtt"]["sha256"] == hashlib.sha256(vtt.read_bytes()).hexdigest()
    assert manifest_payload["subtitles"]["json"]["sha256"] == hashlib.sha256(timeline.read_bytes()).hexdigest()
