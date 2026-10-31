"""A lost HTTP receipt must not duplicate model work or its budget."""
from concurrent.futures import ThreadPoolExecutor
import json
import threading

import pytest

import web_api.montage_director as module
from web_api.montage_director import DirectorRequest, MontageDirector, preflight_director
from web_api.montage_jobs import MontageJobs, save_json

REQUEST_ID = 'request-test-0123456789'


def request(**overrides):
    return DirectorRequest(**{'project_id': 'demo', 'pipeline': 'documentary-montage',
        'brief': '制作真实素材纪录片', 'provider': 'ollama', 'model': 'test',
        'confirm': True, 'client_request_id': REQUEST_ID, **overrides})


@pytest.fixture
def service(tmp_path, monkeypatch):
    project = tmp_path / 'demo'
    project.mkdir()
    jobs = MontageJobs(tmp_path)
    director = MontageDirector(tmp_path, jobs)
    calls = []
    def dispatch(req, project, run, row):
        calls.append(row['session_id'])
        director.owned.add((req.project_id, row['session_id']))
    monkeypatch.setattr(director, '_dispatch', dispatch)
    monkeypatch.setattr(module, 'preflight_director', lambda *_: {'can_execute': True, 'status': 'ready'})
    yield director, project, calls
    director.shutdown()
    jobs.shutdown()


def test_same_submission_returns_original_before_any_repeat_probe(service, monkeypatch):
    director, project, calls = service
    first = director.start(request())
    monkeypatch.setattr(module, 'preflight_director', lambda *_: pytest.fail('no repeat preflight'))
    second = director.start(request())
    assert first['session_id'] == second['session_id']
    assert second['deduplicated'] and second['request_status'] == 'accepted'
    assert calls == [first['session_id']]
    assert len(list((project / 'analysis/montage/director').iterdir())) == 1
    assert 'request' not in second and 'messages' not in second


def test_concurrent_repeated_posts_dispatch_once(service, monkeypatch):
    director, project, calls = service
    barrier = threading.Barrier(2)
    def preflight(*_):
        barrier.wait(timeout=5)
        return {'can_execute': True, 'status': 'ready'}
    monkeypatch.setattr(module, 'preflight_director', preflight)
    with ThreadPoolExecutor(max_workers=2) as pool:
        rows = list(pool.map(lambda _: director.start(request()), range(2)))
    assert rows[0]['session_id'] == rows[1]['session_id']
    assert len(calls) == 1
    assert len(list((project / 'analysis/montage/director').iterdir())) == 1


@pytest.mark.parametrize('change', [dict(brief='不同的需求'), dict(max_cost_usd=2),
                                  dict(provider='deepseek'), dict(allow_network=True)])
def test_same_token_cannot_hide_changed_parameters(service, change):
    director, _, calls = service
    director.start(request())
    with pytest.raises(ValueError, match='参数已变化'):
        director.start(request(**change))
    assert len(calls) == 1


@pytest.mark.parametrize('status', ['completed', 'failed', 'budget_exhausted', 'cancelled'])
def test_retry_of_terminal_task_is_read_only_not_paid_restart(service, status):
    director, project, calls = service
    first = director.start(request())
    _, run = director.locate('demo', first['session_id'])
    row = director.state('demo', first['session_id'], internal=True)
    row.update(status=status, spent_or_reserved_usd=.4)
    save_json(run / 'session.json', row)
    director.owned.clear()
    receipt_bytes = (run / 'session.json').read_bytes()
    second = director.start(request())
    assert second['status'] == status and second['spent_or_reserved_usd'] == .4
    assert (run / 'session.json').read_bytes() == receipt_bytes
    assert len(calls) == 1


def test_restart_recovers_receipt_without_dispatch_or_changing_original(service, monkeypatch):
    director, project, calls = service
    first = director.start(request())
    before = {p: p.read_bytes() for p in project.rglob('*') if p.is_file()}
    restarted = MontageDirector(project.parent, director.tools)
    monkeypatch.setattr(restarted, '_dispatch', lambda *_: pytest.fail('must not redispatch'))
    try:
        recovered = restarted.start(request())
        assert recovered['status'] == 'interrupted'
        assert recovered['session_id'] == first['session_id'] and recovered['deduplicated']
        assert before == {p: p.read_bytes() for p in project.rglob('*') if p.is_file()}
    finally:
        restarted.shutdown()


