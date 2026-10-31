#!/usr/bin/env python3
"""Actual offline Chinese alignment, timing shift and animated caption export.

Reuses an existing, explicitly labelled Piper acceptance recording and scenic
image. The video is a still-background test fixture, not a completed production.
All source media, model files, outputs and failed attempts are retained.
"""
from datetime import datetime
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import statistics
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from web_api.montage_jobs import MontageJobs
from web_api.montage_registry import NativeToolRequest, tool_catalog


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--resume-checks', type=Path, help='Reuse completed alignment checks; retry only the failed caption render')
    args = parser.parse_args()
    os.environ['PATH'] = str(Path(sys.executable).parent) + os.pathsep + os.environ.get('PATH', '')
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    directory = ROOT / 'artifacts/montage-completion-20261001' / ('alignment-' + stamp)
    previous = None
    if args.resume_checks:
        previous_dir = args.resume_checks.resolve()
        assert previous_dir.is_relative_to(ROOT / 'artifacts/montage-completion-20261001')
        previous = json.loads((previous_dir / 'acceptance.json').read_text())
        assert len(previous['jobs']) >= 3 and all(j['status'] == 'completed' for j in previous['jobs'][:3])
        project = Path(previous['project'])
        directory.mkdir(parents=True, exist_ok=False)
    else:
        project = directory / 'projects/acceptance'
        project.mkdir(parents=True, exist_ok=False)
    source_project = ROOT / 'projects/draft-20260914-141923-cc721bf9b9'
    voice = source_project / 'analysis/montage/tools/20261001T055033-58147e7ac587/outputs/output_path/audio.wav'
    scene = source_project / 'assets/frames/shot-1.png'
    originals = {str(p):sha(p) for p in (voice, scene)}
    if not previous:
        shutil.copyfile(voice, project/'speech.wav')
        shutil.copyfile(scene, project/'scene.png')
    else:
        assert sha(voice) == sha(project/'speech.wav') and sha(scene) == sha(project/'scene.png')
    request = json.loads((voice.parents[2]/'request.json').read_text())
    text = request['inputs']['text']
    report = {'project':str(project), 'jobs':[], 'paid_calls':0, 'private_media_uploaded':False,
              'fixture': 'Real Piper speech with known script; still scenic background, not a real new production'}
    if previous:
        report['completed_checks_reused_from'] = str(previous_dir/'acceptance.json')
        report['prior_caption_attempts_retained'] = previous['jobs'][3:]
    def save():
        (directory/'acceptance.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    jobs = MontageJobs(project.parent)
    def run(name, values):
        row = jobs.submit(NativeToolRequest(project_id=project.name, tool=name, inputs=values,
                                           confirm=True, timeout_seconds=900))
        deadline = time.monotonic() + 915
        while row['status'] in {'queued','running','cancelling'} and time.monotonic() < deadline:
            time.sleep(.4); row = jobs.get(project.name, row['job_id'])
        report['jobs'].append(row); save()
        print(name, row['status'], row.get('native_result', {}).get('error') or row.get('error') or '', flush=True)
        if row['status'] != 'completed':
            raise RuntimeError('Actual native task did not complete')
        return row
    try:
        if previous:
            original, delayed, recognized = previous['jobs'][:3]
            report['jobs'].extend(previous['jobs'][:3])
        else:
            original = run('transcript_aligner', {'input_path':'speech.wav', 'text':text})
        words = original['native_result']['data']['word_timestamps']
        assert len(words) >= 20 and all(w['end'] > w['start'] >= 0 for w in words)
        assert len({round(w['end']-w['start'], 2) for w in words}) >= 3, 'Alignment used uniform text-length timing'
        # A known one-second waveform shift should shift the same characters,
        # unlike assigning each word by proportion of the total media length.
        if not previous:
            subprocess.run(['ffmpeg','-n','-v','error','-i',str(project/'speech.wav'),
                            '-af','adelay=1000:all=1',str(project/'delayed.wav')],check=True)
            delayed = run('transcript_aligner', {'input_path':'delayed.wav','text':text})
        moved = delayed['native_result']['data']['word_timestamps']
        assert [w['word'] for w in words] == [w['word'] for w in moved]
        shifts = [b['start']-a['start'] for a,b in zip(words,moved)]
        report['timing_shift_check'] = {'median_seconds':statistics.median(shifts),
            'max_absolute_error_seconds':max(abs(s-1) for s in shifts), 'expected_shift_seconds':1}
        assert .90 <= statistics.median(shifts) <= 1.10 and max(abs(s-1) for s in shifts) <= .25
        save()
        if not previous:
            recognized = run('transcriber', {'input_path':'speech.wav','model_size':'small',
                                            'language':'zh','alignment':'whisperx_zh'})
        data = recognized['native_result']['data']
        assert data['local_model'] == 'whisper-small' and data['alignment']['engine'] == 'whisperx_forced_ctc'
        assert data['word_timestamps'] and data['network_used'] is False
        report['asr_text_needs_review'] = ''.join(s['text'] for s in data['segments'])
        duration = original['native_result']['data']['duration_seconds']
        if not previous:
            subprocess.run(['ffmpeg','-n','-v','error','-loop','1','-i',str(project/'scene.png'),
                '-i',str(project/'speech.wav'),'-t',str(duration),'-vf','scale=640:360', '-r','24',
                '-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac',
                str(project/'caption-fixture.mp4')],check=True)
        aligned = original['native_result']['data']['subtitles']['json']
        if previous and previous['jobs'][-1]['status'] == 'completed' and previous['jobs'][-1]['tool'] == 'remotion_caption_burn':
            captioned = previous['jobs'][-1]
            report['jobs'].append(captioned)
            report['completed_caption_reused_without_rendering'] = True
        else:
            captioned = run('remotion_caption_burn', {'input_path':'caption-fixture.mp4',
                'transcript_path':aligned,'output_path':'captioned.mp4','words_per_page':8,'font_size':32})
        assert captioned['native_result']['data']['method'] == 'remotion'
        assert captioned['native_result']['data']['word_timing_source'] == 'provided_word_timestamps'
        video = next(f for f in captioned['outputs'] if f['path'] == captioned['native_result']['data']['output'])
        assert video.get('playable')
        probe = json.loads(subprocess.run(['ffprobe','-v','error','-show_streams','-show_format','-of','json',
            str(project/video['path'])],check=True,capture_output=True,text=True).stdout)
        assert any(s['codec_type']=='audio' for s in probe['streams'])
        assert abs(float(probe['format']['duration'])-duration) < .15
        frames = directory/'caption-frames'; frames.mkdir()
        for i, offset in enumerate((.8,1.1,1.5)):
            subprocess.run(['ffmpeg','-n','-v','error','-ss',str(offset),'-i',str(project/video['path']),
                '-frames:v','1',str(frames/f'frame-{i}.png')],check=True)
        assert len({sha(p) for p in frames.glob('*.png')}) == 3, 'Animated word highlight did not change'
        assert all(sha(Path(path)) == digest for path,digest in originals.items())
        report.update(all_originals_unchanged=True, original_sha256=originals, completed_jobs=len(report['jobs']),
                      request_fully_completed=False, content_accuracy='human_review_required')
        save()
        (directory/'catalog.json').write_text(json.dumps(tool_catalog(),ensure_ascii=False,indent=2),encoding='utf-8')
        print('LOCAL_ALIGNMENT_ACCEPTANCE_COMPLETE',directory,flush=True)
    finally:
        jobs.shutdown()


if __name__ == '__main__':
    main()
