"""Offline contract tests for the direct Ark Doubao-Seedream adapter.

These tests deliberately replace ``requests`` with a tiny fake module.  They
prove payload/auth/output handling without making a paid provider call.
"""

from __future__ import annotations

import base64
import json
import sys
import types
from pathlib import Path

import pytest


class _Response:
    def __init__(
        self,
        payload: dict | None = None,
        *,
        content: bytes = b"",
        headers: dict[str, str] | None = None,
        status_code: int = 200,
    ) -> None:
        self._payload = payload or {}
        self.content = content
        self.headers = headers or {}
        self.status_code = status_code
        self.closed = False

    def close(self) -> None:
        self.closed = True

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self) -> dict:
        return self._payload


def _fake_requests(monkeypatch, post_response: _Response, get_response: _Response):
    calls: dict[str, list[dict]] = {"post": [], "get": []}

    def post(url, **kwargs):
        calls["post"].append({"url": url, **kwargs})
        return post_response

    def get(url, **kwargs):
        calls["get"].append({"url": url, **kwargs})
        return get_response

    module = types.ModuleType("requests")
    module.post = post
    module.get = get
    # The production adapter checks the requests exception namespace to
    # distinguish retryable transport failures from programming/provider
    # errors.  Keep the fake module's surface close to requests without ever
    # making a network call.
    class _RequestException(Exception):
        pass

    class _SSLError(_RequestException):
        pass

    class _ConnectionError(_RequestException):
        pass

    class _Timeout(_RequestException):
        pass

    module.exceptions = types.SimpleNamespace(
        RequestException=_RequestException,
        SSLError=_SSLError,
        ConnectionError=_ConnectionError,
        Timeout=_Timeout,
    )
    monkeypatch.setitem(sys.modules, "requests", module)
    return calls


def _fake_requests_sequence(monkeypatch, post_actions, get_actions=()):
    """Install a requests double whose actions are consumed in order."""

    calls: dict[str, list[dict]] = {"post": [], "get": []}
    post_queue = list(post_actions)
    get_queue = list(get_actions)

    def invoke(queue, method, url, **kwargs):
        calls[method].append({"url": url, **kwargs})
        action = queue.pop(0) if queue else RuntimeError(f"no fake {method} action left")
        if isinstance(action, BaseException):
            raise action
        return action

    module = types.ModuleType("requests")

    class _RequestException(Exception):
        pass

    class _SSLError(_RequestException):
        pass

    class _ConnectionError(_RequestException):
        pass

    class _Timeout(_RequestException):
        pass

    module.exceptions = types.SimpleNamespace(
        RequestException=_RequestException,
        SSLError=_SSLError,
        ConnectionError=_ConnectionError,
        Timeout=_Timeout,
    )
    # Expose the concrete classes to the test so a simulated SSLError is
    # recognized by the adapter's retry classifier.
    module._SSLError = _SSLError
    module.post = lambda url, **kwargs: invoke(post_queue, "post", url, **kwargs)
    module.get = lambda url, **kwargs: invoke(get_queue, "get", url, **kwargs)
    monkeypatch.setitem(sys.modules, "requests", module)
    return calls, module


@pytest.fixture
def tool(monkeypatch):
    monkeypatch.setenv("ARK_API_KEY", "ark-test-secret")
    from tools.graphics.doubao_seedream_image import DoubaoSeedreamImage

    return DoubaoSeedreamImage()


def test_missing_key_is_truthful_and_status_unavailable(monkeypatch):
    monkeypatch.delenv("ARK_API_KEY", raising=False)
    from tools.graphics.doubao_seedream_image import DoubaoSeedreamImage

    adapter = DoubaoSeedreamImage()
    result = adapter.execute({"prompt": "南北湖湖湾"})

    assert not result.success
    assert adapter.get_status().name == "UNAVAILABLE"
    assert "ark-test-secret" not in (result.error or "")


def test_url_response_is_downloaded_and_metadata_is_written(tool, tmp_path, monkeypatch):
    response = _Response(
        {"model": "ep-test", "data": [{"url": "https://cdn.example/frame.png"}]},
        headers={"x-request-id": "req-42"},
    )
    calls = _fake_requests(
        monkeypatch,
        response,
        _Response(content=b"PNG_BYTES"),
    )
    output = tmp_path / "frame.png"
    result = tool.execute(
        {
            "prompt": "电影级南北湖晨雾与山色",
            "model": "ep-test",
            "size": "2K",
            "watermark": False,
            "output_path": str(output),
        }
    )

    assert result.success, result.error
    assert output.read_bytes() == b"PNG_BYTES"
    assert result.data["provider"] == "ark"
    assert result.data["model"] == "ep-test"
    assert result.data["request_id"] == "req-42"
    assert result.data["metadata_path"] == str(output.with_suffix(".json"))
    assert str(output.with_suffix(".json")) not in result.artifacts
    payload = calls["post"][0]["json"]
    assert payload["model"] == "ep-test"
    assert payload["prompt"].startswith("电影级")
    assert payload["size"] == "2K"
    assert payload["watermark"] is False
    assert calls["post"][0]["headers"]["Authorization"] == "Bearer ark-test-secret"
    assert calls["get"][0]["url"] == "https://cdn.example/frame.png"
    metadata = json.loads(output.with_suffix(".json").read_text(encoding="utf-8"))
    assert metadata["request_id"] == "req-42"
    assert metadata["payload_summary"]["reference_count"] == 0


