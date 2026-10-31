"""Minimal task API around the official OpenMontage Seedance Ark tool.

The API deliberately owns only request validation, budget/auth gates and task
metadata persistence. Provider-specific request construction and HTTP calls
remain in :class:`tools.video.seedance_ark.SeedanceArkVideo`.
"""

from __future__ import annotations

import json
import math
import os
import re
import secrets
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Protocol
from urllib.parse import urlsplit, urlunsplit

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field, field_validator


TASK_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$")
SENSITIVE_KEY_PATTERN = re.compile(
    r"(?:api[_-]?key|token|authorization|secret|password|credential)",
    flags=re.IGNORECASE,
)
DEFAULT_MAX_COST_CNY = 50.0
DEFAULT_WEB_ORIGIN = "http://127.0.0.1:3010"


class ToolLike(Protocol):
    """The small portion of the OpenMontage tool contract used by this API."""

    name: str

    def dry_run(self, inputs: dict[str, Any]) -> dict[str, Any]: ...

    def execute(self, inputs: dict[str, Any]) -> Any: ...

    def get_status(self) -> Any: ...


@dataclass(frozen=True)
class WebApiSettings:
    """Configuration that is safe to keep in application state.

    The paid authorization token is intentionally not cached here. It is read
    from the environment at the create boundary so a long-running process can
    be disabled by removing the variable without exposing the token in health
    responses or logs.
    """

    max_cost_cny: float = DEFAULT_MAX_COST_CNY
    web_origin: str = DEFAULT_WEB_ORIGIN
    db_path: Path = Path(__file__).resolve().parent / "tasks.sqlite3"

    @classmethod
    def from_env(cls, db_path: str | Path | None = None) -> "WebApiSettings":
        raw_limit = os.environ.get("WEB_API_MAX_COST_CNY", str(DEFAULT_MAX_COST_CNY))
        try:
            max_cost = float(raw_limit)
        except (TypeError, ValueError):
            max_cost = DEFAULT_MAX_COST_CNY
        if not math.isfinite(max_cost) or max_cost <= 0:
            max_cost = DEFAULT_MAX_COST_CNY

        raw_path = db_path if db_path is not None else os.environ.get("WEB_API_DB_PATH")
        resolved_path = (
            Path(raw_path).expanduser()
            if raw_path is not None
            else Path(__file__).resolve().parent / "tasks.sqlite3"
        )
        return cls(
            max_cost_cny=max_cost,
            web_origin=os.environ.get("WEB_ORIGIN", DEFAULT_WEB_ORIGIN),
            db_path=resolved_path,
        )


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json_safe(value: Any) -> Any:
    """Convert provider-shaped values into strict JSON without leaking errors."""

    if value is None or isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, Mapping):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(item) for item in value]
    return str(value)


def _strict_json(value: Any) -> str:
    return json.dumps(_json_safe(value), ensure_ascii=False, allow_nan=False)


def _remove_sensitive_fields(value: Any) -> Any:
    """Recursively remove credential-shaped mapping keys.

    The original request is passed to the provider before this function is
    used. It is only a persistence/output boundary guard, so provider features
    that legitimately consume an extra field continue to work for that call.
    """

    if isinstance(value, Mapping):
        return {
            str(key): _remove_sensitive_fields(item)
            for key, item in value.items()
            if not SENSITIVE_KEY_PATTERN.search(str(key))
        }
    if isinstance(value, (list, tuple, set)):
        return [_remove_sensitive_fields(item) for item in value]
    return value


def _safe_output(value: Any, key: str | None = None) -> Any:
    """Redact error-shaped provider fields before they reach a client."""

    if isinstance(value, Mapping):
        return {
            str(item_key): _safe_output(item_value, str(item_key))
            for item_key, item_value in value.items()
        }
    if isinstance(value, (list, tuple, set)):
        return [_safe_output(item, key) for item in value]
    if key and key.lower() in {"error", "message", "detail", "exception"}:
        return _safe_error(value)
    return _json_safe(value)


