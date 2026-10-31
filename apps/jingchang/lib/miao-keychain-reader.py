"""Private, noninteractive reader for one existing MiaoAPI Keychain entry.

Called only through the Node server's captured subprocess pipes. No writes,
alternate key services, environment credential fallback, or network calls.
The fixed service/account match V2 web_api/miaoapi_director.py.
"""
import ctypes
import json
import sys

SERVICE = b'cn.zhejiang-tourism.workbench.miaoapi'
ACCOUNT = b'director-text'
MAX_SECRET_BYTES = 4096


class BridgeError(Exception):
    def __init__(self, code=36):
        super().__init__('MiaoAPI local credential unavailable')
        self.code = code


def _frameworks():
    if sys.platform != 'darwin':
        raise BridgeError(69)
    security = ctypes.CDLL('/System/Library/Frameworks/Security.framework/Security')
    security.SecKeychainSetUserInteractionAllowed.argtypes = [ctypes.c_bool]
    security.SecKeychainSetUserInteractionAllowed.restype = ctypes.c_int32
    security.SecKeychainFindGenericPassword.argtypes = [
        ctypes.c_void_p, ctypes.c_uint32, ctypes.c_char_p,
        ctypes.c_uint32, ctypes.c_char_p, ctypes.POINTER(ctypes.c_uint32),
        ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_void_p),
    ]
    security.SecKeychainFindGenericPassword.restype = ctypes.c_int32
    security.SecKeychainItemFreeContent.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    security.SecKeychainItemFreeContent.restype = ctypes.c_int32
    core = ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
    core.CFRelease.argtypes = [ctypes.c_void_p]
    core.CFRelease.restype = None
    return security, core


def read_keychain(operation, frameworks=None):
    if operation not in ('metadata', 'resolve'):
        raise BridgeError(64)
    security, core = frameworks if frameworks is not None else _frameworks()
    # Fail closed if noninteractive mode cannot be set; never show an ACL dialog.
    if security.SecKeychainSetUserInteractionAllowed(False) != 0:
        raise BridgeError()
    length, data, item = ctypes.c_uint32(), ctypes.c_void_p(), ctypes.c_void_p()
    secret = None
    try:
        # Apple's API explicitly permits NULL for both password outputs when
        # obtaining only an item reference. Metadata requests no password bytes.
        status = security.SecKeychainFindGenericPassword(
            None, len(SERVICE), SERVICE, len(ACCOUNT), ACCOUNT,
            None if operation == 'metadata' else ctypes.byref(length),
            None if operation == 'metadata' else ctypes.byref(data),
            ctypes.byref(item),
        )
        if status == -25300:
            raise BridgeError(44)
        if status != 0:
            raise BridgeError()
        if operation == 'metadata':
            return {'configured': True}
        if not data.value or not 1 <= length.value <= MAX_SECRET_BYTES:
            raise BridgeError()
        # Avoid an immutable Python bytes/string copy of the secret.
        secret = bytearray(length.value)
        destination = (ctypes.c_ubyte * length.value).from_buffer(secret)
        ctypes.memmove(ctypes.addressof(destination), data, length.value)
        if any(byte < 33 or byte > 126 for byte in secret):
            raise BridgeError()
        return secret
    except Exception:
        if secret is not None:
            secret[:] = b'\0' * len(secret)
        raise
    finally:
        try:
            if data.value:
                try:
                    if 0 < length.value <= MAX_SECRET_BYTES:
                        ctypes.memset(data, 0, length.value)
                finally:
                    security.SecKeychainItemFreeContent(None, data)
        finally:
            if item.value:
                core.CFRelease(item)


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1 or args[0] not in ('metadata', 'resolve'):
        sys.stderr.write('MiaoAPI local credential operation unavailable\n')
        return 64
    result = None
    try:
        result = read_keychain(args[0])
        if args[0] == 'metadata':
            sys.stdout.write(json.dumps(result, separators=(',', ':')))
        else:
            # stdout is the private parent pipe; never a UI/API/log response.
            sys.stdout.buffer.write(result)
            sys.stdout.buffer.write(b'\n')
            sys.stdout.buffer.flush()
        return 0
    except BridgeError as error:
        sys.stderr.write('MiaoAPI local credential unavailable\n')
        return error.code
    except Exception:
        # No exception text, captured output, secret, or traceback is published.
        sys.stderr.write('MiaoAPI local credential unavailable\n')
        return 36
    finally:
        if isinstance(result, bytearray):
            result[:] = b'\0' * len(result)


if __name__ == '__main__':
    raise SystemExit(main())
