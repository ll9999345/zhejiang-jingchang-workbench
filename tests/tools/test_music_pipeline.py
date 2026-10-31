from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from tools.base_tool import ToolResult, ToolStatus
from web_api.music_pipeline import create_music_app, estimate_music, render_music


class FakeMusicTool:
    name = "fake_music"
    provider = "fake-elevenlabs"
    calls: list[dict[str, Any]]

    def __init__(self, available: bool = True) -> None:
        self.available = available
        self.calls = []

    def get_status(self) -> ToolStatus:
        return ToolStatus.AVAILABLE if self.available else ToolStatus.UNAVAILABLE

    def get_info(self) -> dict[str, Any]:
        return {"dependencies": ["test-only"], "supports": {"exact_duration": True}}

    def estimate_cost(self, inputs: dict[str, Any]) -> float:
        return round(float(inputs["duration_seconds"]) * 0.01, 4)

    def execute(self, inputs: dict[str, Any]) -> ToolResult:
        self.calls.append(dict(inputs))
        output = Path(inputs["output_path"])
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"fake-music-bytes")
        return ToolResult(success=True, data={"provider": "fake", "format": "mp3"}, artifacts=[str(output)])


async def request(app: Any, method: str, url: str, **kwargs: Any) -> httpx.Response:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.request(method, url, **kwargs)


def test_estimate_is_free_and_has_a_deterministic_cue_sheet(tmp_path: Path) -> None:
    project = tmp_path / "nanbeihu-demo"
    project.mkdir()
    tool = FakeMusicTool()
    result = estimate_music(
        {
            "project_id": project.name,
            "prompt": "南北湖晨雾与山色，克制而有电影感",
            "duration_seconds": 12,
        },
        tool=tool,
        project_root=tmp_path,
    )
    assert result["status"] == "dry_run"
    assert result["would_generate"] is True
    assert len(result["cue_sheet"]) == 4
    assert not list(project.rglob("*"))
    assert not tool.calls


def test_render_requires_explicit_confirmation_and_writes_real_artifacts(tmp_path: Path) -> None:
    project = tmp_path / "nanbeihu-demo"
    project.mkdir()
    tool = FakeMusicTool()
    body = {
        "project_id": project.name,
        "prompt": "南北湖晨雾与山色，克制而有电影感",
        "duration_seconds": 12,
        "dry_run": False,
        "execute": True,
        "confirm": True,
    }
    guarded = render_music(body, tool=tool, project_root=tmp_path, authorized=False)
    assert guarded["status"] == "authorization_required"
    assert not tool.calls

    result = render_music(body, tool=tool, project_root=tmp_path, authorized=True)
    assert result["status"] == "completed"
    output = project / result["output"]["path"]
    assert output.is_file()
    assert output.read_bytes() == b"fake-music-bytes"
    manifest = project / "artifacts/music_manifest.json"
    cue_sheet = project / "artifacts/music_cue_sheet.json"
    checkpoint = project / "checkpoint_compose.json"
    assert manifest.is_file() and cue_sheet.is_file() and checkpoint.is_file()
    manifest_data = json.loads(manifest.read_text(encoding="utf-8"))
    assert manifest_data["stage"] == "bgm_postproduction"
    assert manifest_data["output"]["sha256"] == result["music"]["sha256"]
    assert "ELEVENLABS_API_KEY" not in manifest.read_text(encoding="utf-8")
    assert len(tool.calls) == 1


@pytest.mark.asyncio
async def test_music_http_route_returns_unavailable_without_provider(tmp_path: Path) -> None:
    project = tmp_path / "nanbeihu-demo"
    project.mkdir()
    app = create_music_app(project_root=tmp_path, tool=FakeMusicTool(available=False))
    response = await request(
        app,
        "POST",
        "/api/music/estimate",
        json={"project_id": project.name, "prompt": "南北湖湖光山色", "duration_seconds": 8},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "dry_run"
    assert payload["would_generate"] is False
    assert payload["provider"]["status"] == "unavailable"

