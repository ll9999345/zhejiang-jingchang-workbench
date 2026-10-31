from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from tools.base_tool import ToolResult, ToolStatus
import web_api.footage_music as module
import web_api.footage_pipeline as footage


class FakeMusicTool:
    name = 'fake_elevenlabs_music'
    provider = 'elevenlabs'

    def __init__(self, *, available=True, rate=.02, fail=False):
        self.available, self.rate, self.fail = available, rate, fail
        self.estimates, self.calls = [], []

    def get_status(self):
        return ToolStatus.AVAILABLE if self.available else ToolStatus.UNAVAILABLE

    def get_info(self):
        return {'supports': {'instrumental': True}}

    def estimate_cost(self, inputs):
        self.estimates.append(dict(inputs))
        return float(inputs['duration_seconds']) * self.rate

    def execute(self, inputs):
        self.calls.append(dict(inputs))
        if self.fail:
            return ToolResult(success=False, error='private-provider-error-not-for-user')
        output = Path(inputs['output_path'])
        output.write_bytes(b'synthetic audio fixture')
        return ToolResult(success=True, data={'model_id': inputs['model_id']}, artifacts=[str(output)])


@pytest.fixture
def project(tmp_path):
    result = tmp_path / 'demo'
    result.mkdir()
    return result


def request(**changes):
    options = dict(bgm_mode='elevenlabs', bgm_prompt='  gentle   scenic piano  ',
                   bgm_model_id='music_v2', bgm_confirm_paid=True, bgm_confirm_text=True,
                   bgm_billing_limit_configured=True, bgm_budget_usd=2.0, variants=5)
    options.update(changes.pop('options', {}))
    body = dict(project_id='demo', action='render', stop_at='video', options=SimpleNamespace(**options))
    body.update(changes)
    return SimpleNamespace(**body)


@pytest.mark.parametrize('changes', [
    {'action': 'collect'}, {'stop_at': 'script'}, {'stop_at': 'terms'},
    {'stop_at': 'materials'}, {'stop_at': 'audio'}, {'stop_at': 'subtitle'},
    {'options': {'bgm_mode': 'none'}}, {'options': {'bgm_mode': 'selected'}},
    {'options': {'bgm_mode': 'random'}}, {'options': {'bgm_mode': 'local'}},
])
def test_free_stages_do_not_construct_or_inspect_a_music_tool(project, monkeypatch, changes):
    def forbidden(*args, **kwargs):
        pytest.fail('free stages must not construct, estimate or execute paid music')
    monkeypatch.setattr(module, 'MusicPipelineRequest', forbidden)
    monkeypatch.setattr(module, 'estimate_music', forbidden)
    monkeypatch.setattr(module, 'render_music', forbidden)
    current = request(**changes)
    assert not module.paid_music_requested(current)
    assert module.preflight_footage_music(project.parent, current, float('nan'),
                                         tool=SimpleNamespace(execute=forbidden), require_approval=True) == {
        'required': False, 'ready': True, 'errors': [], 'approvals': []}
    assert not list(project.iterdir())


def test_paid_music_predicate_accepts_mapping_without_media_execution():
    assert module.paid_music_requested({'action': 'create', 'stop_at': 'video',
                                        'options': {'bgm_mode': 'elevenlabs'}})


def test_preflight_reuses_full_prompt_exact_duration_and_selected_model(project):
    tool = FakeMusicTool()
    current = request(options={'bgm_model_id': 'music_v2_5'})
    checked = module.preflight_footage_music(project.parent, current, 12.345, tool=tool)
    assert checked['required'] and checked['ready']
    assert checked['model_id'] == 'music_v2_5'
    assert checked['estimated_cost_usd'] == pytest.approx(.2469)
    assert checked['duration_seconds'] == 12.345
    assert checked['prompt_preview'].startswith('gentle scenic piano\n')
    assert 'Cue sheet:' in checked['prompt_preview']
    assert tool.estimates[0]['model_id'] == 'music_v2_5'
    assert tool.estimates[0]['duration_seconds'] == 12.345
    assert not tool.calls and not list(project.iterdir())