def _safe_error(error: Any) -> str:
    """Return an actionable provider error while removing secrets and URLs."""

    message = str(error or "request failed")
    known_secrets = {
        value
        for value in (
            os.environ.get("WEB_API_PAID_AUTH_TOKEN"),
            os.environ.get("ARK_API_KEY"),
        )
        if value
    }
    for secret in known_secrets:
        message = message.replace(secret, "[redacted]")

    message = re.sub(
        r"data:(?:image|audio|video)/[^;\s]+;base64,[A-Za-z0-9+/=]+",
        "[redacted data URI]",
        message,
        flags=re.IGNORECASE,
    )
    message = re.sub(
        r"(?i)(authorization\s*[:=]\s*bearer\s+)\S+",
        r"\1[redacted]",
        message,
    )

    def redact_url(match: re.Match[str]) -> str:
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
            safe = urlunsplit((parsed.scheme, host, parsed.path, "", ""))
            return safe + trailing
        except ValueError:
            return "[redacted URL]"

    return re.sub(r"https?://[^\s'\"<>]+", redact_url, message, flags=re.I)


def _default_tool() -> ToolLike:
    """Load the official provider only when the first request needs it."""

    from tools.video.seedance_ark import SeedanceArkVideo

    return SeedanceArkVideo()


class GenerationRequest(BaseModel):
    """Common request envelope forwarded to ``SeedanceArkVideo``.

    ``extra='allow'`` keeps this facade thin: newly supported provider fields
    can pass through without duplicating the full provider schema here. The
    budget field is consumed by this API and never forwarded to the provider.
    """

    model_config = ConfigDict(extra="allow")

    max_cost_cny: float | None = Field(default=None, gt=0)
    prompt: str | None = None
    operation: str = "text_to_video"
    model_variant: str = "standard"
    model: str | None = None
    custom_price_cny_per_million_tokens: float | None = Field(default=None, gt=0)
    duration: int | str | None = 5
    aspect_ratio: str = "16:9"
    resolution: str = "720p"
    generate_audio: bool = True
    watermark: bool = False
    return_last_frame: bool = False

    @field_validator("max_cost_cny", "custom_price_cny_per_million_tokens")
    @classmethod
    def _finite_positive(cls, value: float | None) -> float | None:
        if value is not None and not math.isfinite(value):
            raise ValueError("must be a finite number")
        return value


class HealthResponse(BaseModel):
    status: str
    database: str
    tool_status: str
    paid_authorization_configured: bool


class EstimateResponse(BaseModel):
    valid: bool
    estimated_cost_cny: float | None = None
    estimated_cost_usd: float | None = None
    estimated_tokens: int | None = None
    requested_max_cost_cny: float | None = None
    server_max_cost_cny: float
    within_max_cost: bool | None = None
    dry_run: dict[str, Any] = Field(default_factory=dict)
    error: str | None = None


class TaskResponse(BaseModel):
    task_id: str
    status: str
    provider: str | None = None
    model: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
    data: dict[str, Any] = Field(default_factory=dict)


class ErrorResponse(BaseModel):
    detail: str


