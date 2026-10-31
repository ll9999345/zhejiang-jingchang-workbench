"""Offline JSON bridge to the project's Intel-compatible ML interpreter.

Only three fixed native tools are allowed. The bridge never fetches a model,
executes arbitrary source supplied by a request, or sends user media off-device.
"""
from __future__ import annotations

import contextlib
import dataclasses
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

from tools.base_tool import ToolResult

ROOT = Path(__file__).resolve().parents[1]
CHILD = 'OPENMONTAGE_LOCAL_ML_CHILD'
TOOLS = frozenset({'upscale', 'face_restore', 'video_understand', 'transcript_aligner'})
PACKAGES = {
    'restoration': ('torch', 'torchvision', 'basicsr', 'realesrgan', 'facexlib', 'gfpgan', 'cv2'),
    'vision': ('torch', 'transformers', 'PIL', 'safetensors'),
    'alignment': ('torch', 'torchaudio', 'transformers', 'safetensors', 'pandas', 'nltk'),
}
_health: dict[tuple, tuple[float, bool]] = {}


def runtime_python() -> Path:
    return Path(os.environ.get('OPENMONTAGE_ML_PYTHON', str(ROOT / '.runtime/montage-ml/bin/python')))


def needs_bridge() -> bool:
    return os.environ.get(CHILD) != '1' and sys.executable != str(runtime_python())


def runtime_ready(group: str) -> bool:
    packages = PACKAGES[group]
    if not needs_bridge():
        return all(importlib.util.find_spec(name) for name in packages)
    python = runtime_python()
    if not python.is_absolute() or not python.is_file():
        return False
    stat = python.stat()
    key = (str(python), stat.st_mtime_ns, group)
    cached = _health.get(key)
    if cached and time.monotonic() - cached[0] < 30:
        return cached[1]
    try:
        code = 'import importlib.util; print(int(all(importlib.util.find_spec(n) for n in ' + repr(packages) + ')))'
        result = subprocess.run([str(python), '-c', code], capture_output=True, text=True, timeout=10)
        ready = result.returncode == 0 and result.stdout.strip() == '1'
    except (OSError, subprocess.TimeoutExpired):
        ready = False
    _health[key] = (time.monotonic(), ready)
    return ready


def execute(tool: str, inputs: dict) -> ToolResult:
    if tool not in TOOLS:
        return ToolResult(success=False, error='Tool is not allow-listed for local ML')
    env = {**os.environ, CHILD: '1', 'PYTHONPATH': str(ROOT), 'PYTHONUNBUFFERED': '1',
           'OMP_NUM_THREADS': '2', 'MKL_NUM_THREADS': '2', 'NUMBA_NUM_THREADS': '2',
           'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1', 'HF_HUB_DISABLE_TELEMETRY': '1'}
    env['NLTK_DATA'] = str(ROOT / '.runtime/nltk_data')
    try:
        child = subprocess.run([str(runtime_python()), '-m', 'tools.local_ml_runtime'],
            input=json.dumps({'tool': tool, 'inputs': inputs}, ensure_ascii=False, allow_nan=False),
            cwd=ROOT, env=env, text=True, capture_output=True, timeout=1800)
        if child.returncode:
            return ToolResult(success=False, error='本机 ML 进程未完成；没有联网下载或调用其他模型')
        from tools.optional_runtime import _decode_result
        result = _decode_result(json.loads(child.stdout))
        result.data.setdefault('execution', 'project_local_offline_ml')
        return result
    except subprocess.TimeoutExpired:
        return ToolResult(success=False, error='本机 CPU 推理超时；已保留源文件，没有自动重试')
    except (OSError, ValueError, TypeError):
        return ToolResult(success=False, error='本机 ML 返回无效结果；没有调用外部替代服务')


def _offline():
    original = socket.socket.connect
    def connect(sock, address):
        if isinstance(address, tuple):
            raise PermissionError('Local ML inference cannot access the network')
        return original(sock, address)
    socket.socket.connect = connect
    for key in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'):
        os.environ.pop(key, None)
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1')
    import torch
    torch.set_num_threads(2)
    # Official .pth state dictionaries were validated during installation.
    # Enforce restricted loading for every upstream checkpoint read as well.
    load = torch.load
    def weights_only(*args, **kwargs):
        kwargs['weights_only'] = True
        return load(*args, **kwargs)
    torch.load = weights_only


def main():
    packet = json.loads(sys.stdin.read(300_000))
    name = packet.get('tool')
    if name not in TOOLS or not isinstance(packet.get('inputs'), dict):
        raise ValueError('Invalid fixed-tool request')
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        _offline()
        if name == 'upscale':
            from tools.enhancement.upscale import Upscale
            tool = Upscale()
        elif name == 'face_restore':
            from tools.enhancement.face_restore import FaceRestore
            tool = FaceRestore()
        elif name == 'transcript_aligner':
            from tools.analysis.transcript_aligner import TranscriptAligner
            tool = TranscriptAligner()
        else:
            from tools.analysis.video_understand import VideoUnderstand
            tool = VideoUnderstand()
        result = tool.execute(packet['inputs'])
    sys.stdout.write(json.dumps(dataclasses.asdict(result), ensure_ascii=False, allow_nan=False))


if __name__ == '__main__':
    main()
