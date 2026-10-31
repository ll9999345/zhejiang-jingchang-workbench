import hashlib
import json
import sys
import time
import wave
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from tools.base_tool import BaseTool, ToolResult, ToolStatus
from web_api.montage_api import create_montage_router
from web_api.montage_jobs import MontageJobs, new_run, save_json
from web_api.montage_registry import NativeToolRequest, path_inputs, preflight_tool, tool_catalog
from web_api.montage_worker import execute_native


@pytest.fixture
def project(tmp_path):
    directory = tmp_path / 'demo'
    directory.mkdir()
    return directory


def test_catalog_is_the_actual_complete_registry():
    from tools.tool_registry import registry
    result = tool_catalog()
    assert {t['name'] for t in result['tools']} == set(registry.list_all())
    assert result['tool_count'] >= 126
    assert all(t['input_schema']['type'] == 'object' for t in result['tools'])
    manim = next(t for t in result['tools'] if t['name'] == 'math_animate')
    assert 'allow_unsafe_code' not in manim['input_schema']['properties']


@pytest.mark.parametrize('value', ['../outside.mp4', '/etc/passwd', '.credentials.json'])
def test_paths_cannot_escape_or_read_hidden_files(project, value):
    with pytest.raises(ValueError):
        path_inputs(project, {'input_path': value}, project / 'output')


def test_symlink_escape_rejected_and_output_names_never_overwrite(project, tmp_path):
    outside = tmp_path / 'secret.mp4'
    outside.write_bytes(b'original')
    (project / 'linked.mp4').symlink_to(outside)
    with pytest.raises(ValueError): path_inputs(project, {'input_path': 'linked.mp4'}, project / 'new')
    existing = project / 'final.mp4'
    existing.write_bytes(b'accepted')
    mapped = path_inputs(project, {'output_path': 'final.mp4'}, project / 'new')
    assert mapped['output_path'] == str(project / 'new/output_path/final.mp4')
    assert existing.read_bytes() == b'accepted'
    assert path_inputs(project, {'cuts': [{'source': 'asset-1'}]}, project / 'new')['cuts'][0]['source'] == 'asset-1'


def test_preflight_and_unconfirmed_execute_write_nothing(project):
    request = NativeToolRequest(project_id='demo', tool='character_spec_generator', inputs={'brief': '文旅角色'})
    before = list(project.rglob('*'))
    assert preflight_tool(request, project.parent)['can_execute']
    jobs = MontageJobs(project.parent)
    try:
        assert jobs.submit(request)['status'] == 'confirmation_required'
        assert list(project.rglob('*')) == before
    finally: jobs.shutdown()


def test_native_code_capture_network_cannot_be_silently_authorized(project):
    app = FastAPI(); app.include_router(create_montage_router(project.parent))
    with TestClient(app) as client:
        for tool, inputs in [('math_animate', {'scene_code': 'class Scene: pass', 'allow_unsafe_code': True}),
                             ('video_downloader', {'url': 'http://127.0.0.1:9999/internal'})]:
            response = client.post('/model-api/montage/tools/execute', json={'project_id':'demo','tool':tool,'inputs':inputs,'confirm':True})
            assert response.status_code == 422
        assert client.post('/model-api/montage/tools/execute', json={}, headers={'origin':'https://foreign.example'}).status_code == 403
    assert not list(project.rglob('*'))


def wait_job(jobs, project, job_id):
    end = time.monotonic() + 20
    while time.monotonic() < end:
        row = jobs.get(project, job_id)
        if row['status'] not in {'queued','running','cancelling'}: return row
        time.sleep(.05)
    raise AssertionError('Job did not terminate')


def test_real_native_job_preserves_source_and_restart_does_not_resubmit(project):
    source = project / 'original.wav'
    with wave.open(str(source), 'wb') as stream:
        stream.setnchannels(1); stream.setsampwidth(2); stream.setframerate(16000)
        stream.writeframes(b'\x00\x00' * 16000)
    before = hashlib.sha256(source.read_bytes()).hexdigest()
    jobs = MontageJobs(project.parent)
    try:
        row = jobs.submit(NativeToolRequest(project_id='demo', tool='audio_probe', inputs={'input_path':'original.wav'},confirm=True))
        result = wait_job(jobs, 'demo', row['job_id'])
        assert result['status'] == 'completed', result
        assert result['native_result']['success']
        assert hashlib.sha256(source.read_bytes()).hexdigest() == before
        run_id, run = new_run(project, 'tools')
        save_json(run / 'job.json', {'job_id':run_id,'project_id':'demo','status':'running'})
        assert jobs.get('demo',run_id)['status'] == 'interrupted'
        assert (run / 'job.json').exists()
    finally: jobs.shutdown()