class TaskStore:
    """Small sqlite3 repository; each operation gets a short-lived connection."""

    def __init__(self, path: str | Path):
        self.path = str(path)
        self._memory_connection: sqlite3.Connection | None = None
        if self.path != ":memory:":
            Path(self.path).expanduser().parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        if self.path == ":memory:":
            if self._memory_connection is None:
                self._memory_connection = sqlite3.connect(
                    ":memory:", check_same_thread=False
                )
                self._memory_connection.row_factory = sqlite3.Row
            return self._memory_connection
        connection = sqlite3.connect(self.path, timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout=5000")
        return connection

    def _initialize(self) -> None:
        connection = self._connect()
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS tasks (
                task_id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                provider TEXT,
                model TEXT,
                request_json TEXT NOT NULL,
                data_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        connection.commit()
        if self.path != ":memory:":
            connection.close()

    def ping(self) -> bool:
        connection = self._connect()
        try:
            connection.execute("SELECT 1").fetchone()
            return True
        finally:
            if self.path != ":memory:":
                connection.close()

    def get(self, task_id: str) -> dict[str, Any] | None:
        connection = self._connect()
        try:
            row = connection.execute(
                "SELECT * FROM tasks WHERE task_id = ?", (task_id,)
            ).fetchone()
            return dict(row) if row is not None else None
        finally:
            if self.path != ":memory:":
                connection.close()

    def save(
        self,
        *,
        task_id: str,
        status: str,
        provider: str | None,
        model: str | None,
        request: Any,
        data: Any,
    ) -> dict[str, Any]:
        now = _utc_now()
        connection = self._connect()
        try:
            existing = connection.execute(
                "SELECT created_at, request_json FROM tasks WHERE task_id = ?",
                (task_id,),
            ).fetchone()
            created_at = str(existing["created_at"]) if existing else now
            if existing and request is None:
                try:
                    previous_request = json.loads(str(existing["request_json"]))
                except (TypeError, ValueError):
                    previous_request = {}
                request_json = _strict_json(_remove_sensitive_fields(previous_request))
            else:
                request_json = _strict_json(_remove_sensitive_fields(request or {}))
            connection.execute(
                """
                INSERT INTO tasks
                    (task_id, status, provider, model, request_json, data_json,
                     created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(task_id) DO UPDATE SET
                    status=excluded.status,
                    provider=excluded.provider,
                    model=excluded.model,
                    request_json=excluded.request_json,
                    data_json=excluded.data_json,
                    updated_at=excluded.updated_at
                """,
                (
                    task_id,
                    status,
                    provider,
                    model,
                    request_json,
                    _strict_json(_remove_sensitive_fields(data or {})),
                    created_at,
                    now,
                ),
            )
            connection.commit()
        finally:
            if self.path != ":memory:":
                connection.close()
        saved = self.get(task_id)
        if saved is None:  # pragma: no cover - defensive sqlite failure guard
            raise RuntimeError("task persistence failed")
        return saved


def _provider_result(raw: Any) -> tuple[bool, dict[str, Any], str | None]:
    """Normalize ``ToolResult`` and tiny fake-tool results to one shape."""

    if isinstance(raw, Mapping):
        data = raw.get("data")
        normalized_data = data if isinstance(data, Mapping) else raw
        success = bool(raw.get("success", normalized_data.get("valid", True)))
        safe_data = _remove_sensitive_fields(_safe_output(normalized_data))
        return success, dict(safe_data), (
            str(raw["error"]) if raw.get("error") else None
        )

    raw_data = getattr(raw, "data", {})
    normalized_data = raw_data if isinstance(raw_data, Mapping) else {}
    success = bool(getattr(raw, "success", False))
    error = getattr(raw, "error", None)
    safe_data = _remove_sensitive_fields(_safe_output(normalized_data))
    return success, dict(safe_data), str(error) if error else None


def _request_payload(request: GenerationRequest, action: str) -> tuple[dict[str, Any], float | None]:
    values = request.model_dump(exclude_none=True)
    requested_max = values.pop("max_cost_cny", None)
    values["task_action"] = action
    return values, requested_max


def _number(data: Mapping[str, Any], key: str) -> float | None:
    value = data.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    value = float(value)
    return value if math.isfinite(value) and value >= 0 else None


def _int_number(data: Mapping[str, Any], key: str) -> int | None:
    value = data.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    value = int(value)
    return value if value >= 0 else None


def _status_from_data(data: Mapping[str, Any], fallback: str) -> str:
    nested = data.get("task")
    if isinstance(nested, Mapping) and nested.get("status"):
        return str(nested["status"])
    return str(data.get("status") or fallback)


def _task_id_from_data(data: Mapping[str, Any]) -> str | None:
    raw = data.get("task_id") or data.get("id")
    if raw is None and isinstance(data.get("task"), Mapping):
        raw = data["task"].get("id") or data["task"].get("task_id")
    value = str(raw or "")
    return value if TASK_ID_PATTERN.fullmatch(value) else None


def _record_response(record: Mapping[str, Any]) -> TaskResponse:
    try:
        data = json.loads(str(record.get("data_json") or "{}"))
    except (TypeError, ValueError):
        data = {}
    return TaskResponse(
        task_id=str(record["task_id"]),
        status=str(record.get("status") or "unknown"),
        provider=str(record["provider"]) if record.get("provider") else None,
        model=str(record["model"]) if record.get("model") else None,
        created_at=str(record.get("created_at")) if record.get("created_at") else None,
        updated_at=str(record.get("updated_at")) if record.get("updated_at") else None,
        data=data if isinstance(data, dict) else {},
    )


def _validate_path_task_id(task_id: str) -> None:
    if not TASK_ID_PATTERN.fullmatch(task_id):
        raise HTTPException(status_code=422, detail="task_id is missing or invalid")


def _require_paid_authorization(authorization: str | None) -> None:
    expected = os.environ.get("WEB_API_PAID_AUTH_TOKEN")
    if not expected:
        raise HTTPException(
            status_code=503,
            detail="paid task submission is not configured",
        )
    if not authorization or not secrets.compare_digest(authorization, expected):
        raise HTTPException(status_code=403, detail="invalid generation authorization")


def _tool_status(tool: Any) -> str:
    try:
        value = tool.get_status()
        return str(getattr(value, "value", value))
    except Exception:
        return "unknown"


def create_app(
    tool: ToolLike | None = None,
    db_path: str | Path | None = None,
    settings: WebApiSettings | None = None,
) -> FastAPI:
    """Create an app, allowing tests to inject a fake provider and DB path."""

    config = settings or WebApiSettings.from_env(db_path=db_path)
    store = TaskStore(config.db_path)
    application = FastAPI(
        title="OpenMontage Seedance Task API",
        version="0.1.0",
        responses={400: {"model": ErrorResponse}, 403: {"model": ErrorResponse}},
    )
    application.state.tool = tool
    application.state.store = store
    application.state.settings = config

    application.add_middleware(
        CORSMiddleware,
        allow_origins=[config.web_origin],
        allow_credentials=False,
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "X-Generation-Authorization"],
    )

    def get_tool() -> ToolLike:
        if application.state.tool is None:
            application.state.tool = _default_tool()
        return application.state.tool

    @application.get("/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        try:
            database = "ok" if store.ping() else "degraded"
        except Exception:
            database = "degraded"
        return HealthResponse(
            status="ok" if database == "ok" else "degraded",
            database=database,
            tool_status=_tool_status(get_tool()),
            paid_authorization_configured=bool(
                os.environ.get("WEB_API_PAID_AUTH_TOKEN")
            ),
        )

    @application.post("/api/tasks/estimate", response_model=EstimateResponse)
    def estimate(request: GenerationRequest) -> EstimateResponse:
        payload, requested_max = _request_payload(request, "create")
        try:
            raw = get_tool().dry_run(payload)
            valid, dry_data, error = _provider_result(raw)
        except Exception as exc:
            return EstimateResponse(
                valid=False,
                requested_max_cost_cny=requested_max,
                server_max_cost_cny=config.max_cost_cny,
                dry_run={},
                error=_safe_error(exc),
            )

        estimated_cost = _number(dry_data, "estimated_cost_cny")
        within = None
        if estimated_cost is not None and requested_max is not None:
            within = estimated_cost <= min(requested_max, config.max_cost_cny)
        return EstimateResponse(
            valid=valid,
            estimated_cost_cny=estimated_cost,
            estimated_cost_usd=_number(dry_data, "estimated_cost_usd"),
            estimated_tokens=_int_number(dry_data, "estimated_tokens"),
            requested_max_cost_cny=requested_max,
            server_max_cost_cny=config.max_cost_cny,
            within_max_cost=within,
            dry_run=dry_data,
            error=_safe_error(error) if error else None,
        )

    @application.post(
        "/api/tasks",
        response_model=TaskResponse,
    )
    def create_task(
        request: GenerationRequest,
        x_generation_authorization: str | None = Header(
            default=None, alias="X-Generation-Authorization"
        ),
    ) -> TaskResponse:
        _require_paid_authorization(x_generation_authorization)
        payload, requested_max = _request_payload(request, "create")
        if requested_max is None:
            raise HTTPException(
                status_code=422,
                detail="max_cost_cny is required for paid task submission",
            )

        try:
            dry_raw = get_tool().dry_run(payload)
            dry_success, dry_data, dry_error = _provider_result(dry_raw)
        except Exception as exc:
            raise HTTPException(status_code=502, detail=_safe_error(exc)) from None

        estimated_cost = _number(dry_data, "estimated_cost_cny")
        if not dry_success or estimated_cost is None:
            detail = dry_error or dry_data.get("error") or "task estimate is invalid"
            raise HTTPException(status_code=422, detail=_safe_error(detail))

        allowed = min(requested_max, config.max_cost_cny)
        if estimated_cost > allowed:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"estimated cost {estimated_cost:.4f} CNY exceeds the allowed "
                    f"limit of {allowed:.4f} CNY"
                ),
            )

        try:
            raw = get_tool().execute(payload)
            success, data, error = _provider_result(raw)
        except Exception as exc:
            raise HTTPException(status_code=502, detail=_safe_error(exc)) from None
        if not success:
            raise HTTPException(
                status_code=502,
                detail=_safe_error(error or "provider task submission failed"),
            )

        task_id = _task_id_from_data(data)
        if task_id is None:
            raise HTTPException(
                status_code=502,
                detail="provider returned no valid task_id",
            )
        record = store.save(
            task_id=task_id,
            status=_status_from_data(data, "submitted"),
            provider=str(data.get("provider")) if data.get("provider") else "ark",
            model=str(data.get("model")) if data.get("model") else None,
            request=payload,
            data=data,
        )
        return _record_response(record)

    @application.get("/api/tasks/{task_id}", response_model=TaskResponse)
    def query_task(
        task_id: str,
        x_generation_authorization: str | None = Header(
            default=None, alias="X-Generation-Authorization"
        ),
    ) -> TaskResponse:
        _require_paid_authorization(x_generation_authorization)
        _validate_path_task_id(task_id)
        payload = {"task_action": "query", "task_id": task_id}
        try:
            raw = get_tool().execute(payload)
            success, data, error = _provider_result(raw)
        except Exception as exc:
            raise HTTPException(status_code=502, detail=_safe_error(exc)) from None
        if not success:
            raise HTTPException(
                status_code=502,
                detail=_safe_error(error or "provider task query failed"),
            )

        previous = store.get(task_id)
        record = store.save(
            task_id=task_id,
            status=_status_from_data(data, previous.get("status", "unknown") if previous else "unknown"),
            provider=(
                str(data.get("provider"))
                if data.get("provider")
                else (str(previous["provider"]) if previous and previous.get("provider") else "ark")
            ),
            model=(
                str(data.get("model"))
                if data.get("model")
                else (str(previous["model"]) if previous and previous.get("model") else None)
            ),
            request=None,
            data=data,
        )
        return _record_response(record)

    @application.delete("/api/tasks/{task_id}", response_model=TaskResponse)
    def cancel_task(
        task_id: str,
        x_generation_authorization: str | None = Header(
            default=None, alias="X-Generation-Authorization"
        ),
    ) -> TaskResponse:
        _require_paid_authorization(x_generation_authorization)
        _validate_path_task_id(task_id)
        payload = {"task_action": "cancel", "task_id": task_id}
        try:
            raw = get_tool().execute(payload)
            success, data, error = _provider_result(raw)
        except Exception as exc:
            raise HTTPException(status_code=502, detail=_safe_error(exc)) from None
        if not success:
            raise HTTPException(
                status_code=502,
                detail=_safe_error(error or "provider task cancellation failed"),
            )

        previous = store.get(task_id)
        record = store.save(
            task_id=task_id,
            status="cancel_requested",
            provider=(
                str(data.get("provider"))
                if data.get("provider")
                else (str(previous["provider"]) if previous and previous.get("provider") else "ark")
            ),
            model=(
                str(data.get("model"))
                if data.get("model")
                else (str(previous["model"]) if previous and previous.get("model") else None)
            ),
            request=None,
            data=data,
        )
        return _record_response(record)

    return application


app = create_app()


__all__ = [
    "ErrorResponse",
    "EstimateResponse",
    "GenerationRequest",
    "HealthResponse",
    "TaskResponse",
    "TaskStore",
    "WebApiSettings",
    "app",
    "create_app",
]
