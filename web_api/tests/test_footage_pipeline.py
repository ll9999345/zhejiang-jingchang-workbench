import json
from pathlib import Path
import threading

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from web_api.footage_api import create_footage_router
from web_api.footage_pipeline import FootageJobs, FootageRequest, local_path, plan_footage, read_json, write_json


class Deferred:
    def __init__(self):
        self.calls = []

    def submit(self, fn, *args):
        self.calls.append((fn, args))

    def run(self):
        fn, args = self.calls.pop(0)
        fn(*args)


@pytest.fixture
def project(tmp_path):
    p = tmp_path / 'demo'
    write_json(p / 'artifacts/workflow_state.json', {'prompt': '三清山', 'storyboard': {'shots': [
        {'id': 'shot-1', 'title': '远山', 'duration_seconds': 4},
        {'id': 'shot-2', 'title': '湖水', 'duration_seconds': 3},
    ]}})
    write_json(p / 'artifacts/script.json', {'sections': [{'text': '云雾在山间升起。'}, {'text': '风吹过水面。'}]})
    return p


def test_plan_carries_project_script_without_network(project, monkeypatch):
    def no_network(*args, **kwargs):
        raise AssertionError('a plan must not search')
    monkeypatch.setattr('tools.video.direct_clip_search.DirectClipSearch.execute', no_network)
    before = sorted(str(p) for p in project.rglob('*'))
    result = plan_footage(project.parent, FootageRequest(project_id='demo'))
    assert result['shots'][0]['text'] == '云雾在山间升起。'
    assert result['shots'][0]['queries'][0]['text'] == '三清山'
    assert result['shots'][0]['queries'][-1]['kind'] == 'generic'
    assert result['network_used'] is False
    assert sorted(str(p) for p in project.rglob('*')) == before


def test_edited_script_resegments_and_no_fake_ai_text(project):
    result = plan_footage(project.parent, FootageRequest(project_id='demo', script='这是一段新的解说。\n这是第二段。'))
    assert [s['text'] for s in result['shots']] == ['这是一段新的解说。', '这是第二段。']


def test_local_music_failure_keeps_narration_and_does_not_render(project, monkeypatch):
    source=project/'assets/footage/imports/scene.mp4'
    source.parent.mkdir(parents=True);source.write_bytes(b'fixture')
    executor=Deferred()
    def forbidden(*args, **kwargs):
        pytest.fail('failed music must not submit render or network work')
    manager=FootageJobs(project.parent, executor=executor, renderer=forbidden, search=forbidden)
    def narration(p, directory, shots, request, event):
        output=directory/'narration.wav';output.write_bytes(b'preserved narration');return output
    monkeypatch.setattr(manager,'_narrate',narration)
    monkeypatch.setattr('web_api.local_music_pipeline.render_local_music',lambda *a,**k:{'status':'provider_error'})
    request=FootageRequest(project_id='demo',action='render',material_mode='local',
        shots=[{'id':'one','source_path':source.relative_to(project).as_posix(),'text':'本机配乐测试','duration_seconds':3}],
        options={'bgm_mode':'local','bgm_style':'documentary'})
    queued=manager.submit(request);executor.run()
    result=manager.get('demo',queued['job_id'])
    assert result['status']=='failed' and result['outputs']==[]
    assert '本机配乐未完成' in result['message']
    assert (manager.directory('demo',queued['job_id'])/'narration.wav').read_bytes()==b'preserved narration'


