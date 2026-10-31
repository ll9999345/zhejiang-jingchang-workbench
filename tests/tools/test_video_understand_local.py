"""Offline visual analysis must not guess VQA answers or fetch another model."""
import hashlib
import json

import numpy as np
import pytest
from PIL import Image

from tools.analysis.video_understand import VideoUnderstand
from web_api.montage_registry import NativeToolRequest, preflight_tool


@pytest.fixture
def project(tmp_path):
    directory = tmp_path / 'demo'
    directory.mkdir()
    pixels = np.indices((48, 64)).sum(axis=0) % 2 * 180 + 30
    Image.fromarray(np.repeat(pixels[..., None], 3, axis=2).astype('uint8')).save(directory / 'source.png')
    return directory


def test_real_quality_metrics_need_no_torch_and_preserve_source(project, monkeypatch):
    source = project / 'source.png'
    before = hashlib.sha256(source.read_bytes()).hexdigest()
    monkeypatch.setattr(VideoUnderstand, '_load_model', lambda *_: pytest.fail('Quality must not load a model'))
    result = VideoUnderstand().execute({'input_path': str(source), 'mode': 'quality', 'model': 'llava'})
    assert result.success
    assert result.data['model'] == 'metrics'
    frame = result.data['frames'][0]
    assert frame['resolution'] == '64x48' and frame['brightness'] == 120
    assert frame['blur_score'] > 100 and frame['contrast'] == 90
    assert result.data['limitations']
    assert hashlib.sha256(source.read_bytes()).hexdigest() == before


def test_clip_question_answer_is_rejected_before_loading_or_sampling(project, monkeypatch):
    monkeypatch.setattr(VideoUnderstand, '_load_frames', lambda *_: pytest.fail('Unsupported QA must stop before inference'))
    result = VideoUnderstand().execute({'input_path': str(project / 'source.png'), 'mode': 'qa',
                                        'model': 'clip', 'query': 'How many buildings are there?'})
    assert not result.success and 'CLIP' in result.error
    assert not result.data
    with pytest.raises(ValueError, match='does not support'):
        VideoUnderstand()._analyze_qa([], 'clip', 'Is there a castle?')


def test_web_preflight_checks_mode_and_writes_nothing(project):
    before = set(project.rglob('*'))
    checked = preflight_tool(NativeToolRequest(project_id='demo', tool='video_understand',
        inputs={'input_path': 'source.png', 'mode': 'qa', 'model': 'clip', 'query': 'What is this place?'}), project.parent)
    assert not checked['can_execute'] and 'CLIP' in ' '.join(checked['requirements'])
    checked = preflight_tool(NativeToolRequest(project_id='demo', tool='video_understand',
        inputs={'input_path': 'source.png', 'mode': 'quality'}), project.parent)
    assert checked['can_execute'] and not checked['effects']['network']
    assert checked['would_write'] is False and set(project.rglob('*')) == before


def test_clip_scores_use_actual_image_vectors_and_are_not_probability(project, monkeypatch):
    from lib import clip_embedder
    seen = []
    def images(paths):
        seen.extend(paths)
        assert all(p.is_file() for p in paths)
        return np.array([[1, 0]], dtype=np.float32)
    def texts(candidates):
        vectors = np.zeros((len(candidates), 2), dtype=np.float32)
        vectors[:, 1] = 1
        vectors[1] = [1, 0]
        return vectors
    monkeypatch.setattr(clip_embedder, 'embed_images', images)
    monkeypatch.setattr(clip_embedder, 'embed_texts', texts)
    with Image.open(project / 'source.png') as image:
        classified = VideoUnderstand()._analyze_classify([image], 'clip')[0]
        description = VideoUnderstand()._analyze_describe([image], 'clip')[0]
    assert seen and classified['top_category'] == 'outdoor'
    assert classified['score_kind'] == 'cosine_similarity_not_probability'
    assert 'confidence' not in classified and 'confidence' not in description
    assert description['description_kind'] == 'candidate_label'


def test_absent_caption_runtime_does_not_use_clip_instead(project, monkeypatch):
    from tools.analysis import video_understand
    original = video_understand.importlib.util.find_spec
    monkeypatch.setattr(video_understand.importlib.util, 'find_spec', lambda name: None if name == 'torch' else original(name))
    monkeypatch.setattr(VideoUnderstand, '_clip_scores', lambda *_: pytest.fail('No silent model substitution'))
    result = VideoUnderstand().execute({'input_path': str(project / 'source.png'), 'model': 'blip2'})
    assert not result.success and 'blip2' in result.error


def test_caption_model_requires_all_local_safetensors_shards(tmp_path):
    (tmp_path / 'config.json').write_text('{}')
    (tmp_path / 'pytorch_model.bin').write_bytes(b'not accepted')
    assert not VideoUnderstand._safe_weights_installed(tmp_path)
    index = tmp_path / 'model.safetensors.index.json'
    index.write_text(json.dumps({'weight_map': {'a': 'model-1.safetensors', 'b': 'model-2.safetensors'}}))
    (tmp_path / 'model-1.safetensors').write_bytes(b'weights')
    assert not VideoUnderstand._safe_weights_installed(tmp_path)
    (tmp_path / 'model-2.safetensors').write_bytes(b'weights')
    assert VideoUnderstand._safe_weights_installed(tmp_path)
    index.write_text(json.dumps({'weight_map': {'a': '../model-1.safetensors'}}))
    assert not VideoUnderstand._safe_weights_installed(tmp_path)


@pytest.mark.parametrize('count', [0, 33, True])
def test_frame_work_is_bounded(project, count):
    result = VideoUnderstand().execute({'input_path': str(project / 'source.png'), 'mode': 'quality', 'max_frames': count})
    assert not result.success and 'max_frames' in result.error
