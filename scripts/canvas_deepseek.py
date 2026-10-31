#!/usr/bin/env python3
"""Private JSON pipe for the native canvas; never prints a credential or traceback."""
from pathlib import Path
import json
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main():
    from web_api.canvas_director import DeepSeekCanvas, DirectorError
    try:
        raw = sys.stdin.buffer.read(256_001)
        if len(raw) > 256_000:
            raise DirectorError('画布请求过大，未提交')
        body = json.loads(raw)
        provider = body.get('provider', 'deepseek')
        if provider == 'miaoapi':
            from web_api.miaoapi_director import MiaoCanvas
            service = MiaoCanvas()
        elif provider == 'deepseek':
            service = DeepSeekCanvas()
        else:
            raise DirectorError('画布模型服务无效')
        if body.get('operation') == 'status':
            result = service.status()
        elif body.get('operation') == 'complete':
            result = service.complete(body)
        else:
            raise DirectorError('画布导演操作无效')
        print(json.dumps({'ok': True, 'result': result}, ensure_ascii=False))
    except DirectorError as error:
        print(json.dumps({'ok': False, 'error': str(error), 'status': error.status}, ensure_ascii=False))
    except Exception:
        print(json.dumps({'ok': False, 'error': '画布导演配置或响应不可读取；未改用其他认证，没有自动重试', 'status': 502}, ensure_ascii=False))


if __name__ == '__main__':
    main()
