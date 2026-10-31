"""Direct Volcengine Ark adapter for Doubao-Seedream image generation.

This provider deliberately uses the official Ark ``images/generations``
endpoint rather than a gateway such as fal.ai.  The selector can therefore
use the same server-side ``ARK_API_KEY`` already used by Seedance video.

The API returns either a short-lived download URL or Base64 image data.  Both
are immediately persisted to the caller's output path so a project never
depends on a remote URL expiring later.
"""

from __future__ import annotations

import base64
import binascii
import mimetypes
import os
import time
from pathlib import Path
from typing import Any, Iterable

from tools.base_tool import (
    Determinism,
    ExecutionMode,
    ResourceProfile,
    RetryPolicy,
    ToolResult,
    ToolRuntime,
    ToolStability,
    ToolStatus,
    ToolTier,
    BaseTool,
)


class _ArkTransportError(RuntimeError):
    """A retryable network/TLS failure with the attempts preserved.

    ``requests`` raises these failures before an HTTP response exists.  Keeping
    the operation and attempt count lets the UI explain what happened without
    exposing the credential or pretending that a provider-side rejection was a
    network problem.
    """

    def __init__(self, operation: str, attempts: int, cause: BaseException) -> None:
        self.operation = operation
        self.attempts = attempts
        self.cause = cause
        super().__init__(
            f"{operation} transport failed after {attempts} attempt(s): {cause}"
        )