def test_unconfigured_provider_cannot_render_or_execute(project):
    tool = FakeMusicTool(available=False)
    checked = module.preflight_footage_music(project.parent, request(), 10, tool=tool, require_approval=True)
    assert not checked['ready']
    assert 'ELEVENLABS_API_KEY 未配置' in '；'.join(checked['errors'])
    with pytest.raises(ValueError, match='ELEVENLABS_API_KEY 未配置'):
        module.render_footage_music(project.parent, request(), 10, 'new.mp3', tool=tool)
    assert not tool.calls and not list(project.iterdir())


@pytest.mark.parametrize('field', ['bgm_confirm_paid', 'bgm_confirm_text', 'bgm_billing_limit_configured'])
def test_each_approval_is_required_before_render(project, monkeypatch, field):
    tool = FakeMusicTool()
    current = request(options={field: False})
    checked = module.preflight_footage_music(project.parent, current, 10, tool=tool, require_approval=True)
    assert not checked['ready'] and checked['approvals']
    monkeypatch.setattr(module, 'render_music', lambda *args, **kwargs: pytest.fail('approval missing'))
    with pytest.raises(ValueError):
        module.render_footage_music(project.parent, current, 10, 'new.mp3', tool=tool)
    assert not tool.calls


@pytest.mark.parametrize('budget', [None, 0, -1, float('nan'), float('inf'), float('-inf'), True, '2'])
def test_budget_requires_finite_positive_numeric_amount(project, budget):
    checked = module.preflight_footage_music(project.parent, request(options={'bgm_budget_usd': budget}),
                                             10, tool=FakeMusicTool(), require_approval=True)
    assert not checked['ready'] and checked['approvals']


def test_actual_cut_duration_rechecks_budget_without_generation(project, monkeypatch):
    tool = FakeMusicTool()
    current = request(options={'bgm_budget_usd': .21})
    assert module.preflight_footage_music(project.parent, current, 10, tool=tool, require_approval=True)['ready']
    checked = module.preflight_footage_music(project.parent, current, 11, tool=tool, require_approval=True)
    assert not checked['ready'] and '超过本次预算' in '；'.join(checked['approvals'])
    monkeypatch.setattr(module, 'render_music', lambda *args, **kwargs: pytest.fail('measured cut exceeds budget'))
    with pytest.raises(ValueError, match='超过本次预算'):
        module.render_footage_music(project.parent, current, 11, 'new.mp3', tool=tool)
    assert not tool.calls


@pytest.mark.parametrize('cost', [None, 0, -1, float('nan'), float('inf'), True, '0.2'])
def test_unknown_or_invalid_price_is_never_treated_as_free(project, monkeypatch, cost):
    monkeypatch.setattr(module, 'estimate_music', lambda *args, **kwargs: {
        'status': 'dry_run', 'would_generate': True, 'provider': {'status': 'available'},
        'estimated_cost_usd': cost, 'prompt_preview': 'full enriched prompt'})
    checked = module.preflight_footage_music(project.parent, request(), 10, require_approval=True)
    assert not checked['ready'] and '价格未知' in '；'.join(checked['errors'])


@pytest.mark.parametrize('changes', [
    {'bgm_model_id': 'music_v3'}, {'bgm_model_id': None}, {'bgm_model_id': ' music_v2'},
    {'bgm_prompt': '   abc   '}, {'bgm_prompt': 'x' * 3101}, {'bgm_prompt': None},
])
def test_invalid_model_or_prompt_is_rejected_before_estimate(project, monkeypatch, changes):
    monkeypatch.setattr(module, 'estimate_music', lambda *args, **kwargs: pytest.fail('invalid model/prompt'))
    checked = module.preflight_footage_music(project.parent, request(options=changes), 10)
    assert not checked['ready'] and checked['errors']


@pytest.mark.parametrize('duration', [2.99, 600.01, float('nan'), float('inf'), None, True])
def test_invalid_actual_duration_is_not_clamped_or_estimated(project, monkeypatch, duration):
    monkeypatch.setattr(module, 'estimate_music', lambda *args, **kwargs: pytest.fail('invalid duration'))
    checked = module.preflight_footage_music(project.parent, request(), duration)
    assert not checked['ready'] and '实际时长' in '；'.join(checked['errors'])


