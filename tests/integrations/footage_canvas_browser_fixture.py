"""Isolated real services/fixtures for footage_canvas_browser.cjs, no cloud."""
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
import uvicorn
from web_api.canvas_bridge import CANVAS_ROOT, CanvasBridge, create_canvas_router
from web_api.canvas_module import create_canvas_module_router
from web_api.footage_api import create_footage_router
from web_api.footage_pipeline import FootageRequest, save_footage_draft, write_json


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def main():
    output=Path(sys.argv[1]).resolve()
    output.mkdir(parents=True, exist_ok=True)
    projects=output/'projects';project=projects/'footage-qa'
    (project/'assets/footage/imports').mkdir(parents=True,exist_ok=True)
    write_json(project/'project.json',{'title':'本机流程验收示例 · 合成测试素材'})
    write_json(project/'artifacts/script.json',{'title':'本机流程验收示例',
        'sections':[{'text':'风穿过树林。'},{'text':'湖面映着晨光。'}]})
    write_json(project/'artifacts/workflow_state.json',{'prompt':'本机流程验收示例',
        'storyboard':{'shots':[{'id':'one','title':'镜头一','duration_seconds':3},
                               {'id':'two','title':'镜头二','duration_seconds':3}]}})
    source=project/'assets/footage/imports/synthetic-test-pattern.mp4'
    subprocess.run(['ffmpeg','-v','error','-n','-f','lavfi','-i','testsrc2=size=320x180:rate=24',
                    '-t','12','-c:v','libx264','-pix_fmt','yuv420p',str(source)],check=True,capture_output=True)
    request=FootageRequest(project_id='footage-qa',topic='本机流程验收示例',material_mode='local',
        shots=[{'id':'one','text':'风穿过树林。','source_path':source.relative_to(project).as_posix(),
                'start_seconds':.5,'duration_seconds':3},
               {'id':'two','text':'湖面映着晨光。','source_path':source.relative_to(project).as_posix(),
                'start_seconds':2,'duration_seconds':3}],
        options={'narration':'local','voice':'Tingting','resolution':480,'transition':'cut'})
    save_footage_draft(projects,request)
    node_port,port=free_port(),free_port()
    node_log=(output/'native.log').open('xb')
    child=subprocess.Popen(['node','server.mjs'],cwd=CANVAS_ROOT,stdout=node_log,stderr=subprocess.STDOUT,
        env={**os.environ,'PORT':str(node_port),'JINGCHANG_DATA_DIR':str(output/'native-data'),
             'JINGCHANG_LLM_URL':'','JINGCHANG_LLM_MODEL':'',
             'NODE_OPTIONS':'--import '+str(CANVAS_ROOT/'tests/helpers/local-network-only.mjs')})
    bridge=CanvasBridge(projects,runtime=output/'bridge',port=node_port)
    try:
        for _ in range(100):
            if bridge.status()['ready']:break
            if child.poll() is not None:raise RuntimeError('isolated native server failed; see native.log')
            time.sleep(.1)
        else:raise RuntimeError('isolated native server timeout')
        app=FastAPI()
        app.include_router(create_footage_router(projects))
        app.include_router(create_canvas_router(projects,runtime=output/'bridge',port=node_port))
        if '--mounted' in sys.argv:
            app.include_router(create_canvas_module_router(projects,bridge=bridge,engine_port=node_port))
        app.mount('/ui',StaticFiles(directory=ROOT/'backlot/ui'),name='ui')
        @app.get('/footage')
        async def footage():return FileResponse(ROOT/'backlot/ui/footage.html')
        if '--mounted' not in sys.argv:
            @app.get('/canvas')
            async def canvas():return FileResponse(ROOT/'backlot/ui/canvas.html')
        @app.get('/api/projects')
        async def project_list():return [{'project_id':'footage-qa','title':'本机流程验收示例 · 合成测试素材'}]
        print(json.dumps({'base':f'http://127.0.0.1:{port}','native':f'http://127.0.0.1:{node_port}',
                          'project_id':'footage-qa','output':str(output)}),flush=True)
        uvicorn.run(app,host='127.0.0.1',port=port,log_level='warning')
    finally:
        child.terminate();child.wait(timeout=15);node_log.close()


if __name__=='__main__':main()
