from __future__ import annotations

import json
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from tools.base_tool import ToolResult
from web_api.footage_pipeline import FootageRequest, FootageJobs, local_path, read_json, write_json
from web_api.reference_adaptation import (
    AdaptRequest,
    AnalyzeRequest,
    ReferenceJobs,
    create_reference_router,
    make_blueprint,
)


class Deferred:
    def __init__(self):
        self.calls = []

    def submit(self, fn, *args):
        self.calls.append((fn, args))

    def run(self):
        fn, args = self.calls.pop(0)
        fn(*args)


@pytest.fixture
def project(tmp_path: Path) -> Path:
    project = tmp_path / 'source-project'
    write_json(project / 'artifacts/workflow_state.json', {
        'prompt': '参考改编测试',
        'storyboard': {'shots': [{'id': 'old-1', 'title': '第一段', 'duration_seconds': 1}]},
    })
    write_json(project / 'artifacts/script.json', {'sections': [{'text': '旧旁白'}]})
    source = project / 'assets' / 'reference.mp4'
    source.parent.mkdir(parents=True)
    source.write_bytes(b'local-video-fixture')
    return project


def _recipe() -> dict:
    return {
        'reference_id': 'ref-' + 'a' * 24,
        'source': {'path': 'assets/reference.mp4', 'duration': 6.0, 'sha256': 'digest'},
        'scenes': [
            {'id': 'scene-1', 'start': 0, 'end': 1.0, 'duration': 1.0, 'frame': 'analysis/reference_runs/ref-' + 'a' * 24 + '/frames/1.jpg'},
            {'id': 'scene-2', 'start': 1.0, 'end': 3.5, 'duration': 2.5, 'frame': 'analysis/reference_runs/ref-' + 'a' * 24 + '/frames/2.jpg'},
            {'id': 'scene-3', 'start': 3.5, 'end': 6.0, 'duration': 2.5, 'frame': 'analysis/reference_runs/ref-' + 'a' * 24 + '/frames/3.jpg'},
        ],
    }


def test_project_picker_lists_only_real_nonhidden_projects(project: Path) -> None:
    write_json(project / 'project.json', {'title': '南北湖晨雾'})
    hidden = project.parent / '_test-draft'
    write_json(hidden / 'project.json', {'title': '测试项目'})
    native = project.parent / 'hypit-native'
    write_json(native / 'hypit.runtime.json', {'format': 'hypit.runtime-local@1'})
    app = FastAPI()
    app.include_router(create_reference_router(project.parent))
    result = TestClient(app).get('/model-api/reference/projects')
    assert result.status_code == 200
    assert [row['project_id'] for row in result.json()['projects']] == [project.name]
    assert result.json()['projects'][0]['label'] == '南北湖晨雾'


