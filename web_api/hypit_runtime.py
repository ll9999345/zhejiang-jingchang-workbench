"""Safe access to the pinned Hypit distribution.

This module is deliberately a small boundary around the official checkout in
``integrations/hypit/upstream``.  It does not import the TypeScript workspace
or copy any of its implementation into OpenMontage.  Native CLI commands are
passed to the pinned upstream launcher with ``shell=False`` and the selected
Hypit project as the working directory. OpenMontage-owned helpers keep their
own explicit project-path checks.

The adapter reports three different facts separately:

* a Hypit command was accepted and exited successfully;
* an asynchronous adapter job reached a terminal state; and
* a local media file was discovered and inspected at the adapter boundary.

The first two facts do not imply that a finished video was reviewed.  Remote
model work also remains blocked until the selected Runtime Profile has an
available credential.  Secrets are read from the environment only when the
child process is started and are never persisted or returned to callers.
"""

from __future__ import annotations

import asyncio
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import queue
import re
import shutil
import shlex
import subprocess
import threading
import time
from typing import Any, Callable, Iterable, Literal, Mapping, Protocol, Sequence
from urllib.parse import urlsplit, urlunsplit
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from web_api.hypit_bridge import HypitBridgeOptions, export_hypit_package

# The checkout and revision are part of the integration contract.  Keeping the
# default path derived from this file prevents a request from selecting an
# arbitrary executable elsewhere on the machine.
HYPIT_COMMIT = "9c9918d0cedf2f06574ab0d517b1b6b0afb56a66"
HYPIT_VERSION = "0.2.12"
HYPIT_LICENSE = "Hypit Open Source License"
HYPIT_ROOT = Path(__file__).resolve().parents[1] / "integrations" / "hypit" / "upstream"
HYPIT_LAUNCHER = HYPIT_ROOT / "bin" / "hypit.mjs"
# These are command dialects verified against fixed distributions, not a
# promise that every checkout with a matching package version is unmodified.
HYPIT_DIALECTS = {"0.2.12": "--workspace", "0.3.1": "--project"}
HYPIT_REFERENCE_COMMITS = {
    HYPIT_VERSION: HYPIT_COMMIT,
    "0.3.1": "0d36de9a9d17562fca0e478969b80eb1c16a7693",
}