class DoubaoSeedreamImage(BaseTool):
    """Generate images directly through Volcengine Ark's ImageGenerations API."""

    name = "doubao_seedream_image"
    version = "0.1.0"
    tier = ToolTier.GENERATE
    capability = "image_generation"
    provider = "ark"
    stability = ToolStability.BETA
    execution_mode = ExecutionMode.SYNC
    determinism = Determinism.STOCHASTIC
    runtime = ToolRuntime.API

    BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"
    ENDPOINT = f"{BASE_URL}/images/generations"
    DEFAULT_MODEL = "doubao-seedream-5-0-260128"
    API_KEY_ENV = "ARK_API_KEY"
    BASE_URL_ENV = "ARK_BASE_URL"
    MODEL_ENV = "ARK_SEEDREAM_MODEL"
    MAX_RETRIES_ENV = "ARK_IMAGE_MAX_RETRIES"
    BACKOFF_SECONDS_ENV = "ARK_IMAGE_BACKOFF_SECONDS"
    CONNECT_TIMEOUT_ENV = "ARK_IMAGE_CONNECT_TIMEOUT"
    READ_TIMEOUT_ENV = "ARK_IMAGE_READ_TIMEOUT"
    DOWNLOAD_TIMEOUT_ENV = "ARK_IMAGE_DOWNLOAD_TIMEOUT"
    # This is only a conservative planning value.  The final cost must come
    # from the provider receipt/usage when the endpoint supplies it.
    PRICE_CNY_ENV = "ARK_SEEDREAM_CNY_PER_IMAGE"
    CNY_PER_IMAGE_DEFAULT = 0.22
    CNY_PER_USD_DEFAULT = 7.2
    MAX_IMAGE_BYTES = 30 * 1024 * 1024

    dependencies = ["env:ARK_API_KEY"]
    install_instructions = (
        "Set ARK_API_KEY to the Volcengine Ark API key body (without the "
        "Bearer prefix). Optional: ARK_SEEDREAM_MODEL for a model ID or "
        "Endpoint ID. The adapter automatically retries transient Ark/TLS "
        "transport failures; ARK_IMAGE_MAX_RETRIES and "
        "ARK_IMAGE_BACKOFF_SECONDS can tune that behavior."
    )
    agent_skills = ["visual-style", "seedance-2-0"]

    capabilities = [
        "generate_image",
        "text_to_image",
        "image_to_image",
        "reference_image",
        "multi_reference_images",
    ]
    supports = {
        "complex_instructions": True,
        "reference_image": True,
        "multiple_reference_images": True,
        "image_edit": True,
        "custom_size": True,
        "aspect_ratio": True,
        "watermark": True,
        "base64_output": True,
        "url_output": True,
    }
    best_for = [
        "direct Volcengine Ark Doubao-Seedream 5.0 image generation",
        "high-quality scenic storyboard frames and cinematic tourism visuals",
        "reference-conditioned image editing and continuity frame repair",
    ]
    not_good_for = [
        "offline generation",
        "unapproved paid generation",
        "long-running batch jobs without a persisted project manifest",
    ]
    fallback_tools = ["seedream_image", "openai_image", "comfyui_image"]

    input_schema = {
        "type": "object",
        "required": ["prompt"],
        "properties": {
            "prompt": {"type": "string"},
            "model": {
                "type": "string",
                "description": (
                    "Ark model ID or configured Endpoint ID. Defaults to "
                    "ARK_SEEDREAM_MODEL or doubao-seedream-5-0-260128."
                ),
            },
            "size": {
                "type": "string",
                "default": "2K",
                "description": "Ark size tier such as 1K, 2K, or 4K.",
            },
            "resolution": {
                "type": "string",
                "description": "Provider-neutral resolution hint; 1K/2K/4K are mapped to size.",
            },
            "width": {"type": "integer", "minimum": 64, "maximum": 8192},
            "height": {"type": "integer", "minimum": 64, "maximum": 8192},
            "aspect_ratio": {"type": "string"},
            "seed": {"type": "integer", "minimum": -1, "maximum": 2147483647},
            "image": {
                "type": "array",
                "items": {"type": "string"},
                "description": "URL or data URI references accepted by Ark.",
            },
            "images": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Provider-neutral URL/path references; paths are encoded locally.",
            },
            "image_url": {"type": "string"},
            "image_path": {"type": "string"},
            "image_urls": {"type": "array", "items": {"type": "string"}},
            "image_paths": {"type": "array", "items": {"type": "string"}},
            "sequential_image_generation": {
                "type": "string",
                "enum": ["disabled", "auto"],
                "default": "disabled",
            },
            "watermark": {"type": "boolean", "default": False},
            "response_format": {
                "type": "string",
                "enum": ["url", "b64_json"],
                "default": "url",
            },
            "output_format": {
                "type": "string",
                "enum": ["png", "jpeg"],
                "description": "Supported by Seedream 5.0-lite; omitted for other variants.",
            },
            "output_path": {"type": "string"},
            "metadata_path": {"type": "string"},
        },
    }

    output_schema = {
        "type": "object",
        "properties": {
            "output": {"type": "string"},
            "outputs": {"type": "array", "items": {"type": "string"}},
            "provider": {"type": "string"},
            "model": {"type": "string"},
            "request_id": {"type": ["string", "null"]},
            "usage": {"type": ["object", "null"]},
        },
    }

    resource_profile = ResourceProfile(
        cpu_cores=1, ram_mb=512, vram_mb=0, disk_mb=100, network_required=True
    )
    retry_policy = RetryPolicy(
        max_retries=3,
        backoff_seconds=1.5,
        retryable_errors=["rate_limit", "timeout", "server_error"],
    )
    idempotency_key_fields = [
        "prompt",
        "operation",
        "scene_id",
        "model",
        "size",
        "resolution",
        "width",
        "height",
        "aspect_ratio",
        "seed",
        "image",
        "images",
        "image_url",
        "image_path",
        "image_urls",
        "image_paths",
        "sequential_image_generation",
        "response_format",
        "output_format",
        "watermark",
    ]
    side_effects = [
        "writes image file to output_path",
        "calls Volcengine Ark ImageGenerations API",
    ]
    user_visible_verification = [
        "Inspect the downloaded image for scene fidelity, detail, continuity, and artifacts",
        "Check the saved provider metadata and image hash before using it in a storyboard",
    ]
    quality_score = 0.92
    latency_p50_seconds = 30.0

    @classmethod
    def _get_api_key(cls) -> str | None:
        value = os.environ.get(cls.API_KEY_ENV)
        if not isinstance(value, str):
            return None
        value = value.strip()
        return value or None

    @classmethod
    def _model(cls, inputs: dict[str, Any]) -> str:
        value = inputs.get("model") or os.environ.get(cls.MODEL_ENV) or cls.DEFAULT_MODEL
        return str(value).strip() or cls.DEFAULT_MODEL

    @classmethod
    def _get_base_url(cls) -> str:
        """Resolve the Ark API base URL without allowing insecure endpoints."""

        base_url = os.environ.get(cls.BASE_URL_ENV, cls.BASE_URL).strip().rstrip("/")
        if not base_url.startswith("https://"):
            raise ValueError(f"{cls.BASE_URL_ENV} must be an https:// URL")
        return base_url

    @classmethod
    def _configured_max_retries(cls) -> int:
        try:
            value = int(os.environ.get(cls.MAX_RETRIES_ENV, str(cls.retry_policy.max_retries)))
        except (TypeError, ValueError):
            value = cls.retry_policy.max_retries
        # A malformed environment variable must not create an infinite retry
        # loop or turn a single image into an unexpectedly long paid job.
        return max(0, min(5, value))

    @classmethod
    def _configured_backoff_seconds(cls) -> float:
        try:
            value = float(os.environ.get(cls.BACKOFF_SECONDS_ENV, str(cls.retry_policy.backoff_seconds)))
        except (TypeError, ValueError):
            value = cls.retry_policy.backoff_seconds
        return max(0.0, min(30.0, value))

    @classmethod
    def _configured_timeout(cls, env_name: str, default: float, *, maximum: float) -> float:
        try:
            value = float(os.environ.get(env_name, str(default)))
        except (TypeError, ValueError):
            value = default
        return max(1.0, min(maximum, value))

    @classmethod
    def _generation_timeout(cls) -> tuple[float, float]:
        return (
            cls._configured_timeout(cls.CONNECT_TIMEOUT_ENV, 30.0, maximum=120.0),
            cls._configured_timeout(cls.READ_TIMEOUT_ENV, 180.0, maximum=1800.0),
        )

    @classmethod
    def _download_timeout(cls) -> tuple[float, float]:
        timeout = cls._configured_timeout(cls.DOWNLOAD_TIMEOUT_ENV, 120.0, maximum=1800.0)
        return (min(timeout, 120.0), timeout)

    @staticmethod
    def _retryable_status(status_code: Any) -> bool:
        try:
            return int(status_code) in {408, 425, 429, 500, 502, 503, 504}
        except (TypeError, ValueError):
            return False

    @staticmethod
    def _retry_after_seconds(response: Any) -> float | None:
        headers = getattr(response, "headers", {}) or {}
        value = None
        for key, candidate in getattr(headers, "items", lambda: [])():
            if str(key).lower() == "retry-after":
                value = candidate
                break
        if value is None:
            return None
        try:
            # Ark normally returns a number of seconds.  Date-form Retry-After
            # is intentionally ignored; exponential backoff is safer when a
            # proxy sends an unparsable date or an unexpectedly large value.
            return max(0.0, min(30.0, float(value)))
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _close_response(response: Any) -> None:
        close = getattr(response, "close", None)
        if callable(close):
            try:
                close()
            except Exception:
                pass

    @staticmethod
    def _transport_exception_types(requests_module: Any) -> tuple[type[BaseException], ...]:
        """Return only exceptions that represent a retryable transport break."""

        types: list[type[BaseException]] = [TimeoutError, ConnectionError, OSError]
        exceptions = getattr(requests_module, "exceptions", None)
        # Do not include the umbrella ``RequestException``: it also covers
        # deterministic client errors such as InvalidURL, which should fail
        # immediately rather than spend four attempts on a malformed request.
        # Chunked/content-decoding failures are transport breaks for the image
        # download path and are safe to retry with a fresh connection.
        for name in (
            "SSLError",
            "ConnectionError",
            "Timeout",
            "ChunkedEncodingError",
            "ContentDecodingError",
        ):
            candidate = getattr(exceptions, name, None)
            if isinstance(candidate, type) and issubclass(candidate, BaseException):
                types.append(candidate)
        # Preserve order but remove duplicates (requests' ConnectionError may
        # itself inherit from RequestException).
        unique: list[type[BaseException]] = []
        for item in types:
            if item not in unique:
                unique.append(item)
        return tuple(unique)

    @classmethod
    def _is_transport_exception(cls, requests_module: Any, error: BaseException) -> bool:
        return isinstance(error, cls._transport_exception_types(requests_module))

    @classmethod
    def _sleep_before_retry(
        cls,
        attempt_index: int,
        response: Any | None = None,
        *,
        retry_after: float | None = None,
    ) -> None:
        delay = retry_after if retry_after is not None else (
            cls._retry_after_seconds(response) if response is not None else None
        )
        if delay is None:
            delay = cls._configured_backoff_seconds() * (2**attempt_index)
        if delay > 0:
            time.sleep(min(30.0, delay))

    @classmethod
    def _request_with_retry(
        cls,
        requests_module: Any,
        method: str,
        url: str,
        *,
        headers: dict[str, str],
        timeout: float | tuple[float, float],
        json_payload: dict[str, Any] | None = None,
        operation: str,
    ) -> tuple[Any, int]:
        """Issue one request with bounded transport/status retries.

        A fresh ``requests`` call plus ``Connection: close`` is deliberate:
        it avoids reusing a stale keep-alive socket, the pattern that produced
        the observed ``UNEXPECTED_EOF_WHILE_READING`` failure.  The same
        idempotency header is reused on every attempt so an upstream gateway
        can de-duplicate a request if it received the body before the socket
        broke.
        """

        request_fn = getattr(requests_module, method, None)
        if not callable(request_fn):
            raise RuntimeError(f"requests module has no {method}() function")
        max_retries = cls._configured_max_retries()
        for attempt in range(max_retries + 1):
            kwargs: dict[str, Any] = {"headers": headers, "timeout": timeout}
            if json_payload is not None:
                kwargs["json"] = json_payload
            try:
                response = request_fn(url, **kwargs)
            except Exception as exc:
                if not cls._is_transport_exception(requests_module, exc):
                    raise
                if attempt >= max_retries:
                    raise _ArkTransportError(operation, attempt + 1, exc) from exc
                cls._sleep_before_retry(attempt)
                continue

            if cls._retryable_status(getattr(response, "status_code", None)) and attempt < max_retries:
                # Read Retry-After before closing the response.  Some HTTP
                # clients discard headers during close(), and a provider's
                # backoff hint is more useful than blindly retrying quickly.
                retry_after = cls._retry_after_seconds(response)
                cls._close_response(response)
                cls._sleep_before_retry(attempt, response, retry_after=retry_after)
                continue
            return response, attempt + 1
        # The loop always returns or raises, but keeping this guard makes the
        # contract explicit if the implementation is changed later.
        raise RuntimeError(f"{operation} returned no response")

    @classmethod
    def _headers(cls, api_key: str, idempotency_key: str) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Connection": "close",
            "User-Agent": "ZhejiangTourismDirector/1.0 OpenMontage",
            "Idempotency-Key": idempotency_key,
        }

    @staticmethod
    def _download_headers() -> dict[str, str]:
        return {
            "Accept": "image/*",
            "Connection": "close",
            "User-Agent": "ZhejiangTourismDirector/1.0 OpenMontage",
        }

    def get_status(self) -> ToolStatus:
        return ToolStatus.AVAILABLE if self._get_api_key() else ToolStatus.UNAVAILABLE

    def estimate_cost(self, inputs: dict[str, Any]) -> float:
        """Return a planning estimate in USD; provider usage remains authoritative."""
        raw = os.environ.get(self.PRICE_CNY_ENV, str(self.CNY_PER_IMAGE_DEFAULT))
        try:
            cny = float(raw)
        except (TypeError, ValueError):
            cny = self.CNY_PER_IMAGE_DEFAULT
        try:
            cny_usd = float(os.environ.get("ARK_CNY_PER_USD", str(self.CNY_PER_USD_DEFAULT)))
        except (TypeError, ValueError):
            cny_usd = self.CNY_PER_USD_DEFAULT
        return round(max(0.0, cny) / max(0.01, cny_usd), 4)

    @staticmethod
    def _mime_for_path(path: Path) -> str:
        mime = mimetypes.guess_type(path.name)[0] or "image/png"
        return mime if mime.startswith("image/") else "image/png"

    @classmethod
    def _as_data_uri(cls, value: str) -> str:
        """Convert a local image path to an Ark-compatible data URI."""
        text = str(value).strip()
        if not text:
            raise ValueError("image reference must not be empty")
        if text.startswith(("http://", "https://", "data:image/")):
            return text
        path = Path(text).expanduser()
        if not path.is_file():
            raise FileNotFoundError(f"reference image not found: {text}")
        if path.stat().st_size > cls.MAX_IMAGE_BYTES:
            raise ValueError(f"reference image exceeds {cls.MAX_IMAGE_BYTES // (1024 * 1024)} MB")
        encoded = base64.b64encode(path.read_bytes()).decode("ascii")
        return f"data:{cls._mime_for_path(path)};base64,{encoded}"

    @classmethod
    def _references(cls, inputs: dict[str, Any]) -> list[str]:
        values: list[str] = []
        for key in ("image", "images", "image_urls", "image_paths"):
            raw = inputs.get(key)
            if isinstance(raw, str):
                raw = [raw]
            if isinstance(raw, Iterable) and not isinstance(raw, (bytes, bytearray, dict)):
                values.extend(str(item) for item in raw if str(item).strip())
        for key in ("image_url", "image_path"):
            value = inputs.get(key)
            if value:
                values.append(str(value))
        # De-duplicate while preserving order.  This also avoids sending a
        # repeated reference when selector aliases image_paths to images.
        seen: set[str] = set()
        result: list[str] = []
        for value in values:
            if value not in seen:
                seen.add(value)
                result.append(cls._as_data_uri(value))
        return result

    @staticmethod
    def _size(inputs: dict[str, Any]) -> str:
        value = inputs.get("size") or inputs.get("resolution") or "2K"
        text = str(value).strip()
        upper = text.upper()
        if upper in {"1K", "2K", "4K"}:
            return upper
        # OpenMontage's provider-neutral resolution often contains a suffix
        # such as "480p" or "auto_2K".  Only pass documented Ark tiers.
        for tier in ("4K", "2K", "1K"):
            if tier.lower() in text.lower():
                return tier
        return "2K"

    @classmethod
    def _payload(cls, inputs: dict[str, Any]) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": cls._model(inputs),
            "prompt": str(inputs.get("prompt", "")),
            "size": cls._size(inputs),
            "watermark": bool(inputs.get("watermark", False)),
            "response_format": inputs.get("response_format", "url"),
        }
        refs = cls._references(inputs)
        if refs:
            payload["image"] = refs
        if inputs.get("sequential_image_generation"):
            payload["sequential_image_generation"] = inputs["sequential_image_generation"]
        # output_format is documented for the 5.0-lite family; callers can
        # select that model explicitly.  Do not send unsupported fields by
        # default to the other Seedream variants.
        if inputs.get("output_format"):
            payload["output_format"] = inputs["output_format"]
        if inputs.get("seed") is not None:
            payload["seed"] = int(inputs["seed"])
        return payload

    @staticmethod
    def _response_request_id(response: Any, data: dict[str, Any]) -> str | None:
        headers = getattr(response, "headers", {}) or {}
        for key in ("x-request-id", "request-id", "X-Request-ID"):
            value = headers.get(key)
            if value:
                return str(value)
        value = data.get("request_id") or data.get("requestId")
        return str(value) if value else None

    @classmethod
    def _output_paths(cls, output_path: str | None, count: int, output_format: str) -> list[Path]:
        suffix = ".png" if output_format not in {"jpeg", "jpg"} else ".jpg"
        base = Path(output_path or f"seedream-ark{suffix}")
        if not base.suffix:
            base = base.with_suffix(suffix)
        if count == 1:
            return [base]
        return [base.with_name(f"{base.stem}_{i}{base.suffix}") for i in range(1, count + 1)]

    @staticmethod
    def _decode_b64(value: str) -> bytes:
        text = str(value)
        if "," in text and text.startswith("data:"):
            text = text.split(",", 1)[1]
        try:
            return base64.b64decode(text, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("Ark returned invalid Base64 image data") from exc

    def execute(self, inputs: dict[str, Any]) -> ToolResult:
        api_key = self._get_api_key()
        if not api_key:
            return ToolResult(success=False, error="ARK_API_KEY is not configured. " + self.install_instructions)
        prompt = str(inputs.get("prompt", "")).strip()
        if len(prompt) < 2:
            return ToolResult(success=False, error="prompt must contain at least two non-space characters")
        try:
            payload = self._payload({**inputs, "prompt": prompt})
        except (ValueError, FileNotFoundError) as exc:
            return ToolResult(success=False, error=str(exc))

        import requests

        started = time.time()
        request_attempts = 0
        download_attempts = 0
        try:
            endpoint = f"{self._get_base_url()}/images/generations"
            # The hash is deliberately derived from all output-affecting
            # fields, not from the local output path.  Retrying a broken socket
            # must remain the same logical provider request, while writing the
            # same result to a different local path is still allowed.
            idempotency_key = self.idempotency_key({**inputs, "prompt": prompt})
            response, request_attempts = self._request_with_retry(
                requests,
                "post",
                endpoint,
                headers=self._headers(api_key, idempotency_key),
                json_payload=payload,
                timeout=self._generation_timeout(),
                operation="Ark image generation",
            )
            response.raise_for_status()
            result = response.json()
            if not isinstance(result, dict):
                raise RuntimeError("Ark returned a non-object response")
            items = result.get("data") or []
            if not isinstance(items, list) or not items:
                error = result.get("error")
                detail = error.get("message") if isinstance(error, dict) else error
                raise RuntimeError(str(detail or "Ark returned no image outputs"))
            output_format = str(inputs.get("output_format") or "png").lower()
            paths = self._output_paths(inputs.get("output_path"), len(items), output_format)
            artifacts: list[str] = []
            for item, path in zip(items, paths):
                if not isinstance(item, dict):
                    raise RuntimeError("Ark returned an invalid image item")
                if item.get("b64_json"):
                    content = self._decode_b64(item["b64_json"])
                elif item.get("url"):
                    image_response, attempts = self._request_with_retry(
                        requests,
                        "get",
                        str(item["url"]),
                        headers=self._download_headers(),
                        timeout=self._download_timeout(),
                        operation="Ark image download",
                    )
                    download_attempts += attempts
                    image_response.raise_for_status()
                    content = bytes(image_response.content)
                else:
                    raise RuntimeError("Ark image item has neither url nor b64_json")
                if not content:
                    raise RuntimeError("Ark returned an empty image")
                if len(content) > self.MAX_IMAGE_BYTES:
                    raise RuntimeError("Ark image output exceeds the safe download limit")
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
                artifacts.append(str(path))

            request_id = self._response_request_id(response, result)
            metadata_path = inputs.get("metadata_path")
            if not metadata_path and artifacts:
                metadata_path = str(Path(artifacts[0]).with_suffix(".json"))
            if metadata_path:
                import json
                meta = {
                    "provider": "ark",
                    "tool": self.name,
                    "model": result.get("model") or payload["model"],
                    "request_id": request_id,
                    "created": result.get("created"),
                    "usage": result.get("usage"),
                    "image_count": len(artifacts),
                    "payload_summary": {
                        "size": payload.get("size"),
                        "response_format": payload.get("response_format"),
                        "reference_count": len(payload.get("image") or []),
                        "watermark": payload.get("watermark"),
                    },
                    "network_attempts": {
                        "generation": request_attempts,
                        "downloads": download_attempts,
                        "total": request_attempts + download_attempts,
                    },
                }
                meta_path = Path(metadata_path)
                meta_path.parent.mkdir(parents=True, exist_ok=True)
                meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

        except Exception as exc:
            # Never include the API key in a provider exception, even if a
            # third-party HTTP library happens to echo request headers.
            safe = str(exc).replace(api_key, "[REDACTED]")
            if isinstance(exc, _ArkTransportError):
                safe = (
                    f"{safe}; 网络/TLS传输中断，已自动重试 {exc.attempts} 次仍未成功"
                )
            total_attempts = request_attempts + download_attempts
            if total_attempts > 1 and not isinstance(exc, _ArkTransportError):
                safe = f"{safe}; 网络请求共尝试 {total_attempts} 次"
            return ToolResult(
                success=False,
                error=f"Doubao-Seedream Ark generation failed: {safe[:600]}",
                duration_seconds=round(time.time() - started, 2),
            )

        model = result.get("model") or payload["model"]
        data = {
            "provider": "ark",
            "model": model,
            "prompt": prompt,
            "request_id": request_id,
            "image_count": len(artifacts),
            "outputs": artifacts,
            "output": artifacts[0],
            "usage": result.get("usage"),
            "size": payload.get("size"),
            "network_attempts": {
                "generation": request_attempts,
                "downloads": download_attempts,
                "total": request_attempts + download_attempts,
            },
        }
        if metadata_path:
            data["metadata_path"] = str(metadata_path)
        return ToolResult(
            success=True,
            data=data,
            # ``artifacts`` contains media outputs only.  Metadata is exposed
            # explicitly in ``data.metadata_path`` so downstream image
            # pipelines never mistake a JSON sidecar for a frame.
            artifacts=artifacts,
            cost_usd=self.estimate_cost(inputs),
            duration_seconds=round(time.time() - started, 2),
            model=str(model),
        )


__all__ = ["DoubaoSeedreamImage"]
