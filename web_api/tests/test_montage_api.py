from fastapi import FastAPI
from fastapi.testclient import TestClient

import web_api.montage_api as api
import web_api.montage_composition as composition


def client(root):
    app = FastAPI()
    app.include_router(api.create_montage_router(root))
    return TestClient(app)


def payload(**extra):
    return dict(project_id='demo', scenes=[{'type': 'text_card', 'props': {'text': '浙江'}}], **extra)


def test_web_preflight_and_unconfirmed_execution_leave_files_untouched(tmp_path, monkeypatch):
    (tmp_path / 'demo/assets').mkdir(parents=True)
    monkeypatch.setattr(composition, 'composition_runtime', lambda: {'status': 'available', 'reasons': []})
    browser = client(tmp_path)
    before = list(tmp_path.rglob('*'))
    check = browser.post('/model-api/montage/composition/preflight', json=payload())
    assert check.status_code == 200 and check.json()['can_execute']
    execute = browser.post('/model-api/montage/composition/execute', json=payload(dry_run=False, execute=True))
    assert execute.status_code == 200 and execute.json()['status'] == 'confirmation_required'
    assert list(tmp_path.rglob('*')) == before


def test_foreign_site_cannot_trigger_local_renderer(tmp_path, monkeypatch):
    def forbidden(*_a, **_kw):
        raise AssertionError('renderer must not be called')
    monkeypatch.setattr(api, 'execute_composition', forbidden)
    browser = client(tmp_path)
    response = browser.post('/model-api/montage/composition/execute', json=payload(), headers={'origin': 'https://foreign.example'})
    assert response.status_code == 403
    response = browser.post('/model-api/montage/clips/execute', json={}, headers={'sec-fetch-site': 'cross-site'})
    assert response.status_code == 403
    assert not list(tmp_path.iterdir())


def test_routes_reject_unrestricted_code_paths_and_unknown_fields(tmp_path):
    browser = client(tmp_path)
    for extra in ({'scene_code': 'external code'}, {'output_name': '../outside.mp4'}, {'fps': 25}):
        response = browser.post('/model-api/montage/composition/preflight', json=payload(**extra))
        assert response.status_code == 422
    response = browser.post('/model-api/montage/clips/preflight', json={
        'project_id': 'demo', 'input_path': '/private/tmp/private.mp4',
        'segments': [{'start_seconds': 0, 'end_seconds': 1}],
    })
    assert response.status_code == 422
    assert not list(tmp_path.iterdir())


def test_director_request_lookup_is_readonly_and_repeated_http_start_dispatches_once(tmp_path, monkeypatch):
    import web_api.montage_director as director_module
    (tmp_path / 'demo').mkdir()
    dispatches = []
    monkeypatch.setattr(director_module, 'preflight_director', lambda *_: {'can_execute': True, 'status': 'ready'})
    def dispatch(service, req, project, run, row):
        service.owned.add((req.project_id, row['session_id']))
        dispatches.append(row['session_id'])
    monkeypatch.setattr(api.MontageDirector, '_dispatch', dispatch)
    token = 'http-request-0123456789'
    body = dict(project_id='demo', pipeline='documentary-montage', brief='本地协议测试',
                provider='ollama', model='test', client_request_id=token, confirm=True)
    with client(tmp_path) as browser:
        lookup = f'/model-api/montage/director/requests/{token}?project_id=demo'
        before = list(tmp_path.rglob('*'))
        assert browser.get(lookup).json()['request_status'] == 'not_found'
        assert list(tmp_path.rglob('*')) == before
        assert browser.post('/model-api/montage/director/start', json=body,
                            headers={'origin': 'https://foreign.example'}).status_code == 403
        first = browser.post('/model-api/montage/director/start', json=body)
        second = browser.post('/model-api/montage/director/start', json=body)
        found = browser.get(lookup)
        assert first.status_code == second.status_code == found.status_code == 200
        assert first.json()['session_id'] == second.json()['session_id'] == found.json()['session_id']
        assert second.json()['deduplicated'] and found.json()['request_status'] == 'accepted'
        assert len(dispatches) == 1
        assert 'request' not in found.json() and 'messages' not in found.json()
        assert browser.get('/model-api/montage/director/requests/short?project_id=demo').status_code == 422
        assert browser.get(lookup.replace('project_id=demo', 'project_id=missing')).status_code == 422
