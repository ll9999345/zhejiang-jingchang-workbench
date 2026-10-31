"""Bridge selected local tools to an optional isolated Python runtime.

The workbench currently runs on Python 3.13, while MediaPipe has no matching
Intel macOS wheel for that interpreter.  When
``OPENMONTAGE_MEDIAPIPE_PYTHON`` points at a separate interpreter, the small
JSON bridge in this module runs only the explicitly allow-listed local tools
there.  Media files stay on the same filesystem; no network transport is
involved.

The child process receives one JSON request on stdin and emits exactly one
JSON ``ToolResult`` object on stdout.  The configured runtime variable is
removed from the child environment (and a child sentinel is set) so the
delegated tool cannot call the bridge recursively.
"""

from __future__ import annotations

import contextlib
import copy
import dataclasses
import io
import json
import math
import os
from pathlib import Path
import platform
import subprocess
import sys
import time
from typing import Any

from tools.base_tool import ToolResult


MEDIAPIPE_RUNTIME_ENV = "OPENMONTAGE_MEDIAPIPE_PYTHON"
OPTIONAL_RUNTIME_CHILD_ENV = "OPENMONTAGE_OPTIONAL_RUNTIME_CHILD"

# Keep these names in one static map.  The request must never be able to
# import an arbitrary module or class supplied by a caller.
OPTIONAL_RUNTIME_TOOLS = frozenset(
    {"face_tracker", "auto_reframe", "eye_enhance"}
)

DEFAULT_RUNTIME_TIMEOUT_SECONDS = 900.0
HEALTHCHECK_TIMEOUT_SECONDS = 10.0
MAX_RUNTIME_TIMEOUT_SECONDS = 1800.0

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_health_cache: tuple[tuple[str, int, int], float, ToolResult] | None = None


def _tool_class(tool_name: str) -> type:
    """Resolve one of the fixed child-tool classes.

    This is deliberately written as an explicit branch instead of importing
    a user-supplied module path.
    """

    if tool_name == "face_tracker":
        from tools.analysis.face_tracker import FaceTracker

        return FaceTracker
    if tool_name == "auto_reframe":
        from tools.video.auto_reframe import AutoReframe

        return AutoReframe
    if tool_name == "eye_enhance":
        from tools.enhancement.eye_enhance import EyeEnhance

        return EyeEnhance
    raise ValueError("tool is not allow-listed")


def configured_runtime_python() -> Path | None:
    """Return the configured executable, or ``None`` when it is unusable."""

    if os.environ.get(OPTIONAL_RUNTIME_CHILD_ENV, "").strip() == "1":
        return None
    raw = os.environ.get(MEDIAPIPE_RUNTIME_ENV, "").strip()
    if not raw:
        return None
    path = Path(raw).expanduser()
    if not path.is_absolute() or not path.is_file() or not os.access(path, os.X_OK):
        return None
    return path


def optional_runtime_configured() -> bool:
    """Whether a valid isolated-runtime executable is configured."""

    return configured_runtime_python() is not None


def _failure(message: str, *, data: dict[str, Any] | None = None) -> ToolResult:
    """Build a bridge error without echoing subprocess output or inputs."""

    return ToolResult(success=False, data=data or {}, error=message)


def _timeout_seconds(timeout: float | int | None) -> float:
    if timeout is None:
        return DEFAULT_RUNTIME_TIMEOUT_SECONDS
    try:
        value = float(timeout)
    except (TypeError, ValueError):
        return DEFAULT_RUNTIME_TIMEOUT_SECONDS
    if not math.isfinite(value) or value <= 0:
        return DEFAULT_RUNTIME_TIMEOUT_SECONDS
    return min(value, MAX_RUNTIME_TIMEOUT_SECONDS)


def _child_environment() -> dict[str, str]:
    """Prepare a child environment while preventing bridge recursion."""

    child_env = os.environ.copy()
    # Removing this variable is the primary recursion guard.  The sentinel is
    # also needed because BaseTool's dotenv loader may reload the variable
    # from .env when the child imports a tool module.
    child_env.pop(MEDIAPIPE_RUNTIME_ENV, None)
    child_env[OPTIONAL_RUNTIME_CHILD_ENV] = "1"
    child_env["PYTHONUNBUFFERED"] = "1"
    current_pythonpath = child_env.get("PYTHONPATH", "")
    child_env["PYTHONPATH"] = (
        str(_PROJECT_ROOT)
        if not current_pythonpath
        else str(_PROJECT_ROOT) + os.pathsep + current_pythonpath
    )
    return child_env


