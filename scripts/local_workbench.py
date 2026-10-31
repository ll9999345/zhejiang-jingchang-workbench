#!/usr/bin/env python3
"""Start or inspect this local workbench without replacing an existing listener."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import ProxyHandler, build_opener
import uuid

ROOT = Path(__file__).resolve().parents[1]


def service_state(port: int) -> str:
    """Only identify our rendered page; local checks never use a proxy."""
    url = f'http://127.0.0.1:{port}/footage'
    try:
        with build_opener(ProxyHandler({})).open(url, timeout=2) as response:
            page = response.read(128 * 1024).decode('utf-8', errors='replace')
            if response.status == 200 and 'data-studio-page="footage"' in page and 'data-studio-layout="moneyprinter"' in page:
                return 'ready'
    except (URLError, OSError):
        pass
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=.5):
            return 'occupied'
    except OSError:
        return 'stopped'


@contextmanager
def startup_lock(root: Path, port: int):
    runtime = root / '.runtime'
    runtime.mkdir(parents=True, exist_ok=True)
    with (runtime / f'workbench-start-{port}.lock').open('a') as lock:
        deadline = time.monotonic() + 30
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise RuntimeError('另一个启动操作仍在进行，请稍后检查状态。')
                time.sleep(.2)
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def start(root: Path, port: int, *, timeout: float = 30) -> dict:
    with startup_lock(root, port):
        state = service_state(port)
        if state == 'ready':
            return {'status': 'ready', 'started': False, 'url': f'http://127.0.0.1:{port}/'}
        if state == 'occupied':
            raise RuntimeError(f'{port} 端口已有其他服务，未停止或替换它。请先核对占用程序，或使用 --port 指定另一端口。')
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8]
        directory = root / 'artifacts' / 'local-server'
        directory.mkdir(parents=True, exist_ok=True)
        log_path = directory / f'server-{port}-{stamp}.log'
        env = dict(os.environ, HOST='127.0.0.1', PORT=str(port))
        with log_path.open('xb') as output:
            child = subprocess.Popen(['sh', str(root / 'scripts/serve_model_adapter.sh')],
                                     cwd=root, env=env, stdin=subprocess.DEVNULL,
                                     stdout=output, stderr=subprocess.STDOUT,
                                     start_new_session=True)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if child.poll() is not None:
                raise RuntimeError(f'服务启动未完成，请查看本机日志：{log_path}')
            if service_state(port) == 'ready':
                receipt = {'status': 'ready', 'started': True, 'pid': child.pid,
                           'url': f'http://127.0.0.1:{port}/', 'log_path': str(log_path),
                           'started_at': datetime.now(timezone.utc).isoformat()}
                # Each startup receipt and log is a new file. Nothing is erased.
                (directory / f'start-{port}-{stamp}.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2), 'utf-8')
                return receipt
            time.sleep(.25)
        raise RuntimeError(f'服务尚未就绪，启动进程与日志已保留。请用 status 检查，不要重复启动。日志：{log_path}')


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description='启动或检查本机浙江文旅工作台；保留已有服务和全部作品')
    parser.add_argument('command', choices=('start', 'status'), nargs='?', default='start')
    parser.add_argument('--port', type=int, default=4750)
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args(argv)
    if not 1024 <= args.port <= 65535:
        parser.error('端口须为 1024–65535')
    if args.command == 'status':
        state = service_state(args.port)
        print({'ready': '工作台正在运行', 'stopped': '工作台尚未启动', 'occupied': '端口已占用，尚未确认是本工作台'}[state])
        if state == 'ready':
            print(f'http://127.0.0.1:{args.port}/')
        return 0 if state == 'ready' else 1
    result = start(ROOT, args.port)
    print('工作台已启动，关闭此终端窗口也可继续使用。' if result['started'] else '工作台已经运行，已沿用现有服务。')
    print(result['url'])
    if result.get('log_path'):
        print('本次日志：' + result['log_path'])
    if not args.no_browser:
        opener = ['open', '-a', 'Google Chrome', result['url']] if sys.platform == 'darwin' else ['xdg-open', result['url']]
        try:
            if subprocess.run(opener, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
                print('浏览器未自动打开，可复制上面的地址。')
        except OSError:
            print('浏览器未自动打开，可复制上面的地址。')
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