@pytest.mark.parametrize('stage', ['script', 'terms'])
def test_text_stages_export_without_search_narration_or_renderer(project, monkeypatch, stage):
    original = (project / 'artifacts/script.json').read_bytes()
    executor = Deferred()
    def forbidden(*args, **kwargs):
        pytest.fail('text-only stages must not use media production or network')
    manager = FootageJobs(project.parent, executor=executor, search=forbidden, renderer=forbidden)
    monkeypatch.setattr(manager, '_narrate', forbidden)
    request = FootageRequest(project_id='demo', action='create', stop_at=stage,
                             script='三清山的峰林与云海。', sources=['unconfigured-source'],
                             options={'narration': 'edge'}, confirm_network=False)
    plan = manager.validate_request(request)
    assert plan['network_required'] is False
    state = manager.submit(request)
    executor.run()
    completed = manager.get('demo', state['job_id'])
    assert completed['status'] == 'stage_completed'
    assert completed['stage'] == stage
    result = completed['outputs'][0]
    assert local_path(project, result['script_path']).read_text('utf-8') == request.script
    assert result['script_source'] == 'project_or_user'
    assert result['network_used'] is False
    assert 'audio_path' not in result and 'output_path' not in result
    if stage == 'terms':
        terms = read_json(local_path(project, result['terms_path']))
        assert terms['keyword_source'] == 'local_query_planner'
        assert terms['terms'] and terms['shots'][0]['shot_id'] == 'shot-1'
        assert any(q['text'] == '三清山' for q in terms['shots'][0]['queries'])
        assert result['terms_count'] == len(terms['terms'])
    app = FastAPI()
    app.include_router(create_footage_router(project.parent, jobs=manager))
    client = TestClient(app)
    for key in ('script_path', 'terms_path'):
        if key in result:
            response = client.get('/model-api/footage/assets/demo', params={'path': result[key], 'download': 'true'})
            assert response.status_code == 200 and response.content == local_path(project, result[key]).read_bytes()
    assert (project / 'artifacts/script.json').read_bytes() == original


def test_replanning_and_manual_selection_keep_existing_stock_provenance(project):
    source=project/'assets/stock/sanqing.ogv'
    source.parent.mkdir(parents=True);source.write_bytes(b'existing media')
    record={'path':'assets/stock/sanqing.ogv','source':'wikimedia','source_url':'https://commons.wikimedia.org/wiki/File:Sanqing_Shan.ogv',
            'license':'CC BY-SA 3.0','creator':'Original author','query':'Mount Sanqing','shot_ids':['older-shot']}
    write_json(project/'artifacts/stock_search_manifest.json',{'clips':[record]})
    plan=plan_footage(project.parent,FootageRequest(project_id='demo',script='三清山的峰林。'))
    assert plan['shots'][0]['candidates'][0]['creator']=='Original author'
    manual=plan_footage(project.parent,FootageRequest(project_id='demo',shots=[{'id':'new-shot','text':'另一段说明','query':'different query','source_path':record['path']}]))
    assert manual['shots'][0]['selected_source']['license']=='CC BY-SA 3.0'
    assert manual['shots'][0]['selected_source']['source_url']==record['source_url']


def test_paths_symlinks_and_duplicate_ids_rejected(project, tmp_path):
    other = tmp_path / 'private.wav'
    other.write_bytes(b'private')
    (project / 'escape.wav').symlink_to(other)
    for name in ('../private.wav', str(other), 'escape.wav'):
        with pytest.raises(ValueError):
            local_path(project, name)
    with pytest.raises(ValueError):
        FootageRequest(project_id='demo', shots=[{'id': 'one'}, {'id': 'one'}])


def test_job_submit_deduplicates_refresh_and_restart_never_retries(project):
    executor = Deferred()
    manager = FootageJobs(project.parent, executor=executor)
    request = FootageRequest(project_id='demo', action='collect', confirm_network=True, request_id='same-click')
    first = manager.submit(request)
    second = manager.submit(request)
    assert first['job_id'] == second['job_id']
    assert len(executor.calls) == 1
    other_process = FootageJobs(project.parent, executor=Deferred())
    assert other_process.get('demo', first['job_id'])['status'] == 'interrupted'
    assert len(executor.calls) == 1