def _result_payload(result: ToolResult) -> dict[str, Any]:
    """Convert a ToolResult to the wire format used by the child."""

    return dataclasses.asdict(result)


def _decode_result(payload: Any) -> ToolResult:
    """Validate and decode one child JSON result."""

    if not isinstance(payload, dict) or not isinstance(payload.get("success"), bool):
        raise ValueError("child response is not a ToolResult")

    data = payload.get("data", {})
    artifacts = payload.get("artifacts", [])
    error = payload.get("error")
    if not isinstance(data, dict) or not isinstance(artifacts, list):
        raise ValueError("child response has invalid ToolResult fields")
    if any(not isinstance(item, str) for item in artifacts):
        raise ValueError("child response has invalid artifact paths")
    if error is not None and not isinstance(error, str):
        raise ValueError("child response has invalid error field")

    numeric_fields: dict[str, float | int | None] = {}
    for field_name, default in (
        ("cost_usd", 0.0),
        ("duration_seconds", 0.0),
        ("seed", None),
    ):
        value = payload.get(field_name, default)
        if value is not None and not isinstance(value, (int, float)):
            raise ValueError(f"child response has invalid {field_name}")
        numeric_fields[field_name] = value

    return ToolResult(
        success=payload["success"],
        data=data,
        artifacts=artifacts,
        error=error,
        cost_usd=float(numeric_fields["cost_usd"] or 0.0),
        duration_seconds=float(numeric_fields["duration_seconds"] or 0.0),
        seed=(
            int(numeric_fields["seed"])
            if numeric_fields["seed"] is not None
            else None
        ),
        model=(payload.get("model") if isinstance(payload.get("model"), str) else None),
    )


def _invoke_child(payload: dict[str, Any], *, timeout: float | int | None) -> ToolResult:
    """Send one request to the configured interpreter and decode its result."""

    runtime_python = configured_runtime_python()
    if runtime_python is None:
        return _failure(
            f"Optional MediaPipe runtime is not configured; set {MEDIAPIPE_RUNTIME_ENV} "
            "to an executable Python 3.11/3.12 environment."
        )

    try:
        request = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        return _failure("Optional runtime inputs must be JSON serializable.")

    command = [str(runtime_python), "-m", "tools.optional_runtime"]
    try:
        completed = subprocess.run(
            command,
            input=request,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=_timeout_seconds(timeout),
            cwd=_PROJECT_ROOT,
            env=_child_environment(),
            check=False,
        )
    except subprocess.TimeoutExpired:
        return _failure(
            f"Optional MediaPipe runtime timed out after {_timeout_seconds(timeout):g} seconds.",
            data={"timed_out": True, "runtime": "isolated"},
        )
    except FileNotFoundError:
        return _failure("Optional MediaPipe runtime executable is unavailable.")
    except OSError:
        # Do not expose OS error text: it may contain environment-specific
        # paths or command-line details.
        return _failure("Optional MediaPipe runtime could not be started.")

    if completed.returncode != 0:
        # stderr is intentionally discarded.  It may contain library paths,
        # environment values, or other data that must not reach the caller.
        return _failure(
            f"Optional MediaPipe runtime exited with code {completed.returncode}.",
            data={"returncode": completed.returncode, "runtime": "isolated"},
        )

    stdout = (completed.stdout or "").strip()
    if not stdout:
        return _failure("Optional MediaPipe runtime returned no JSON result.")
    try:
        payload_result = json.loads(stdout)
        return _decode_result(payload_result)
    except (json.JSONDecodeError, ValueError, TypeError):
        # Do not echo stdout: a misbehaving dependency could have printed
        # arbitrary text, including sensitive values, before the JSON.
        return _failure("Optional MediaPipe runtime returned invalid JSON.")


def run_optional_tool(
    tool_name: str,
    inputs: dict[str, Any],
    *,
    timeout: float | int | None = None,
) -> ToolResult:
    """Run one allow-listed tool in the configured isolated runtime."""

    if tool_name not in OPTIONAL_RUNTIME_TOOLS:
        return _failure("Requested tool is not allow-listed for the optional runtime.")
    if not isinstance(inputs, dict):
        return _failure("Optional runtime inputs must be an object.")
    return _invoke_child(
        {"operation": "run", "tool": tool_name, "inputs": inputs},
        timeout=timeout,
    )