JOB_PREFIX = "hypit-"
JOB_RE = re.compile(r"^hypit-[a-f0-9]{24}$")
PROJECT_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
BUILD_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$")
SAFE_RELATIVE_RE = re.compile(r"^[^\\\x00]+$")
TERMINAL = frozenset({
    "completed",
    "build_completed",
    "failed",
    "cancelled",
    "needs_attention",
    "interrupted",
    "awaiting_authorization",
    "authorization_required",
    "dry_run",
    "plan_required",
    "preflight_failed",
})
MEDIA_SUFFIXES = frozenset({".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".wav", ".mp3", ".m4a"})
SOURCE_SUFFIXES = frozenset({".svml", ".svs", ".svrun"})

# These names are workbench conveniences. The complete native CLI entry point
# below passes supported commands to the pinned Hypit distribution unchanged.
HYPIT_ACTIONS = (
    "example_import",
    "bridge_export",
    "project_init",
    "project_select",
    "check",
    "plan",
    "studio",
    "build",
    "builds",
    "history",
    "build_status",
    "inspect",
    "get",
    "doctor",
    "cancel",
    "native_cli",
)
HYPIT_ACTION_SET = frozenset(HYPIT_ACTIONS)

SENSITIVE_KEY_RE = re.compile(
    r"(?:api[_-]?key|access[_-]?token|(?:^|[_-])key(?:$|[_-])|(?:^|[_-])token(?:$|[_-])|auth(?:orization)?|secret|password|credential|private[_-]?key|bearer)",
    re.IGNORECASE,
)
BEARER_RE = re.compile(r"(?i)(authorization\s*[:=]\s*bearer\s+)\S+")
DATA_URI_RE = re.compile(r"(?i)data:(?:image|audio|video)/[^;\s]+;base64,[A-Za-z0-9+/=]+")
URL_RE = re.compile(r"https?://[^\s'\"<>]+", re.IGNORECASE)

# The set is intentionally descriptive as well as executable.  No request
# field can become an argv fragment; each entry is generated below.
OPERATIONS = (
    "status",
    "doctor",
    "catalog",
    "examples",
    "example_import",
    "bridge_export",
    "manifest",
    "manifest_validate",
    # Direct native Hypit CLI operations used by the workbench.
    "check",
    "plan",
    "studio",
    "build",
    "builds",
    "history",
    "build_status",
    "inspect",
    "get",
    # Older local names remain accepted for compatibility with saved links.
    "validate",
    "compile",
    "preview",
    "render",
        "run",
    "cancel",
    "studio_status",
    "studio_start",
    # Exact upstream CLI entry point. This forwards argv to the pinned Hypit
    # executable with shell=False; the workbench does not reinterpret SVML.
    "native_cli",
    # Stable aliases used by callers that prefer the longer resource names.
    "project_manifest",
    "validate_manifest",
)
OPERATION_SET = frozenset(OPERATIONS)
OPERATION_ALIASES = {
    "project_manifest": "manifest",
    "validate_manifest": "manifest_validate",
    "validate": "check",
    "compile": "plan",
    "preview": "studio",
    "render": "build",
    "run": "build",
}
UPSTREAM_COMMANDS = frozenset({
    "check", "plan", "pricing", "build", "builds", "history", "logs", "status", "inspect", "get",
    "result edit", "doctor", "runtime", "programs", "packages", "activity", "cancel", "paths", "auth",
    "version", "transcribe", "measure", "snapshot", "studio", "media", "capture", "vocabulary",
})

NATIVE_PAID_COMMANDS = frozenset({"build", "transcribe", "snapshot"})


class HypitRuntimeError(ValueError):
    """A safe, user-facing adapter error."""


class CommandRunner(Protocol):
    def __call__(
        self,
        argv: Sequence[str],
        *,
        cwd: Path,
        env: Mapping[str, str],
        cancel_event: threading.Event,
    ) -> "CommandResult": ...


@dataclass(frozen=True)
class CommandResult:
    argv: tuple[str, ...]
    returncode: int | None
    stdout: str = ""
    stderr: str = ""
    cancelled: bool = False
    timed_out: bool = False
    duration_seconds: float = 0.0


@dataclass(frozen=True)
class HypitSettings:
    """Safe runtime configuration.

    ``project_root`` is a directory containing allowed project directories.
    ``hypit_root`` is injectable for tests, while production callers use the
    fixed checkout default above.  The service still requires the launcher to
    live under the selected checkout.
    """

    project_root: Path
    hypit_root: Path = HYPIT_ROOT
    max_jobs: int = 4
    command_timeout_seconds: float = 900.0
    output_limit: int = 256 * 1024
    node_executable: str = "node"
    state_home: Path | None = None

    @classmethod
    def from_env(
        cls,
        project_root: str | Path | None = None,
        *,
        hypit_root: str | Path | None = None,
    ) -> "HypitSettings":
        root_value = project_root if project_root is not None else os.environ.get("OPENMONTAGE_HYPIT_PROJECT_ROOT")
        resolved_project = Path(root_value).expanduser() if root_value else HYPIT_ROOT.parents[2]
        checkout = Path(hypit_root).expanduser() if hypit_root else HYPIT_ROOT
        raw_jobs = os.environ.get("OPENMONTAGE_HYPIT_MAX_JOBS", "4")
        try:
            max_jobs = max(1, min(16, int(raw_jobs)))
        except (TypeError, ValueError):
            max_jobs = 4
        raw_timeout = os.environ.get("OPENMONTAGE_HYPIT_COMMAND_TIMEOUT", "900")
        try:
            timeout = float(raw_timeout)
        except (TypeError, ValueError):
            timeout = 900.0
        if not math.isfinite(timeout) or timeout <= 0:
            timeout = 900.0
        return cls(
            project_root=resolved_project.resolve(strict=False),
            hypit_root=checkout.resolve(strict=False),
            max_jobs=max_jobs,
            command_timeout_seconds=timeout,
        )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json_safe(value: Any, *, limit: int = 256 * 1024) -> Any:
    """Convert provider/CLI shaped values to strict JSON-friendly values."""

    if value is None or isinstance(value, (str, int, bool)):
        if isinstance(value, str) and len(value) > limit:
            return value[:limit] + "…[truncated]"
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, Mapping):
        return {str(key): _json_safe(item, limit=limit) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(item, limit=limit) for item in value]
    return str(value)


def _secret_values() -> tuple[str, ...]:
    """Read only values that are already explicitly present in the environment."""

    # A value can be present in a profile's env CredentialStore.  We do not
    # enumerate the full environment here; this list is used solely for
    # redacting accidental child-process diagnostics.
    names = {
        name
        for name in os.environ
        if SENSITIVE_KEY_RE.search(name)
        or name.endswith(("_KEY", "_TOKEN", "_SECRET", "_PASSWORD"))
    }
    return tuple(value for name in names if (value := os.environ.get(name)))


def _safe_error(error: Any) -> str:
    message = str(error or "Hypit operation failed")
    for secret in _secret_values():
        message = message.replace(secret, "[redacted]")
    message = DATA_URI_RE.sub("[redacted data URI]", message)
    message = BEARER_RE.sub(r"\1[redacted]", message)

    def clean_url(match: re.Match[str]) -> str:
        raw = match.group(0)
        trailing = ""
        while raw and raw[-1] in ".,;:)]}":
            trailing = raw[-1] + trailing
            raw = raw[:-1]
        try:
            parsed = urlsplit(raw)
            host = parsed.hostname or ""
            if parsed.port:
                host = f"{host}:{parsed.port}"
            return urlunsplit((parsed.scheme, host, parsed.path, "", "")) + trailing
        except ValueError:
            return "[redacted URL]"

    message = URL_RE.sub(clean_url, message)
    return message if len(message) <= 256 * 1024 else message[-256 * 1024:]


def _redact(value: Any, *, key: str | None = None) -> Any:
    # ``authorization`` is also the public, non-secret readiness section that
    # this adapter returns.  Its nested credential references contain no
    # values, so keep that metadata while still redacting actual auth tokens.
    if key and SENSITIVE_KEY_RE.search(key) and key.lower() not in {"authorization"}:
        return "[redacted]"
    if isinstance(value, Mapping):
        return {str(item_key): _redact(item, key=str(item_key)) for item_key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_redact(item, key=key) for item in value]
    if isinstance(value, str):
        result = value
        for secret in _secret_values():
            result = result.replace(secret, "[redacted]")
        if key in {"error", "message", "stderr", "stdout", "command", "command_line", "argv"}:
            return _safe_error(result) if result else ""
        return result
    return _json_safe(value)


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.part")
    with temporary.open("x", encoding="utf-8") as handle:
        json.dump(_redact(value), handle, ensure_ascii=False, indent=2, allow_nan=False)
        handle.write("\n")
    os.replace(temporary, path)


def _read_json(path: Path) -> dict[str, Any]:
    try:
        raw = json.loads(path.read_text("utf-8"))
    except (OSError, UnicodeError, ValueError):
        return {}
    return raw if isinstance(raw, dict) else {}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _relative(path: Path, root: Path) -> str:
    return path.resolve(strict=False).relative_to(root.resolve(strict=False)).as_posix()


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.resolve(strict=False).relative_to(root.resolve(strict=False))
        return True
    except ValueError:
        return False


def _extract_json(stdout: str) -> Any:
    """Parse JSON output even when a CLI emits a short human banner first."""

    text = str(stdout or "").strip()
    if not text:
        return None
    candidates = [text]
    candidates.extend(line.strip() for line in reversed(text.splitlines()) if line.strip())
    for candidate in candidates:
        try:
            return json.loads(candidate)
        except (TypeError, ValueError):
            continue
    return None


def _run_subprocess(
    argv: Sequence[str],
    *,
    cwd: Path,
    env: Mapping[str, str],
    cancel_event: threading.Event,
    timeout_seconds: float = 900.0,
    output_limit: int = 256 * 1024,
) -> CommandResult:
    """Run one already-whitelisted argv without invoking a shell."""

    started = time.monotonic()
    process: subprocess.Popen[str] | None = None
    try:
        process = subprocess.Popen(
            list(argv),
            cwd=str(cwd),
            env=dict(env),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            shell=False,
        )
        timed_out = False
        while True:
            if cancel_event.is_set() and process.poll() is None:
                process.terminate()
                try:
                    stdout, stderr = process.communicate(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    stdout, stderr = process.communicate()
                return CommandResult(
                    tuple(argv), process.returncode, stdout[-output_limit:], stderr[-output_limit:],
                    cancelled=True, duration_seconds=time.monotonic() - started,
                )
            try:
                stdout, stderr = process.communicate(timeout=0.2)
                return CommandResult(
                    tuple(argv), process.returncode, stdout[-output_limit:], stderr[-output_limit:],
                    duration_seconds=time.monotonic() - started,
                )
            except subprocess.TimeoutExpired:
                if time.monotonic() - started > timeout_seconds:
                    timed_out = True
                    process.terminate()
                    try:
                        stdout, stderr = process.communicate(timeout=2)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        stdout, stderr = process.communicate()
                    return CommandResult(
                        tuple(argv), process.returncode, stdout[-output_limit:], stderr[-output_limit:],
                        timed_out=timed_out, duration_seconds=time.monotonic() - started,
                    )
    except FileNotFoundError as exc:
        return CommandResult(tuple(argv), 127, stderr=_safe_error(exc), duration_seconds=time.monotonic() - started)
    except OSError as exc:
        return CommandResult(tuple(argv), 126, stderr=_safe_error(exc), duration_seconds=time.monotonic() - started)


def _safe_env(profile: Mapping[str, Any] | None = None) -> dict[str, str]:
    """Pass PATH and explicitly requested environment credentials only.

    Hypit's env CredentialStore resolves a named variable on demand.  Keeping
    the child environment narrow prevents unrelated Host secrets from being
    inherited by a local command while preserving the official store contract.
    """

    names = {"PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM", "NO_COLOR", "PUPPETEER_CACHE_DIR"}
    if isinstance(profile, Mapping):
        def visit(value: Any, parent_key: str | None = None) -> None:
            if isinstance(value, Mapping):
                # The official profile writes {"store": "env", "key": "ENV_NAME"}.
                if value.get("store") == "env" and isinstance(value.get("key"), str):
                    names.add(str(value["key"]))
                for item_key, item in value.items():
                    visit(item, str(item_key))
            elif isinstance(value, list):
                for item in value:
                    visit(item, parent_key)
        visit(profile)
    return {name: value for name in names if (value := os.environ.get(name)) is not None}


def _profile_env_keys(profile: Mapping[str, Any]) -> set[str]:
    keys: set[str] = set()
    def visit(value: Any) -> None:
        if isinstance(value, Mapping):
            if value.get("store") == "env" and isinstance(value.get("key"), str):
                keys.add(str(value["key"]))
            for item in value.values():
                visit(item)
        elif isinstance(value, list):
            for item in value:
                visit(item)
    visit(profile)
    return keys


def _provider_is_local(provider: str) -> bool:
    value = provider.lower()
    return value.endswith("-local") or value in {
        "@hypit/provider-media-local",
        "@hypit/provider-hyperframes-local",
        "@hypit/provider-whisperx-local",
        "@hypit/provider-image-opencv-local",
        "@hypit/provider-yt-dlp-local",
    }


def _file_record(path: Path, root: Path, *, include_json: bool = False) -> dict[str, Any]:
    record: dict[str, Any] = {"path": _relative(path, root), "exists": path.is_file()}
    if not path.is_file():
        return record
    try:
        stat = path.stat()
        record.update({"bytes": stat.st_size, "sha256": _sha256(path)})
    except OSError as exc:
        record["error"] = _safe_error(exc)
    if include_json and path.suffix.lower() == ".json":
        raw = _read_json(path)
        record["json"] = _redact(raw)
    return record


@dataclass
class HypitRuntime:
    """Service facade and job owner for the pinned Hypit checkout."""

    project_root: Path = HYPIT_ROOT.parents[2]
    hypit_root: Path = HYPIT_ROOT
    executor: Any | None = None
    runner: CommandRunner | None = None
    settings: HypitSettings | None = None
    _active: dict[str, threading.Event] = field(default_factory=dict, init=False, repr=False)
    _futures: dict[str, Future[Any]] = field(default_factory=dict, init=False, repr=False)
    _studio_processes: dict[str, subprocess.Popen[str]] = field(default_factory=dict, init=False, repr=False)
    _lock: threading.RLock = field(default_factory=threading.RLock, init=False, repr=False)

    def __post_init__(self) -> None:
        config = self.settings or HypitSettings(
            project_root=Path(self.project_root).expanduser().resolve(strict=False),
            hypit_root=Path(self.hypit_root).expanduser().resolve(strict=False),
        )
        self.settings = config
        self.project_root = config.project_root
        self.hypit_root = config.hypit_root
        package = _read_json(self.hypit_root / "package.json")
        self.distribution_version = str(package.get("version") or HYPIT_VERSION)
        self.executor = self.executor or ThreadPoolExecutor(
            max_workers=config.max_jobs, thread_name_prefix="hypit-runtime"
        )
        self.runner = self.runner or _run_subprocess

    @property
    def project_option(self) -> str:
        try:
            return HYPIT_DIALECTS[self.distribution_version]
        except KeyError:
            raise HypitRuntimeError(f"尚未验证 Hypit {self.distribution_version} 的命令契约；没有执行命令") from None

    def _command_env(self, project: Path | None = None) -> dict[str, str]:
        env = _safe_env(self._profile(project) if project else None)
        if self.settings.state_home is not None:
            env["HYPIT_STATE_HOME"] = str(self.settings.state_home.resolve(strict=False))
        executable = self.settings.node_executable
        if Path(executable).is_absolute():
            env["PATH"] = str(Path(executable).parent) + os.pathsep + env.get("PATH", os.defpath)
        return env

    def _jobs_base(self, project: Path) -> Path:
        base = project / "artifacts" / "hypit_jobs"
        # Preserve legacy receipts; a second-version manager must never mark
        # another version's active job interrupted while listing its own jobs.
        return base if self.distribution_version == HYPIT_VERSION else base / ("v" + hashlib.sha256(self.distribution_version.encode()).hexdigest()[:16])

    @classmethod
    def from_env(
        cls,
        project_root: str | Path | None = None,
        *,
        hypit_root: str | Path | None = None,
        executor: Any | None = None,
        runner: CommandRunner | None = None,
    ) -> "HypitRuntime":
        settings = HypitSettings.from_env(project_root, hypit_root=hypit_root)
        return cls(
            settings.project_root,
            hypit_root=settings.hypit_root,
            executor=executor,
            runner=runner,
            settings=settings,
        )

    def close(self, *, wait: bool = True) -> None:
        """Stop accepting adapter work; running child processes remain governed by their jobs."""

        shutdown = getattr(self.executor, "shutdown", None)
        if callable(shutdown):
            shutdown(wait=wait, cancel_futures=False)

    # ---- Scope and metadata -------------------------------------------------

    def _checkout_launcher(self) -> Path:
        launcher = (self.hypit_root / "bin" / "hypit.mjs").resolve(strict=False)
        if not _is_within(launcher, self.hypit_root) or launcher.name != "hypit.mjs":
            raise HypitRuntimeError("Hypit checkout launcher is outside the pinned checkout")
        return launcher

    def project(self, project: str | Path | None = None) -> Path:
        raw = self.project_root if project is None else Path(project)
        if not isinstance(raw, Path):
            raw = Path(raw)
        candidate = raw.expanduser() if raw.is_absolute() else self.project_root / raw
        resolved = candidate.resolve(strict=False)
        if not _is_within(resolved, self.project_root):
            raise HypitRuntimeError("Hypit project path must remain inside the configured project root")
        if not resolved.is_dir():
            raise HypitRuntimeError("Hypit project directory does not exist")
        return resolved

    def project_id(self, project: Path) -> str:
        if project == self.project_root:
            return "."
        try:
            relative = project.relative_to(self.project_root)
        except ValueError as exc:
            raise HypitRuntimeError("Hypit project path must remain inside the configured project root") from exc
        if len(relative.parts) != 1 or not PROJECT_ID_RE.fullmatch(relative.name):
            raise HypitRuntimeError("Hypit project id is invalid")
        return relative.name

    def _job_directory(self, project: Path, job_id: str) -> Path:
        if not JOB_RE.fullmatch(job_id):
            raise HypitRuntimeError("Hypit job id is invalid")
        directory = (self._jobs_base(project) / job_id).resolve(strict=False)
        if not _is_within(directory, project):
            raise HypitRuntimeError("Hypit job path escaped the project")
        return directory

    def _safe_file(self, project: Path, raw: str, *, suffixes: Iterable[str] = ()) -> Path:
        value = str(raw or "").strip()
        path = Path(value)
        if not value or path.is_absolute() or ".." in path.parts or not SAFE_RELATIVE_RE.fullmatch(value):
            raise HypitRuntimeError("Hypit source path must be a relative project path")
        resolved = (project / path).resolve(strict=False)
        if not _is_within(resolved, project):
            raise HypitRuntimeError("Hypit source path escaped the project")
        allowed = {str(item).lower() for item in suffixes}
        if allowed and resolved.suffix.lower() not in allowed:
            raise HypitRuntimeError("Hypit source path has an unsupported suffix")
        if not resolved.is_file():
            raise HypitRuntimeError("Hypit source file does not exist in the project")
        return resolved

    def _profile_path(self, project: Path) -> Path | None:
        explicit = project / "hypit.runtime.json"
        if explicit.is_file():
            resolved = explicit.resolve(strict=False)
            return resolved if _is_within(resolved, project) else None
        selection = project / ".hypit" / "runtime"
        try:
            selected = selection.read_text("utf-8").strip()
        except (OSError, UnicodeError):
            return None
        if not selected:
            return None
        candidate = Path(selected)
        if not candidate.is_absolute():
            candidate = project / candidate
        candidate = candidate.resolve(strict=False)
        return candidate if _is_within(candidate, project) and candidate.is_file() else None

    def _profile(self, project: Path) -> dict[str, Any]:
        path = self._profile_path(project)
        return _read_json(path) if path else {}

    def _authorization(self, project: Path, profile: Mapping[str, Any] | None = None) -> dict[str, Any]:
        current = profile if profile is not None else self._profile(project)
        endpoints = current.get("endpoints") if isinstance(current, Mapping) else None
        endpoints = endpoints if isinstance(endpoints, Mapping) else {}
        remote: list[dict[str, Any]] = []
        local: list[dict[str, Any]] = []
        missing: list[dict[str, Any]] = []
        configured: list[dict[str, Any]] = []
        credential_keys = _profile_env_keys(current) if isinstance(current, Mapping) else set()
        for endpoint, item in endpoints.items():
            if not isinstance(item, Mapping):
                continue
            provider = str(item.get("use") or "unknown")
            record = {"endpoint": str(endpoint), "provider": provider}
            if _provider_is_local(provider):
                local.append(record)
                continue
            remote.append(record)
            if credential_keys:
                # An env store is ready only when every explicitly requested
                # variable is present. Values themselves never leave env.
                endpoint_keys = _profile_env_keys(item)
                if endpoint_keys and all(os.environ.get(key) for key in endpoint_keys):
                    configured.append(record)
                    continue
            # Platform/OS/File stores cannot be inspected by this boundary.
            # They intentionally remain pending until the official CLI doctor
            # or auth flow is explicitly used by an authorized user.
            missing.append(record)
        if missing:
            state = "awaiting_authorization"
        elif remote and not configured:
            state = "awaiting_authorization"
        elif not current:
            state = "runtime_not_selected"
        else:
            state = "ready"
        return {
            "state": state,
            "external_endpoints": remote,
            "local_endpoints": local,
            "configured_external_endpoints": configured,
            "missing_external_endpoints": missing,
            "profile_present": bool(current),
            "environment_keys_present": sorted(key for key in credential_keys if os.environ.get(key)),
        }

    def _plan_authorization(self, project: Path, plan: Mapping[str, Any]) -> dict[str, Any]:
        """Check only the external Endpoints demanded by one official plan.

        A Runtime Profile may contain several unrelated remote Endpoints.  A
        local or otherwise authorized Run must not be blocked merely because a
        different Endpoint has no credential.  The plan's resolved provider
        rows are the narrowest safe authorization scope available before Build.
        """

        profile = self._profile(project)
        endpoints = profile.get("endpoints") if isinstance(profile, Mapping) else None
        endpoints = endpoints if isinstance(endpoints, Mapping) else {}
        providers = plan.get("providers")
        required: list[dict[str, Any]] = []
        configured: list[dict[str, Any]] = []
        missing: list[dict[str, Any]] = []
        if not isinstance(providers, list):
            return {
                "state": "plan_invalid",
                "required_external_endpoints": required,
                "configured_external_endpoints": configured,
                "missing_external_endpoints": [{"endpoint": "<missing-plan-providers>", "provider": "unknown"}],
            }
        for provider in providers:
            if not isinstance(provider, Mapping):
                continue
            pricing = provider.get("pricing")
            if isinstance(pricing, Mapping) and pricing.get("kind") == "local":
                continue
            endpoint_name = str(provider.get("endpoint") or "").strip()
            plan_provider = str(provider.get("use") or provider.get("capability") or "unknown")
            record = {"endpoint": endpoint_name or "<missing-endpoint>", "provider": plan_provider}
            required.append(record)
            item = endpoints.get(endpoint_name) if endpoint_name else None
            if not isinstance(item, Mapping):
                missing.append(record)
                continue
            profile_provider = str(item.get("use") or plan_provider)
            if _provider_is_local(profile_provider):
                # The plan classified this request as external, but the
                # selected Runtime Profile points at a local implementation.
                # Treat the mismatch as unready instead of assuming it is safe.
                missing.append({**record, "provider": profile_provider})
                continue
            endpoint_keys = _profile_env_keys(item)
            if endpoint_keys and all(os.environ.get(key) for key in endpoint_keys):
                configured.append({**record, "provider": profile_provider})
            else:
                missing.append({**record, "provider": profile_provider})
        return {
            "state": "ready" if not missing else "awaiting_authorization",
            "required_external_endpoints": required,
            "configured_external_endpoints": configured,
            "missing_external_endpoints": missing,
            "profile_present": bool(profile),
        }

    def status(self, project: str | Path | None = None) -> dict[str, Any]:
        selected = self.project(project)
        launcher = self._checkout_launcher()
        node = shutil.which(self.settings.node_executable)
        profile = self._profile(selected)
        with self._lock:
            active_jobs = [job_id for job_id in self._active if self._job_project(job_id) == selected]
        authorization = self._authorization(selected, profile)
        return {
            "service": "hypit",
            "status": "ready" if launcher.is_file() and node and self.distribution_version in HYPIT_DIALECTS else "degraded",
            "command_contract_supported": self.distribution_version in HYPIT_DIALECTS,
            "project_option": HYPIT_DIALECTS.get(self.distribution_version),
            "checkout": {
                "path": str(self.hypit_root),
                "launcher": _relative(launcher, self.hypit_root),
                "exists": launcher.is_file(),
                "version": self.distribution_version,
                "commit": HYPIT_REFERENCE_COMMITS.get(self.distribution_version),
                "commit_kind": "integration_reference_not_checkout_integrity_proof",
                "license": HYPIT_LICENSE,
                "node_available": bool(node),
                "node_path": node,
                "dependencies_installed": (self.hypit_root / "node_modules").is_dir(),
            },
            "project": {"path": str(selected), "id": self.project_id(selected)},
            "authorization": authorization,
            "active_jobs": active_jobs,
            "studio": self.studio_status(selected),
            "video_completed": False,
            "delivery_verification": "command_exit_and_local_media_inspection_are_separate",
        }

    def catalog(self, project: str | Path | None = None) -> dict[str, Any]:
        selected = self.project(project)
        upstream_package = _read_json(self.hypit_root / "package.json")
        packages = self.packages()
        return {
            "service": "hypit",
            "version": self.distribution_version,
            "commit": HYPIT_REFERENCE_COMMITS.get(self.distribution_version),
            "commit_kind": "integration_reference_not_checkout_integrity_proof",
            "license": HYPIT_LICENSE,
            "checkout": str(self.hypit_root),
            "package": {
                "name": upstream_package.get("name", "@hypit/hypit"),
                "version": upstream_package.get("version", HYPIT_VERSION),
                "package_manager": upstream_package.get("packageManager", "pnpm@10.33.0"),
                "engines": _redact(upstream_package.get("engines", {"node": ">=22.15.0"})),
                "scripts": sorted(str(name) for name in (upstream_package.get("scripts") or {}) if isinstance(name, str)),
            },
            "operations": [
                {
                    "name": name,
                    "supported": not (name == "bridge_export" and self.distribution_version != HYPIT_VERSION),
                    "kind": "read" if name in {"status", "doctor", "catalog", "examples", "manifest", "manifest_validate", "history", "studio_status"} else "execution",
                    "requires_external_authorization": name in {"transcribe", "snapshot", "native_cli"},
                    "authorization_scope": "depends_on_exact_run_plan" if name in {"build", "render", "run"} else "depends_on_upstream_command" if name == "native_cli" else None,
                    "async": name in {"example_import", "bridge_export", "check", "plan", "studio", "build", "builds", "history", "build_status", "inspect", "get", "validate", "compile", "render", "run", "cancel", "doctor", "native_cli"},
                    "available": True,
                }
                for name in OPERATIONS if name not in {"validate", "compile", "preview", "render", "run"}
            ],
            "upstream_commands": sorted(UPSTREAM_COMMANDS),
            "project": {"path": str(selected), "id": self.project_id(selected)},
            "projects": packages,
            "notes": [
                "check and plan are read-only; build submits a Build",
                "Studio preview is a browser session and is not an MP4 export",
                "Studio runs as a managed long-lived local session and is stopped by cancelling its adapter job",
                "external model availability depends on the selected Runtime Profile and credential store",
            ],
        }

    def packages(self) -> list[dict[str, Any]]:
        """List immediate child native Hypit workspaces under the configured root.

        The catalog is intentionally bounded to direct children of the configured
        workspace root. Arbitrary directories and symlinks escaping that root are
        never exposed as selectable packages.
        """
        if not self.project_root.is_dir():
            return []
        rows: list[dict[str, Any]] = []
        for path in sorted(self.project_root.iterdir(), key=lambda item: item.name.lower()):
            if not PROJECT_ID_RE.fullmatch(path.name) or path.is_symlink() or not path.is_dir():
                continue
            resolved = path.resolve(strict=False)
            if not _is_within(resolved, self.project_root) or resolved.parent != self.project_root:
                continue
            # Old bridge packages were incomplete and must not masquerade as
            # native projects. The current, explicitly-versioned bridge format
            # is a full Hypit workspace and is selectable by the official CLI.
            bridge_manifest = _read_json(resolved / "bridge.manifest.json")
            if (resolved / "bridge.manifest.json").is_file() and bridge_manifest.get("bridge") != "openmontage-hypit-author@1":
                continue
            runtime_manifest = resolved / "hypit.runtime.json"
            native_sources: list[str] = []
            for current, directories, files in os.walk(resolved):
                current_path = Path(current)
                depth = len(current_path.relative_to(resolved).parts)
                directories[:] = [
                    name for name in directories
                    if name not in {"node_modules", ".git", ".hypit", "results", "artifacts", "__pycache__"}
                    and not name.startswith(".")
                    and depth < 6
                ]
                for filename in files:
                    if Path(filename).suffix.lower() in SOURCE_SUFFIXES:
                        native_sources.append((current_path / filename).relative_to(resolved).as_posix())
                        if len(native_sources) >= 100:
                            break
                if len(native_sources) >= 100:
                    break
            if not runtime_manifest.is_file() and not native_sources:
                continue
            rows.append({
                "project_id": path.name,
                "path": path.name,
                "project_path": path.name,
                "label": path.name,
        "source_files": sorted(native_sources),
                "runtime_profile": runtime_manifest.is_file(),
                "migration_receipt": (resolved / "migration.receipt.json").is_file(),
                "migration_status": _read_json(resolved / ".migration/job.json").get("status"),
            })
        return rows[:200]

    def _link_example_dependencies(self, example: Path, destination: Path) -> dict[str, Any]:
        """Reuse installed, declared dependencies of a 0.3 example package.

        Source checkouts rely on their pnpm workspace ancestors. A copied
        component loses that resolution. Link exact installed package roots,
        never the whole node_modules, executable scripts or an external path.
        This does not install packages or run lifecycle hooks. The imported
        project remains explicitly bound to this local distribution.
        """
        linked: list[dict[str, str]] = []
        unavailable: list[dict[str, str]] = []
        if self.distribution_version != "0.3.1":
            return {"linked": linked, "unavailable": unavailable, "distribution_bound": False}
        for manifest in destination.rglob("package.json"):
            if "node_modules" in manifest.relative_to(destination).parts:
                continue
            relative = manifest.relative_to(destination)
            package = _read_json(manifest)
            names = set()
            for field_name in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
                value = package.get(field_name)
                if isinstance(value, Mapping):
                    names.update(str(name) for name in value)
            for name in sorted(names):
                if not re.fullmatch(r"(?:@[A-Za-z0-9][A-Za-z0-9._-]*/)?[A-Za-z0-9][A-Za-z0-9._-]*", name) or name in {".", ".."} or name.endswith("/.."):
                    unavailable.append({"package": str(relative), "dependency": name, "reason": "invalid_name"})
                    continue
                current = (example / relative).parent
                dependency = None
                while _is_within(current, self.hypit_root):
                    candidate = (current / "node_modules" / name).resolve(strict=False)
                    if candidate.is_dir() and _is_within(candidate, self.hypit_root) and _read_json(candidate / "package.json").get("name") == name:
                        dependency = candidate
                        break
                    if current == self.hypit_root:
                        break
                    current = current.parent
                if dependency is None:
                    unavailable.append({"package": str(relative), "dependency": name, "reason": "not_installed_in_distribution"})
                    continue
                target = manifest.parent / "node_modules" / name
                if target.exists() or target.is_symlink():
                    raise HypitRuntimeError("示例依赖目标已存在；保留现有文件，不覆盖")
                target.parent.mkdir(parents=True, exist_ok=True)
                target.symlink_to(dependency, target_is_directory=True)
                linked.append({"package": str(relative), "dependency": name, "version": str(_read_json(dependency / "package.json").get("version") or "unknown")})
        return {"linked": linked, "unavailable": unavailable, "distribution_bound": bool(linked)}

    def import_example(self, source_project: str | Path, example_id: str, cancel_event: threading.Event) -> dict[str, Any]:
        """Copy one pinned upstream example into a new, isolated workspace."""
        source = self.project(source_project)
        example_name = str(example_id or "").strip()
        if not PROJECT_ID_RE.fullmatch(example_name) or Path(example_name).name != example_name:
            raise HypitRuntimeError("Hypit 演示项目编号无效")
        examples_root = (self.hypit_root / "examples").resolve(strict=False)
        example = (examples_root / example_name).resolve(strict=False)
        if example.parent != examples_root or not _is_within(example, self.hypit_root) or example.is_symlink() or not example.is_dir():
            raise HypitRuntimeError("找不到固定 Hypit 发行版中的该演示项目")
        source_files = sorted(
            path for path in example.rglob("*")
            if path.is_file()
            and not path.is_symlink()
            and path.suffix.lower() in SOURCE_SUFFIXES
            and _is_within(path, example)
        )
        if not source_files:
            raise HypitRuntimeError("该官方演示没有可执行的 Hypit Source/Run 文件")
        source_id = self.project_id(source)
        stem = re.sub(r"[^A-Za-z0-9._-]+", "-", example_name).strip("-._") or "demo"
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        destination: Path | None = None
        project_id = ""
        for _ in range(8):
            project_id = f"hypit-demo-{stem[:32]}-{stamp}-{uuid.uuid4().hex[:8]}"
            destination = self.project_root / project_id
            try:
                destination.mkdir(parents=False, exist_ok=False)
                break
            except FileExistsError:
                destination = None
        if destination is None:
            raise HypitRuntimeError("无法分配不冲突的 Hypit 演示项目目录")

        skipped = {".git", "node_modules", "results", "artifacts", "__pycache__", ".cache", ".hypit"}
        copied_files = 0
        try:
            for current, directories, filenames in os.walk(example, followlinks=False):
                current_path = Path(current)
                relative = current_path.relative_to(example)
                target_dir = destination / relative
                target_dir.mkdir(parents=True, exist_ok=True)
                directories[:] = [name for name in directories if name not in skipped and not (current_path / name).is_symlink()]
                for filename in filenames:
                    if cancel_event.is_set():
                        return {
                            "status": "cancelled", "command_succeeded": False, "delivery_verified": False,
                            "message": f"演示复制已取消；已生成的部分目录保留供检查：{project_id}",
                            "partial_project_path": project_id,
                        }
                    if filename == ".env" or filename.startswith(".env."):
                        continue
                    candidate = current_path / filename
                    if candidate.is_symlink() or not candidate.is_file():
                        continue
                    shutil.copy2(candidate, target_dir / filename)
                    copied_files += 1
            # The official selection marker is deliberately copied separately:
            # the rest of .hypit is runtime state and must never be imported.
            # A marker such as ``hypit.runtime.json`` remains useful to the
            # upstream CLI after the example becomes an independent project.
            marker = example / ".hypit" / "runtime"
            marker_copied = False
            if marker.is_file() and not marker.is_symlink():
                target_marker = destination / ".hypit" / "runtime"
                target_marker.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(marker, target_marker)
                marker_copied = True
            dependencies = self._link_example_dependencies(example, destination)
        except Exception:
            # Keep any partial output visible for inspection; never silently
            # delete files created by an interrupted or failed authoring task.
            raise
        return {
            "status": "completed", "operation": "example_import", "command_succeeded": True,
            "delivery_verified": False, "hypit_project_id": project_id,
            "hypit_project_path": project_id, "source_project_id": source_id,
            "example_id": example_name, "copied_file_count": copied_files,
            "source_count": len(source_files),
            "runtime_selection_marker_copied": marker_copied,
            "dependencies": dependencies,
            "message": "已从固定 Hypit 发行版复制官方演示到独立本机项目；原演示与 OpenMontage 项目均未修改。",
        }

    def export_openmontage(self, source_project: str | Path, params: Mapping[str, Any], cancel_event: threading.Event) -> dict[str, Any]:
        """Create a new native Hypit workspace from one OpenMontage project."""
        self.command_for("bridge_export", source_project)
        source = self.project(source_project)
        if cancel_event.is_set():
            return {"status": "cancelled", "command_succeeded": False, "delivery_verified": False, "message": "导出已取消；未建立 Hypit 包。"}
        source_id = self.project_id(source)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        destination: Path | None = None
        project_id = ""
        for _ in range(8):
            project_id = f"hypit-om-{source_id[:36]}-{stamp}-{uuid.uuid4().hex[:8]}"
            if not PROJECT_ID_RE.fullmatch(project_id):
                raise HypitRuntimeError("生成的 Hypit 项目编号无效")
            candidate = self.project_root / project_id
            if candidate.exists():
                continue
            destination = candidate
            break
        if destination is None:
            raise HypitRuntimeError("无法分配不冲突的 Hypit 导出目录")
        allowed = {"asset_mode", "language", "aspect_ratio", "resolution", "fps", "variant_count"}
        values = {key: params[key] for key in allowed if key in params}
        values["package_id"] = re.sub(r"[^a-z0-9._-]+", "-", f"openmontage-{source_id.lower()}").strip("-._")[:80] or "openmontage-video"
        options = HypitBridgeOptions.model_validate(values)
        result = export_hypit_package(source, destination, options)
        if cancel_event.is_set():
            return {
                "status": "cancelled", "command_succeeded": False, "delivery_verified": False,
                "hypit_project_id": project_id, "hypit_project_path": project_id,
                "partial_project_path": project_id, "bridge": result,
                "message": f"导出已取消；保留部分 Hypit 包供检查：{project_id}",
            }
        return {
            "status": "completed", "operation": "bridge_export", "command_succeeded": True,
            "delivery_verified": False, "hypit_project_id": project_id,
            "hypit_project_path": project_id, "source_project_id": source_id,
            "bridge": result, "needs": result.get("needs", []),
            "message": "OpenMontage 项目已转换为独立 Hypit Author Package；源项目未修改，导出结果仍需在 Hypit 中检查。",
        }

    def initialize_project(self, source_project: str | Path | None = None) -> dict[str, Any]:
        """Create an empty native workspace and initialize it with Hypit's CLI.

        No OpenMontage media or project state is translated or copied. The
        upstream ``runtime init`` command owns its Runtime Profile files.
        """
        project_option = self.project_option
        source = self.project(source_project)
        source_id = self.project_id(source)
        stem = re.sub(r"[^A-Za-z0-9._-]+", "-", source_id).strip("-._") or "project"
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        for _ in range(8):
            project_id = f"hypit-{stem[:48]}-{stamp}-{uuid.uuid4().hex[:8]}"
            if not PROJECT_ID_RE.fullmatch(project_id):
                raise HypitRuntimeError("Hypit project id is invalid")
            destination = (self.project_root / project_id).resolve(strict=False)
            if not _is_within(destination, self.project_root) or destination.parent != self.project_root:
                raise HypitRuntimeError("Hypit project path escaped the configured project root")
            try:
                destination.mkdir(parents=False, exist_ok=False)
            except FileExistsError:
                continue
            argv = [self.settings.node_executable, str(self._checkout_launcher()), "runtime", "init", project_option, str(destination), "--json"]
            result = self.runner(
                argv,
                cwd=destination,
                env=self._command_env(),
                cancel_event=threading.Event(),
            )
            if result.returncode != 0 or result.cancelled or result.timed_out:
                # Preserve a partially initialized directory for inspection;
                # never erase it as an error-handling shortcut.
                raise HypitRuntimeError(
                    f"Hypit runtime init 未完成；保留项目目录 {project_id}，未复制 OpenMontage 素材："
                    f"{_safe_error(result.stderr or result.stdout or 'Hypit CLI failed')}"
                )
            return {
                "status": "created",
                "action": "project_init",
                "operation": "runtime init",
                "project_id": project_id,
                "project_path": project_id,
                "project": {"id": project_id, "path": str(destination)},
                "command": argv,
                "message": "已通过 Hypit 官方 runtime init 初始化空工作区；未转换脚本、未复制素材。请使用 Hypit Skill 或现有 Source 创建作品。",
                "command_succeeded": True,
                "delivery_verified": False,
            }
        raise HypitRuntimeError("无法分配不冲突的 Hypit 项目目录")

    def select_project(self, project_path: str | Path) -> dict[str, Any]:
        """Resolve a cataloged native workspace to its canonical project id."""
        raw = str(project_path or "").strip()
        if not raw or "\\" in raw or "\x00" in raw:
            raise HypitRuntimeError("Hypit project path is invalid")
        selected = self.project(raw)
        if selected == self.project_root or selected.parent != self.project_root:
            raise HypitRuntimeError("Hypit project must be a direct child of the configured project root")
        project_id = self.project_id(selected)
        if not any(row["project_id"] == project_id for row in self.packages()):
            raise HypitRuntimeError("所选目录不是原生 Hypit 工作区")
        return {
            "status": "selected",
            "action": "project_select",
            "project_id": project_id,
            "project_path": project_id,
            "project": {"id": project_id, "path": str(selected)},
            "message": "已选择 Hypit 原生工作区。",
            "command_succeeded": False,
            "delivery_verified": False,
        }

    def examples(self, project: str | Path | None = None) -> dict[str, Any]:
        self.project(project)
        root = (self.hypit_root / "examples").resolve(strict=False)
        if not _is_within(root, self.hypit_root) or not root.is_dir():
            return {"examples": [], "available": False}
        entries: list[dict[str, Any]] = []
        for directory in sorted(root.iterdir(), key=lambda item: item.name):
            if not directory.is_dir() or directory.name.startswith("."):
                continue
            readme = directory / "README.md"
            sources = sorted(
                _relative(path, self.hypit_root)
                for path in directory.rglob("*")
                if path.is_file()
                and not path.is_symlink()
                and path.suffix.lower() in SOURCE_SUFFIXES
                and _is_within(path, directory)
            )[:100]
            entries.append({
                "id": directory.name,
                "path": _relative(directory, self.hypit_root),
                "readme": _relative(readme, self.hypit_root) if readme.is_file() else None,
                "runtime_profile": (directory / "hypit.runtime.json").is_file(),
                "runtime_selection_marker": (directory / ".hypit" / "runtime").is_file(),
                "sources": sources,
                # README-only/template directories remain discoverable for
                # provenance, but the workbench must not present them as
                # executable import choices.
                "executable": bool(sources),
            })
        return {"available": True, "examples": entries, "license": HYPIT_LICENSE, "commit": HYPIT_REFERENCE_COMMITS.get(self.distribution_version)}

    def project_manifest(self, project: str | Path) -> dict[str, Any]:
        selected = self.project(project)
        names = ("package.json", "hypit.runtime.json", "hypit.results.json", ".hypit/runtime")
        files = []
        for name in names:
            path = selected / name
            if path.is_file():
                files.append(_file_record(path, selected, include_json=path.suffix.lower() == ".json"))
        source_files = [
            _file_record(path, selected)
            for path in sorted(selected.rglob("*"))
            if path.is_file() and path.suffix.lower() in SOURCE_SUFFIXES and _is_within(path, selected)
        ][:200]
        return {
            "project": {"id": self.project_id(selected), "path": str(selected)},
            "manifest_files": files,
            "source_files": source_files,
            "runtime": self._authorization(selected),
            "valid": bool(source_files),
        }

    def validate_project_manifest(self, project: str | Path) -> dict[str, Any]:
        selected = self.project(project)
        errors: list[str] = []
        warnings: list[str] = []
        package = selected / "package.json"
        if package.is_file():
            try:
                package_json = json.loads(package.read_text("utf-8"))
                if not isinstance(package_json, dict):
                    errors.append("package.json must contain an object")
            except (OSError, UnicodeError, ValueError) as exc:
                errors.append(f"package.json is not valid JSON: {_safe_error(exc)}")
        profile_path = self._profile_path(selected)
        if profile_path:
            profile = _read_json(profile_path)
            if profile.get("format") not in {"hypit.runtime-local@1", "hypit.runtime@1"}:
                warnings.append("Runtime Profile format is not the known local format")
            if not isinstance(profile.get("endpoints", {}), dict):
                errors.append("Runtime Profile endpoints must be an object")
        elif not any(path.suffix.lower() == ".svrun" for path in selected.rglob("*")):
            warnings.append("no hypit.runtime.json or selected Runtime Profile")
        source_files = [path for path in selected.rglob("*") if path.is_file() and path.suffix.lower() in SOURCE_SUFFIXES]
        if not source_files:
            errors.append("project has no .svml, .svs or .svrun source")
        for path in source_files:
            try:
                text = path.read_text("utf-8")
            except (OSError, UnicodeError) as exc:
                errors.append(f"cannot read {_relative(path, selected)}: {_safe_error(exc)}")
                continue
            if not text.strip():
                errors.append(f"source is empty: {_relative(path, selected)}")
        return {
            "project": {"id": self.project_id(selected), "path": str(selected)},
            "valid": not errors,
            "errors": errors,
            "warnings": warnings,
            "files": self.project_manifest(selected),
            "command_succeeded": False,
            "delivery_verified": False,
        }

    def _job_project(self, job_id: str) -> Path | None:
        # Active events are indexed by id only.  State files are searched under
        # the bounded project root when status needs to show local activity.
        for project in [item for item in self.project_root.iterdir() if item.is_dir()] if self.project_root.is_dir() else []:
            if (self._jobs_base(project) / job_id / "job.json").is_file():
                return project.resolve(strict=False)
        root_job = self._jobs_base(self.project_root) / job_id / "job.json"
        return self.project_root if root_job.is_file() else None

    # ---- Whitelisted command construction ----------------------------------

    def _native_cli_tokens(self, project: Path, command_line: Any) -> list[str]:
        """Pass the entered command to the pinned Hypit CLI without a shell.

        Hypit owns command and file-path semantics. The workbench only parses
        the text into argv, locks explicit --workspace / --project to the selected
        project, and prevents plaintext credentials from entering job history.
        """
        raw = str(command_line or "").strip()
        if not raw or len(raw) > 16_384 or "\x00" in raw:
            raise HypitRuntimeError("请输入一条 Hypit 官方命令；命令长度不能超过 16 KB")
        try:
            tokens = shlex.split(raw, posix=True)
        except ValueError as exc:
            raise HypitRuntimeError(f"Hypit 命令引号格式有误：{_safe_error(exc)}") from exc
        if tokens and tokens[0] == "hypit":
            tokens = tokens[1:]
        if not tokens or len(tokens) > 128 or any(len(item) > 4096 or "\x00" in item for item in tokens):
            raise HypitRuntimeError("Hypit 命令为空或参数数量过多")

        selected = project.resolve(strict=False)
        index = 0
        while index < len(tokens):
            token = tokens[index]
            if token == "--":
                # capture run owns every following argument; do not reinterpret
                # script arguments as Hypit CLI options.
                break
            option, separator, inline_value = token.partition("=")
            option_name = option.lstrip("-").replace("-", "_")
            if option.startswith("-") and SENSITIVE_KEY_RE.search(option_name):
                raise HypitRuntimeError("不要把密钥或令牌直接写进命令；请使用 Hypit auth 或其官方凭据方式")
            if option in {"--workspace", "--project"}:
                if separator:
                    workspace = inline_value
                elif index + 1 < len(tokens):
                    index += 1
                    workspace = tokens[index]
                else:
                    raise HypitRuntimeError(f"{option} 缺少路径参数")
                path = Path(workspace).expanduser()
                resolved = path.resolve(strict=False) if path.is_absolute() else (selected / path).resolve(strict=False)
                if resolved != selected:
                    raise HypitRuntimeError("Hypit 官方命令只能作用于当前选择的项目")
            index += 1
        return tokens

    @staticmethod
    def _native_paid_scope(tokens: Sequence[str]) -> str | None:
        if not tokens or "--help" in tokens or "-h" in tokens or tokens[0] == "help":
            return None
        # A global --workspace option may be placed before the command by the
        # native parser. Search command tokens so it cannot bypass the paid
        # confirmation guard; false positives only ask for an extra review.
        return next((token for token in tokens if token in NATIVE_PAID_COMMANDS), None)

    @staticmethod
    def _validate_native_paid_approval(command: str, approval: Any) -> None:
        if command not in NATIVE_PAID_COMMANDS:
            return
        item = approval if isinstance(approval, Mapping) else {}
        service = str(item.get("service") or "").strip()
        budget = item.get("budget_cny")
        try:
            amount = float(budget)
        except (TypeError, ValueError):
            amount = 0
        if (
            item.get("confirmed") is not True
            or item.get("pricing_reviewed") is not True
            or not service
            or len(service) > 120
            or not math.isfinite(amount)
            or amount <= 0
        ):
            raise HypitRuntimeError(
                "此 Hypit 命令可能产生费用；请先运行 plan/pricing，填写服务和人民币预算并明确确认本次范围"
            )

    def command_for(self, operation: str, project: str | Path, **params: Any) -> list[str] | None:
        if operation not in OPERATION_SET:
            raise HypitRuntimeError("Hypit operation is not allowed")
        operation = OPERATION_ALIASES.get(operation, operation)
        selected = self.project(project)
        launcher = self._checkout_launcher()
        if operation == "bridge_export" and self.distribution_version != HYPIT_VERSION:
            raise HypitRuntimeError("旧版 OpenMontage 转换包尚未迁移到当前 Hypit；请保留旧版入口或使用新版原生工程")
        if operation in {"status", "catalog", "examples", "example_import", "bridge_export", "manifest", "manifest_validate", "studio_status"}:
            return None
        if operation == "native_cli":
            self.project_option  # Fail closed for an unverified distribution dialect.
            tokens = self._native_cli_tokens(selected, params.get("command_line"))
            return [self.settings.node_executable, str(launcher), *tokens]
        def source(name: str, suffixes: Iterable[str]) -> str:
            path = self._safe_file(selected, str(params.get(name) or ""), suffixes=suffixes)
            # The official Studio and CLI resolve relative arguments from cwd.
            return _relative(path, selected)
        base = [self.settings.node_executable, str(launcher)]
        # 0.3 resolves execution Profiles separately from projects. Pin both
        # plan and build to the same bounded Profile. Inspect/Get intentionally
        # receive no --runtime: those commands read the recorded Result.
        profile = self._profile_path(selected)
        runtime_args = ["--runtime", str(profile)] if self.distribution_version == "0.3.1" and profile else []
        if operation == "doctor":
            return base + ["doctor", self.project_option, str(selected), "--json"]
        if operation == "check":
            return base + ["check", source("source", (".svml", ".svs", ".svrun")), self.project_option, str(selected), "--json"]
        if operation == "plan":
            return base + ["plan", source("run", (".svrun",)), self.project_option, str(selected), "--json", *runtime_args]
        if operation == "build":
            args = base + ["build", source("run", (".svrun",)), self.project_option, str(selected), "--json", *runtime_args]
            if bool(params.get("follow")):
                args.append("--follow")
            title = str(params.get("title") or "").strip()
            if title:
                if len(title) > 200 or "\x00" in title:
                    raise HypitRuntimeError("Hypit build title is invalid")
                args.extend(["--title", title])
            return args
        if operation == "studio":
            args = base + ["studio", "--run", source("run", (".svrun",)), self.project_option, str(selected)]
            port = params.get("port")
            if port is not None:
                try:
                    value = int(port)
                except (TypeError, ValueError):
                    raise HypitRuntimeError("Studio port is invalid") from None
                if value <= 0 or value > 65535:
                    raise HypitRuntimeError("Studio port is invalid")
                args.extend(["--port", str(value)])
            return args
        if operation == "studio_start":
            return self.command_for("studio", selected, **dict(params))
        if operation == "builds":
            return base + ["builds", self.project_option, str(selected), "--json"]
        if operation == "history":
            output = str(params.get("output") or "").strip()
            if not output or len(output) > 200 or "\x00" in output:
                raise HypitRuntimeError("Hypit history output name is invalid")
            return base + ["history", output, self.project_option, str(selected), "--json"]
        if operation in {"build_status", "inspect"}:
            build = str(params.get("build_id") or "")
            if not BUILD_ID_RE.fullmatch(build):
                raise HypitRuntimeError("Hypit Build id is invalid")
            command = "status" if operation == "build_status" else "inspect"
            return base + [command, build, self.project_option, str(selected), "--json"]
        if operation == "get":
            build = str(params.get("build_id") or "")
            output = str(params.get("output") or "").strip()
            target_raw = str(params.get("to") or "").strip()
            if not BUILD_ID_RE.fullmatch(build):
                raise HypitRuntimeError("Hypit Build id is invalid")
            if not output or len(output) > 200 or "\x00" in output:
                raise HypitRuntimeError("Hypit output name is invalid")
            if not target_raw or "\\" in target_raw or "\x00" in target_raw:
                raise HypitRuntimeError("Hypit export path is invalid")
            target = Path(target_raw)
            target = (selected / target).resolve(strict=False) if not target.is_absolute() else target.resolve(strict=False)
            if not _is_within(target, selected) or target == selected:
                raise HypitRuntimeError("Hypit export path must stay inside the selected project")
            if target.exists():
                raise HypitRuntimeError("Hypit export target already exists; choose a new path to avoid overwriting")
            return base + ["get", build, "--output", output, "--to", _relative(target, selected), self.project_option, str(selected), "--json"]
        if operation == "cancel":
            build = str(params.get("build_id") or "")
            if not BUILD_ID_RE.fullmatch(build):
                raise HypitRuntimeError("Hypit Build id is invalid")
            return base + ["cancel", build, self.project_option, str(selected), "--json"]
        raise HypitRuntimeError("Hypit operation has no command mapping")

    def _operation_requires_authorization(self, operation: str, project: Path) -> bool:
        operation = OPERATION_ALIASES.get(operation, operation)
        return operation in {"build", "transcribe", "snapshot"} and bool(self._authorization(project).get("missing_external_endpoints"))

    def _paid_scope(self, operation: str, project: Path, params: Mapping[str, Any]) -> str | None:
        canonical = OPERATION_ALIASES.get(operation, operation)
        if canonical in NATIVE_PAID_COMMANDS:
            return canonical
        if canonical != "native_cli":
            return None
        argv = self.command_for("native_cli", project, **dict(params))
        return self._native_paid_scope(argv[2:] if argv else ())

    def _operation(self, operation: str, project: Path, params: Mapping[str, Any], cancel_event: threading.Event) -> dict[str, Any]:
        operation = OPERATION_ALIASES.get(operation, operation)
        if operation == "status":
            return self.status(project)
        if operation == "catalog":
            return self.catalog(project)
        if operation == "examples":
            return self.examples(project)
        if operation == "example_import":
            return self.import_example(project, str(params.get("example_id") or ""), cancel_event)
        if operation == "bridge_export":
            return self.export_openmontage(project, params, cancel_event)
        if operation == "manifest":
            return self.project_manifest(project)
        if operation == "manifest_validate":
            return self.validate_project_manifest(project)
        if operation == "studio_status":
            return self.studio_status(project)
        build_plan: dict[str, Any] | None = None
        paid_command = self._paid_scope(operation, project, params) if operation != "build" else None
        if paid_command:
            self._validate_native_paid_approval(paid_command, params.get("paid_approval"))
        if operation == "build":
            preflight = self._build_preflight(project, params, cancel_event)
            if preflight.get("status"):
                return {**preflight, "build_submitted": False}
            build_plan = preflight["plan"]
            if preflight["cost_classification"] == "external":
                approval = params.get("paid_approval")
                if not isinstance(approval, Mapping) or not approval:
                    return {
                        "status": "authorization_required", "command_succeeded": False,
                        "build_submitted": False,
                        "delivery_verified": False, "build_plan": build_plan,
                        "cost_classification": "external",
                        "message": "官方计划发现本次 Run 会调用外部 Provider；尚未提交 Build。请核对服务与费用后填写本次预算并再次渲染。",
                    }
                try:
                    self._validate_native_paid_approval("build", approval)
                except HypitRuntimeError as exc:
                    return {
                        "status": "authorization_required", "command_succeeded": False,
                        "build_submitted": False,
                        "delivery_verified": False, "build_plan": build_plan,
                        "cost_classification": "external",
                        "message": f"本次外部 Build 的授权信息不完整；未提交 Build：{exc}",
                    }
                plan_authorization = self._plan_authorization(project, build_plan)
                if plan_authorization.get("state") != "ready":
                    return {
                        "status": "authorization_required", "command_succeeded": False,
                        "build_submitted": False,
                        "delivery_verified": False, "build_plan": build_plan,
                        "cost_classification": "external", "authorization": plan_authorization,
                        "message": "官方计划所需的外部 Endpoint 凭据尚未完整就绪；未提交 Build。",
                    }
        argv = self.command_for(operation, project, **dict(params))
        if argv is None:
            raise HypitRuntimeError("Hypit operation does not execute a command")
        result = self.runner(
            argv,
            cwd=project,
            env=self._command_env(project),
            cancel_event=cancel_event,
        )
        stdout = _safe_error(result.stdout) if result.stdout else ""
        stderr = _safe_error(result.stderr) if result.stderr else ""
        parsed = _extract_json(stdout)
        cancelled = result.cancelled or cancel_event.is_set()
        command_succeeded = result.returncode == 0 and not cancelled and not result.timed_out
        concise_failure = _safe_error(stderr or stdout or "Hypit 命令失败")
        if operation == "plan" and isinstance(parsed, Mapping):
            preflight_view = parsed.get("preflight")
            diagnostics = preflight_view.get("diagnostics") if isinstance(preflight_view, Mapping) else None
            if isinstance(diagnostics, list):
                reasons = [
                    _safe_error(row.get("message") or row.get("code"))[:360]
                    for row in diagnostics if isinstance(row, Mapping) and (row.get("message") or row.get("code"))
                ]
                if reasons:
                    concise_failure = "Hypit 官方计划未通过：" + "；".join(reasons[:3])
        build_invocation = self._is_build_invocation(operation, argv)
        if build_invocation and cancelled:
            classified = {
                "status": "cancelled",
                "command_succeeded": False,
                "message": "Hypit Build 已取消。",
            }
        elif build_invocation and not command_succeeded:
            build_view = parsed.get("build") if isinstance(parsed, Mapping) else None
            official_failure = build_view.get("failure") if isinstance(build_view, Mapping) else None
            failure_text = _safe_error(official_failure) if official_failure else ""
            if "listen EPERM" in failure_text:
                failure_text = "HyperFrames 本地渲染器在当前执行环境无法监听 127.0.0.1（EPERM）；本次未生成视频。请在本机终端核对监听权限后重试。"
            classified = {
                "status": "failed",
                "command_succeeded": False,
                "message": (failure_text or concise_failure)[:1000],
            }
        elif build_invocation:
            classified = self._classify_build_result(parsed)
        else:
            classified = {
                "status": "cancelled" if cancelled else "completed" if command_succeeded else "failed",
                "command_succeeded": command_succeeded,
                "message": "命令已完成；本地媒体质量复核仍需单独执行" if command_succeeded else concise_failure[:1000],
            }
        return {
            **classified,
            "delivery_verified": False,
            "authorization": self._authorization(project),
            "command": [str(item) for item in argv],
            "returncode": result.returncode,
            "stdout": stdout,
            "stderr": stderr,
            "parsed": _redact(parsed),
            "cancelled": cancelled,
            "timed_out": result.timed_out,
            "duration_seconds": round(result.duration_seconds, 3),
            "artifacts": self._discover_artifacts(project, parsed),
            **({"build_plan": build_plan, "cost_classification": preflight["cost_classification"]} if build_plan is not None else {}),
        }

    def _build_preflight(self, project: Path, params: Mapping[str, Any], cancel_event: threading.Event) -> dict[str, Any]:
        """Ask the pinned CLI to price the exact Run before submitting a Build.

        Only an explicit, internally consistent all-local plan skips the
        paid-service confirmation. Missing or ambiguous pricing fails closed.
        """
        try:
            argv = self.command_for("plan", project, run=params.get("run"))
        except HypitRuntimeError as exc:
            return {"status": "preflight_failed", "command_succeeded": False, "delivery_verified": False,
                    "message": f"无法检查本次 Hypit Run：{exc}"}
        if cancel_event.is_set():
            return {"status": "cancelled", "command_succeeded": False, "delivery_verified": False,
                    "build_submitted": False,
                    "message": "渲染前检查已取消；没有提交 Build。"}
        result = self.runner(argv or (), cwd=project, env=self._command_env(project), cancel_event=cancel_event)
        parsed = _extract_json(result.stdout)
        if result.cancelled or cancel_event.is_set():
            return {"status": "cancelled", "command_succeeded": False, "delivery_verified": False,
                    "command": [str(item) for item in (argv or ())], "message": "官方计划检查已取消；没有提交 Build。"}
        if result.timed_out or result.returncode != 0 or not isinstance(parsed, Mapping):
            detail = _safe_error(result.stderr or result.stdout or "Hypit plan 未返回有效 JSON")
            return {"status": "preflight_failed", "command_succeeded": False, "delivery_verified": False,
                    "command": [str(item) for item in (argv or ())], "stdout": _safe_error(result.stdout),
                    "stderr": _safe_error(result.stderr), "message": f"官方计划检查失败；没有提交 Build：{detail}"}
        plan = _redact(parsed)
        if plan.get("ok") is not True:
            return {"status": "preflight_failed", "command_succeeded": False, "delivery_verified": False,
                    "build_plan": plan, "command": [str(item) for item in (argv or ())],
                    "message": "官方计划未通过；没有提交 Build。请先解决计划中列出的项目。"}
        preflight = plan.get("preflight")
        if not isinstance(preflight, Mapping) or preflight.get("ok") is not True:
            return {"status": "plan_required", "command_succeeded": False, "delivery_verified": False,
                    "build_plan": plan, "command": [str(item) for item in (argv or ())],
                    "message": "Hypit 没有提供可核验的 Provider / 费用预检；没有提交 Build。请先选择 Runtime Profile 并检查官方计划。"}
        try:
            request_count = int(plan["requestCount"])
            local_count = int(plan["localRequestCount"])
            provider_count = int(plan["providerRequestCount"])
            issue_count = int(plan.get("requestIssueCount", 0))
            unresolved_count = int(plan.get("unresolvedRequestCount", 0))
            unsupported_count = int(plan.get("unsupportedRequestCount", 0))
        except (KeyError, TypeError, ValueError):
            return {"status": "plan_required", "command_succeeded": False, "delivery_verified": False,
                    "build_plan": plan, "command": [str(item) for item in (argv or ())],
                    "message": "Hypit 计划缺少费用分类计数；没有提交 Build。"}
        providers = plan.get("providers")
        if not isinstance(providers, list) or request_count < 0 or min(local_count, provider_count, issue_count, unresolved_count, unsupported_count) < 0:
            return {"status": "plan_required", "command_succeeded": False, "delivery_verified": False,
                    "build_plan": plan, "command": [str(item) for item in (argv or ())],
                    "message": "Hypit 计划的 Provider 列表或计数格式异常；没有提交 Build。"}
        if issue_count or unresolved_count or unsupported_count or local_count + provider_count != request_count:
            return {"status": "plan_required", "command_succeeded": False, "delivery_verified": False,
                    "build_plan": plan, "command": [str(item) for item in (argv or ())],
                    "message": "官方计划仍有未解析或不支持的请求；没有提交 Build。请先修复 Run / Provider 配置。"}
        if any(not isinstance(provider, Mapping) or provider.get("status") != "resolved" for provider in providers):
            return {"status": "plan_required", "command_succeeded": False, "delivery_verified": False,
                    "build_plan": plan, "command": [str(item) for item in (argv or ())],
                    "message": "至少一个官方 Provider 尚未解析；没有提交 Build。"}
        if any(
            not isinstance(provider.get("pricing"), Mapping)
            or provider["pricing"].get("kind") not in {"local", "page"}
            or (
                provider["pricing"].get("kind") != "local"
                and not str(provider.get("endpoint") or "").strip()
            )
            for provider in providers
        ):
            return {"status": "plan_required", "command_succeeded": False, "delivery_verified": False,
                    "build_plan": plan, "command": [str(item) for item in (argv or ())],
                    "message": "官方计划的 Provider 定价或 Endpoint 信息不完整；没有提交 Build。"}
        all_local = (
            provider_count == 0 and local_count == request_count
            and len(providers) == request_count
            and all(isinstance(provider.get("pricing"), Mapping) and provider["pricing"].get("kind") == "local" for provider in providers)
        )
        if all_local:
            return {"plan": plan, "cost_classification": "local"}
        if provider_count > 0:
            return {"plan": plan, "cost_classification": "external"}
        return {"status": "plan_required", "command_succeeded": False, "delivery_verified": False,
                "build_plan": plan, "command": [str(item) for item in (argv or ())],
                "message": "官方计划的费用类别无法确认；没有提交 Build。"}

    def _discover_artifacts(self, project: Path, parsed: Any) -> list[dict[str, Any]]:
        candidates: set[Path] = set()
        def visit(value: Any) -> None:
            if isinstance(value, Mapping):
                for item in value.values():
                    visit(item)
            elif isinstance(value, (list, tuple)):
                for item in value:
                    visit(item)
            elif isinstance(value, str):
                candidate = Path(value)
                if candidate.suffix.lower() in MEDIA_SUFFIXES:
                    if not candidate.is_absolute():
                        candidate = project / candidate
                    resolved = candidate.resolve(strict=False)
                    if _is_within(resolved, project) and resolved.is_file():
                        candidates.add(resolved)
        visit(parsed)
        return [
            {
                "path": _relative(path, project),
                "bytes": path.stat().st_size,
                "sha256": _sha256(path),
                "media_quality_review": "not_run",
            }
            for path in sorted(candidates)
        ]

    @staticmethod
    def _is_build_invocation(operation: str, argv: Sequence[str]) -> bool:
        canonical = OPERATION_ALIASES.get(operation, operation)
        if canonical == "build":
            return True
        # native_cli deliberately preserves the official argv.  The launcher
        # is argv[0:2], so a real ``hypit build ...`` is identifiable without
        # guessing from stdout or from an unrelated result command.
        return canonical == "native_cli" and len(argv) > 2 and argv[2] == "build"

    @staticmethod
    def _classify_build_result(parsed: Any) -> dict[str, Any]:
        """Classify the official ``hypit.cli-build@1`` machine view.

        A zero process exit only means that the CLI reported its view.  Build
        completion requires both execution and Result completion, while an
        attention view remains actionable and must not be presented as a
        successful video.
        """

        build = parsed.get("build") if isinstance(parsed, Mapping) else None
        work = build.get("work") if isinstance(build, Mapping) else None
        result = build.get("result") if isinstance(build, Mapping) else None
        if not isinstance(work, Mapping) or not isinstance(result, Mapping):
            return {
                "status": "needs_attention",
                "command_succeeded": False,
                "message": "Hypit Build CLI 返回了不完整的 Build/Result 状态；需要检查后才能确认成片。",
            }
        attention = build.get("attention")
        failure = build.get("failure")
        work_outcome = work.get("outcome")
        result_state = result.get("state")
        if work_outcome == "cancelled" or result_state == "cancelled":
            return {
                "status": "cancelled",
                "command_succeeded": False,
                "build_outcome": work_outcome,
                "result_state": result_state,
                "message": "Hypit Build 已取消。",
            }
        if attention not in (None, "", False, {}, []):
            return {
                "status": "needs_attention",
                "command_succeeded": False,
                "build_outcome": work_outcome,
                "result_state": result_state,
                "message": "Hypit Build 需要处理 attention；没有确认最终 Result。",
            }
        if failure not in (None, "", False, {}, []) or work_outcome == "failed" or result_state == "failed":
            return {
                "status": "failed",
                "command_succeeded": False,
                "build_outcome": work_outcome,
                "result_state": result_state,
                "message": "Hypit Build 或 Result 已失败。",
            }
        if work_outcome == "complete" and result_state == "complete":
            return {
                "status": "build_completed",
                "command_succeeded": True,
                "build_completed": True,
                "build_outcome": work_outcome,
                "result_state": result_state,
                "message": "Hypit Build 与 Result 均已完成；本地媒体质量复核仍需单独执行。",
            }
        return {
            "status": "needs_attention",
            "command_succeeded": False,
            "build_outcome": work_outcome,
            "result_state": result_state,
            "message": "Hypit Build 尚未同时达到 complete/complete；需要继续检查。",
        }

    # Public operation helpers keep the service usable without FastAPI.  They
    # all return the same durable job envelope; read-only metadata methods
    # above remain synchronous because they never spawn a process.

    def doctor(self, project: str | Path | None = None) -> dict[str, Any]:
        return self.submit("doctor", project or self.project_root)

    def validate(self, project: str | Path, source: str) -> dict[str, Any]:
        return self.submit("validate", project, source=source)

    def compile(self, project: str | Path, run: str) -> dict[str, Any]:
        return self.submit("compile", project, run=run)

    def preview(self, project: str | Path, run: str, *, port: int | None = None) -> dict[str, Any]:
        return self.submit("preview", project, run=run, port=port)

    def render(self, project: str | Path, run: str, *, title: str | None = None) -> dict[str, Any]:
        return self.submit("render", project, run=run, title=title)

    def run(self, project: str | Path, run: str, *, follow: bool = False, title: str | None = None) -> dict[str, Any]:
        return self.submit("run", project, run=run, follow=follow, title=title)

    def history(self, project: str | Path) -> dict[str, Any]:
        return self.submit("builds", project)

    def validate_manifest(self, project: str | Path) -> dict[str, Any]:
        return self.submit("manifest_validate", project)

    def project_manifest_job(self, project: str | Path) -> dict[str, Any]:
        return self.submit("project_manifest", project)

    def dry_run(self, operation: str, project: str | Path, **params: Any) -> dict[str, Any]:
        """Describe the safe, non-starting Studio state for dry-run responses."""
        selected = self.project(project)
        if operation in {"preview", "studio", "studio_start"}:
            return {
                "status": "dry_run",
                "operation": operation,
                "project_id": self.project_id(selected),
                "would_execute": False,
                "would_generate": False,
                "studio_state": "not_started",
                "command_succeeded": False,
                "delivery_verified": False,
                "message": "安全预演已完成：没有启动 Studio 监听、Hypit CLI 或远程生成任务。",
            }
        adapter_cancel = operation == "cancel" and JOB_RE.fullmatch(str(params.get("job_id") or ""))
        argv = None if adapter_cancel else self.command_for(operation, selected, **params)
        job_id = JOB_PREFIX + uuid.uuid4().hex[:24]
        directory = self._job_directory(selected, job_id)
        directory.mkdir(parents=True, exist_ok=False)
        state = {
            "job_id": job_id,
            "project_id": self.project_id(selected),
            "status": "dry_run",
            "operation": operation,
            "request": _redact({"operation": operation, "project_id": self.project_id(selected), **params}),
            "created_at": _now(),
            "updated_at": _now(),
            "command_succeeded": False,
            "delivery_verified": False,
            "would_execute": argv is not None or bool(adapter_cancel),
            "would_generate": operation in {"build", "render", "run"},
            "command": [str(item) for item in argv] if argv else ("cancel adapter job" if adapter_cancel else None),
            "message": "Dry-run 预览已生成；没有启动 Hypit CLI、提交生成任务或调用外部 Provider。",
        }
        _write_json(directory / "job.json", state)
        return _redact(state)

    # ---- Asynchronous jobs --------------------------------------------------

    def _persist(self, project: Path, job_id: str, **values: Any) -> dict[str, Any]:
        with self._lock:
            path = self._job_directory(project, job_id) / "job.json"
            state = _read_json(path)
            state.update(values)
            state["updated_at"] = _now()
            _write_json(path, state)
            return state

    def get(self, project: str | Path, job_id: str) -> dict[str, Any]:
        selected = self.project(project)
        path = self._job_directory(selected, job_id) / "job.json"
        state = _read_json(path)
        if not state:
            raise HypitRuntimeError("找不到当前项目中的 Hypit 任务")
        if state.get("status") not in TERMINAL:
            # Read both the result and worker ownership under the same lock.
            # A worker may finish between two unlocked reads; treating that
            # stale queued result as orphaned would overwrite a real outcome.
            with self._lock:
                state = _read_json(path)
                if state.get("status") not in TERMINAL and job_id not in self._active:
                    state = self._persist(selected, job_id, status="interrupted", message="服务重启，任务已停止；没有自动重试")
        return _redact(state)

    def list(self, project: str | Path) -> list[dict[str, Any]]:
        selected = self.project(project)
        base = self._jobs_base(selected)
        if not base.is_dir():
            return []
        paths = sorted(base.glob("hypit-*/job.json"), key=lambda item: item.stat().st_mtime, reverse=True)
        return [self.get(selected, path.parent.name) for path in paths[:100]]

    def submit(self, operation: str, project: str | Path, **params: Any) -> dict[str, Any]:
        if operation not in OPERATION_SET:
            raise HypitRuntimeError("Hypit operation is not allowed")
        if operation in {
            "status", "catalog", "examples", "manifest", "project_manifest",
            "manifest_validate", "validate_manifest", "studio_status",
        }:
            # Read-only operations still use the same job contract so a UI can
            # observe one stable queue, while the worker remains cheap/local.
            pass
        selected = self.project(project)
        argv = self.command_for(operation, selected, **params)  # validation before persistence
        paid_command = self._paid_scope(operation, selected, params)
        if paid_command and OPERATION_ALIASES.get(operation, operation) != "build":
            self._validate_native_paid_approval(paid_command, params.get("paid_approval"))
        with self._lock:
            if len(self._active) >= (self.settings.max_jobs if self.settings else 4):
                raise HypitRuntimeError("Hypit 任务队列已满，请等待或取消后再提交")
            job_id = JOB_PREFIX + uuid.uuid4().hex[:24]
            directory = self._job_directory(selected, job_id)
            directory.mkdir(parents=True, exist_ok=False)
            event = threading.Event()
            request = {"operation": operation, "project_id": self.project_id(selected), **dict(params)}
            state = {
                "job_id": job_id,
                "distribution_version": self.distribution_version,
                "project_id": self.project_id(selected),
                "status": "queued",
                "operation": operation,
                "request": _redact(request),
                "created_at": _now(),
                "updated_at": _now(),
                "command_succeeded": False,
                "delivery_verified": False,
            }
            _write_json(directory / "job.json", state)
            self._active[job_id] = event
            future = self.executor.submit(self._run_job, selected, job_id, operation, dict(params), event)
            self._futures[job_id] = future
            return _redact(state)

    def _run_job(self, project: Path, job_id: str, operation: str, params: dict[str, Any], event: threading.Event) -> None:
        try:
            self._persist(project, job_id, status="running", stage=operation, message="Hypit 任务正在执行")
            if operation in {"preview", "studio", "studio_start"}:
                result = self._run_studio_job(project, job_id, params, event)
            elif operation == "native_cli" and (self.command_for(operation, project, **params) or [None, None, None])[2] == "studio":
                result = self._run_studio_job(project, job_id, {**params, "_native_cli": True}, event)
            else:
                result = self._operation(operation, project, params, event)
            self._persist(project, job_id, **result)
        except Exception as exc:
            self._persist(
                project,
                job_id,
                status="cancelled" if event.is_set() else "failed",
                command_succeeded=False,
                delivery_verified=False,
                error=_safe_error(exc),
                message=_safe_error(exc),
            )
        finally:
            with self._lock:
                self._active.pop(job_id, None)
                self._futures.pop(job_id, None)
                self._studio_processes.pop(job_id, None)

    def _run_studio_job(
        self,
        project: Path,
        job_id: str,
        params: Mapping[str, Any],
        cancel_event: threading.Event,
    ) -> dict[str, Any]:
        """Run Studio as a managed local session that can be stopped by job id."""
        argv = (
            self.command_for("native_cli", project, **dict(params))
            if params.get("_native_cli")
            else self.command_for("studio_start", project, **dict(params))
        )
        if argv is None:
            raise HypitRuntimeError("Studio command is unavailable")
        self._persist(
            project,
            job_id,
            operation="studio",
            stage="studio_starting",
            studio_state="starting",
            message="Hypit Studio 正在本机启动",
        )
        process = subprocess.Popen(
            argv,
            cwd=str(project),
            env=self._command_env(project),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            shell=False,
            bufsize=1,
        )
        with self._lock:
            self._studio_processes[job_id] = process
        output: queue.Queue[str] = queue.Queue()
        captured: list[str] = []
        url_match: list[str] = []

        def drain() -> None:
            stream = process.stdout
            if stream is None:
                return
            try:
                for line in stream:
                    output.put(line)
            finally:
                stream.close()

        reader = threading.Thread(target=drain, name=f"hypit-studio-output-{job_id[-6:]}", daemon=True)
        reader.start()
        deadline = time.monotonic() + (self.settings.command_timeout_seconds if self.settings else 900.0)
        timed_out = False
        while process.poll() is None:
            if cancel_event.is_set():
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                break
            if time.monotonic() >= deadline:
                timed_out = True
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                break
            try:
                line = output.get(timeout=0.1)
            except queue.Empty:
                continue
            captured.append(line)
            if sum(map(len, captured)) > (self.settings.output_limit if self.settings else 256 * 1024):
                captured = captured[-1000:]
            if not url_match:
                for raw in re.findall(r"https?://(?:localhost|127\.0\.0\.1|\[::1\]):\d{1,5}(?:/[^\s]*)?", line):
                    parsed = urlsplit(raw.rstrip(".,;"))
                    if parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"} and parsed.port:
                        url_match.append(urlunsplit(("http", parsed.netloc, parsed.path or "/", "", "")))
                        self._persist(
                            project,
                            job_id,
                            status="running",
                            stage="studio_ready",
                            studio_state="running",
                            studio_url=url_match[0],
                            message="Hypit Studio 已在本机启动；可通过取消此任务停止会话。",
                        )
                        break
        reader.join(timeout=1)
        while True:
            try:
                captured.append(output.get_nowait())
            except queue.Empty:
                break
        combined = _safe_error("".join(captured))
        cancelled = cancel_event.is_set()
        return {
            "status": "cancelled" if cancelled else "failed" if timed_out or process.returncode else "completed",
            "operation": "studio",
            "command_succeeded": not cancelled and not timed_out and process.returncode == 0,
            "delivery_verified": False,
            "studio_state": "stopped" if cancelled or process.poll() is not None else "running",
            "studio_url": url_match[0] if url_match else None,
            "command": [str(item) for item in argv],
            "returncode": process.returncode,
            "timed_out": timed_out,
            "stdout": combined,
            "message": (
                "Hypit Studio 会话已停止。" if cancelled else
                "Hypit Studio 启动超时，会话已停止。" if timed_out else
                "Hypit Studio 进程已退出。" if process.returncode == 0 else
                "Hypit Studio 未能启动，请检查本地依赖和 Run 文件。"
            ),
        }

    def cancel(
        self,
        project: str | Path,
        job_id: str | None = None,
        *,
        build_id: str | None = None,
    ) -> dict[str, Any]:
        """Cancel an adapter job or submit the official Build cancellation.

        UI polling uses the ``hypit-<hex>`` adapter id.  A Build id is passed
        through the official ``hypit cancel`` command and therefore remains
        subject to Hypit's own runtime selection and remote cancellation
        semantics.
        """

        selected = self.project(project)
        if build_id is not None:
            return self.submit("cancel", selected, build_id=build_id)
        if not job_id:
            raise HypitRuntimeError("Hypit job id or Build id is required")
        job_path = self._job_directory(selected, job_id) / "job.json" if JOB_RE.fullmatch(job_id) else None
        if job_path is None or not job_path.is_file():
            return self.submit("cancel", selected, build_id=job_id)
        state = self.get(selected, job_id)
        with self._lock:
            event = self._active.get(job_id)
            if event is not None and state.get("status") not in TERMINAL:
                event.set()
                return self._persist(selected, job_id, cancel_requested=True, message="正在停止；已完成的本地产物会保留")
        return state

    # ---- Studio -------------------------------------------------------------

    def studio_status(self, project: str | Path | None = None) -> dict[str, Any]:
        selected = self.project(project)
        active: list[str] = []
        with self._lock:
            candidates = list(self._active)
        urls: list[dict[str, str]] = []
        for job_id in candidates:
            job = _read_json(self._job_directory(selected, job_id) / "job.json")
            if job.get("operation") in {"studio", "studio_start", "preview"} and job.get("status") not in TERMINAL:
                active.append(job_id)
                if job.get("studio_url"):
                    urls.append({"job_id": job_id, "url": str(job["studio_url"])})
        return {
            "service": "hypit-studio",
            "available": self._checkout_launcher().is_file() and shutil.which(self.settings.node_executable) is not None and self.distribution_version in HYPIT_DIALECTS,
            "running": bool(active),
            "active_jobs": active,
            "active_sessions": urls,
            "description": "Hypit Studio is a local browser preview/editor; it does not export an MP4 by itself.",
            "session_management_available": True,
            "license": HYPIT_LICENSE,
            "requires_external_authorization": False,
        }

    def studio_start_description(self, project: str | Path, run: str, *, port: int | None = None) -> dict[str, Any]:
        selected = self.project(project)
        argv = self.command_for("studio_start", selected, run=run, port=port)
        if argv is None:
            raise HypitRuntimeError("Studio command is unavailable")
        return {
            "service": "hypit-studio",
            "description": "启动本机 Hypit Studio 浏览器预览；预览不等于 MP4 导出",
            "command": argv,
            "project": {"id": self.project_id(selected), "path": str(selected)},
            "run": _relative(self._safe_file(selected, run, suffixes=(".svrun",)), selected),
            "requires_external_authorization": False,
        }


# Backward-friendly aliases for callers that call this a manager/service.
HypitService = HypitRuntime
HypitJobManager = HypitRuntime


class HypitJobRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    project_id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
    operation: Literal[
        "status", "doctor", "catalog", "examples", "manifest", "manifest_validate",
        "check", "plan", "studio", "build", "builds", "build_status", "inspect", "get",
        "validate", "compile", "preview", "render", "run", "history", "cancel",
        "studio_status", "studio_start", "project_manifest", "validate_manifest",
    ]
    source: str | None = Field(default=None, max_length=1024)
    run: str | None = Field(default=None, max_length=1024)
    build_id: str | None = Field(default=None, max_length=256)
    output: str | None = Field(default=None, max_length=200)
    to: str | None = Field(default=None, max_length=1024)
    title: str | None = Field(default=None, max_length=200)
    follow: bool = False
    port: int | None = Field(default=None, ge=1, le=65535)
    paid_approval: dict[str, Any] | None = None

    def params(self) -> dict[str, Any]:
        values = self.model_dump(exclude={"project_id", "operation"}, exclude_none=True)
        return values


class HypitActionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    action: Literal[
        "example_import", "bridge_export", "project_init", "project_select", "check", "plan", "studio", "build", "builds",
        "history", "build_status", "inspect", "get", "doctor", "cancel",
        "native_cli",
    ]
    project_id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
    project_path: str | None = Field(default=None, max_length=2048)
    options: dict[str, Any] = Field(default_factory=dict)


async def _same_origin(request: Request) -> None:
    if request.method in {"GET", "HEAD", "OPTIONS"}:
        return
    origin = request.headers.get("origin")
    if (origin and urlsplit(origin).netloc != request.headers.get("host")) or request.headers.get("sec-fetch-site") == "cross-site":
        raise HTTPException(status_code=403, detail="仅允许从本机工作台发起操作")


def create_hypit_router(
    project_root: str | Path,
    *,
    service: HypitRuntime | None = None,
    executor: Any | None = None,
    runner: CommandRunner | None = None,
    hypit_root: str | Path = HYPIT_ROOT,
    api_prefix: str = "/model-api/hypit",
) -> APIRouter:
    """Create the same-origin API used by the local workbench.

    The router accepts operation names, never raw commands.  All mutating or
    potentially long-running operations return a 202-style job envelope; the
    actual response body remains JSON so callers can poll after a refresh.
    """

    manager = service or HypitRuntime(Path(project_root), hypit_root=Path(hypit_root), executor=executor, runner=runner)
    router = APIRouter(prefix=api_prefix, tags=["hypit-runtime"], dependencies=[Depends(_same_origin)])

    async def call(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
        try:
            return await asyncio.to_thread(fn, *args, **kwargs)
        except HypitRuntimeError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @router.get("/status")
    async def get_status(project_id: str | None = None):
        return await call(manager.status, project_id)

    @router.get("/doctor")
    async def get_doctor(project_id: str | None = None):
        # Doctor is an observation job because the official command may probe
        # local dependencies or an authorized endpoint. It never receives a
        # secret in the request.
        selected = project_id or "."
        return await call(manager.submit, "doctor", selected)

    @router.get("/catalog")
    async def get_catalog(project_id: str | None = None):
        return await call(manager.catalog, project_id)

    @router.post("/action", status_code=202)
    async def post_action(body: HypitActionRequest):
        action = body.action
        if action == "example_import":
            return await call(manager.submit, "example_import", body.project_id, example_id=body.options.get("example_id"))
        if action == "bridge_export":
            params = {key: value for key, value in body.options.items() if key in {"asset_mode", "language", "aspect_ratio", "resolution", "fps", "variant_count"}}
            return await call(manager.submit, "bridge_export", body.project_id, **params)
        if action == "project_init":
            return await call(manager.initialize_project, body.project_id)
        if action == "project_select":
            return await call(manager.select_project, body.project_path or body.options.get("project_path"))

        selected = body.project_path or body.project_id
        options = body.options
        operation = action
        if operation == "check":
            params = {"source": options.get("source")}
        elif operation in {"plan", "studio", "build"}:
            params = {"run": options.get("run")}
            if operation == "studio":
                params["port"] = options.get("port")
            if operation == "build":
                params["follow"] = bool(options.get("follow", False))
                params["title"] = options.get("title")
                params["paid_approval"] = options.get("paid_approval")
        elif operation in {"builds", "doctor"}:
            params = {}
        elif operation == "history":
            params = {"output": options.get("output")}
        elif operation in {"build_status", "inspect"}:
            params = {"build_id": options.get("build_id")}
        elif operation == "get":
            params = {key: options.get(key) for key in ("build_id", "output", "to")}
        elif operation == "cancel":
            adapter_job_id = options.get("job_id")
            build_id = options.get("build_id")
            if options.get("dry_run"):
                params = {"job_id": adapter_job_id} if adapter_job_id and JOB_RE.fullmatch(str(adapter_job_id)) else {"build_id": build_id}
            elif adapter_job_id and JOB_RE.fullmatch(str(adapter_job_id)):
                return await call(manager.cancel, selected, str(adapter_job_id))
            else:
                params = {"build_id": build_id}
        elif operation == "native_cli":
            params = {
                "command_line": options.get("command_line"),
                "paid_approval": options.get("paid_approval"),
            }
        else:
            raise HTTPException(status_code=422, detail="Hypit action is not supported")

        if options.get("dry_run") is True:
            return await call(manager.dry_run, operation, selected, **params)
        return await call(manager.submit, operation, selected, **params)

    @router.get("/examples")
    async def get_examples(project_id: str | None = None):
        return await call(manager.examples, project_id)

    @router.get("/projects/{project_id}/manifest")
    async def get_manifest(project_id: str):
        return await call(manager.project_manifest, project_id)

    @router.post("/projects/{project_id}/manifest/validate", status_code=202)
    async def validate_manifest(project_id: str):
        return await call(manager.submit, "manifest_validate", project_id)

    @router.post("/projects/{project_id}/validate", status_code=202)
    async def validate_source(project_id: str, source: str):
        return await call(manager.submit, "validate", project_id, source=source)

    @router.post("/projects/{project_id}/compile", status_code=202)
    async def compile_run(project_id: str, run: str):
        return await call(manager.submit, "compile", project_id, run=run)

    @router.post("/projects/{project_id}/preview", status_code=202)
    async def preview_run(project_id: str, run: str, port: int | None = None):
        return await call(manager.submit, "preview", project_id, run=run, port=port)

    @router.post("/projects/{project_id}/render", status_code=202)
    async def render_run(project_id: str, run: str, title: str | None = None):
        return await call(manager.submit, "render", project_id, run=run, title=title)

    @router.post("/projects/{project_id}/run", status_code=202)
    async def run_build(project_id: str, run: str, follow: bool = False, title: str | None = None):
        return await call(manager.submit, "run", project_id, run=run, follow=follow, title=title)

    @router.get("/projects/{project_id}/history")
    async def get_history(project_id: str):
        return await call(manager.submit, "builds", project_id)

    @router.post("/projects/{project_id}/cancel", status_code=202)
    async def cancel_build(project_id: str, build_id: str):
        return await call(manager.submit, "cancel", project_id, build_id=build_id)

    @router.post("/jobs", status_code=202)
    async def create_job(body: HypitJobRequest):
        return await call(manager.submit, body.operation, body.project_id, **body.params())

    @router.get("/jobs")
    async def list_jobs(project_id: str):
        return {"jobs": await call(manager.list, project_id)}

    @router.get("/jobs/{job_id}")
    async def get_job(job_id: str, project_id: str):
        return await call(manager.get, project_id, job_id)

    @router.post("/jobs/{job_id}/cancel")
    async def cancel_job(job_id: str, project_id: str):
        return await call(manager.cancel, project_id, job_id)

    @router.get("/studio/status")
    async def studio_status(project_id: str | None = None):
        return await call(manager.studio_status, project_id)

    @router.post("/studio/start", status_code=202)
    async def studio_start(body: HypitJobRequest):
        if body.operation not in {"studio_start", "preview"}:
            raise HTTPException(status_code=422, detail="studio/start requires studio_start or preview")
        return await call(manager.submit, "studio_start", body.project_id, **body.params())

    return router


create_router = create_hypit_router


def create_hypit_app(
    project_root: str | Path,
    *,
    service: HypitRuntime | None = None,
    executor: Any | None = None,
    runner: CommandRunner | None = None,
    hypit_root: str | Path = HYPIT_ROOT,
) -> Any:
    """Build a small standalone FastAPI app for local integration tests."""

    from fastapi import FastAPI

    application = FastAPI(title="OpenMontage Hypit Runtime Adapter", version="0.1.0")
    application.include_router(
        create_hypit_router(
            project_root,
            service=service,
            executor=executor,
            runner=runner,
            hypit_root=hypit_root,
        )
    )
    return application


create_app = create_hypit_app


__all__ = [
    "HYPIT_COMMIT",
    "HYPIT_LICENSE",
    "HYPIT_ROOT",
    "HYPIT_VERSION",
    "HypitJobManager",
    "HypitJobRequest",
    "HypitRuntime",
    "HypitRuntimeError",
    "HypitService",
    "HypitSettings",
    "CommandResult",
    "create_hypit_router",
    "create_hypit_app",
    "create_router",
    "create_app",
]
