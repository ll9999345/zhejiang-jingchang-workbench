"""Run exactly one registered native tool in an isolated process, without retries."""
from __future__ import annotations

import contextlib
import dataclasses
import io
import json
import os
from pathlib import Path
import shutil
import socket
import sys

from web_api.montage_registry import OUTPUT_KEYS, NativeToolRequest, blender_cpu_default, native_tool, native_inputs, path_inputs, redact, validate_inputs
from web_api.native_progress import ProgressWriter
from lib.tool_progress import tool_progress_context


def no_external_network():
    original = socket.socket.connect
    def connect(sock, address):
        if isinstance(address, tuple):
            import ipaddress
            host = address[0]
            try: local = ipaddress.ip_address(host).is_loopback
            except ValueError: local = host == 'localhost'
            if not local:
                raise PermissionError('本次任务没有联网授权')
        return original(sock, address)
    socket.socket.connect = connect
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1',
                      HYPERFRAMES_NO_TELEMETRY='1', HYPERFRAMES_SKIP_SKILLS='1')
    for key in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'):
        os.environ.pop(key, None)


def default_output(tool, inputs):
    name = tool.name
    if name == 'character_rig_renderer': return 'preview.html'
    if name == 'blender_world':
        return 'render.mp4' if inputs.get('operation') == 'render_animation' else 'world.blend' if inputs.get('operation', 'build') == 'build' else 'render.png'
    if name == 'threejs_world': return 'world'
    if name == 'upscale':
        from tools.enhancement.upscale import VIDEO_EXTENSIONS
        return 'upscaled.mp4' if Path(inputs.get('input_path', '')).suffix.lower() in VIDEO_EXTENSIONS else 'upscaled.png'
    if name == 'face_restore': return 'restored.png'
    if name in {'code_snippet', 'diagram_gen'} or 'image' in tool.capability: return 'image.png'
    if name in {'subtitle_gen'}: return 'subtitles.' + inputs.get('format', 'srt')
    if name in {'audio_mixer', 'audio_enhance'} or tool.capability in {'tts', 'music', 'music_generation'}: return 'audio.wav'
    if name in {'math_animate', 'video_stitch', 'video_trimmer', 'auto_reframe', 'color_grade',
                'eye_enhance', 'face_enhance', 'remotion_caption_burn', 'showcase_card',
                'green_screen_composite', 'green_screen_processor', 'video_compose', 'hyperframes_compose',
                'screen_recorder', 'talking_head', 'lip_sync'} or 'video_generation' == tool.capability:
        return 'video.mp4'
    if name == 'bg_remove': return 'cutout.png'
    return 'result.json'


def execute_native(request: NativeToolRequest, project: Path, output: Path):
    tool = native_tool(request.tool)
    inputs = validate_inputs(tool, native_inputs(tool, request.inputs))
    if tool.name == 'blender_world' and blender_cpu_default():
        inputs.setdefault('render_engine', 'CYCLES')
        if inputs['render_engine'] == 'CYCLES': inputs.setdefault('cpu_render', True)
    schema = tool.input_schema.get('properties', {})
    if request.tool == 'corpus_builder':
        # A fresh corpus is never an in-place rewrite of the creator's library.
        inputs['corpus_dir'] = str(output / 'corpus')
    corpus = inputs.pop('corpus_dir', None) if request.tool == 'corpus_builder' else None
    inputs = path_inputs(project, inputs, output)
    if corpus: inputs['corpus_dir'] = corpus
    for key in OUTPUT_KEYS & schema.keys():
        if key == 'video_output_path' and not inputs.get('render_video') and not inputs.get(key):
            continue
        if not inputs.get(key):
            filename = 'world.blend' if key == 'blend_path' else 'video.mp4' if key == 'video_output_path' else default_output(tool, inputs)
            inputs[key] = str(output / key / (filename if key.endswith('path') else 'files'))
    for key, value in list(inputs.items()):
        if key in OUTPUT_KEYS:
            destination = Path(value)
            destination.mkdir(parents=True, exist_ok=True) if key.endswith('dir') else destination.parent.mkdir(parents=True, exist_ok=True)
    if request.tool in {'hyperframes_compose', 'threejs_world', 'character_rig_renderer'} and inputs.get('workspace_path'):
        source = Path(inputs['workspace_path'])
        workspace = output / 'workspace'
        if source.exists():
            paths = list(source.rglob('*'))
            if any(path.is_symlink() for path in paths):
                raise ValueError('工程含符号链接，请使用本机文件副本')
            if len(paths) > 10000 or sum(p.stat().st_size for p in paths if p.is_file()) > 500_000_000:
                raise ValueError('工程超过本次复制上限（10000 个文件 / 500 MB）')
            shutil.copytree(source, workspace)
        else: workspace.mkdir(parents=True)
        inputs['workspace_path'] = str(workspace)
    if request.tool == 'character_rig_renderer' and not inputs.get('workspace_path'):
        inputs['workspace_path'] = str(output / 'workspace')
    # Transcriber resolves the exact requested local model itself. In
    # particular, a request for base must not silently run small.
    if not request.allow_network: no_external_network()
    result = tool.execute(inputs)
    if not isinstance(result.success, bool): raise ValueError('原生工具返回格式无效')
    payload = dataclasses.asdict(result)
    # Some native data structures use absolute paths. Expose project-relative paths.
    def relative(item):
        if isinstance(item, dict): return {k: relative(v) for k, v in item.items()}
        if isinstance(item, (tuple, list)): return [relative(v) for v in item]
        if isinstance(item, str): return item.replace(str(project) + os.sep, '')
        return item
    return {'status': 'completed' if result.success else 'failed',
            'message': '原生工具已完成；请检查产物。' if result.success else '原生工具未完成，已保留中间产物。',
            'native_result': redact(relative(payload)), 'cost_usd': result.cost_usd}


def main():
    packet = json.loads(sys.stdin.read(300_000))
    request = NativeToolRequest.model_validate(packet['request'])
    project, run = Path(packet['project']).resolve(), Path(packet['run']).resolve()
    if not run.is_relative_to(project) or run.name == project.name:
        raise ValueError('运行目录无效')
    output = run / 'outputs'
    output.mkdir(exist_ok=False)
    progress = ProgressWriter(run, request.tool)
    progress({'phase': 'tool_started'})
    try:
        # SDKs/tool printouts are neither a receipt nor safe credential logs.
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            from tools.video.direct_clip_search import stock_progress_context
            with tool_progress_context(progress), stock_progress_context(progress):
                result = execute_native(request, project, output)
    except Exception as exc:
        result = {'status': 'failed', 'message': '原生工具未完成，已有文件已保留。',
                  'error': redact(str(exc))[:600]}
    finally:
        progress({'phase': 'tool_completed' if locals().get('result', {}).get('status') == 'completed' else 'tool_failed'})
        progress.close()
    sys.stdout.write(json.dumps(result, ensure_ascii=False, allow_nan=False))


if __name__ == '__main__': main()
