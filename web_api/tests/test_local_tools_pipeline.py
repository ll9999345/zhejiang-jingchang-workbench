from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from pydantic import ValidationError

from backlot.model_adapter import create_app as create_model_app
from tools.base_tool import ToolResult
from web_api.app import create_app as create_task_app
from web_api.local_tools_pipeline import (
    LocalToolRequest,
    create_local_tools_app,
    execute_local_tool,
)
import web_api.local_tools_pipeline as local_tools


class FakeLocalTool:
    name = "fake_local_tool"
    provider = "fake"
    runtime = "local"
    dependencies: list[str] = []
    capabilities = ["test"]
    best_for = ["unit tests"]
    install_instructions = ""
    status = "available"
    calls: list[dict[str, Any]] = []

    def get_status(self) -> str:
        return self.status

    def get_info(self) -> dict[str, Any]:
        return {"dependencies": [], "capabilities": self.capabilities}

    def execute(self, inputs: dict[str, Any]) -> ToolResult:
        self.calls.append(dict(inputs))
        output = Path(inputs["output_path"])
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"local-tool-test-output")
        return ToolResult(success=True, data={"output": str(output)}, artifacts=[str(output)])


class UnavailableLocalTool(FakeLocalTool):
    status = "unavailable"

    def execute(self, inputs: dict[str, Any]) -> ToolResult:
        raise AssertionError("unavailable tools must never execute")


def _project(tmp_path: Path) -> tuple[Path, Path]:
    root = tmp_path / "projects"
    project = root / "local-demo"
    (project / "assets").mkdir(parents=True)
    return root, project


async def _request(app: FastAPI, method: str, path: str, **kwargs: Any) -> httpx.Response:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.request(method, path, **kwargs)


def test_request_is_closed_and_rejects_host_paths() -> None:
    with pytest.raises(ValidationError):
        LocalToolRequest.model_validate({
            "operation": "manim_title",
            "project_id": "local-demo",
            "scene_code": "import os; os.remove('x')",
        })
    with pytest.raises(ValidationError):
        LocalToolRequest.model_validate({
            "operation": "bg_remove",
            "project_id": "local-demo",
            "input_path": "/Users/creator/private.png",
        })
    with pytest.raises(ValidationError):
        LocalToolRequest.model_validate({
            "operation": "hyperframes_render",
            "project_id": "local-demo",
            "workspace_path": "../../outside",
        })


def test_manim_scene_is_generated_from_fixed_template() -> None:
    request = LocalToolRequest(
        operation="manim_title",
        project_id="local-demo",
        title='湖畔 "晨光"',
    )
    source = local_tools._manim_scene_code(request)
    assert "class OpenMontageLocalTemplate(Scene)" in source
    assert "湖畔" in source
    assert "scene_code" not in source
    assert "subprocess" not in source


@pytest.mark.asyncio
async def test_estimate_is_read_only_and_execute_uses_unique_outputs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root, project = _project(tmp_path)
    source = project / "assets" / "source.png"
    source.write_bytes(b"source-image")
    FakeLocalTool.calls = []
    monkeypatch.setitem(local_tools._LOCAL_TOOL_CLASSES, "bg_remove", FakeLocalTool)
    monkeypatch.setattr(local_tools, "notify_project_changed", lambda _project_id: None)

    app = create_local_tools_app(project_root=root)
    estimate = await _request(
        app,
        "POST",
        "/api/local-tools/estimate",
        json={"operation": "bg_remove", "project_id": "local-demo", "input_path": "assets/source.png"},
    )
    assert estimate.status_code == 200
    plan = estimate.json()
    assert plan["status"] == "dry_run"
    assert plan["cost_cny"] == 0.0
    assert plan["would_write"] is True
    assert not (project / "assets" / "local-tools").exists()

    payload = {
        "operation": "bg_remove",
        "project_id": "local-demo",
        "input_path": "assets/source.png",
        "dry_run": False,
        "execute": True,
        "confirm": True,
    }
    first = await _request(app, "POST", "/api/local-tools/execute", json=payload)
    second = await _request(app, "POST", "/api/local-tools/execute", json=payload)
    assert first.status_code == second.status_code == 200
    first_body, second_body = first.json(), second.json()
    assert first_body["status"] == second_body["status"] == "completed"
    assert first_body["run_id"] != second_body["run_id"]
    first_path = project / first_body["output"]["path"]
    second_path = project / second_body["output"]["path"]
    assert first_path.is_file() and second_path.is_file()
    assert first_path != second_path
    assert first_body["manifest"]["path"].startswith("artifacts/local_tools_")
    assert len(FakeLocalTool.calls) == 2


@pytest.mark.asyncio
async def test_execute_requires_confirmation_and_truthfully_reports_missing_dependency(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root, project = _project(tmp_path)
    source = project / "assets" / "source.png"
    source.write_bytes(b"source-image")
    monkeypatch.setitem(local_tools._LOCAL_TOOL_CLASSES, "bg_remove", UnavailableLocalTool)
    app = create_local_tools_app(project_root=root)

    missing_confirmation = await _request(
        app,
        "POST",
        "/api/local-tools/execute",
        json={
            "operation": "bg_remove",
            "project_id": "local-demo",
            "input_path": "assets/source.png",
            "dry_run": False,
            "execute": True,
            "confirm": False,
        },
    )
    assert missing_confirmation.status_code == 200
    assert missing_confirmation.json()["status"] == "confirmation_required"
    assert not (project / "assets" / "local-tools").exists()

    unavailable = await _request(
        app,
        "POST",
        "/api/local-tools/execute",
        json={
            "operation": "bg_remove",
            "project_id": "local-demo",
            "input_path": "assets/source.png",
            "dry_run": False,
            "execute": True,
            "confirm": True,
        },
    )
    assert unavailable.status_code == 200
    assert unavailable.json()["status"] == "unavailable"
    assert unavailable.json()["would_write"] is False
    assert not (project / "assets" / "local-tools").exists()


@pytest.mark.asyncio
async def test_hyperframes_workspace_must_be_project_local_and_existing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root, project = _project(tmp_path)
    monkeypatch.setitem(local_tools._LOCAL_TOOL_CLASSES, "hyperframes_render", FakeLocalTool)
    app = create_local_tools_app(project_root=root)
    response = await _request(
        app,
        "POST",
        "/api/local-tools/estimate",
        json={"operation": "hyperframes_render", "project_id": "local-demo"},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "invalid_request"
    assert "workspace" in response.json()["error"]

    workspace = project / "hyperframes"
    workspace.mkdir()
    (workspace / "index.html").write_text("<!doctype html>", encoding="utf-8")
    response = await _request(
        app,
        "POST",
        "/api/local-tools/estimate",
        json={"operation": "hyperframes_render", "project_id": "local-demo"},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "dry_run"


@pytest.mark.asyncio
async def test_model_adapter_exposes_local_tool_routes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root, _ = _project(tmp_path)
    monkeypatch.setattr(local_tools, "_LOCAL_TOOL_CLASSES", {
        operation: FakeLocalTool for operation in local_tools.LOCAL_OPERATIONS
    })
    task_app = create_task_app(FakeLocalTool(), tmp_path / "tasks.sqlite3")
    board = FastAPI()
    app = create_model_app(task_application=task_app, board_application=board, project_root=root)
    response = await _request(app, "GET", "/model-api/local-tools/capabilities")
    assert response.status_code == 200
    body = response.json()
    assert body["local_free_only"] is True
    assert body["arbitrary_code"] is False
    assert set(item["operation"] for item in body["tools"]) == set(local_tools.LOCAL_OPERATIONS)
