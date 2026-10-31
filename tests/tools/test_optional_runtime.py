"""Unit tests for the isolated optional MediaPipe runtime bridge."""

from __future__ import annotations

import json
from types import SimpleNamespace
import sys
from unittest.mock import Mock

import pytest

from tools.base_tool import ToolResult, ToolStatus
from tools import optional_runtime
from tools.analysis.face_tracker import FaceTracker
from tools.enhancement.eye_enhance import EyeEnhance
from tools.video.auto_reframe import AutoReframe


@pytest.fixture(autouse=True)
def clear_health_cache(monkeypatch):
    monkeypatch.setattr(optional_runtime, "_health_cache", None)


def test_health_cache_expires_and_tracks_runtime_path(monkeypatch, tmp_path):
    first = tmp_path / "python-one"
    second = tmp_path / "python-two"
    for path in (first, second):
        path.touch()
        path.chmod(0o700)
    monkeypatch.setenv(optional_runtime.MEDIAPIPE_RUNTIME_ENV, str(first))
    clock = [10.0]
    monkeypatch.setattr(optional_runtime.time, "monotonic", lambda: clock[0])
    invoke = Mock(return_value=ToolResult(success=True, data={"mediapipe": True}))
    monkeypatch.setattr(optional_runtime, "_invoke_child", invoke)
    optional_runtime.optional_runtime_status()
    optional_runtime.optional_runtime_status()
    assert invoke.call_count == 1
    clock[0] = 26.0
    optional_runtime.optional_runtime_status()
    assert invoke.call_count == 2
    monkeypatch.setenv(optional_runtime.MEDIAPIPE_RUNTIME_ENV, str(second))
    optional_runtime.optional_runtime_status()
    assert invoke.call_count == 3


def test_failed_health_probe_is_not_cached(monkeypatch):
    monkeypatch.setenv(optional_runtime.MEDIAPIPE_RUNTIME_ENV, sys.executable)
    invoke = Mock(return_value=ToolResult(success=False))
    monkeypatch.setattr(optional_runtime, "_invoke_child", invoke)
    optional_runtime.optional_runtime_status()
    optional_runtime.optional_runtime_status()
    assert invoke.call_count == 2


def _wire_result(result: ToolResult) -> str:
    return json.dumps(
        {
            "success": result.success,
            "data": result.data,
            "artifacts": result.artifacts,
            "error": result.error,
            "cost_usd": result.cost_usd,
            "duration_seconds": result.duration_seconds,
            "seed": result.seed,
            "model": result.model,
        }
    )


def test_unconfigured_runtime_is_not_available(monkeypatch):
    monkeypatch.delenv(optional_runtime.MEDIAPIPE_RUNTIME_ENV, raising=False)
    monkeypatch.delenv(optional_runtime.OPTIONAL_RUNTIME_CHILD_ENV, raising=False)

    assert optional_runtime.configured_runtime_python() is None
    assert not optional_runtime.optional_runtime_configured()
    result = optional_runtime.run_optional_tool("face_tracker", {})
    assert not result.success
    assert "not configured" in (result.error or "")


def test_child_environment_removes_runtime_variable(monkeypatch):
    monkeypatch.setenv(optional_runtime.MEDIAPIPE_RUNTIME_ENV, sys.executable)
    fake = SimpleNamespace(
        returncode=0,
        stdout=_wire_result(ToolResult(success=True, data={"method": "mediapipe"})),
        stderr="secret should never be surfaced",
    )
    run = Mock(return_value=fake)
    monkeypatch.setattr(optional_runtime.subprocess, "run", run)

    result = optional_runtime.run_optional_tool("face_tracker", {"input_path": "x"})

    assert result.success
    child_env = run.call_args.kwargs["env"]
    assert optional_runtime.MEDIAPIPE_RUNTIME_ENV not in child_env
    assert child_env[optional_runtime.OPTIONAL_RUNTIME_CHILD_ENV] == "1"
    assert run.call_args.args[0][-2:] == ["-m", "tools.optional_runtime"]


def test_child_error_does_not_echo_stderr(monkeypatch):
    secret = "runtime-secret-value"
    monkeypatch.setenv(optional_runtime.MEDIAPIPE_RUNTIME_ENV, sys.executable)
    run = Mock(
        return_value=SimpleNamespace(
            returncode=7,
            stdout="",
            stderr=f"traceback contains {secret}",
        )
    )
    monkeypatch.setattr(optional_runtime.subprocess, "run", run)

    result = optional_runtime.run_optional_tool("eye_enhance", {})

    assert not result.success
    assert "code 7" in (result.error or "")
    assert secret not in (result.error or "")


