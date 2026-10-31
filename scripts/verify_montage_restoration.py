#!/usr/bin/env python3
"""Real offline native jobs: enhancement, face restoration and BLIP inference.

Fixture: scikit-image's bundled NASA astronaut image, plus a copied existing
scenic project image and an explicitly synthetic decoder video. Originals and
every run are retained. This tests inference/media delivery, not universal
semantic accuracy or a complete AI-directed production.
"""
from __future__ import annotations
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

from PIL import Image
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from web_api.montage_jobs import MontageJobs
from web_api.montage_registry import NativeToolRequest, tool_catalog


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    os.environ['PATH'] = str(Path(sys.executable).parent) + os.pathsep + os.environ.get('PATH', '')
    directory = ROOT / 'artifacts/montage-completion-20261001' / ('restoration-' + datetime.now().strftime('%Y%m%d-%H%M%S'))
    project = directory / 'projects/acceptance'
    project.mkdir(parents=True, exist_ok=False)
    fixture = ROOT / '.runtime/montage-ml/lib/python3.12/site-packages/skimage/data/astronaut.png'
    scenic = ROOT / 'projects/draft-20260914-141923-cc721bf9b9/assets/frames/shot-1.png'
    originals = {str(fixture): sha(fixture), str(scenic): sha(scenic)}
    with Image.open(fixture) as image:
        image.resize((256, 256), Image.Resampling.LANCZOS).save(project / 'portrait.png')
        image.resize((64, 64), Image.Resampling.LANCZOS).save(project / 'tiny.png')
    with Image.open(scenic) as image:
        image.thumbnail((256, 256)); image.convert('RGB').save(project / 'scenic.png')
    input_hashes = {p.name: sha(p) for p in project.glob('*.png')}
    subprocess.run(['ffmpeg', '-n', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x48:rate=2',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(project / 'synthetic.mp4')], check=True)
    input_hashes['synthetic.mp4'] = sha(project / 'synthetic.mp4')
    jobs = MontageJobs(project.parent)
    records = []
    print('ACCEPTANCE_DIR', directory, flush=True)
    def execute(tool, inputs):
        row = jobs.submit(NativeToolRequest(project_id='acceptance', tool=tool, inputs=inputs,
            confirm=True, timeout_seconds=900))
        deadline = time.monotonic() + 915
        while row['status'] in {'queued', 'running', 'cancelling'} and time.monotonic() < deadline:
            time.sleep(.4); row = jobs.get('acceptance', row['job_id'])
        records.append(row)
        (directory / 'acceptance.json').write_text(json.dumps({'project': str(project), 'jobs': records,
            'paid_calls': 0, 'external_inference_calls': 0}, ensure_ascii=False, indent=2))
        print(tool, inputs.get('model', ''), inputs.get('mode', ''), row['status'],
            row.get('native_result', {}).get('error') or row.get('error') or '', flush=True)
        if row['status'] != 'completed': raise RuntimeError('Real native task failed')
        return row
    def output_image(row):
        target = project / row['native_result']['data']['output']
        with Image.open(target) as image: return np.asarray(image.convert('RGB')), image.size
    try:
        for model in ['RealESRGAN_x4plus', 'RealESRGAN_x4plus_anime_6B', 'RealESRNet_x4plus', 'realesr-general-x4v3']:
            row = execute('upscale', {'input_path': 'tiny.png', 'scale': 2, 'model': model, 'tile_size': 64})
            output, size = output_image(row)
            assert size == (128, 128)
            with Image.open(project / 'tiny.png') as image:
                ordinary = np.asarray(image.resize(size, Image.Resampling.LANCZOS).convert('RGB'))
            assert not np.array_equal(output, ordinary), 'Neural inference was replaced by ordinary resize'
        row = execute('upscale', {'input_path': 'synthetic.mp4', 'model': 'realesr-general-x4v3', 'scale': 2, 'max_video_frames': 2})
        video = next(p for p in row['outputs'] if p['kind'] == 'video')
        assert video.get('playable') and row['native_result']['data']['total_frames'] == 2
        probe = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json',
            str(project / video['path'])], check=True, capture_output=True, text=True).stdout)
        stream = next(p for p in probe['streams'] if p['codec_type'] == 'video')
        assert (stream['width'], stream['height']) == (128, 96)
        assert any(p['codec_type'] == 'audio' for p in probe['streams'])
        assert abs(float(probe['format']['duration']) - 1) < .15
        for model in ['GFPGAN', 'CodeFormer']:
            row = execute('face_restore', {'input_path': 'portrait.png', 'model': model, 'upscale': 2})
            assert row['native_result']['data']['faces_restored'] >= 1
            assert row['native_result']['data']['restoration_applied'] is True
            output, size = output_image(row)
            assert size == (512, 512)
            with Image.open(project / 'portrait.png') as image:
                assert not np.array_equal(output, np.asarray(image.resize(size, Image.Resampling.LANCZOS)))
        row = execute('upscale', {'input_path': 'portrait.png', 'model': 'realesr-general-x4v3', 'scale': 2, 'face_enhance': True})
        assert row['native_result']['data']['faces_restored'] >= 1
        descriptions = []
        for path in ['portrait.png', 'scenic.png']:
            row = execute('video_understand', {'input_path': path, 'mode': 'describe', 'model': 'blip'})
            text = row['native_result']['data']['frames'][0]['description']
            assert text and row['native_result']['data']['limitations']
            descriptions.append(text)
            print('BLIP_CAPTION', text, flush=True)
        assert descriptions[0] != descriptions[1], 'Different actual scenes returned identical captions'
        row = execute('video_understand', {'input_path': 'portrait.png', 'mode': 'qa', 'model': 'blip',
            'query': 'How many people are in this image?'})
        answer = row['native_result']['data']['frames'][0]['answer']
        print('BLIP_VQA', answer, flush=True)
        assert answer.lower().strip(' .') in {'1', 'one'}, 'One-person reference question failed'
        execute('video_understand', {'input_path': 'synthetic.mp4', 'mode': 'classify', 'model': 'clip', 'max_frames': 2})
        assert all(sha(path) == digest for path, digest in originals.items())
        assert all(sha(project / name) == digest for name, digest in input_hashes.items())
        receipt = {'all_originals_unchanged': True, 'original_sha256': originals, 'fixture_sha256': input_hashes,
            'completed_jobs': len(records), 'video_audio_and_timing_checked': True,
            'limits': 'Real offline inference, not universal semantic or aesthetic acceptance'}
        (directory / 'source-verification.json').write_text(json.dumps(receipt, indent=2))
        (directory / 'catalog.json').write_text(json.dumps(tool_catalog(), ensure_ascii=False, indent=2))
        print('LOCAL_RESTORATION_ACCEPTANCE_COMPLETE', directory, flush=True)
    finally:
        jobs.shutdown()


if __name__ == '__main__':
    main()
