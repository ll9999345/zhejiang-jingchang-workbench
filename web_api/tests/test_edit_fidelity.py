"""Actual local-media verification, without network, models or user projects."""
from array import array
import json
import math
import os
from pathlib import Path
import subprocess

import pytest

from web_api.footage_canvas import subtitle_cues
from web_api.footage_render import _mux_audio


def ff(*args):
    return subprocess.check_output(['ffmpeg', '-hide_banner', '-loglevel', 'error',
                                    '-nostdin', '-threads', '1', *map(str, args)], timeout=40)


def energy(samples, start, end, frequency):
    lo, hi = int(start * 48000), int(end * 48000)
    re = sum(samples[i] * math.cos(2 * math.pi * frequency * i / 48000) for i in range(lo, hi))
    im = sum(samples[i] * math.sin(2 * math.pi * frequency * i / 48000) for i in range(lo, hi))
    return 2 * math.hypot(re, im) / (hi - lo)


def test_verified_srt_keeps_milliseconds_overlaps_and_reports_clipped_tail(tmp_path):
    file = tmp_path / 'original.srt'
    raw = '\ufeff1\r\n00:00:00,150 --> 00:00:00,650\r\n第一句\r\n\r\n2\r\n00:00:00,500 --> 00:00:01,800\r\n跨镜字幕\r\n\r\n3\r\n00:00:02,000 --> 00:00:04,000\r\n片尾'
    file.write_bytes(raw.encode('utf-8'))
    result, clipped = subtitle_cues(file, 3)
    assert result == [{'start': .15, 'end': .65, 'text': '第一句'},
                      {'start': .5, 'end': 1.8, 'text': '跨镜字幕'},
                      {'start': 2, 'end': 3, 'text': '片尾'}]
    assert clipped == 1
    assert file.read_bytes() == raw.encode('utf-8')


@pytest.mark.parametrize('text', ['无时间字幕', '00:00:01,000 --> 00:00:00,200\n倒序',
                                 '00:61:00,000 --> 00:61:01,000\n坏时间',
                                 '00:00:00,000 --> 00:00:00,500\n'])
def test_invalid_srt_is_refused_instead_of_replaced_by_shot_dialogue(tmp_path, text):
    file = tmp_path / 'bad.srt'
    file.write_text(text)
    with pytest.raises(ValueError):
        subtitle_cues(file, 3)
    assert file.read_text() == text


def test_actual_footage_mix_ducks_music_only_while_narration_is_audible(tmp_path):
    video, voice, music = [tmp_path / p for p in ['blue.mp4', 'voice.wav', 'music.wav']]
    ff('-f', 'lavfi', '-i', 'color=blue:s=160x90:r=24:d=6', '-an', '-c:v', 'libx264',
       '-threads', '2', '-pix_fmt', 'yuv420p', video)
    ff('-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=6',
       '-af', "volume='if(between(t,1,3),1,0)':eval=frame", voice)
    ff('-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=6', music)
    results = {}
    for enabled in [True, False]:
        output = tmp_path / ('ducked.mp4' if enabled else 'fixed.mp4')
        _mux_audio(video, output, project=tmp_path, segments=[], total=6,
                   options={'narration_volume': 1, 'bgm_volume': .5, 'source_volume': 0, 'duck_bgm': enabled},
                   audio_path=voice, bgm_path=music, ffmpeg='ffmpeg', progress=None, cancelled=None)
        samples = array('f', ff('-i', output, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'))
        before, during, after = [energy(samples, start, end, 220) for start, end in [(.3, .7), (1.5, 2), (4, 4.5)]]
        assert before > .02 and after > before * .8
        assert energy(samples, 1.5, 2, 880) > .02
        assert energy(samples, .3, .7, 880) < .002
        if enabled:
            assert during < before * .4
        else:
            assert during > before * .8
        results[str(enabled)] = {'before': before, 'during': during, 'after': after,
                                 'attenuation_db': 20 * math.log10(during / before), 'output': str(output)}
    if folder := os.environ.get('FOOTAGE_EDIT_FIDELITY_EVIDENCE'):
        path = Path(folder)
        path.mkdir(parents=True, exist_ok=True)
        with (path / 'footage-ducking-metrics.json').open('x') as stream:
            json.dump({'evidence': 'actual_local_synthetic_audio', 'measurements': results}, stream, indent=2)
