"""Caption timing, preservation and isolated runtime regression boundaries."""
import json
from pathlib import Path
from types import SimpleNamespace
import sys

import pytest

from tools.base_tool import ToolResult
from tools.video import _caption_runtime as runtime
from tools.video.remotion_caption_burn import RemotionCaptionBurn
from tools.analysis import transcript_aligner as aligner


def test_aligned_json_keeps_actual_character_boundaries(tmp_path, monkeypatch):
    video = tmp_path / 'original.mp4'; video.write_bytes(b'original')
    transcript = tmp_path / 'accepted.json'
    transcript.write_text(json.dumps({'segments': [{'text': '湖光', 'start': .2, 'end': 1.3,
        'words': [{'word': '湖', 'start': .2, 'end': .46}, {'word': '光', 'start': .47, 'end': 1.3}]}]}))
    tool = RemotionCaptionBurn()
    captured = []
    monkeypatch.setattr(tool, '_remotion_available', lambda: True)
    def render(*args, **kwargs):
        captured.extend(args[2])
        return ToolResult(success=True, data={'method': 'remotion'})
    monkeypatch.setattr(tool, '_render_remotion', render)
    result = tool.execute({'input_path': str(video), 'output_path': str(tmp_path / 'new.mp4'),
                           'transcript_path': str(transcript)})
    assert result.success and result.data['word_timing_source'] == 'provided_word_timestamps'
    assert captured == [{'word': '湖', 'startMs': 200, 'endMs': 460},
                        {'word': '光', 'startMs': 470, 'endMs': 1300}]
    assert video.read_bytes() == b'original'


@pytest.mark.parametrize('words', [
    [{'word': '湖', 'start': float('nan'), 'end': 1}],
    [{'word': '湖', 'start': 2, 'end': 1}],
    [{'word': '湖', 'start': 'invented', 'end': 1}],
    [{'word': '湖'}],
])
def test_invalid_timings_cannot_become_completed_video(tmp_path, words):
    video = tmp_path / 'original.mp4'; video.write_bytes(b'original')
    output = tmp_path / 'new.mp4'
    result = RemotionCaptionBurn().execute({'input_path': str(video), 'output_path': str(output),
                                           'segments': [{'words': words}]})
    assert not result.success and not output.exists()


def test_existing_output_cannot_be_replaced(tmp_path):
    original = tmp_path / 'accepted.mp4'; original.write_bytes(b'accepted')
    result = RemotionCaptionBurn().execute({'input_path': str(original), 'output_path': str(original),
                                           'segments': [{'text': '湖光', 'start': 0, 'end': 1}]})
    assert not result.success and original.read_bytes() == b'accepted'


def test_each_caption_workspace_preserves_main_composer(tmp_path, monkeypatch):
    source = tmp_path / 'composer'; source.mkdir()
    for name in ('TalkingHead.tsx', 'components/CaptionOverlay.tsx'):
        path = source / 'src' / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text('accepted source')
    (source / 'package.json').write_text('{}')
    node_modules = source / 'node_modules/remotion'; node_modules.mkdir(parents=True)
    (node_modules / 'package.json').write_text('{"version": "test"}')
    monkeypatch.setattr(runtime, 'runtime_for', lambda root: root)
    one, _, record = runtime.prepare_workspace(source, tmp_path / 'outputs', 640, 360, 180)
    two, _, _ = runtime.prepare_workspace(source, tmp_path / 'outputs', 640, 360, 180)
    assert one != two and not (source / 'src/caption-entry.tsx').exists()
    assert not any(p.is_symlink() for p in one.rglob('*'))
    assert 'Root.tsx' not in (one / 'src/caption-entry.tsx').read_text()
    assert record['main_composer_mutated'] is False and record['font_downloads_requested'] is False
    assert (source / 'src/TalkingHead.tsx').read_text() == 'accepted source'


def test_unsupported_spoken_characters_are_not_silently_dropped(monkeypatch):
    calls = []
    alignment_module = SimpleNamespace(load_align_model=lambda *args, **kwargs: ('model', {'dictionary': {'湖': 1}}),
                                       align=lambda *args, **kwargs: calls.append(args))
    monkeypatch.setitem(sys.modules, 'nltk', SimpleNamespace(data=SimpleNamespace(path=[])))
    monkeypatch.setitem(sys.modules, 'whisperx.alignment', alignment_module)
    with pytest.raises(ValueError, match='沒有|没有丢字'):
        aligner.align_segments(Path('audio.wav'), [{'start': 0, 'end': 1, 'text': '湖臺'}])
    assert calls == []
