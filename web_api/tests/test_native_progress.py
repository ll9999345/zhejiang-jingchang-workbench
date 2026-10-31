import io
import json
import os
from pathlib import Path
import subprocess
import sys
import time

import pytest

from lib.tool_progress import report_tool_progress, tool_progress_context
from web_api.native_progress import FILENAME, MAX_BYTES, MAX_EVENTS, ProgressWriter, read_progress


def test_observers_are_nested_isolated_and_cannot_fail_tools():
    from concurrent.futures import ThreadPoolExecutor
    a, b = [], []
    def worker(events):
        with tool_progress_context(events.append):
            report_tool_progress('tool_started')
            with tool_progress_context(lambda _: 1 / 0): report_tool_progress('ignored')
            report_tool_progress('tool_completed')
    with ThreadPoolExecutor(2) as pool:
        list(pool.map(worker, [a, b]))
    assert a == b == [{'phase': 'tool_started'}, {'phase': 'tool_completed'}]


def test_progress_is_bounded_filtered_and_reserves_terminal(tmp_path):
    writer = ProgressWriter(tmp_path, 'corpus_builder')
    for i in range(MAX_EVENTS + 20):
        writer({'phase': 'clip_indexed', 'indexed': i, 'query': 'private', 'source': 'secret-key',
                'Authorization': 'secret-key', 'frames': True})
    writer({'phase': 'tool_completed'})
    writer.close()
    raw = (tmp_path / FILENAME).read_text()
    assert len(raw.encode()) <= MAX_BYTES
    assert len(raw.splitlines()) == MAX_EVENTS
    assert 'private' not in raw and 'secret-key' not in raw and 'Authorization' not in raw
    result = read_progress(tmp_path, 'corpus_builder', os.getpid())
    assert result['phase'] == 'tool_completed' and result['indexed'] == MAX_EVENTS + 19
    assert 'frames' not in result


def test_existing_or_linked_progress_never_overwritten(tmp_path):
    secret = tmp_path / 'original'; secret.write_text('accepted')
    (tmp_path / FILENAME).symlink_to(secret)
    writer = ProgressWriter(tmp_path, 'tool'); writer({'phase':'tool_started'}); writer.close()
    assert secret.read_text() == 'accepted'
    assert read_progress(tmp_path, 'tool', os.getpid()) is None
    other = tmp_path / 'other'; other.mkdir()
    (other / FILENAME).write_text('previous attempt')
    writer = ProgressWriter(other, 'tool'); writer({'phase':'tool_started'}); writer.close()
    assert (other / FILENAME).read_text() == 'previous attempt'


@pytest.mark.parametrize('mutation', ['pid', 'tool', 'job_id', 'seq', 'elapsed_seconds', 'phase', 'oversize', 'list', 'fifo'])
def test_untrusted_progress_is_ignored(tmp_path, mutation):
    writer = ProgressWriter(tmp_path, 'corpus_builder'); writer({'phase':'tool_started'}); writer.close()
    path = tmp_path / FILENAME
    if mutation == 'oversize': path.write_bytes(b' ' * (MAX_BYTES + 1))
    elif mutation == 'list': path.write_text('[]\n')
    elif mutation == 'fifo':
        # A new alternate run tests FIFO without removing prior evidence.
        alternate = tmp_path / 'fifo-run'; alternate.mkdir()
        os.mkfifo(alternate / FILENAME); tmp_path = alternate
    else:
        row = json.loads(path.read_text())
        row[mutation] = {'pid':True, 'tool':'other', 'job_id':'old', 'seq':2,
                         'elapsed_seconds':float('nan'), 'phase':[]}[mutation]
        path.write_text(json.dumps(row) + '\n')
    assert read_progress(tmp_path, 'corpus_builder', os.getpid()) is None