def test_reference_video_can_start_an_independent_workspace(project: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr('web_api.reference_adaptation.probe', lambda _: {
        'duration': 2.0, 'width': 720, 'height': 1280, 'has_audio': True, 'has_video': True,
    })
    app = FastAPI()
    app.include_router(create_reference_router(project.parent))
    client = TestClient(app)
    created = client.post('/model-api/reference/standalone', json={'filename': '参考片.mp4'})
    assert created.status_code == 201
    standalone_id = created.json()['project_id']
    assert standalone_id != project.name
    assert read_json(project.parent / standalone_id / 'project.json')['workspace_kind'] == 'reference_standalone'
    uploaded = client.post(
        '/model-api/reference/upload', params={'project_id': standalone_id, 'filename': '参考片.mp4'},
        content=b'video-fixture', headers={'Content-Type': 'video/mp4'},
    )
    assert uploaded.status_code == 200
    assert uploaded.json()['path'].startswith('analysis/reference_imports/')
    assert (project.parent / standalone_id / uploaded.json()['path']).read_bytes() == b'video-fixture'
    assert (project / 'assets' / 'reference.mp4').read_bytes() == b'local-video-fixture'
    context = client.get(f'/model-api/reference/context/{standalone_id}')
    assert context.status_code == 200
    assert context.json()['workspace_kind'] == 'reference_standalone'
    assert context.json()['reference_sources'] == [{'path': uploaded.json()['path'], 'label': '参考片.mp4'}]


def test_blueprint_preserves_source_coverage_and_measured_proportions(project: Path) -> None:
    request = AdaptRequest(project_id=project.name, reference_id='ref-' + 'a' * 24,
                           topic='新故事', script='第一句。第二句。', target_duration=8)
    result = make_blueprint(_recipe(), request)
    assert sum(slot['source_end'] - slot['source_start'] for slot in result['slots']) == pytest.approx(6)
    assert sum(slot['planned_duration'] for slot in result['slots']) == pytest.approx(8)
    assert result['slots'][0]['source_start'] == 0
    assert result['slots'][-1]['source_end'] == 6
    assert all(shot['source_path'] == '' for shot in result['shots'])
    assert result['semantic_analysis'] == 'creator_authored_not_automatic'


def test_blueprint_rejects_gapped_or_missing_source_timeline(project: Path) -> None:
    request = AdaptRequest(project_id=project.name, reference_id='ref-' + 'a' * 24,
                           topic='新故事', script='一句话')
    recipe = _recipe()
    recipe['scenes'][1]['start'] = 1.4
    with pytest.raises(ValueError, match='完整覆盖'):
        make_blueprint(recipe, request)


def test_analyze_rejects_outside_path_and_does_not_schedule(project: Path, tmp_path: Path) -> None:
    outside = tmp_path / 'outside.mp4'
    outside.write_bytes(b'outside')
    manager = ReferenceJobs(project.parent, executor=Deferred())
    with pytest.raises(ValueError):
        manager.submit(AnalyzeRequest(project_id=project.name, source_path='../outside.mp4'))
    assert not (project / 'analysis' / 'reference_runs').exists()


def test_analyze_with_no_frames_is_failed_and_not_completed(project: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr('web_api.reference_adaptation.probe', lambda _: {
        'duration': 1.0, 'width': 64, 'height': 64, 'has_audio': False, 'has_video': True,
    })
    monkeypatch.setattr('tools.analysis.scene_detect.SceneDetect.execute', lambda self, inputs: ToolResult(
        success=True, data={'scenes': [], 'method': 'test'}))
    monkeypatch.setattr('tools.analysis.frame_sampler.FrameSampler.execute', lambda self, inputs: ToolResult(
        success=True, data={'frames': []}))
    executor = Deferred()
    manager = ReferenceJobs(project.parent, executor=executor)
    state = manager.submit(AnalyzeRequest(project_id=project.name, source_path='assets/reference.mp4', max_frames=3))
    executor.run()
    final = manager.get(project.name, state['reference_id'])
    assert final['status'] == 'failed'
    assert not (project / 'analysis' / 'reference_runs' / state['reference_id'] / 'recipe.json').exists()


def test_analysis_write_failure_is_persisted_as_failed(project: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr('web_api.reference_adaptation.probe', lambda _: {
        'duration': 1.0, 'width': 64, 'height': 64, 'has_audio': False, 'has_video': True,
    })
    frame_path = project / 'analysis' / 'placeholder.jpg'

    def detect(self, inputs):
        return ToolResult(success=True, data={'scenes': [], 'method': 'test'})

    def sample(self, inputs):
        output = Path(inputs['output_dir'])
        output.mkdir(parents=True, exist_ok=True)
        frame = output / 'frame.jpg'
        frame.write_bytes(b'frame')
        return ToolResult(success=True, data={'frames': [{'path': str(frame)}]})

    monkeypatch.setattr('tools.analysis.scene_detect.SceneDetect.execute', detect)
    monkeypatch.setattr('tools.analysis.frame_sampler.FrameSampler.execute', sample)
    real_write = __import__('web_api.reference_adaptation', fromlist=['write_json']).write_json

    def fail_recipe(path, data):
        if Path(path).name == 'recipe.json':
            raise OSError('simulated disk failure')
        return real_write(path, data)

    monkeypatch.setattr('web_api.reference_adaptation.write_json', fail_recipe)
    executor = Deferred()
    manager = ReferenceJobs(project.parent, executor=executor)
    state = manager.submit(AnalyzeRequest(project_id=project.name, source_path='assets/reference.mp4', max_frames=3))
    executor.run()
    final = manager.get(project.name, state['reference_id'])
    assert final['status'] == 'failed'
    assert '保存' not in final['message']


def test_adaptation_rejects_cross_project_media_and_deduplicates_without_request_id(project: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    ref_id = 'ref-' + 'a' * 24
    reference_dir = project / 'analysis' / 'reference_runs' / ref_id
    write_json(reference_dir / 'job.json', {'reference_id': ref_id, 'project_id': project.name, 'status': 'completed'})
    write_json(reference_dir / 'recipe.json', _recipe())
    app = FastAPI()
    app.include_router(create_reference_router(project.parent))
    client = TestClient(app)
    payload = {
        'project_id': project.name,
        'reference_id': ref_id,
        'topic': '新项目',
        'script': '新的旁白。',
        'options': {'narration': 'uploaded', 'audio_path': 'assets/old.wav'},
    }
    rejected = client.post('/model-api/reference/adapt', json=payload)
    assert rejected.status_code == 422
    assert not any(p.name.startswith('reference-') for p in project.parent.iterdir())

    payload['options'] = {'narration': 'none'}
    first = client.post('/model-api/reference/adapt', json=payload)
    second = client.post('/model-api/reference/adapt', json=payload)
    assert first.status_code == second.status_code == 200
    assert first.json()['project_id'] == second.json()['project_id']
    new_project = project.parent / first.json()['project_id']
    assert not (new_project / 'assets').exists()
    assert (new_project / 'artifacts' / 'reference_blueprint.json').is_file()


def test_reference_router_enforces_same_origin_and_reference_file_scope(project: Path) -> None:
    app = FastAPI()
    app.include_router(create_reference_router(project.parent))
    client = TestClient(app)
    forbidden = client.post('/model-api/reference/preview', headers={'origin': 'http://evil.example'}, json={})
    assert forbidden.status_code == 403
    assert client.get('/model-api/reference/file/' + project.name,
                      params={'path': '../outside.mp4'}).status_code == 422


def test_footage_reference_timing_comparison_is_written_only_for_reference_project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from web_api.footage_pipeline import FootageJobs

    project = tmp_path / 'reference-project'
    write_json(project / 'artifacts/workflow_state.json', {'prompt': 'test', 'storyboard': {'shots': []}})
    write_json(project / 'artifacts/script.json', {'sections': []})
    write_json(project / 'artifacts/reference_blueprint.json', {
        'reference_id': 'ref-' + 'b' * 24,
        'source_project_id': 'source-project',
        'source': {'duration': 3.0},
        'timing_policy': 'actual_narration_first',
        'slots': [
            {'shot_id': 'one', 'source_scene_id': 'scene-1', 'source_start': 0, 'source_end': 1.5,
             'planned_start': 0, 'planned_duration': 1.0},
            {'shot_id': 'two', 'source_scene_id': 'scene-2', 'source_start': 1.5, 'source_end': 3,
             'planned_start': 1.0, 'planned_duration': 2.0},
        ],
    })
    media = project / 'assets' / 'clip.mp4'
    media.parent.mkdir(parents=True)
    media.write_bytes(b'fixture')
    monkeypatch.setattr('web_api.footage_pipeline.probe', lambda _: {'has_video': True, 'duration': 3.1})
    captured = []

    def renderer(project_dir, output_dir, shots, options, **kwargs):
        output_dir.mkdir(parents=True)
        output = output_dir / 'final.mp4'
        output.write_bytes(b'rendered')
        captured.append(shots)
        return {'status': 'completed', 'output_path': output.relative_to(project_dir).as_posix()}

    executor = Deferred()
    manager = FootageJobs(tmp_path, executor=executor, renderer=renderer)
    state = manager.submit(FootageRequest(
        project_id='reference-project', action='render', material_mode='local',
        shots=[
            {'id': 'one', 'text': '一', 'source_path': 'assets/clip.mp4', 'duration_seconds': 1.1},
            {'id': 'two', 'text': '二', 'source_path': 'assets/clip.mp4', 'duration_seconds': 2.2},
        ], options={'narration': 'none'},
    ))
    executor.run()
    result = manager.get('reference-project', state['job_id'])
    assert result['status'] == 'completed'
    timing_path = result['outputs'][0]['reference_timing_path']
    comparison = json.loads((project / timing_path).read_text('utf-8'))
    assert comparison['planned_duration_seconds'] == pytest.approx(3)
    assert comparison['actual_narration_duration_seconds'] == pytest.approx(3.3)
    assert comparison['shots'][1]['actual_minus_planned_seconds'] == pytest.approx(.2)