def test_timeout_is_reported_as_failure(monkeypatch):
    monkeypatch.setenv(optional_runtime.MEDIAPIPE_RUNTIME_ENV, sys.executable)

    def timeout(*args, **kwargs):
        raise optional_runtime.subprocess.TimeoutExpired(args[0], kwargs["timeout"])

    monkeypatch.setattr(optional_runtime.subprocess, "run", timeout)
    result = optional_runtime.run_optional_tool("face_tracker", {})

    assert not result.success
    assert result.data == {"timed_out": True, "runtime": "isolated"}
    assert "timed out" in (result.error or "")


def test_unknown_tool_is_rejected_without_dynamic_import(monkeypatch):
    run = Mock()
    monkeypatch.setattr(optional_runtime.subprocess, "run", run)

    result = optional_runtime.run_optional_tool(
        "tools.some_user_module:SomeTool", {"input_path": "x"}
    )

    assert not result.success
    assert "allow-listed" in (result.error or "")
    run.assert_not_called()


def test_child_dispatch_uses_only_allow_list(monkeypatch):
    class FakeTool:
        def execute(self, inputs):
            assert inputs == {"input_path": "local.mp4"}
            return ToolResult(success=True, data={"ok": True})

    monkeypatch.setattr(optional_runtime, "_tool_class", lambda name: FakeTool)
    result = optional_runtime._child_dispatch(
        {
            "operation": "run",
            "tool": "face_tracker",
            "module": "user.supplied.module",
            "inputs": {"input_path": "local.mp4"},
        }
    )
    assert result.success
    assert result.data == {"ok": True}

    rejected = optional_runtime._child_dispatch(
        {
            "operation": "run",
            "tool": "user.supplied.module",
            "inputs": {},
        }
    )
    assert not rejected.success


def test_health_result_reports_missing_optional_modules(monkeypatch):
    # Importing an intentionally missing module is local and deterministic;
    # it avoids depending on whether the host happens to have MediaPipe.
    real_import = __import__

    def fake_import(name, *args, **kwargs):
        if name in {"cv2", "mediapipe"}:
            raise ImportError(name)
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", fake_import)
    result = optional_runtime._health_result()
    assert not result.success
    assert result.data["mediapipe"] is False
    assert result.data["opencv"] is False
    assert "mediapipe" in (result.error or "")


@pytest.mark.parametrize(
    ("module_name", "tool_class"),
    [
        ("tools.analysis.face_tracker", FaceTracker),
        ("tools.video.auto_reframe", AutoReframe),
        ("tools.enhancement.eye_enhance", EyeEnhance),
    ],
)
def test_target_tools_delegate_when_runtime_is_configured(
    monkeypatch, tmp_path, module_name, tool_class
):
    input_path = tmp_path / "input.mp4"
    input_path.touch()
    sentinel = ToolResult(success=True, data={"runtime": "isolated"})
    monkeypatch.setenv(optional_runtime.MEDIAPIPE_RUNTIME_ENV, sys.executable)
    monkeypatch.setattr(
        f"{module_name}.run_optional_tool",
        lambda name, inputs: sentinel,
    )

    result = tool_class().execute({"input_path": str(input_path)})

    assert result is sentinel


def test_face_tracker_status_uses_isolated_health(monkeypatch):
    monkeypatch.setattr(
        "tools.analysis.face_tracker.optional_runtime_configured", lambda: True
    )
    monkeypatch.setattr(
        "tools.analysis.face_tracker.optional_runtime_status",
        lambda: ToolResult(
            success=True,
            data={"mediapipe": True, "opencv": True},
        ),
    )
    assert FaceTracker().get_status() == ToolStatus.AVAILABLE


def test_eye_enhance_status_reports_degraded_when_mediapipe_missing(monkeypatch):
    monkeypatch.setattr(
        "tools.enhancement.eye_enhance.optional_runtime_configured", lambda: True
    )
    monkeypatch.setattr(
        "tools.enhancement.eye_enhance.optional_runtime_status",
        lambda: ToolResult(
            success=False,
            data={"mediapipe": False, "opencv": True},
            error="optional module unavailable",
        ),
    )
    monkeypatch.setattr(EyeEnhance, "_has_opencv", lambda self: True)
    assert EyeEnhance().get_status() == ToolStatus.DEGRADED
