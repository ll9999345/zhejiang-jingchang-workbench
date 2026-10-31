import json

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from web_api.footage_api import create_footage_router
from web_api.footage_batches import BatchRequest, FootageBatches
from web_api.footage_pipeline import FootageJobs, FootageRequest, write_json


class Deferred:
    def __init__(self):
        self.calls = []

    def submit(self, fn, *args):
        self.calls.append((fn, args))

    def run(self):
        fn, args = self.calls.pop(0)
        fn(*args)


class Immediate:
    def submit(self, fn, *args):
        fn(*args)


@pytest.fixture
def root(tmp_path):
    for name in ('one', 'two'):
        write_json(tmp_path / name / 'artifacts/script.json', {'sections': [{'text': '保存原稿。'}]})
    return tmp_path


def row(project='one', **kw):
    return dict(project_id=project, script='湖面荡起微光。', material_mode='local',
                action='create', stop_at='subtitle', options={'narration': 'none'}, **kw)


def test_partial_subtitles_do_not_search_or_render_and_report_timing(root):
    def never(*a, **kw):
        raise AssertionError('subtitle-only must not search or render')
    jobs = FootageJobs(root, executor=Immediate(), search=never, renderer=never)
    receipt = jobs.submit(FootageRequest(**row()))
    final = jobs.get('one', receipt['job_id'])
    assert final['status'] == 'stage_completed'
    assert final['stage'] == 'subtitle'
    output = final['outputs'][0]
    assert output['timing_source'] == 'planned_shot_durations'
    assert '-->' in (root / 'one' / output['subtitle_path']).read_text()
    assert 'output_path' not in output
    assert json.loads((root / 'one/artifacts/script.json').read_text())['sections'][0]['text'] == '保存原稿。'


def test_audio_requires_real_narration_mode_and_five_variants_supported(root):
    jobs = FootageJobs(root, executor=Deferred())
    with pytest.raises(ValueError, match='请选择音色'):
        jobs.validate_request(FootageRequest(**dict(row(), stop_at='audio')))
    assert FootageRequest(**dict(row(), options={'variants': 5})).options.variants == 5
    with pytest.raises(ValueError):
        FootageRequest(**dict(row(), options={'variants': 6}))


def test_batch_preflight_is_readonly_and_rejects_entire_invalid_list(root):
    jobs = FootageJobs(root, executor=Deferred())
    batches = FootageBatches(jobs, executor=Deferred())
    before = sorted(str(p) for p in root.rglob('*'))
    body = BatchRequest(requests=[row(), dict(row('two'), options={'api_key': 'do-not-echo'})], confirm=True)
    check = batches.preflight(body)
    assert not check['ready'] and check['items'][0]['ready']
    assert 'do-not-echo' not in json.dumps(check)
    with pytest.raises(ValueError, match='没有提交'):
        batches.submit(body)
    assert sorted(str(p) for p in root.rglob('*')) == before
    assert not jobs.executor.calls


def test_batch_sequential_cross_project_receipts_and_deduplication(root):
    jobs = FootageJobs(root, executor=Immediate())
    executor = Deferred()
    batches = FootageBatches(jobs, executor=executor)
    body = BatchRequest(requests=[row(), row('two')], confirm=True, request_id='same-click')
    first = batches.submit(body)
    assert batches.submit(body)['batch_id'] == first['batch_id']
    assert len(executor.calls) == 1
    executor.run()
    final = batches.get('one', first['batch_id'])
    assert final['status'] == 'completed' and final['progress'] == 100
    assert [r['project_id'] for r in final['items']] == ['one', 'two']
    assert all(r['status'] == 'stage_completed' for r in final['items'])
    assert len({r['job_id'] for r in final['items']}) == 2
    assert batches.list('two') == []  # cross-project batch belongs to first row
    assert batches.submit(body)['batch_id'] == first['batch_id']  # no repeat after completion


def test_cancel_queued_batch_submits_nothing_and_restart_never_resumes(root):
    jobs = FootageJobs(root, executor=Immediate())
    executor = Deferred()
    batches = FootageBatches(jobs, executor=executor)
    first = batches.submit(BatchRequest(requests=[row(), row('two')], confirm=True))
    batches.cancel('one', first['batch_id'])
    executor.run()
    final = batches.get('one', first['batch_id'])
    assert final['status'] == 'cancelled'
    assert all('job_id' not in r for r in final['items'])
    pending = batches.submit(BatchRequest(requests=[row()], confirm=True))
    restarted = FootageBatches(jobs, executor=Deferred())
    assert restarted.get('one', pending['batch_id'])['status'] == 'interrupted'
    assert not restarted.executor.calls


def test_network_consent_is_per_row_not_a_batch_override(root):
    batches = FootageBatches(FootageJobs(root, executor=Deferred()), executor=Deferred())
    body = BatchRequest(requests=[dict(row(), stop_at='video', material_mode='stock')], confirm=True)
    assert not batches.preflight(body)['ready']


def test_batch_endpoint_rejects_cross_origin_and_invalid_batch_id(root):
    app = FastAPI()
    app.include_router(create_footage_router(root, jobs=FootageJobs(root, executor=Deferred())))
    client = TestClient(app)
    body = {'requests': [row()]}
    assert client.post('/model-api/footage/batches/preflight', json=body).json()['ready']
    assert client.post('/model-api/footage/batches/preflight', json=body, headers={'origin': 'https://other.example'}).status_code == 403
    assert client.get('/model-api/footage/batches/invalid?project_id=one').status_code == 422
    assert client.post('/model-api/footage/batches', json=body).status_code == 422
