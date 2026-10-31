"""Mount the existing Jingchang service inside the Zhejiang workbench.

The native service remains the sole owner of its projects, assets and jobs.
HTML/JS/CSS are read live, never copied into a second application. Only local
resource URLs and the separate presentation layer are adapted at this boundary.
"""
from __future__ import annotations
import asyncio
import json
from pathlib import Path
import re
from urllib.parse import urlsplit, urlencode
import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, Response, StreamingResponse, FileResponse

PREFIX = '/canvas-module'
OPAQUE_JSON_KEYS = frozenset({'recommendations', 'nativeSource'})
URL_KEYS = {'url', 'href', 'subtitleUrl', 'downloadUrl', 'previewUrl', 'mediaUrl', 'thumbnailUrl', 'imageUrl', 'audioUrl', 'videoUrl'}
# Only URL-shaped literals; ordinary text, regexes, provider URLs and protocol
# relative URLs are not rewritten. Imported module paths keep their semantics.
ROOT_URL = re.compile(r'''(["'`])/(?!/)(?=(?:api|media|renders|public|vendor|bundles)(?:[/"'`?])|[\w.-]+\.(?:html|js|mjs|css|svg|png|webp|jpg|woff2?|ttf)(?:[?"'`#])|creation-studio(?:[?"'`]))''')
HOME_URL = re.compile(r'''(["'`])/(?=[?"'`])''')
LOCAL_MEDIA = re.compile(r'^/(?:media|renders|bundles|api)/')


def rewrite_source(text: str, *, native_path: str) -> str:
    if native_path == '/canvas-tools.mjs':
        text = text.replace("from '../public/", "from '/canvas-module/public/")
    text = ROOT_URL.sub(lambda m: m[1] + PREFIX + '/', text)
    text = re.sub(r"(href=[\"'])/(?=[?\"'])", lambda m: m[1] + '/canvas', text)
    text = re.sub(r"((?:location\.href|\.href)\s*=\s*[\"'])/(?=[?\"'])", lambda m: m[1] + '/canvas', text)
    if native_path == '/task-motion.js':
        text = text.replace("if(button&&!button.disabled&&!button.classList.contains('port')&&!reduced.matches)", "if(!window.StudioButtonFeedback&&button&&!button.disabled&&!button.classList.contains('port')&&!reduced.matches)")
        text = text.replace("if(['Enter',' '].includes(event.key)&&event.target.matches('button')", "if(!window.StudioButtonFeedback&&['Enter',' '].includes(event.key)&&event.target.matches('button')")
    elif native_path == '/ambient-glass.js':
        text = text.replace("if (measured.static) save('auto');", '// Keep diagnostics without changing the user motion preference.')
    elif native_path == '/app.js':
        marker = 'function draw(){if(!project)return;'
        text = text.replace(marker, marker + "window.dispatchEvent(new CustomEvent('jingchang:location',{detail:{project:project.id,view}}));")
        # Do not briefly show a different project's task before boot selects this one.
        setup = 'installTaskMotion({getProjectId:()=>project?.id,openTasks:()=>document.querySelector(\'[data-action="tasks"]\')?.click()});'
        if setup in text and 'boot().then(registerWebTools);' in text:
            text = text.replace(setup, '')
            text = text.replace('boot().then(registerWebTools);', 'boot().then(()=>{' + setup + 'return registerWebTools();});')
    return text


def media_urls(value, *, reverse=False):
    if isinstance(value, list):
        return [media_urls(item, reverse=reverse) for item in value]
    if not isinstance(value, dict):
        return value
    out = {}
    for key, item in value.items():
        # Template annotations are user JSON, not mounted resource links.
        if key in OPAQUE_JSON_KEYS:
            out[key] = item
            continue
        if key in URL_KEYS and isinstance(item, str):
            if reverse and item.startswith(PREFIX + '/') and LOCAL_MEDIA.match(item[len(PREFIX):]):
                item = item[len(PREFIX):]
            elif not reverse and LOCAL_MEDIA.match(item):
                item = PREFIX + item
        out[key] = media_urls(item, reverse=reverse)
    return out