def test_cancellation_stops_owned_child_even_if_sigterm_ignored(project, monkeypatch):
    import web_api.montage_jobs as module
    original = module.subprocess.Popen
    def sleeping_worker(_command, **kwargs):
        return original([sys.executable,'-c','import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(60)'], **kwargs)
    monkeypatch.setattr(module.subprocess, 'Popen', sleeping_worker)
    jobs = MontageJobs(project.parent)
    try:
        row = jobs.submit(NativeToolRequest(project_id='demo',tool='character_spec_generator',inputs={'brief':'demo'},confirm=True))
        deadline = time.monotonic() + 5
        while ('demo',row['job_id']) not in jobs.processes and time.monotonic()<deadline: time.sleep(.03)
        time.sleep(.15)
        jobs.cancel('demo',row['job_id'])
        assert wait_job(jobs,'demo',row['job_id'])['status'] == 'cancelled'
    finally: jobs.shutdown()


def test_poll_during_completion_never_invents_a_service_restart(project, monkeypatch):
    import threading
    jobs = MontageJobs(project.parent)
    run_id, run = new_run(project, 'tools')
    record = run / 'job.json'
    save_json(record, {'job_id': run_id, 'project_id': 'demo', 'status': 'running'})
    jobs.owned.add(('demo', run_id))
    read_snapshot, writer_started, writer_finished = (threading.Event() for _ in range(3))
    original_read = Path.read_text
    def read_during_finish(path, *args, **kwargs):
        snapshot = original_read(path, *args, **kwargs)
        if path == record and not read_snapshot.is_set():
            read_snapshot.set()
            assert writer_started.wait(2)
            # The older implementation let the worker finish after reading
            # running but before checking ownership, inventing a restart.
            writer_finished.wait(.1)
        return snapshot
    def finish():
        assert read_snapshot.wait(2)
        writer_started.set()
        with jobs.lock:
            save_json(record, {'job_id': run_id, 'project_id': 'demo', 'status': 'completed'})
            jobs.owned.discard(('demo', run_id))
        writer_finished.set()
    monkeypatch.setattr(Path, 'read_text', read_during_finish)
    worker = threading.Thread(target=finish)
    worker.start()
    try:
        row = jobs.get('demo', run_id)
        assert row['status'] in {'running', 'completed'}
        worker.join(3)
        assert not worker.is_alive()
        assert jobs.get('demo', run_id)['status'] == 'completed'
    finally:
        jobs.shutdown()


def test_selector_must_pin_one_provider(project):
    from web_api.montage_registry import validate_inputs, native_tool
    selector = native_tool('tts_selector')
    with pytest.raises(ValueError): validate_inputs(selector, {'text':'hello','preferred_provider':'auto'})
    inputs = validate_inputs(selector, {'text':'hello','preferred_provider':'macos_say_tts','allowed_providers':['elevenlabs_tts']})
    assert inputs['allowed_providers'] == ['macos_say_tts']


def test_optional_video_output_is_not_injected(project, monkeypatch):
    import web_api.montage_worker as module
    class ProbeTool(BaseTool):
        name = 'character_rig_renderer'
        input_schema = {'type':'object','properties':{'output_path':{'type':'string'},'video_output_path':{'type':'string'},'render_video':{'type':'boolean'}}}
        def execute(self, inputs):
            assert 'video_output_path' not in inputs
            return ToolResult(success=True)
    monkeypatch.setattr(module, 'native_tool', lambda _: ProbeTool())
    monkeypatch.setattr(module, 'no_external_network', lambda: None)
    assert execute_native(NativeToolRequest(project_id='demo',tool='character_rig_renderer'),project,project/'new')['status']=='completed'


