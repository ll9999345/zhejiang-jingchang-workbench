from __future__ import annotations

from pathlib import Path
import json
import sqlite3
from typing import Any

import httpx
import pytest

from web_api.app import create_app


class FakeTool:
    name = "fake_seedance_ark"

    def __init__(self, estimated_cost_cny: float = 2.5):
        self.estimated_cost_cny = estimated_cost_cny
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def get_status(self) -> str:
        return "available"

    def dry_run(self, inputs: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(("dry_run", dict(inputs)))
        return {
            "tool": self.name,
            "task_action": inputs.get("task_action"),
            "valid": True,
            "estimated_tokens": 123,
            "estimated_cost_cny": self.estimated_cost_cny,
            "estimated_cost_usd": 0.35,
        }

    def execute(self, inputs: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(("execute", dict(inputs)))
        action = inputs["task_action"]
        task_id = inputs.get("task_id", "fake-task-001")
        if action == "create":
            return {
                "success": True,
                "data": {
                    "task_id": task_id,
                    "status": "submitted",
                    "provider": "fake",
                    "model": "fake-mini",
                },
            }
        if action == "query":
            return {
                "success": True,
                "data": {
                    "task": {
                        "id": task_id,
                        "status": "succeeded",
                        "model": "fake-mini",
                    }
                },
            }
        if action == "cancel":
            return {
                "success": True,
                "data": {"task_id": task_id, "status": "cancel_requested"},
            }
        raise AssertionError(f"unexpected action: {action}")


class FailingTool(FakeTool):
    def dry_run(self, inputs: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(("dry_run", dict(inputs)))
        return {
            "valid": False,
            "error": (
                "Authorization: Bearer test-only-token "
                "https://provider.invalid/tasks?id=secret-query"
            ),
        }


async def request(app, method: str, url: str, **kwargs: Any) -> httpx.Response:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.request(method, url, **kwargs)


@pytest.fixture(autouse=True)
def no_provider_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ARK_API_KEY", raising=False)
    monkeypatch.delenv("WEB_API_PAID_AUTH_TOKEN", raising=False)


@pytest.mark.asyncio
async def test_health_is_safe_and_cors_is_exact(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WEB_API_PAID_AUTH_TOKEN", "test-only-token")
    fake = FakeTool()
    app = create_app(fake, tmp_path / "tasks.sqlite3")

    response = await request(
        app,
        "GET",
        "/health",
        headers={"Origin": "http://127.0.0.1:3010"},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.json()["paid_authorization_configured"] is True
    assert "test-only-token" not in response.text
    assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:3010"

    blocked = await request(
        app,
        "GET",
        "/health",
        headers={"Origin": "http://evil.invalid"},
    )
    assert "access-control-allow-origin" not in blocked.headers


@pytest.mark.asyncio
async def test_estimate_only_calls_dry_run(tmp_path: Path) -> None:
    fake = FakeTool()
    app = create_app(fake, tmp_path / "tasks.sqlite3")

    response = await request(
        app,
        "POST",
        "/api/tasks/estimate",
        json={"prompt": "test", "max_cost_cny": 3},
    )
    assert response.status_code == 200
    assert response.json()["estimated_cost_cny"] == 2.5
    assert response.json()["within_max_cost"] is True
    assert [kind for kind, _ in fake.calls] == ["dry_run"]
    assert fake.calls[0][1]["task_action"] == "create"


@pytest.mark.asyncio
async def test_create_auth_budget_and_persistence_across_restart(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = FakeTool(estimated_cost_cny=4)
    db = tmp_path / "tasks.sqlite3"
    app = create_app(fake, db)

    missing_auth = await request(
        app,
        "POST",
        "/api/tasks",
        json={"prompt": "test", "max_cost_cny": 5},
    )
    assert missing_auth.status_code == 503
    assert [kind for kind, _ in fake.calls] == []

    monkeypatch.setenv("WEB_API_PAID_AUTH_TOKEN", "test-only-token")
    missing_budget = await request(
        app,
        "POST",
        "/api/tasks",
        headers={"X-Generation-Authorization": "test-only-token"},
        json={"prompt": "test"},
    )
    assert missing_budget.status_code == 422

    over_budget = await request(
        app,
        "POST",
        "/api/tasks",
        headers={"X-Generation-Authorization": "test-only-token"},
        json={"prompt": "test", "max_cost_cny": 3},
    )
    assert over_budget.status_code == 400
    assert [kind for kind, _ in fake.calls] == ["dry_run"]

    created = await request(
        app,
        "POST",
        "/api/tasks",
        headers={"X-Generation-Authorization": "test-only-token"},
        json={"prompt": "test", "max_cost_cny": 5},
    )
    assert created.status_code == 200
    assert created.json()["task_id"] == "fake-task-001"
    assert created.json()["status"] == "submitted"
    assert fake.calls[-1][0] == "execute"
    assert fake.calls[-1][1]["task_action"] == "create"

    restarted_fake = FakeTool()
    restarted_app = create_app(restarted_fake, db)
    queried = await request(
        restarted_app,
        "GET",
        "/api/tasks/fake-task-001",
        headers={"X-Generation-Authorization": "test-only-token"},
    )
    assert queried.status_code == 200
    assert queried.json()["status"] == "succeeded"
    assert restarted_fake.calls == [
        ("execute", {"task_action": "query", "task_id": "fake-task-001"})
    ]

    cancelled = await request(
        restarted_app,
        "DELETE",
        "/api/tasks/fake-task-001",
        headers={"X-Generation-Authorization": "test-only-token"},
    )
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "cancel_requested"


@pytest.mark.asyncio
async def test_query_and_cancel_require_paid_authorization(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = FakeTool()
    app = create_app(fake, tmp_path / "tasks.sqlite3")

    for method in ("GET", "DELETE"):
        missing = await request(app, method, "/api/tasks/fake-task-001")
        assert missing.status_code == 503
    assert fake.calls == []

    monkeypatch.setenv("WEB_API_PAID_AUTH_TOKEN", "test-only-token")
    for method in ("GET", "DELETE"):
        wrong = await request(
            app,
            method,
            "/api/tasks/fake-task-001",
            headers={"X-Generation-Authorization": "wrong-token"},
        )
        assert wrong.status_code == 403
    assert fake.calls == []


@pytest.mark.asyncio
async def test_sensitive_request_fields_are_used_but_not_persisted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("WEB_API_PAID_AUTH_TOKEN", "test-only-token")
    db = tmp_path / "tasks.sqlite3"
    fake = FakeTool()
    app = create_app(fake, db)
    body = {
        "prompt": "test",
        "max_cost_cny": 5,
        "api_key": "request-api-key",
        "nested": {
            "token": "nested-token",
            "safe_value": "keep-me",
            "deep": [{"credential": "nested-credential"}],
        },
        "authorization": "Bearer request-authorization",
        "password": "request-password",
        "client_secret": "request-secret",
    }

    created = await request(
        app,
        "POST",
        "/api/tasks",
        headers={"X-Generation-Authorization": "test-only-token"},
        json=body,
    )
    assert created.status_code == 200
    create_inputs = fake.calls[-1][1]
    assert create_inputs["api_key"] == "request-api-key"
    assert create_inputs["nested"]["token"] == "nested-token"

    with sqlite3.connect(db) as connection:
        request_json, data_json = connection.execute(
            "SELECT request_json, data_json FROM tasks WHERE task_id = ?",
            ("fake-task-001",),
        ).fetchone()
    persisted = f"{request_json} {data_json}"
    for secret in (
        "request-api-key",
        "nested-token",
        "nested-credential",
        "request-authorization",
        "request-password",
        "request-secret",
    ):
        assert secret not in persisted
    assert "safe_value" in json.loads(request_json)["nested"]


@pytest.mark.asyncio
async def test_provider_errors_are_redacted(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WEB_API_PAID_AUTH_TOKEN", "test-only-token")
    app = create_app(FailingTool(), tmp_path / "tasks.sqlite3")

    response = await request(
        app,
        "POST",
        "/api/tasks/estimate",
        json={"prompt": "test", "max_cost_cny": 5},
    )
    assert response.status_code == 200
    assert "test-only-token" not in response.text
    assert "secret-query" not in response.text
    assert "[redacted]" in response.text