def create_canvas_module_router(project_root, *, ui_dir=None, bridge=None, engine_port=None):
    if bridge is None:
        from web_api.canvas_bridge import CanvasBridge
        bridge = CanvasBridge(project_root)
    if engine_port is None:
        from web_api.canvas_bridge import CANVAS_PORT
        engine_port = getattr(bridge, 'port', CANVAS_PORT)
    ui = Path(ui_dir or Path(__file__).resolve().parents[1] / 'backlot' / 'ui')
    router = APIRouter()

    def local_only(request):
        host = request.headers.get('host', '')
        if urlsplit('http://' + host).hostname not in {'127.0.0.1', 'localhost', '::1'}:
            raise HTTPException(403, '仅允许本机工作台访问')
        origin = request.headers.get('origin')
        if origin and origin != f'{request.url.scheme}://{host}':
            raise HTTPException(403, '来源不受信任')
        if request.headers.get('sec-fetch-site') == 'cross-site':
            raise HTTPException(403, '来源不受信任')

    async def forward(request, native_path, *, html_context=None):
        local_only(request)
        target = f'http://127.0.0.1:{engine_port}{native_path}'
        if request.url.query and native_path != '/':
            target += '?' + request.url.query
        headers = {key: value for key, value in request.headers.items() if key.lower() not in {'host','origin','connection','accept-encoding','content-length'}}
        headers['host'] = f'127.0.0.1:{engine_port}'
        if request.headers.get('origin'):
            headers['origin'] = f'http://127.0.0.1:{engine_port}'
        body = request.stream()
        if request.method not in {'GET','HEAD'} and 'application/json' in request.headers.get('content-type',''):
            raw = await request.body()
            try:
                body = json.dumps(media_urls(json.loads(raw), reverse=True), ensure_ascii=False).encode()
            except (ValueError, UnicodeDecodeError):
                body = raw
        client = httpx.AsyncClient(trust_env=False, timeout=httpx.Timeout(300, connect=3), follow_redirects=False)
        try:
            response = await client.send(client.build_request(request.method, target, headers=headers, content=body), stream=True)
        except httpx.HTTPError:
            await client.aclose()
            if native_path == '/':
                return HTMLResponse('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>镜场连接</title><body style="background:#171328;color:#eef;font-family:sans-serif;padding:8vw"><h1>镜场暂未连接</h1><p>现有项目仍保存在本机。</p><button id="start">启动镜场</button><a href="/">返回文旅</a><p role="status" id="status"></p><script>document.querySelector("#start").onclick=async function(){this.disabled=true;try{const r=await fetch("/model-api/canvas/start",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({confirm:true})});if(!r.ok)throw Error("启动尚未完成，请稍后重试");location.reload()}catch(e){document.querySelector("#status").textContent=e.message;this.disabled=false}}</script></body></html>',status_code=503)
            return Response('{"error":"镜场服务暂不可达"}',status_code=502,media_type='application/json')
        out = {key:value for key,value in response.headers.items() if key.lower() not in {'connection','transfer-encoding','content-encoding','content-length','access-control-allow-origin'}}
        out['cache-control']='no-store'
        out['x-content-type-options']='nosniff'
        kind = response.headers.get('content-type','').split(';')[0]
        if request.method != 'HEAD' and kind in {'text/html','text/css','text/javascript','application/javascript','application/json'}:
            raw = await response.aread()
            await response.aclose(); await client.aclose()
            try:
                if kind == 'application/json':
                    raw = json.dumps(media_urls(json.loads(raw)), ensure_ascii=False).encode()
                else:
                    text = rewrite_source(raw.decode(), native_path=native_path)
                    if kind == 'text/html':
                        config = json.dumps(html_context or {},ensure_ascii=False).replace('<','\\u003c')
                        assets = f'<link rel="stylesheet" href="{PREFIX}/_theme/typography.css"><link rel="stylesheet" href="{PREFIX}/_theme/unified.css"><script>window.CanvasModule={config};</script><script defer src="{PREFIX}/_theme/button-feedback.js"></script><script defer src="{PREFIX}/_theme/unified.js"></script>'
                        text = text.replace('<body','<body data-unified-canvas').replace('</head>',assets+'</head>')
                    raw = text.encode()
            except (ValueError, UnicodeDecodeError):
                pass
            return Response(raw,status_code=response.status_code,headers=out)
        async def stream():
            try:
                async for chunk in response.aiter_raw():
                    yield chunk
            finally:
                await response.aclose(); await client.aclose()
        # Preserve upstream Content-Length for media, HEAD and byte-range downloads.
        if 'content-length' in response.headers:
            out['content-length']=response.headers['content-length']
        return StreamingResponse(stream(),status_code=response.status_code,headers=out)

    @router.get('/canvas', response_class=HTMLResponse)
    @router.get('/canvas/', response_class=HTMLResponse)
    async def canvas(request: Request):
        local_only(request)
        params=dict(request.query_params)
        source=params.pop('sourceProject',None)
        selected=params.pop('mirrorProject',None)
        candidate=params.get('project')
        if candidate and not candidate.startswith('draft-'):
            selected = selected or candidate
        if candidate and candidate.startswith('draft-'):
            source=params.pop('project')
        if source:
            params['sourceProject']=source
            if not selected:
                try:
                    linked=await asyncio.to_thread(bridge.read_link,source,params.get('cut',''),int(params.get('version',params.get('cut_version','1'))))
                    selected=linked.get('canvas_project_id') or linked.get('id') if linked else None
                except (ValueError, OSError):
                    pass
        if selected:
            params['project']=selected
        return await forward(request,'/',html_context={'path':'/canvas','query':urlencode(params),'sourceProject':source or ''})

    @router.get('/canvas-exchange', response_class=HTMLResponse)
    async def exchange(request: Request):
        local_only(request)
        text=(ui/'canvas.html').read_text('utf-8')
        # This remains the explicit, confirmed copy/import workflow only.
        text=text.replace('/ui/canvas.js', PREFIX+'/_theme/exchange.js')
        text=text.replace('</head>','<link rel="stylesheet" href="/ui/theme.css"><style>.studio-aurora,.studio-glass-scene{position:fixed!important;inset:0;pointer-events:none;z-index:-1}</style></head>')
        return HTMLResponse(text)

    @router.api_route(PREFIX + '/{resource:path}',methods=['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'])
    async def mounted(request: Request,resource: str):
        local_only(request)
        if resource.startswith('_theme/'):
            name=resource[len('_theme/'):]
            if name == 'exchange.js' and request.method in {'GET','HEAD'}:
                text=(ui/'canvas.js').read_text('utf-8')
                marker="const frame=$('canvasFrame');"
                text=text.replace(marker,"url.host=location.host;url.pathname='/canvas';url.searchParams.set('sourceProject',project);"+marker)
                return Response(text,media_type='text/javascript',headers={'Cache-Control':'no-store'})
            allowed={'typography.css','unified.css','unified.js','button-feedback.js'}
            if name not in allowed or request.method not in {'GET','HEAD'}:
                raise HTTPException(404)
            return FileResponse(ui/'canvas-module'/name,headers={'Cache-Control':'no-store'})
        if '\\' in resource or any(part in {'.','..'} for part in resource.split('/')):
            raise HTTPException(400,'路径无效')
        return await forward(request,'/'+resource,html_context={'path':'/canvas-module/'+resource,'query':request.url.query})
    return router
