"""Add-only, non-interactive macOS credentials for three free stock providers.

Secrets remain in process memory and the OS Keychain. This module does not use
shell commands, files, generic credentials, provider fallbacks or network calls.
"""
from __future__ import annotations

import ctypes
import hmac
import os
import sys
import threading
from collections.abc import Mapping
from typing import Any

PROVIDERS = {'pexels': 'PEXELS_API_KEY', 'pixabay': 'PIXABAY_API_KEY', 'coverr': 'COVERR_API_KEY'}
KEYCHAIN_ACCOUNT = 'zhejiang-tourism-stock'
MAX_KEY_BYTES = 2048
_LOCK = threading.RLock()
_MESSAGES = {
    'invalid_provider': '仅支持 pexels、pixabay、coverr 素材服务',
    'invalid_key': '密钥必须为 1—2048 字节的非空 ASCII 字符，不能含空白或控制字符',
    'invalid_arguments': '参数无效；仅支持 --provider 和可选 --stdin，不接收命令行密钥',
    'environment_conflict': '已有有效环境变量指定其他密钥；没有保存或覆盖',
    'environment_invalid': '已有环境变量格式无效；请先检查，没有保存或覆盖',
    'keychain_conflict': '该素材服务已有其他密钥；没有覆盖',
    'keychain_duplicate': '钥匙串条目已存在；没有更新',
    'platform_unavailable': '该系统不支持 macOS 钥匙串；没有写入其他存储',
    'keychain_error': '钥匙串不可访问或写入；没有弹窗、明文文件或其他凭据后备',
    'verification_failed': '钥匙串保存后未能验证；没有自动重试、覆盖或删除',
}


class StockCredentialError(ValueError):
    def __init__(self, code: str):
        self.code = code if code in _MESSAGES else 'keychain_error'
        super().__init__(_MESSAGES[self.code])


def provider_service(provider: str) -> str:
    if not isinstance(provider, str) or provider not in PROVIDERS:
        raise StockCredentialError('invalid_provider')
    return PROVIDERS[provider]


def _secret_bytes(key: str | bytes) -> bytes:
    try:
        value = key.encode('ascii') if isinstance(key, str) else key if isinstance(key, bytes) else b''
    except UnicodeError:
        raise StockCredentialError('invalid_key') from None
    if not 1 <= len(value) <= MAX_KEY_BYTES or any(byte < 33 or byte > 126 for byte in value):
        raise StockCredentialError('invalid_key')
    return value


def _security():
    if sys.platform != 'darwin':
        raise StockCredentialError('platform_unavailable')
    try:
        lib = ctypes.CDLL('/System/Library/Frameworks/Security.framework/Security')
        lib.SecKeychainFindGenericPassword.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_char_p,
            ctypes.c_uint32, ctypes.c_char_p, ctypes.POINTER(ctypes.c_uint32),
            ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
        lib.SecKeychainFindGenericPassword.restype = ctypes.c_int32
        lib.SecKeychainAddGenericPassword.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_char_p,
            ctypes.c_uint32, ctypes.c_char_p, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_void_p]
        lib.SecKeychainAddGenericPassword.restype = ctypes.c_int32
        lib.SecKeychainItemFreeContent.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        lib.SecKeychainItemFreeContent.restype = ctypes.c_int32
        lib.SecKeychainSetUserInteractionAllowed.argtypes = [ctypes.c_bool]
        lib.SecKeychainSetUserInteractionAllowed.restype = ctypes.c_int32
        # Match the existing director policy: never prompt for access/unlock.
        if lib.SecKeychainSetUserInteractionAllowed(False) != 0:
            raise StockCredentialError('keychain_error')
        return lib
    except StockCredentialError:
        raise
    except Exception:
        raise StockCredentialError('keychain_error') from None