def test_missing_footage_is_not_a_completed_film(project):
    executor = Deferred()
    manager = FootageJobs(project.parent, executor=executor, search=lambda _: {'clips': []})
    result = manager.submit(FootageRequest(project_id='demo', action='create', confirm_network=True))
    executor.run()
    state = manager.get('demo', result['job_id'])
    assert state['status'] == 'needs_materials'
    assert state['outputs'] == []
    assert state['missing_shots'] == ['shot-1', 'shot-2']


def test_cancel_queued_job_preserves_old_project_files(project):
    original = project / 'renders/accepted.mp4'
    original.parent.mkdir()
    original.write_bytes(b'old-accepted-video')
    executor = Deferred()
    manager = FootageJobs(project.parent, executor=executor)
    state = manager.submit(FootageRequest(project_id='demo', action='create', confirm_network=True))
    manager.cancel('demo', state['job_id'])
    executor.run()
    assert manager.get('demo', state['job_id'])['status'] == 'cancelled'
    assert original.read_bytes() == b'old-accepted-video'


def test_network_confirmation_and_unknown_settings_rejected(project):
    manager = FootageJobs(project.parent, executor=Deferred())
    with pytest.raises(ValueError, match='联网'):
        manager.submit(FootageRequest(project_id='demo', action='create'))
    with pytest.raises(ValueError):
        FootageRequest(project_id='demo', options={'api_key': 'never-accept'})


def test_api_project_isolation_assets_settings_and_upload_validation(project):
    executor = Deferred()
    app = FastAPI()
    app.include_router(create_footage_router(project.parent, jobs=FootageJobs(project.parent, executor=executor)))
    client = TestClient(app)
    assert client.get('/model-api/footage/context/demo').status_code == 200
    assert client.get('/model-api/footage/assets/demo', params={'path': '../private.wav'}).status_code == 422
    assert client.get('/model-api/footage/assets/demo', params={'path': 'artifacts/script.json'}).status_code == 404
    assert client.post('/model-api/footage/settings/demo', json={'token': 'reject'}).status_code == 422
    assert client.post('/model-api/footage/upload?project_id=demo&filename=bad.mp4', content=b'not-video').status_code == 422
    assert client.post('/model-api/footage/upload?project_id=demo&filename=secret.env', content=b'bad').status_code == 422
    good = client.post('/model-api/footage/upload?project_id=demo&filename=subtitle.srt', content='1\n00:00:00,000 --> 00:00:01,000\n山水\n'.encode())
    assert good.status_code == 200
    assert good.json()['kind'] == 'subtitle'
    assert local_path(project, good.json()['path']).is_file()


def test_render_local_job_creates_versions_and_uses_actual_renderer_contract(project, monkeypatch):
    monkeypatch.setattr('web_api.footage_pipeline.probe', lambda _: {'has_video': True, 'duration': 6})
    media = project / 'assets/source.mp4'
    media.parent.mkdir(exist_ok=True)
    media.write_bytes(b'fixture')
    captured = []
    def renderer(project_dir, job_dir, shots, options, **kwargs):
        job_dir.mkdir(parents=True)
        out = job_dir / 'film.mp4'
        out.write_bytes(b'rendered')
        captured.append((shots, options))
        return {'status': 'completed', 'output_path': out.relative_to(project_dir).as_posix()}
    executor = Deferred()
    manager = FootageJobs(project.parent, executor=executor, renderer=renderer)
    request = FootageRequest(project_id='demo', action='render', material_mode='local',
                             shots=[{'id': 'one', 'source_path': 'assets/source.mp4', 'text': '山水'}],
                             options={'narration': 'none', 'variants': 2})
    state = manager.submit(request)
    executor.run()
    result = manager.get('demo', state['job_id'])
    assert result['status'] == 'completed'
    assert len(result['outputs']) == 2
    assert len({o['output_path'] for o in result['outputs']}) == 2
    assert captured[0][0][0]['text'] == '山水'
    assert all(local_path(project, o['provenance_path']).is_file() for o in result['outputs'])
