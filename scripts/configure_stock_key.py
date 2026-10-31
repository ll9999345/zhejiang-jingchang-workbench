#!/usr/bin/env python3
"""Configure one stock credential without putting it into arguments or files."""
from __future__ import annotations

import argparse
import getpass
import importlib.util
import json
from pathlib import Path
import sys
import warnings

# web_api.__init__ creates the task application. A credential-only CLI must
# neither initialise it nor inspect unrelated provider configuration.
_module_name = '_zhejiang_stock_credentials_local'
if _module_name not in sys.modules:
    _spec = importlib.util.spec_from_file_location(_module_name, Path(__file__).resolve().parents[1] / 'web_api/stock_credentials.py')
    _credentials = importlib.util.module_from_spec(_spec)
    sys.modules[_module_name] = _credentials
    _spec.loader.exec_module(_credentials)
else:
    _credentials = sys.modules[_module_name]
MAX_KEY_BYTES, PROVIDERS = _credentials.MAX_KEY_BYTES, _credentials.PROVIDERS
StockCredentialError, save_key = _credentials.StockCredentialError, _credentials.save_key


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        # argparse normally echoes unknown arguments, which might be secrets.
        raise StockCredentialError('invalid_arguments')


def main(argv=None, *, stdin=None, output=None, writer=None, prompt=None) -> int:
    output = output if output is not None else sys.stdout
    provider = None
    try:
        parser = SafeParser(description='将一项免费素材服务密钥添加到 macOS 钥匙串；不覆盖已有密钥')
        parser.add_argument('--provider', required=True, choices=tuple(PROVIDERS))
        parser.add_argument('--stdin', action='store_true', help='从标准输入读取不含换行的密钥，最多2048字节')
        args = parser.parse_args(argv)
        provider = args.provider
        if args.stdin:
            stream = stdin if stdin is not None else sys.stdin.buffer
            key = stream.read(MAX_KEY_BYTES + 1)
            if not isinstance(key, bytes) or len(key) > MAX_KEY_BYTES:
                raise StockCredentialError('invalid_key')
        else:
            if prompt is None and not sys.stdin.isatty():
                raise StockCredentialError('invalid_arguments')
            # An actual TTY is required, so getpass cannot fall back to echoed input.
            with warnings.catch_warnings():
                warnings.simplefilter('error', getpass.GetPassWarning)
                key = (prompt or getpass.getpass)(f'{provider} API 密钥（隐藏输入）：')
        receipt = (writer or save_key)(provider, key)
        if (not isinstance(receipt, dict) or receipt.get('provider') != provider
                or receipt.get('service') != PROVIDERS[provider]
                or receipt.get('configured') is not True or receipt.get('verified') is not True
                or not isinstance(receipt.get('saved'), bool)):
            raise StockCredentialError('verification_failed')
        safe = {name: receipt[name] for name in ('provider', 'service', 'configured', 'saved', 'verified')}
        print(json.dumps({'ok': True, **safe}, ensure_ascii=False), file=output)
        return 0
    except StockCredentialError as exc:
        print(json.dumps({'ok': False, 'provider': provider, 'service': PROVIDERS.get(provider)}, ensure_ascii=False), file=output)
        return 2 if exc.code.startswith('invalid_') else 3 if 'conflict' in exc.code else 4
    except (Exception, KeyboardInterrupt):
        print(json.dumps({'ok': False, 'provider': provider, 'service': PROVIDERS.get(provider)}, ensure_ascii=False), file=output)
        return 4


if __name__ == '__main__':
    raise SystemExit(main())
