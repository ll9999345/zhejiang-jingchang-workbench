"""Focused contract and routing tests for the Doubao Speech provider.

These tests never call Volcengine.  They cover the server-only credential
boundary, safe diagnostics, mocked request wiring, and selector routing.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from tools.audio.doubao_tts import DoubaoTTS
from tools.audio.tts_selector import TTSSelector
from tools.base_tool import ToolResult, ToolRuntime, ToolStatus


class _FakeResponse:
    def __init__(self, payload: dict[str, Any], *, content: bytes = b"") -> None:
        self.status_code = 200
        self._payload = payload
        self.content = content

    def json(self) -> dict[str, Any]:
        return self._payload

    def raise_for_status(self) -> None:
        return None


def test_contract_declares_server_credential_and_safe_diagnostics(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("DOUBAO_SPEECH_API_KEY", raising=False)
    monkeypatch.delenv("DOUBAO_SPEECH_VOICE_TYPE", raising=False)
    tool = DoubaoTTS()

    assert tool.runtime == ToolRuntime.API
    assert "env:DOUBAO_SPEECH_API_KEY" in tool.dependencies
    assert tool.get_status() == ToolStatus.UNAVAILABLE
    assert tool.diagnostics() == {
        "ready": False,
        "api_key_configured": False,
        "api_key_env": "DOUBAO_SPEECH_API_KEY",
        "voice_configured": False,
        "voice_env": "DOUBAO_SPEECH_VOICE_TYPE",
        "auth_scheme": "X-Api-Key",
        "resource_id": "seed-tts-2.0",
        "issues": ["DOUBAO_SPEECH_API_KEY is not configured"],
    }

    secret = "doubao-secret-for-test"
    monkeypatch.setenv("DOUBAO_SPEECH_API_KEY", secret)
    monkeypatch.setenv("DOUBAO_SPEECH_VOICE_TYPE", "zh_female_vv_uranus_bigtts")
    diagnostics = tool.diagnostics()
    assert diagnostics["ready"] is True
    assert diagnostics["api_key_configured"] is True
    assert diagnostics["voice_configured"] is True
    assert secret not in json.dumps(diagnostics, ensure_ascii=False)


def test_whitespace_only_key_is_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DOUBAO_SPEECH_API_KEY", "  \t")
    assert DoubaoTTS().get_status() == ToolStatus.UNAVAILABLE
    result = DoubaoTTS().execute({"text": "测试"})
    assert result.success is False
    assert "DOUBAO_SPEECH_API_KEY" in (result.error or "")


def test_selector_routes_by_provider_or_tool_name(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("DOUBAO_SPEECH_API_KEY", "test-key")
    provider = DoubaoTTS()

    def fake_execute(self: DoubaoTTS, inputs: dict[str, Any]) -> ToolResult:
        return ToolResult(
            success=True,
            data={"provider": "doubao", "model": "seed-tts-2.0", "output": inputs.get("output_path")},
        )

    monkeypatch.setattr(DoubaoTTS, "execute", fake_execute)
    monkeypatch.setattr(TTSSelector, "_providers", lambda self: [provider])

    for requested in ("doubao", "doubao_tts"):
        result = TTSSelector().execute(
            {
                "text": "测试旁白",
                "preferred_provider": requested,
                "allowed_providers": [requested],
                "output_path": str(tmp_path / f"{requested}.mp3"),
            }
        )
        assert result.success is True
        assert result.data["selected_tool"] == "doubao_tts"
        assert result.data["selected_provider"] == "doubao"


def test_mocked_async_request_uses_new_console_headers_and_redacts_errors(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    import requests

    secret = "test-doubao-secret"
    monkeypatch.setenv("DOUBAO_SPEECH_API_KEY", secret)
    monkeypatch.setenv("DOUBAO_SPEECH_VOICE_TYPE", "zh_female_vv_uranus_bigtts")
    monkeypatch.setattr(DoubaoTTS, "_audio_duration", staticmethod(lambda path: 1.25))
    monkeypatch.setattr("tools.audio.doubao_tts.time.sleep", lambda seconds: None)

    captured: list[dict[str, Any]] = []

    def fake_post(url: str, *, headers: dict[str, str], json: dict[str, Any], timeout: Any) -> _FakeResponse:
        captured.append({"url": url, "headers": headers, "json": json, "timeout": timeout})
        if url.endswith("/submit"):
            return _FakeResponse({"code": 20000000, "data": {"task_id": "task-1"}})
        return _FakeResponse(
            {
                "code": 20000000,
                "data": {
                    "task_status": 2,
                    "audio_url": "https://audio.example.test/task-1.mp3",
                    "sentences": [{"words": []}],
                },
            }
        )

    monkeypatch.setattr(requests, "post", fake_post)
    monkeypatch.setattr(
        requests,
        "get",
        lambda url, *, timeout: _FakeResponse({}, content=b"fake-audio"),
    )

    output = tmp_path / "narration.mp3"
    result = DoubaoTTS().execute(
        {
            "text": "短样本试听文本。",
            "output_path": str(output),
            "poll_interval_seconds": 0.5,
        }
    )

    assert result.success is True
    assert output.read_bytes() == b"fake-audio"
    assert result.data["provider"] == "doubao"
    assert result.data["task_id"] == "task-1"
    assert captured[0]["headers"]["X-Api-Key"] == secret
    assert captured[0]["headers"]["X-Api-Resource-Id"] == "seed-tts-2.0"
    assert "X-Api-App-Id" not in captured[0]["headers"]
    assert "X-Api-Access-Key" not in captured[0]["headers"]

    safe = DoubaoTTS._safe_error(RuntimeError(f"request failed with {secret}"))
    assert secret not in safe
    assert "[redacted]" in safe
