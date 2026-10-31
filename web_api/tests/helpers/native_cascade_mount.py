"""Isolated acceptance of the real canvas mount against a loopback fixture.

No original project is created, linked, imported, or modified. The native test
service owns its synthetic workspace; this process only mounts the production
router and theme for browser acceptance.
"""
import argparse
import json
import os
from pathlib import Path
import socket
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
import uvicorn
from web_api.canvas_module import create_canvas_module_router


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine-port', type=int, required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    args = parser.parse_args()
    if not 1024 <= args.engine_port <= 65535:
        parser.error('A loopback test engine port is required')
    args.evidence.mkdir(parents=True, exist_ok=True)
    source = args.evidence / 'empty-source-projects'
    source.mkdir(exist_ok=True)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    app = FastAPI()
    # The native canvas and the workbench share the real local light-field
    # assets. Browser acceptance must exercise these rather than a 404 fallback.
    app.mount('/ui', StaticFiles(directory=ROOT / 'backlot' / 'ui'), name='ui')
    app.include_router(create_canvas_module_router(source, engine_port=args.engine_port))
    receipt = {'pid': os.getpid(), 'port': port, 'enginePort': args.engine_port,
               'base': f'http://127.0.0.1:{port}',
               'url': f'http://127.0.0.1:{port}/canvas?project=cascade-project&view=canvas',
               'scope': 'production canvas router and theme; isolated synthetic project',
               'paidCalls': 0, 'originalProjectsTouched': False}
    (args.evidence / 'mounted-fixture.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2))
    print(json.dumps(receipt, ensure_ascii=False), flush=True)
    uvicorn.run(app, host='127.0.0.1', port=port, log_level='warning')


if __name__ == '__main__':
    main()