def test_multiple_variants_generate_once_and_return_the_existing_result(project, monkeypatch):
    tool = FakeMusicTool()
    monkeypatch.setattr(footage, 'probe', lambda path: {'has_audio': True, 'duration': 10.1})
    result = module.render_footage_music(project.parent, request(), 10.1, 'run-unique.mp3', tool=tool)
    assert result['status'] == 'completed'
    assert result['music']['path'] == 'assets/music/run-unique.mp3'
    assert len(tool.calls) == 1
    call = tool.calls[0]
    assert call['model_id'] == 'music_v2' and call['force_instrumental'] is True
    assert call['duration_seconds'] == 10.1
    assert not any(key in call for key in ('reference_video_path', 'reference_audio', 'api_key'))
    manifest = json.loads((project / 'artifacts/music_manifest.json').read_text())
    assert manifest['output']['path'] == result['music']['path']


def test_provider_failure_preserves_existing_audio_and_materials_without_retry(project):
    voice = project / 'narration.wav'
    material = project / 'scene.mp4'
    accepted = project / 'assets/music/accepted.mp3'
    accepted.parent.mkdir(parents=True)
    originals = {voice: b'accepted narration', material: b'accepted footage', accepted: b'accepted bgm'}
    for path, content in originals.items():
        path.write_bytes(content)
    tool = FakeMusicTool(fail=True)
    with pytest.raises(ValueError, match='已有旁白和素材已保留，不会自动重试') as failure:
        module.render_footage_music(project.parent, request(), 10, 'new-run.mp3', tool=tool)
    assert 'private-provider-error' not in str(failure.value)
    assert len(tool.calls) == 1
    assert all(path.read_bytes() == content for path, content in originals.items())
    assert not (accepted.parent / 'new-run.mp3').exists()


@pytest.mark.parametrize('details', [None, {}, {'has_audio': False, 'duration': 10},
                                    {'has_audio': True, 'duration': 0},
                                    {'has_audio': True, 'duration': float('nan')}])
def test_fake_or_unprobed_audio_cannot_be_completed(project, monkeypatch, details):
    tool = FakeMusicTool()
    monkeypatch.setattr(footage, 'probe', lambda path: details)
    with pytest.raises(ValueError, match='未通过项目内音频验证'):
        module.render_footage_music(project.parent, request(), 10, 'new-run.mp3', tool=tool)
    assert len(tool.calls) == 1


def test_completed_response_cannot_point_outside_its_project(project, monkeypatch):
    tool = FakeMusicTool()
    outside = project.parent / 'outside.mp3'
    outside.write_bytes(b'other project audio')
    monkeypatch.setattr(module, 'render_music', lambda *args, **kwargs: {
        'status': 'completed', 'music': {'path': '../outside.mp3'}})
    monkeypatch.setattr(footage, 'probe', lambda path: pytest.fail('outside path must not be probed'))
    with pytest.raises(ValueError, match='未通过项目内音频验证'):
        module.render_footage_music(project.parent, request(), 10, 'new-run.mp3', tool=tool)
    assert outside.read_bytes() == b'other project audio'


def test_existing_output_name_is_not_replaced_or_submitted(project):
    accepted = project / 'assets/music/accepted.mp3'
    accepted.parent.mkdir(parents=True)
    accepted.write_bytes(b'accepted music')
    tool = FakeMusicTool()
    with pytest.raises(ValueError, match='不会覆盖已有配乐'):
        module.render_footage_music(project.parent, request(), 10, 'accepted.mp3', tool=tool)
    assert not tool.calls and accepted.read_bytes() == b'accepted music'


def test_temporary_paid_approvals_never_serialize_into_footage_options():
    options = footage.FootageOptions(bgm_mode='elevenlabs', bgm_prompt='gentle piano', bgm_model_id='music_v2',
                                     bgm_confirm_paid=True, bgm_confirm_text=True,
                                     bgm_billing_limit_configured=True, bgm_budget_usd=.5)
    dumped = options.model_dump()
    assert dumped['bgm_mode'] == 'elevenlabs' and dumped['bgm_model_id'] == 'music_v2'
    for field in ('bgm_confirm_paid', 'bgm_confirm_text', 'bgm_billing_limit_configured', 'bgm_budget_usd'):
        assert field not in dumped and field not in options.model_dump_json()