def test_base64_response_and_reference_path_are_supported(tool, tmp_path, monkeypatch):
    reference = tmp_path / "reference.jpg"
    reference.write_bytes(b"REFERENCE")
    encoded = base64.b64encode(b"JPEG_BYTES").decode("ascii")
    calls = _fake_requests(
        monkeypatch,
        _Response({"data": [{"b64_json": encoded}]}),
        _Response(),
    )
    output = tmp_path / "edited.jpg"
    result = tool.execute(
        {
            "prompt": "保留湖岸线与暖色夕阳，修复人物比例",
            "image_paths": [str(reference)],
            "response_format": "b64_json",
            "output_format": "jpeg",
            "output_path": str(output),
        }
    )

    assert result.success, result.error
    assert output.read_bytes() == b"JPEG_BYTES"
    payload = calls["post"][0]["json"]
    assert len(payload["image"]) == 1
    assert payload["image"][0].startswith("data:image/jpeg;base64,")
    assert payload["response_format"] == "b64_json"


def test_invalid_reference_and_short_prompt_do_not_call_provider(tool, tmp_path, monkeypatch):
    calls = _fake_requests(monkeypatch, _Response(), _Response())
    missing = tool.execute(
        {
            "prompt": "有效提示词",
            "image_paths": [str(tmp_path / "missing.png")],
        }
    )
    short = tool.execute({"prompt": " "})

    assert not missing.success
    assert "not found" in (missing.error or "")
    assert not short.success
    assert "prompt" in (short.error or "")
    assert calls["post"] == []


def test_estimate_cost_can_be_overridden_without_exposing_secrets(tool, monkeypatch):
    monkeypatch.setenv("ARK_SEEDREAM_CNY_PER_IMAGE", "0.44")
    monkeypatch.setenv("ARK_CNY_PER_USD", "8")

    assert tool.estimate_cost({}) == pytest.approx(0.055)


def test_tls_eof_is_retried_with_fresh_connections_and_same_idempotency_key(tool, tmp_path, monkeypatch):
    monkeypatch.setattr("tools.graphics.doubao_seedream_image.time.sleep", lambda _: None)
    calls, requests_module = _fake_requests_sequence(monkeypatch, [])
    # Build the first failure after the fake module exists, so it uses that
    # module's SSLError class instead of requests from the host environment.
    # Replace the queue-backed function with a deterministic two-step closure;
    # this keeps the asserted request headers visible for both attempts.
    post_calls = calls["post"]
    post_attempts = iter([
        requests_module._SSLError("UNEXPECTED_EOF_WHILE_READING"),
        _Response({"model": "ep-test", "data": [{"b64_json": base64.b64encode(b"PNG").decode("ascii")}]}, headers={"x-request-id": "retry-1"}),
    ])

    def post(url, **kwargs):
        post_calls.append({"url": url, **kwargs})
        action = next(post_attempts)
        if isinstance(action, BaseException):
            raise action
        return action

    requests_module.post = post
    output = tmp_path / "retry.png"
    result = tool.execute({
        "prompt": "电影级南北湖晨雾与山色",
        "scene_id": "shot-01",
        "model": "ep-test",
        "response_format": "b64_json",
        "output_path": str(output),
    })

    assert result.success, result.error
    assert output.read_bytes() == b"PNG"
    assert len(post_calls) == 2
    assert post_calls[0]["headers"]["Connection"] == "close"
    assert post_calls[1]["headers"]["Connection"] == "close"
    assert post_calls[0]["headers"]["Idempotency-Key"] == post_calls[1]["headers"]["Idempotency-Key"]
    assert result.data["network_attempts"] == {"generation": 2, "downloads": 0, "total": 2}


def test_exhausted_transport_retries_are_truthful_and_bounded(tool, tmp_path, monkeypatch):
    monkeypatch.setenv("ARK_IMAGE_MAX_RETRIES", "2")
    monkeypatch.setattr("tools.graphics.doubao_seedream_image.time.sleep", lambda _: None)
    calls, requests_module = _fake_requests_sequence(monkeypatch, [])
    attempts = {"count": 0}

    def post(url, **kwargs):
        calls["post"].append({"url": url, **kwargs})
        attempts["count"] += 1
        raise requests_module._SSLError("EOF after TLS handshake")

    requests_module.post = post
    result = tool.execute({
        "prompt": "南北湖湖湾",
        "scene_id": "shot-02",
        "output_path": str(tmp_path / "never-written.png"),
    })

    assert not result.success
    assert attempts["count"] == 3
    assert "transport failed after 3 attempt(s)" in (result.error or "")
    assert "自动重试 3 次" in (result.error or "")
    assert "ark-test-secret" not in (result.error or "")
    assert not (tmp_path / "never-written.png").exists()


def test_http_auth_failure_is_not_retried(tool, tmp_path, monkeypatch):
    response = _Response(status_code=401)
    calls = _fake_requests(monkeypatch, response, _Response())
    result = tool.execute({
        "prompt": "南北湖湖湾",
        "scene_id": "shot-03",
        "output_path": str(tmp_path / "auth.png"),
    })

    assert not result.success
    assert calls["post"] and len(calls["post"]) == 1
    assert "HTTP 401" in (result.error or "")