def test_incomplete_append_is_not_a_failure_and_counters_persist(tmp_path):
    writer = ProgressWriter(tmp_path, 'corpus_builder')
    writer({'phase':'query_started', 'query_index':1,'queries_total':2})
    writer({'phase':'embedding_images'}); writer.close()
    with (tmp_path / FILENAME).open('ab') as stream: stream.write(b'{"part')
    row = read_progress(tmp_path, 'corpus_builder', os.getpid())
    assert row['phase'] == 'embedding_images' and row['query_index'] == 1 and row['queries_total'] == 2


def test_worker_single_json_receipt_and_stock_events_without_stdout_leak(tmp_path, monkeypatch):
    import web_api.montage_worker as module
    from tools.video.direct_clip_search import _report_progress
    run = tmp_path / 'run'; run.mkdir()
    def execute(*_):
        print('SECRET TOOL PRINT')
        _report_progress('query_started', query='PRIVATE',query_index=1,queries_total=2)
        report_tool_progress('embedding_images')
        return {'status':'completed','native_result':{'success':True}}
    monkeypatch.setattr(module, 'execute_native', execute)
    monkeypatch.setattr(sys, 'stdin', io.StringIO(json.dumps({'request':{'project_id':'demo','tool':'audio_probe'},
        'project':str(tmp_path),'run':str(run)})))
    output = io.StringIO(); monkeypatch.setattr(sys, 'stdout', output)
    module.main()
    assert json.loads(output.getvalue())['status'] == 'completed'
    raw = (run / FILENAME).read_text()
    assert 'SECRET' not in raw + output.getvalue() and 'PRIVATE' not in raw
    events = [json.loads(line) for line in raw.splitlines()]
    assert [e['phase'] for e in events] == ['tool_started','query_started','embedding_images','tool_completed']


def test_live_api_reads_child_events_without_rewriting_job_and_retains_final(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    import web_api.montage_jobs as module
    from web_api.montage_api import create_montage_router
    (tmp_path / 'demo').mkdir()
    original = module.subprocess.Popen
    # A real controlled child: protocol test, not real corpus inference.
    code = '''import json,sys,time
from pathlib import Path
from web_api.native_progress import ProgressWriter
p=json.load(sys.stdin); w=ProgressWriter(Path(p['run']),p['request']['tool'])
w({'phase':'tool_started'});w({'phase':'embedding_images','indexed':1})
time.sleep(1.5);w({'phase':'tool_completed'});w.close()
print(json.dumps({'status':'completed','native_result':{'success':True,'artifacts':[]}}))
'''
    monkeypatch.setattr(module.subprocess,'Popen',lambda _command,**kwargs:original([sys.executable,'-c',code],**kwargs))
    app = FastAPI(); app.include_router(create_montage_router(tmp_path))
    with TestClient(app) as client:
        row = client.post('/model-api/montage/tools/execute',json={'project_id':'demo', 'tool':'character_spec_generator',
            'inputs':{'brief':'local test'},'confirm':True}).json()
        path = tmp_path/'demo/analysis/montage/tools'/row['job_id']/'job.json'
        deadline = time.monotonic()+10
        observed = []
        while time.monotonic()<deadline:
            row = client.get('/model-api/montage/jobs?project_id=demo').json()['jobs'][0]
            if row.get('progress',{}).get('phase') == 'embedding_images':
                before = path.read_bytes()
                assert row['status']=='running'
                assert client.get('/model-api/montage/jobs?project_id=demo').json()['jobs'][0]['progress']['indexed']==1
                assert path.read_bytes()==before
                observed.append('live')
            if row['status'] not in {'queued','running','cancelling'}: break
            time.sleep(.03)
        assert observed and row['status']=='completed' and row['progress']['phase']=='tool_completed'
        assert json.loads(path.read_text())['progress']['indexed']==1
    restarted = module.MontageJobs(tmp_path)
    try:
        assert restarted.get('demo',row['job_id'])['progress']['phase']=='tool_completed'
    finally: restarted.shutdown()