def test_unknown_submission_does_not_invent_receipt_or_write_files(service):
    director, project, calls = service
    before = list(project.rglob('*'))
    row = director.submission('demo', REQUEST_ID)
    assert row['request_status'] == 'not_found' and 'session_id' not in row
    assert list(project.rglob('*')) == before and not calls


def test_partial_initialization_reserves_token_and_blocks_duplicate(service, monkeypatch):
    director, project, calls = service
    def fail_init(*_, **__):
        raise ValueError('local init interrupted')
    monkeypatch.setattr(module, 'init_project', fail_init)
    with pytest.raises(ValueError, match='init interrupted'):
        director.start(request())
    before = {p: p.read_bytes() for p in project.rglob('*') if p.is_file()}
    check = director.submission('demo', REQUEST_ID)
    retry = director.start(request())
    assert check['request_status'] == retry['request_status'] == 'pending'
    assert retry['status'] == 'submission_unknown' and 'session_id' not in retry
    assert before == {p: p.read_bytes() for p in project.rglob('*') if p.is_file()}
    assert not calls


def test_corrupt_reservation_is_never_discarded_to_repeat_work(service):
    director, project, calls = service
    path = director._request_path('demo', REQUEST_ID)
    path.parent.mkdir(parents=True)
    path.write_text('{incomplete')
    with pytest.raises(ValueError, match='不可核验'):
        director.start(request())
    assert path.read_text() == '{incomplete' and not calls


def test_reservation_is_scoped_to_project(service):
    director, project, calls = service
    first = director.start(request())
    (project.parent / 'other').mkdir()
    second = director.start(request(project_id='other'))
    assert first['session_id'] != second['session_id'] and len(calls) == 2


def test_unconfirmed_or_unready_starts_reserve_nothing(service, monkeypatch):
    director, project, calls = service
    assert director.start(request(confirm=False))['status'] == 'confirmation_required'
    monkeypatch.setattr(module, 'preflight_director', lambda *_: {'can_execute': False, 'status': 'needs_setup'})
    assert director.start(request())['status'] == 'needs_setup'
    assert not list(project.rglob('*')) and not calls


def test_readiness_reports_each_missing_condition_without_model_or_tool_probe(service, monkeypatch):
    director, project, calls = service
    monkeypatch.setattr(module, 'connection', lambda _: {'ready': False, 'local': False, 'error': '认证未配置'})
    monkeypatch.setattr(module, 'tool_catalog', lambda: pytest.fail('skip optional probes'))
    monkeypatch.setattr(module, 'request_model', lambda *_: pytest.fail('no model call'))
    check = preflight_director(request(model='', provider='deepseek', confirm=False), project.parent)
    assert [row['id'] for row in check['checks']] == ['model', 'permissions', 'tools']
    assert [row['status'] for row in check['checks']] == ['needs_setup', 'needs_setup', 'not_checked']
    assert len(check['requirements']) == 5 and not check['can_execute']
    assert not list(project.rglob('*')) and not calls


def test_symlinked_receipt_does_not_read_external_file(service, tmp_path):
    director, project, calls = service
    outside = tmp_path / 'outside.json'
    outside.write_text(json.dumps({'session_id': '20261002T000000-aaaaaaaaaaaa', 'fingerprint': 'a' * 64}))
    path = director._request_path('demo', REQUEST_ID)
    path.parent.mkdir(parents=True)
    path.symlink_to(outside)
    with pytest.raises(ValueError):
        director.submission('demo', REQUEST_ID)
    assert not calls


@pytest.mark.parametrize('token', ['../private', 'short', 'a' * 65])
def test_submission_identifiers_are_closed_and_path_safe(service, token):
    director, _, calls = service
    with pytest.raises(ValueError):
        director.submission('demo', token)
    with pytest.raises(ValueError):
        request(client_request_id=token)
    assert not calls
