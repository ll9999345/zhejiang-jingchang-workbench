from pathlib import Path
from types import SimpleNamespace
import json
import sys

import pytest

from tools.analysis import transcript_aligner as alignment
from tools.analysis.transcriber import Transcriber


@pytest.mark.parametrize('rows', [
    [{'start':0,'end':31,'text':'你好'}],
    [{'start':0,'end':2,'text':'你好'},{'start':1,'end':3,'text':'欢迎'}],
    [{'start':0,'end':float('nan'),'text':'你好'}],
    [{'start':0,'end':3,'text':''}],
])
def test_bad_or_unbounded_segments_never_get_invented_timestamps(rows):
    with pytest.raises(ValueError):
        alignment.read_segments({'segments':rows}, 40)


def test_srt_and_json_keep_actual_segment_times_and_text(tmp_path):
    rows = [{'start':1.25,'end':3.45,'text':'湖面映着晨光'}]
    path = tmp_path/'accepted.json'
    path.write_text(json.dumps({'segments':rows}), encoding='utf-8')
    assert alignment.read_segments({'transcript_path':str(path)}, 5) == rows
    srt = tmp_path/'accepted.srt'
    srt.write_text('1\n00:00:01,250 --> 00:00:03,450\n湖面映着晨光\n', encoding='utf-8')
    assert alignment.read_segments({'transcript_path':str(srt)}, 5) == rows
    with pytest.raises(ValueError):
        alignment.read_segments({'text':'冲突文本','transcript_path':str(path)}, 5)


def test_alignment_requires_audio_and_never_writes_on_invalid_input(tmp_path, monkeypatch):
    source = tmp_path/'source.wav'
    source.write_bytes(b'accepted source bytes')
    monkeypatch.setattr(alignment, 'probe_audio', lambda path:121)
    out = tmp_path/'outputs'
    result = alignment.TranscriptAligner().execute({'input_path':str(source),'text':'你好','output_dir':str(out)})
    assert not result.success and '上限' in result.error
    assert source.read_bytes() == b'accepted source bytes' and not out.exists()


def test_speaker_option_is_never_silently_ignored(tmp_path):
    audio = tmp_path/'source.wav'
    audio.write_bytes(b'test')
    output = tmp_path/'output'
    result = Transcriber().execute({'input_path':str(audio),'diarize':True,'output_dir':str(output)})
    assert not result.success and '说话人' in result.error and not output.exists()


def test_uninstalled_requested_model_has_no_download_or_substitution(tmp_path):
    audio = tmp_path/'source.wav'
    audio.write_bytes(b'test')
    result = Transcriber().execute({'input_path':str(audio),'model_size':'not-installed','output_dir':str(tmp_path/'output')})
    assert not result.success and '没有改用' in result.error


def test_requested_base_runs_base_offline_and_preserves_previous_transcript(tmp_path, monkeypatch):
    calls = []
    class Model:
        def __init__(self, name, **options):
            calls.append((Path(name).name,options))
        def transcribe(self, *args, **kwargs):
            word = SimpleNamespace(word='湖光',start=0,end=1,probability=.9)
            segment = SimpleNamespace(id=0,start=0,end=1,text='湖光',words=[word])
            return iter([segment]), SimpleNamespace(language='zh',duration=1)
    monkeypatch.setattr(Transcriber, 'local_model', staticmethod(lambda size:tmp_path/('whisper-'+size)))
    monkeypatch.setitem(sys.modules,'faster_whisper',SimpleNamespace(WhisperModel=Model))
    monkeypatch.setitem(sys.modules,'ctranslate2',SimpleNamespace(get_cuda_device_count=lambda:0))
    audio = tmp_path/'source.wav'; audio.write_bytes(b'test')
    first = Transcriber().execute({'input_path':str(audio),'model_size':'base','output_dir':str(tmp_path)})
    kept = Path(first.artifacts[0]).read_bytes()
    second = Transcriber().execute({'input_path':str(audio),'model_size':'base','output_dir':str(tmp_path)})
    assert first.success and second.success and first.artifacts != second.artifacts
    assert Path(first.artifacts[0]).read_bytes() == kept
    assert all(name == 'whisper-base' and options['local_files_only'] is True for name,options in calls)