class MacOSStockKeychain:
    def __init__(self):
        self.lib = _security()

    def read(self, service: str, account: str | None) -> bytes | None:
        s, a = service.encode('ascii'), account.encode('ascii') if account is not None else None
        length, data = ctypes.c_uint32(), ctypes.c_void_p()
        try:
            status = self.lib.SecKeychainFindGenericPassword(None, len(s), s, len(a) if a is not None else 0, a,
                ctypes.byref(length), ctypes.byref(data), None)
            if status == -25300:
                return None
            if status != 0:
                raise StockCredentialError('keychain_error')
            if not data.value or not 1 <= length.value <= MAX_KEY_BYTES:
                raise StockCredentialError('keychain_error')
            return ctypes.string_at(data, length.value)
        except StockCredentialError:
            raise
        except Exception:
            raise StockCredentialError('keychain_error') from None
        finally:
            if data.value:
                try:
                    if self.lib.SecKeychainItemFreeContent(None, data) != 0:
                        raise StockCredentialError('keychain_error')
                except Exception:
                    raise StockCredentialError('keychain_error') from None

    def read_service(self, service: str) -> bytes | None:
        # Startup's existing helper matches service without an account. Avoid
        # adding an ambiguous second entry under a different legacy account.
        return self.read(service, None)

    def add(self, service: str, account: str, secret: bytes) -> None:
        s, a = service.encode('ascii'), account.encode('ascii')
        buffer = ctypes.create_string_buffer(secret, len(secret))
        try:
            status = self.lib.SecKeychainAddGenericPassword(None, len(s), s, len(a), a,
                len(secret), ctypes.cast(buffer, ctypes.c_void_p), None)
            if status == -25299:
                raise StockCredentialError('keychain_duplicate')
            if status != 0:
                raise StockCredentialError('keychain_error')
        except StockCredentialError:
            raise
        except Exception:
            raise StockCredentialError('keychain_error') from None
        finally:
            ctypes.memset(buffer, 0, len(secret))


def save_key(provider: str, key: str | bytes, *, environment: Mapping[str, str] | None = None,
             store: Any | None = None) -> dict[str, Any]:
    """Add an absent provider item, verify it, never replace an existing secret.

    Existing valid environment credentials have precedence and are not copied
    into the Keychain. Injectable mappings/store support entirely offline tests.
    """
    service = provider_service(provider)
    secret = _secret_bytes(key)
    env = os.environ if environment is None else environment
    with _LOCK:
        current = env.get(service)
        if current:
            try:
                existing = _secret_bytes(current)
            except StockCredentialError:
                raise StockCredentialError('environment_invalid') from None
            if not hmac.compare_digest(existing, secret):
                raise StockCredentialError('environment_conflict')
            return {'provider': provider, 'service': service, 'configured': True, 'saved': False, 'verified': True}
        try:
            chosen = store if store is not None else MacOSStockKeychain()
            service_reader = getattr(chosen, 'read_service', None)
            previous = chosen.read(service, KEYCHAIN_ACCOUNT)
            if previous is not None:
                if not isinstance(previous, bytes) or not hmac.compare_digest(previous, secret):
                    raise StockCredentialError('keychain_conflict')
                if callable(service_reader):
                    startup_value = service_reader(service)
                    if not isinstance(startup_value, bytes) or not hmac.compare_digest(startup_value, secret):
                        raise StockCredentialError('keychain_conflict')
                return {'provider': provider, 'service': service, 'configured': True, 'saved': False, 'verified': True}
            if callable(service_reader):
                existing_service = service_reader(service)
                if existing_service is not None:
                    if not isinstance(existing_service, bytes) or not hmac.compare_digest(existing_service, secret):
                        raise StockCredentialError('keychain_conflict')
                    return {'provider': provider, 'service': service, 'configured': True, 'saved': False, 'verified': True}
            saved = True
            try:
                chosen.add(service, KEYCHAIN_ACCOUNT, secret)
            except StockCredentialError as exc:
                if exc.code != 'keychain_duplicate':
                    raise
                saved = False
            verified = chosen.read(service, KEYCHAIN_ACCOUNT)
            if not isinstance(verified, bytes) or not hmac.compare_digest(verified, secret):
                raise StockCredentialError('keychain_conflict' if not saved else 'verification_failed')
            if callable(service_reader):
                startup_value = service_reader(service)
                if not isinstance(startup_value, bytes) or not hmac.compare_digest(startup_value, secret):
                    raise StockCredentialError('verification_failed')
            return {'provider': provider, 'service': service, 'configured': True, 'saved': saved, 'verified': True}
        except StockCredentialError:
            raise
        except Exception:
            raise StockCredentialError('keychain_error') from None


__all__ = ['PROVIDERS', 'KEYCHAIN_ACCOUNT', 'MAX_KEY_BYTES', 'StockCredentialError', 'provider_service', 'save_key']
