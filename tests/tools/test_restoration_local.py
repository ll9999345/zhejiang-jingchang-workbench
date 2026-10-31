"""User originals and explicit model choices remain intact across local ML jobs."""
import hashlib
import json
from types import SimpleNamespace

import pytest
from PIL import Image

from tools.enhancement.face_restore import FaceRestore
from tools.enhancement.upscale import Upscale
from tools import local_ml_runtime
from web_api.montage_worker import default_output


@pytest.fixture
def source(tmp_path):
    file = tmp_path / 'portrait.png'
    Image.new('RGB', (32, 24), '#567890').save(file)
    return file


@pytest.mark.parametrize('tool', [Upscale, FaceRestore])
def test_sources_and_existing_results_cannot_be_overwritten(source, tool, monkeypatch):
    before = hashlib.sha256(source.read_bytes()).hexdigest()
    monkeypatch.setattr(local_ml_runtime, 'execute', lambda *_: pytest.fail('Must reject before starting ML'))
    result = tool().execute({'input_path': str(source), 'output_path': str(source)})
    assert not result.success and '输出' in result.error
    assert hashlib.sha256(source.read_bytes()).hexdigest() == before


@pytest.mark.parametrize('tool,params', [
    (Upscale, {'scale': 3}), (Upscale, {'scale': True}),
    (Upscale, {'tile_size': 0}), (Upscale, {'max_video_frames': 1001}),
    (Upscale, {'denoise_strength': float('nan')}),
    (FaceRestore, {'fidelity': float('inf')}), (FaceRestore, {'upscale': True}),
])
def test_invalid_resource_or_model_parameters_stop_before_inference(source, tool, params, monkeypatch):
    monkeypatch.setattr(local_ml_runtime, 'execute', lambda *_: pytest.fail('Invalid inputs must not start ML'))
    result = tool().execute({'input_path': str(source), **params})
    assert not result.success
    assert not (source.parent / 'portrait_upscaled.png').exists()


def test_missing_exact_model_never_substitutes_a_different_network(source, monkeypatch):
    from tools.enhancement import _local_models
    monkeypatch.setattr(_local_models, 'requirements', lambda name: [f'{name} is not installed'])
    monkeypatch.setattr(local_ml_runtime, 'execute', lambda *_: pytest.fail('No silent fallback'))
    result = FaceRestore().execute({'input_path': str(source), 'model': 'CodeFormer'})
    assert not result.success and 'CodeFormer' in result.error


def test_invalid_fps_is_not_replaced_by_a_guessed_30fps(monkeypatch):
    monkeypatch.setattr(Upscale, 'run_command', lambda *_: SimpleNamespace(stdout=json.dumps({
        'streams': [{'codec_type': 'video', 'avg_frame_rate': '0/0'}]})))
    with pytest.raises((ValueError, ZeroDivisionError)):
        Upscale()._get_video_fps('video.mp4')


def test_worker_output_names_match_the_actual_media_type():
    assert default_output(Upscale(), {'input_path': 'source.webm'}) == 'upscaled.mp4'
    assert default_output(Upscale(), {'input_path': 'source.jpg'}) == 'upscaled.png'
    assert default_output(FaceRestore(), {}) == 'restored.png'


def test_ml_bridge_cannot_import_a_tool_or_module_chosen_by_the_request():
    result = local_ml_runtime.execute('arbitrary.module', {})
    assert not result.success and 'allow-listed' in result.error


def test_blip_qa_and_caption_preflight_check_different_exact_weights(source, tmp_path, monkeypatch):
    from tools.analysis.video_understand import VideoUnderstand
    caption, qa = tmp_path / 'caption', tmp_path / 'qa'
    caption.mkdir(); qa.mkdir()
    for file in ['config.json', 'model.safetensors', 'preprocessor_config.json', 'vocab.txt', 'tokenizer_config.json']:
        (caption / file).write_text('fixture')
    monkeypatch.setenv('OPENMONTAGE_BLIP_CAPTION_MODEL_PATH', str(caption))
    monkeypatch.setenv('OPENMONTAGE_BLIP_VQA_MODEL_PATH', str(qa))
    monkeypatch.setattr(local_ml_runtime, 'runtime_ready', lambda *_: True)
    assert not VideoUnderstand().input_requirements({'model': 'blip', 'mode': 'describe'})
    assert VideoUnderstand().input_requirements({'model': 'blip', 'mode': 'qa'})
    monkeypatch.setattr(local_ml_runtime, 'execute', lambda *_: pytest.fail('Cannot use caption weights for QA'))
    result = VideoUnderstand().execute({'input_path': str(source), 'model': 'blip', 'mode': 'qa', 'query': 'What is this?'})
    assert not result.success