def optional_runtime_status(*, timeout: float | int | None = None) -> ToolResult:
    """Probe MediaPipe/OpenCV availability in the isolated runtime."""

    global _health_cache
    runtime = configured_runtime_python()
    if runtime is None:
        _health_cache = None
        return _failure("Optional MediaPipe runtime is not configured.")
    try:
        stat = runtime.stat()
        key = (str(runtime), stat.st_mtime_ns, stat.st_size)
    except OSError:
        _health_cache = None
        return _failure("Optional MediaPipe runtime executable is unavailable.")
    # Cache successful discovery briefly; execution still starts a fresh child.
    # An explicit timeout requests a fresh probe, useful for diagnostics.
    if timeout is None and _health_cache is not None:
        cached_key, recorded_at, result = _health_cache
        if cached_key == key and time.monotonic() - recorded_at < 15:
            return copy.deepcopy(result)
    result = _invoke_child(
        {"operation": "health"},
        timeout=HEALTHCHECK_TIMEOUT_SECONDS if timeout is None else timeout,
    )
    _health_cache = (key, time.monotonic(), copy.deepcopy(result)) if result.success else None
    return result


def optional_runtime_has(module_name: str) -> bool:
    """Return a truthful module capability from the isolated health probe."""

    if module_name not in {"mediapipe", "opencv"}:
        return False
    result = optional_runtime_status()
    return bool(result.data.get(module_name))


def _health_result() -> ToolResult:
    """Run inside the child and report imports without leaking exceptions."""

    data: dict[str, Any] = {
        "runtime": "isolated",
        "python_version": platform.python_version(),
        "mediapipe": False,
        "opencv": False,
    }
    try:
        import cv2

        data["opencv"] = True
        data["opencv_version"] = str(getattr(cv2, "__version__", "unknown"))
    except Exception:
        data["opencv_error"] = "unavailable"

    try:
        import mediapipe

        data["mediapipe"] = True
        data["mediapipe_version"] = str(
            getattr(mediapipe, "__version__", "unknown")
        )
    except Exception:
        data["mediapipe_error"] = "unavailable"

    healthy = bool(data["mediapipe"] and data["opencv"])
    missing = [
        name
        for name in ("mediapipe", "opencv")
        if not data[name]
    ]
    if healthy:
        return ToolResult(success=True, data=data)
    return ToolResult(
        success=False,
        data=data,
        error="Optional runtime dependencies unavailable: " + ", ".join(missing),
    )


def _child_dispatch(request: Any) -> ToolResult:
    """Dispatch a decoded request using only the static tool allow-list."""

    if not isinstance(request, dict):
        return _failure("Optional runtime request must be a JSON object.")

    operation = request.get("operation")
    if operation == "health":
        return _health_result()
    if operation != "run":
        return _failure("Optional runtime operation is invalid.")

    tool_name = request.get("tool")
    inputs = request.get("inputs")
    if not isinstance(tool_name, str) or tool_name not in OPTIONAL_RUNTIME_TOOLS:
        return _failure("Requested tool is not allow-listed for the optional runtime.")
    if not isinstance(inputs, dict):
        return _failure("Optional runtime inputs must be an object.")

    try:
        tool = _tool_class(tool_name)()
        # A dependency may write progress to either stream.  Keep the wire
        # protocol strict and discard those streams before emitting JSON.
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(
            io.StringIO()
        ):
            result = tool.execute(inputs)
    except Exception:
        return _failure("Optional runtime tool execution failed.")

    if not isinstance(result, ToolResult):
        return _failure("Optional runtime tool returned an invalid result.")
    return result


def main() -> int:
    """CLI entry point for the stdin/stdout JSON protocol."""

    try:
        request = json.load(sys.stdin)
        result = _child_dispatch(request)
        output = json.dumps(
            _result_payload(result),
            ensure_ascii=False,
            separators=(",", ":"),
            default=str,
        )
    except (json.JSONDecodeError, UnicodeDecodeError):
        output = json.dumps(
            _result_payload(_failure("Optional runtime request was invalid JSON.")),
            ensure_ascii=False,
            separators=(",", ":"),
        )
    except Exception:
        # Keep protocol failures truthful and generic.  In particular, do not
        # write traceback text to stderr or include it in the JSON response.
        output = json.dumps(
            _result_payload(_failure("Optional runtime bridge failed.")),
            ensure_ascii=False,
            separators=(",", ":"),
        )

    sys.stdout.write(output)
    sys.stdout.flush()
    return 0


if __name__ == "__main__":  # pragma: no cover - exercised by subprocess tests
    raise SystemExit(main())
