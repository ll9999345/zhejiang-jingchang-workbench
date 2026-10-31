"""Actual PCM composition, no cloud fallback, and preserved earlier tracks."""
import hashlib
from pathlib import Path
import wave

import numpy as np
import pytest

from tools.audio.local_music import LocalMusic
from tools.audio.music_gen import MusicGen
from web_api.music_pipeline import MusicPipelineRequest, estimate_music, render_music


def decode(path):
    with wave.open(str(path), 'rb') as stream:
        properties = (stream.getnchannels(), stream.getframerate(), stream.getnframes())
        signal = np.frombuffer(stream.readframes(stream.getnframes()), dtype='<i2').reshape(-1, 2)
        return properties, signal


def test_real_instrumental_is_audible_repeatable_and_faded(tmp_path):
    hashes = []
    for name in ['one.wav', 'two.wav']:
        result = LocalMusic().execute({'duration_seconds': 3.25, 'output_path': str(tmp_path / name), 'seed': 7})
        assert result.success and result.cost_usd == 0 and result.data['offline']
        assert result.data['creative_method'] == 'procedural_synthesis_not_trained_ai'
        properties, signal = decode(tmp_path / name)
        assert properties == (2, 24000, 78000)
        assert np.sqrt(np.mean(signal.astype('float64') ** 2)) > 100
        assert abs(signal.astype('int32')).max() < 32767
        assert abs(signal[:100].astype('int32')).max() < 200
        assert abs(signal[-100:].astype('int32')).max() < 200
        hashes.append(hashlib.sha256((tmp_path / name).read_bytes()).hexdigest())
    assert hashes[0] == hashes[1]


def test_invalid_duration_vocals_and_existing_music_do_not_write_or_call_cloud(tmp_path, monkeypatch):
    monkeypatch.setattr(MusicGen, 'execute', lambda *_: pytest.fail('No implicit ElevenLabs fallback'))
    for data in [{'duration_seconds': 0}, {'duration_seconds': True},
                 {'duration_seconds': 3, 'force_instrumental': False},
                 {'duration_seconds': 3, 'style': 'unknown'},
                 {'duration_seconds': 3, 'cue_sheet': [{'start_seconds': 2, 'end_seconds': 1, 'energy': 'high'}]}]:
        assert not LocalMusic().execute({**data, 'output_path': str(tmp_path / 'new.wav')}).success
    assert not (tmp_path / 'new.wav').exists()
    existing = tmp_path / 'keep.wav'; existing.write_bytes(b'accepted original')
    assert not LocalMusic().execute({'duration_seconds': 3, 'output_path': str(existing)}).success
    assert existing.read_bytes() == b'accepted original'


def test_energy_cues_change_real_audio(tmp_path):
    for name, energy in [('quiet.wav', 'low'), ('strong.wav', 'high')]:
        assert LocalMusic().execute({'duration_seconds': 8, 'seed': 9, 'output_path': str(tmp_path / name),
            'cue_sheet': [{'start_seconds': 0, 'end_seconds': 4, 'energy': energy}]}).success
    assert (tmp_path / 'quiet.wav').read_bytes() != (tmp_path / 'strong.wav').read_bytes()


def test_web_preflight_is_free_readonly_and_requires_confirmation_before_writes(tmp_path, monkeypatch):
    project = tmp_path / 'demo'; project.mkdir()
    monkeypatch.setattr(MusicGen, 'execute', lambda *_: pytest.fail('Local choice must never call ElevenLabs'))
    request = MusicPipelineRequest(project_id='demo', prompt='国风器乐，留白舒缓', duration_seconds=3, preferred_provider='local')
    snapshot = set(project.rglob('*'))
    checked = estimate_music(request, project_root=tmp_path)
    assert checked['would_generate'] and checked['estimated_cost_usd'] == 0
    assert checked['provider']['provider'] == 'local_synthesis' and checked['provider']['model'] is None
    assert set(project.rglob('*')) == snapshot
    request = request.model_copy(update={'dry_run': False, 'execute': True, 'confirm': False})
    assert render_music(request, project_root=tmp_path, authorized=True)['status'] == 'authorization_required'
    assert set(project.rglob('*')) == snapshot


def test_web_rerun_keeps_accepted_audio_and_uses_distinct_output_manifests(tmp_path, monkeypatch):
    project = tmp_path / 'demo'; project.mkdir()
    accepted = project / 'assets/music/generated-bgm.wav'
    accepted.parent.mkdir(parents=True); accepted.write_bytes(b'accepted earlier music')
    monkeypatch.setattr(MusicGen, 'execute', lambda *_: pytest.fail('Must use explicitly selected free composition'))
    request = MusicPipelineRequest(project_id='demo', prompt='国风器乐，留白舒缓', duration_seconds=3,
        preferred_provider='local', local_style='documentary', local_tempo_bpm=85,
        output_name='generated-bgm.wav', dry_run=False, execute=True, confirm=True)
    paths, manifests = [], []
    for _ in range(2):
        row = render_music(request, project_root=tmp_path, authorized=True)
        assert row['status'] == 'completed' and row['paid_calls'] == 0, row
        assert row['data']['style'] == 'documentary' and row['data']['tempo_bpm'] == 85
        paths.append(row['music']['path']); manifests.append(row['manifest']['path'])
        assert decode(project / paths[-1])[0] == (2, 24000, 72000)
    assert paths[0] != paths[1] and manifests[0] != manifests[1]
    assert accepted.read_bytes() == b'accepted earlier music'
    assert all((project / p).is_file() for p in paths + manifests)


def test_invalid_local_cues_block_before_creating_run_directory(tmp_path):
    project = tmp_path / 'demo'; project.mkdir()
    request = MusicPipelineRequest(project_id='demo', prompt='国风器乐，留白舒缓', duration_seconds=3,
        preferred_provider='local', cue_sheet=[{'start_seconds': 0, 'end_seconds': 3.2, 'energy': 'high'}],
        dry_run=False, execute=True, confirm=True)
    assert estimate_music(request, project_root=tmp_path)['would_generate'] is False
    assert render_music(request, project_root=tmp_path, authorized=True)['would_write'] is False
    assert not list(project.rglob('*'))
