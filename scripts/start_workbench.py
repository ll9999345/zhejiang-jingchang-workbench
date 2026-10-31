#!/usr/bin/env python3
"""One local entry for Zhejiang workbench and the bundled Jingchang service."""
from __future__ import annotations
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
import uuid

ROOT=Path(__file__).resolve().parents[1]

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None

def local_health(port,route):
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    try:
        with opener.open(f'http://127.0.0.1:{port}{route}',timeout=1.5) as response:
            value=json.loads(response.read(32768))
        return value if isinstance(value,dict) else None
    except (OSError,ValueError):return None

def occupied(port):
    with socket.socket() as sock:
        sock.settimeout(.3)
        return sock.connect_ex(('127.0.0.1',port))==0

def port_number(value):
    number=int(value)
    if not 1024<=number<=65535:raise argparse.ArgumentTypeError('端口须在1024–65535之间')
    return number

def wait_ready(child,port,route,key,timeout=30):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        if child.poll() is not None:raise RuntimeError('本次启动的服务已经退出，请查看本次日志')
        health=local_health(port,route)
        if health and health.get(key):return health
        time.sleep(.25)
    raise RuntimeError('本次服务尚未通过启动检查，请查看本次日志')

def stop_owned(child,label):
    if child is None or child.poll() is not None:return
    child.terminate()
    try:child.wait(timeout=8)
    except subprocess.TimeoutExpired:
        print(f'{label}尚未退出（PID {child.pid}），保留进程以便核对；未强制结束。',file=sys.stderr)

def parse_args(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port',type=port_number,default=4750)
    parser.add_argument('--canvas-port',type=port_number,default=4768)
    parser.add_argument('--data-root',type=Path,default=ROOT/'.local')
    parser.add_argument('--tourism-projects',type=Path)
    parser.add_argument('--canvas-data',type=Path)
    parser.add_argument('--reuse-canvas',action='store_true',help='明确复用已有本机镜场，退出时不停止它')
    parser.add_argument('--check',action='store_true',help='仅检查启动条件，不创建目录、不启动服务')
    return parser.parse_args(argv)

def main(argv=None):
    args=parse_args(argv)
    if args.port==args.canvas_port:raise RuntimeError('两个服务须使用不同端口')
    if args.reuse_canvas and args.canvas_data:raise RuntimeError('复用已有镜场时不能另选数据目录')
    canvas=ROOT/'apps/jingchang'
    node=shutil.which('node')
    python=os.environ.get('ZJ_WORKBENCH_PYTHON') or (str(ROOT/'.venv/bin/python') if (ROOT/'.venv/bin/python').is_file() else sys.executable)
    dependencies=subprocess.run([python,'-c',"import fastapi,uvicorn,httpx,yaml,pydantic,PIL; assert int(pydantic.__version__.split('.')[0])>=2"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    checks={'python_dependencies':dependencies.returncode==0,'node':bool(node),
            'bundled_canvas':(canvas/'server.mjs').is_file(),
            'canvas_packages':all((canvas/'node_modules'/name/'package.json').is_file() for name in ['parse5','three','@napi-rs/canvas']),
            'ffmpeg':bool(shutil.which('ffmpeg')),'ffprobe':bool(shutil.which('ffprobe'))}
    if args.check:
        print(json.dumps({'checks':checks,'ready':all(checks.values()),'workbench_url':f'http://127.0.0.1:{args.port}','canvas_port':args.canvas_port},ensure_ascii=False,indent=2))
        return 0 if all(checks.values()) else 1
    if not all(checks.values()):raise RuntimeError('基础启动条件尚未就绪：'+', '.join(name for name,ok in checks.items() if not ok)+'；请按README安装，未自动安装')
    if occupied(args.port):raise RuntimeError(f'主入口端口 {args.port} 已被使用；未停止其他服务，请改用 --port')
    if args.reuse_canvas:
        health=local_health(args.canvas_port,'/api/health')
        if not health or health.get('ok') is not True or not isinstance(health.get('version'),str):raise RuntimeError('指定端口不是已就绪的镜场，未接管')
    elif occupied(args.canvas_port):raise RuntimeError('镜场端口已被使用；请选空闲端口，或明确使用 --reuse-canvas')
    data=args.data_root.expanduser().resolve()
    projects=(args.tourism_projects or data/'tourism-projects').expanduser().resolve()
    canvas_data=(args.canvas_data or data/'jingchang-data').expanduser().resolve()
    logs=data/'sessions'/uuid.uuid4().hex;logs.mkdir(parents=True,exist_ok=False)
    projects.mkdir(parents=True,exist_ok=True)
    env={**os.environ,'WEB_API_LOCAL_MODE':'1','OPENMONTAGE_PROJECTS_DIR':str(projects),'JINGCHANG_PORT':str(args.canvas_port),
         'JINGCHANG_DIRECTOR_PYTHON':python,'JINGCHANG_DIRECTOR_HELPER':str(ROOT/'scripts/canvas_deepseek.py')}
    canvas_child=main_child=None
    try:
        if not args.reuse_canvas:
            canvas_data.mkdir(parents=True,exist_ok=True)
            with (logs/'jingchang.log').open('xb') as stream:
                canvas_child=subprocess.Popen([node,'server.mjs'],cwd=canvas,env={**env,'PORT':str(args.canvas_port),'JINGCHANG_NATIVE_MEDIA_MODE':'versioned','JINGCHANG_DATA_DIR':str(canvas_data),'JINGCHANG_WORKSPACE_ROOT':str(canvas),'JINGCHANG_RUNTIME_INSTANCE':str(uuid.uuid4())},stdin=subprocess.DEVNULL,stdout=stream,stderr=subprocess.STDOUT)
            wait_ready(canvas_child,args.canvas_port,'/api/health','ok')
        with (logs/'workbench.log').open('xb') as stream:
            main_child=subprocess.Popen([python,'-m','uvicorn','backlot.model_adapter:app','--host','127.0.0.1','--port',str(args.port),'--log-level','warning'],cwd=ROOT,env=env,stdin=subprocess.DEVNULL,stdout=stream,stderr=subprocess.STDOUT)
        wait_ready(main_child,args.port,'/model-api/health','status',timeout=45)
        print(f'浙江文旅工作台已启动：http://127.0.0.1:{args.port}',flush=True)
        print(f'本次日志：{logs}\n按 Ctrl+C 停止本次启动的服务。',flush=True)
        while main_child.poll() is None:
            if canvas_child is not None and canvas_child.poll() is not None:raise RuntimeError('本次镜场子服务已退出，请查看日志')
            time.sleep(.5)
        if main_child.returncode:raise RuntimeError('主入口已退出，请查看本次日志')
        return 0
    finally:
        stop_owned(main_child,'文旅主服务')
        stop_owned(canvas_child,'镜场子服务')

if __name__=='__main__':
    try:raise SystemExit(main())
    except KeyboardInterrupt:pass
    except (RuntimeError,OSError) as error:
        print(str(error),file=sys.stderr);raise SystemExit(1)
