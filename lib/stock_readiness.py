"""Read local stock/embedding prerequisites without importing a model or networking."""
import functools
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time


@functools.lru_cache(maxsize=32)
def _probe_python(python, fingerprint, time_slot):
    del fingerprint, time_slot
    program = "import importlib.util,json; print(json.dumps({n:importlib.util.find_spec(n) is not None for n in ('torch','transformers','PIL','numpy')}))"
    try:
        result = subprocess.run([python, '-I', '-c', program], capture_output=True, text=True, timeout=8,
                                env={**os.environ, 'HF_HUB_OFFLINE':'1', 'TRANSFORMERS_OFFLINE':'1'})
        data = json.loads(result.stdout) if result.returncode == 0 else {}
        if not isinstance(data, dict): return False
        return all(data.get(name) is True for name in ('torch','transformers','PIL','numpy'))
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return False


def embedding_readiness():
    from lib.clip_embedder import local_runtime, _needs_bridge
    python, model = local_runtime()
    try: bridge = _needs_bridge()
    except (ValueError, ImportError): bridge = True
    executable = python if bridge else Path(sys.executable)
    files = [model/name for name in ('model.safetensors','config.json','vocab.json','merges.txt','preprocessor_config.json')]
    model_files = all(p.is_file() for p in files)
    executable_ready = executable.is_file() and os.access(executable, os.X_OK)
    deps = False
    if executable_ready and model_files:
        stat = executable.stat()
        deps = _probe_python(str(executable), (stat.st_mtime_ns, stat.st_size), int(time.monotonic()//30))
    return {'model_files':model_files, 'python_dependencies':deps,
            'execution':'separate_local_python' if bridge else 'host_python',
            'ready':model_files and executable_ready and deps,
            'evidence':'local_files_and_module_discovery_not_inference'}


def stock_readiness(needs_embedding=False):
    from tools.video.stock_sources import all_sources
    sources=[]; discovery_failed=False
    try: adapters=all_sources()
    except Exception: adapters=[]; discovery_failed=True
    for source in adapters:
        try: configured=source.is_available() is True
        except Exception: configured=False
        sources.append({'name':source.name, 'configured':configured})
    available=sum(s['configured'] for s in sources)
    binaries=all(shutil.which(name) for name in ('ffmpeg','ffprobe'))
    frame_modules=True
    if needs_embedding:
        frame_modules=all(importlib.util.find_spec(name) is not None for name in ('cv2','numpy','PIL'))
    embedding=embedding_readiness() if needs_embedding else None
    missing=[]
    if not binaries: missing.append('缺少本机媒体读取或校验程序。')
    if not frame_modules: missing.append('缺少本机画面读取组件。')
    if embedding and not embedding['ready']: missing.append('本机语义模型文件或运行组件尚未就绪。')
    if discovery_failed: missing.append('无法读取素材来源配置，请检查本机设置。')
    elif not available: missing.append('尚无已配置的素材来源，请先设置至少一个来源。')
    state='unavailable' if missing else 'degraded' if available<len(sources) else 'available'
    summary=' '.join(missing) if missing else (
        f'本机{"建库" if needs_embedding else "采集"}条件已就绪；{available}/{len(sources)} 个素材来源已配置。'
        + ('未配置的来源不影响使用其他来源。' if available<len(sources) else ''))
    return {'state':state, 'summary':summary, 'requirements':missing,
            'media_tools':binaries, 'frame_modules':frame_modules, 'embedding':embedding,
            'sources':sources, 'configured_sources':available,
            'note':'这里只检查本机条件和来源配置，不代表平台当前连通或素材相关性已验证。'}
