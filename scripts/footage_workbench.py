#!/usr/bin/env python3
"""CLI for the same native footage jobs used by the browser; stdlib only.

Examples: python scripts/footage_workbench.py plan --request request.json
          python scripts/footage_workbench.py run --request request.json --wait
          python scripts/footage_workbench.py batch --file requests.jsonl --wait
"""
import argparse
import json
from pathlib import Path
import sys
import time
import uuid
from urllib.error import HTTPError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import ProxyHandler, Request, build_opener

STAGES = ('script', 'terms', 'materials', 'audio', 'subtitle', 'video')
FINISHED = ('queued', 'running')
BATCH_FAILURES = ('partial', 'failed', 'interrupted', 'cancelled')


def read_batch(path):
    text = Path(path).read_text('utf-8-sig')
    if len(text.encode()) > 1024 * 1024:
        raise ValueError('批处理文件不能超过 1 MiB')
    rows = json.loads(text) if text.lstrip().startswith('[') else [json.loads(line) for line in text.splitlines() if line.strip()]
    if not isinstance(rows, list) or not 1 <= len(rows) <= 100 or not all(isinstance(row, dict) for row in rows):
        raise ValueError('批处理需要 1–100 个请求对象')
    return rows


def main(argv=None):
    parser = argparse.ArgumentParser(description='真实素材自动成片命令行，与网页共用任务和历史')
    parser.add_argument('--server', default='http://127.0.0.1:4750')
    subs = parser.add_subparsers(dest='command', required=True)
    for name in ('plan', 'run'):
        sub = subs.add_parser(name)
        sub.add_argument('--request', required=True)
        if name == 'run':
            sub.add_argument('--wait', action='store_true')
            sub.add_argument('--stop-at', choices=STAGES)
    batch = subs.add_parser('batch')
    batch.add_argument('--file', required=True)
    batch.add_argument('--wait', action='store_true')
    batch.add_argument('--check', action='store_true', help='只检查清单，不提交任务')
    batch.add_argument('--stop-at', choices=STAGES)
    for name in ('list', 'status', 'cancel'):
        sub = subs.add_parser(name)
        sub.add_argument('--project', required=True)
        if name != 'list':
            sub.add_argument('--job', required=True)
    for name in ('batch-list', 'batch-status', 'batch-cancel'):
        sub = subs.add_parser(name)
        sub.add_argument('--project', required=True)
        if name != 'batch-list':
            sub.add_argument('--batch', required=True)
    args = parser.parse_args(argv)
    url = urlsplit(args.server)
    if url.scheme != 'http' or url.hostname not in ('localhost', '127.0.0.1', '::1') or url.username or url.password or url.path not in ('', '/') or url.query or url.fragment:
        parser.error('此命令只连接本机工作台')

    # A global HTTP proxy must not intercept requests to the local workbench.
    opener = build_opener(ProxyHandler({}))

    def call(path, data=None):
        req = Request(args.server.rstrip('/') + '/model-api/footage' + path,
                      data=json.dumps(data, ensure_ascii=False).encode() if data is not None else None,
                      headers={'Content-Type': 'application/json'})
        try:
            with opener.open(req, timeout=60) as response:
                return json.load(response)
        except HTTPError as exc:
            body = json.load(exc)
            raise ValueError(body.get('detail', '请求未完成')) from exc

    def run_one(data):
        data.setdefault('request_id', 'cli-' + uuid.uuid4().hex)
        job = call('/jobs', data)
        if args.wait:
            while job['status'] in FINISHED:
                print(f"{job['job_id']} {job['progress']}% {job['message']}", file=sys.stderr)
                time.sleep(3)
                job = call('/jobs/' + quote(job['job_id'], safe='') + '?' + urlencode({'project_id': data['project_id']}))
        return job

    if args.command in ('run', 'plan'):
        data = json.loads(Path(args.request).read_text('utf-8-sig'))
        if args.command == 'run' and args.stop_at:
            data['stop_at'] = args.stop_at
        result = call('/plan', data) if args.command == 'plan' else run_one(data)
    elif args.command == 'batch':
        rows = read_batch(args.file)
        if args.stop_at:
            rows = [dict(row, stop_at=args.stop_at) for row in rows]
        body = {'requests': rows, 'request_id': 'cli-batch-' + uuid.uuid4().hex, 'confirm': False}
        checked = call('/batches/preflight', body)
        if args.check:
            result = checked
        elif not checked.get('ready'):
            print(json.dumps(checked, ensure_ascii=False, indent=2))
            return 1
        else:
            result = call('/batches', dict(body, confirm=True))
            if args.wait:
                while result['status'] in FINISHED:
                    print(f"{result['batch_id']} {result['progress']}% {result['message']}", file=sys.stderr)
                    time.sleep(3)
                    result = call('/batches/' + quote(result['batch_id'], safe='') + '?' + urlencode({'project_id': result['project_id']}))
    elif args.command == 'batch-list':
        result = call('/batches?' + urlencode({'project_id': args.project}))
    elif args.command == 'batch-cancel':
        result = call('/batches/' + quote(args.batch, safe='') + '/cancel', {'project_id': args.project})
    elif args.command == 'batch-status':
        result = call('/batches/' + quote(args.batch, safe='') + '?' + urlencode({'project_id': args.project}))
    elif args.command == 'list':
        result = call('/jobs?' + urlencode({'project_id': args.project}))
    elif args.command == 'cancel':
        result = call('/jobs/' + quote(args.job, safe='') + '/cancel', {'project_id': args.project})
    else:
        result = call('/jobs/' + quote(args.job, safe='') + '?' + urlencode({'project_id': args.project}))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if args.command == 'batch':
        return int(not result.get('ready')) if args.check else int(result.get('status') in BATCH_FAILURES)
    if args.command == 'run':
        return int(result.get('status') in ('failed','interrupted','cancelled','needs_materials'))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