def test_success_flag_with_missing_native_artifact_is_a_failure(project, monkeypatch):
    import web_api.montage_jobs as module
    original = module.subprocess.Popen
    worker = """import json,sys
from pathlib import Path
p=json.load(sys.stdin)
run=Path(p['run']); (run/'outputs').mkdir()
missing=(run/'outputs/missing.mp4').relative_to(Path(p['project'])).as_posix()
print(json.dumps({'status':'completed','native_result':{'success':True,'artifacts':[missing]}}))
"""
    monkeypatch.setattr(module.subprocess, 'Popen', lambda _command, **kwargs: original([sys.executable,'-c',worker], **kwargs))
    jobs = MontageJobs(project.parent)
    try:
        row = jobs.submit(NativeToolRequest(project_id='demo',tool='character_spec_generator',inputs={'brief':'demo'},confirm=True))
        result = wait_job(jobs,'demo',row['job_id'])
        assert result['status'] == 'failed'
        assert '产物不存在' in result['error']
    finally: jobs.shutdown()


def test_artifact_scan_failure_is_persisted_instead_of_claiming_restart(project, monkeypatch):
    import web_api.montage_jobs as module
    original = module.subprocess.Popen
    worker = """import json,sys
from pathlib import Path
p=json.load(sys.stdin); out=Path(p['run'])/'outputs'; out.mkdir()
(out/'unsafe-link').symlink_to('/etc/passwd')
print(json.dumps({'status':'completed','native_result':{'success':True,'artifacts':[]}}))
"""
    monkeypatch.setattr(module.subprocess, 'Popen', lambda _command, **kwargs: original([sys.executable,'-c',worker], **kwargs))
    jobs = MontageJobs(project.parent)
    try:
        row = jobs.submit(NativeToolRequest(project_id='demo',tool='character_spec_generator',inputs={'brief':'demo'},confirm=True))
        result = wait_job(jobs,'demo',row['job_id'])
        assert result['status'] == 'failed' and '符号链接' in result['error']
        record = project/'analysis/montage/tools'/row['job_id']/'job.json'
        assert json.loads(record.read_text())['status'] == 'failed'
        assert jobs.get('demo',row['job_id'])['status'] == 'failed'
    finally: jobs.shutdown()


def test_authored_artifact_download_cannot_execute_html_or_escape(project, tmp_path):
    directory = project/'analysis/montage/director/session/workspace'
    directory.mkdir(parents=True)
    (directory/'scene.html').write_text('<script>document.body.dataset.executed=true</script>')
    (project/'personal.txt').write_text('keep private')
    outside = tmp_path/'outside';outside.mkdir();(outside/'private.txt').write_text('secret')
    (directory/'escape').symlink_to(outside, target_is_directory=True)
    app=FastAPI();app.include_router(create_montage_router(project.parent))
    with TestClient(app) as client:
        response=client.get('/model-api/montage/files/demo/analysis/montage/director/session/workspace/scene.html')
        assert response.status_code==200
        assert response.headers['content-disposition'].startswith('attachment;')
        assert response.headers['content-security-policy'].startswith('sandbox;')
        assert response.headers['x-content-type-options']=='nosniff'
        for path in ['personal.txt','analysis/montage/%2E%2E%2F%2E%2E%2Fpersonal.txt','analysis/montage/director/session/workspace/escape/private.txt']:
            assert client.get('/model-api/montage/files/demo/'+path).status_code==422


def test_intel_mac_blender_defaults_use_verified_cpu_and_respect_explicit_engine(project, monkeypatch):
    import web_api.montage_registry as registry_module
    import web_api.montage_worker as worker_module
    monkeypatch.setattr(registry_module, 'blender_cpu_default', lambda: True)
    row=next(t for t in tool_catalog()['tools'] if t['name']=='blender_world')
    assert row['input_schema']['properties']['render_engine']['default']=='CYCLES'
    monkeypatch.setattr(worker_module,'blender_cpu_default',lambda: True)
    monkeypatch.setattr(worker_module,'no_external_network',lambda: None)
    seen=[]
    class ProbeTool(BaseTool):
        name='blender_world'
        input_schema={'type':'object','properties':{'render_engine':{'type':'string'},'cpu_render':{'type':'boolean'}}}
        def execute(self, inputs):
            seen.append(inputs)
            return ToolResult(success=True)
    monkeypatch.setattr(worker_module,'native_tool',lambda _: ProbeTool())
    execute_native(NativeToolRequest(project_id='demo',tool='blender_world'),project,project/'new')
    execute_native(NativeToolRequest(project_id='demo',tool='blender_world',inputs={'render_engine':'BLENDER_WORKBENCH'}),project,project/'new2')
    assert seen[0]=={'render_engine':'CYCLES','cpu_render':True}
    assert seen[1]=={'render_engine':'BLENDER_WORKBENCH'}
