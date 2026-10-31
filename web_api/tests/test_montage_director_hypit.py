"""Director/Hypit protocol regressions; bridge and media probe are simulated.

These tests do not start the official CLI, call a provider, or certify production
media. They exercise the director's engine selection, durable approval and
delivery boundaries using files confined to pytest's temporary project.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import threading
import time

import httpx
import pytest

import web_api.media_pipeline as media_module
import web_api.montage_director as module
from lib.pipeline_loader import load_pipeline_readonly
from web_api.montage_director import DirectorRequest, MontageDirector, preflight_director
from web_api.montage_jobs import MontageJobs, new_run, save_json


def request(**overrides):
    values = dict(project_id='demo', pipeline='documentary-montage',
                  brief='理解参考视频后制作本地工程', provider='ollama', model='test')
    values.update(overrides)
    return DirectorRequest(**values)


def hypit(operation, **arguments):
    return {'action': 'hypit', 'arguments': {'operation': operation, **arguments}}


@pytest.fixture
def director(tmp_path, monkeypatch):
    project = tmp_path / 'demo'
    project.mkdir()
    jobs = MontageJobs(tmp_path)
    service = MontageDirector(tmp_path, jobs)
    bridges = []

    class FakeBridge:
        """Deterministic protocol peer, with no native runtime or provider."""

        def __init__(self, project, run):
            self.project, self.run = Path(project), Path(run)
            self.workspace = self.run / 'hypit-workspace'
            self.calls = []
            self.export = None
            self.plan = None
            self.handler = None
            self.entered = threading.Event()
            bridges.append(self)

        def status(self):
            files = [{'path': path.relative_to(self.project).as_posix()}
                     for path in self.workspace.glob('*.svml') if path.is_file()]
            return {'files': files, 'ready': True, 'plan': self.plan, 'fingerprint': self.fingerprint()}

        def write(self, path, content):
            # The real bridge's own author-path protections have separate tests.
            self.workspace.mkdir(exist_ok=True)
            destination = self.workspace / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(content, encoding='utf-8')
            return {'engine': 'hypit', 'status': 'written',
                    'path': destination.relative_to(self.project).as_posix()}

        def import_media(self, source_path):
            self.calls.append(('import_media', source_path))
            return {'engine': 'hypit', 'status': 'imported', 'source_path': source_path}

        def register_component(self, name, activation, entry=None):
            self.calls.append(('register_component', name, activation, entry))
            return {'engine': 'hypit', 'status': 'component_registered',
                    'component': {'name': name, 'activation': activation, 'entry': entry},
                    'author_path': f'packages/{name.rsplit("/", 1)[-1]}/package.json'}

        def fingerprint(self):
            source = self.workspace / 'main.svml'
            return hashlib.sha256(source.read_bytes() if source.exists() else b'').hexdigest()

        def execute(self, arguments, *, expected_fingerprint, cancel_event, on_job):
            assert expected_fingerprint == self.fingerprint()
            self.calls.append(('execute', dict(arguments), expected_fingerprint, cancel_event))
            self.entered.set()
            if self.handler:
                return self.handler(arguments, cancel_event, on_job)
            outputs = [self.export] if arguments['operation'] == 'get' and self.export else []
            return {'engine': 'hypit', 'status': 'succeeded', 'command_succeeded': True,
                    'build_id': arguments.get('build_id'), 'output': arguments.get('output'),
                    'build_fingerprint': self.fingerprint(),
                    'outputs': outputs, 'delivery_verified': False}

        def close(self, *, wait=False):
            pass

    monkeypatch.setattr(module, 'HypitDirectorBridge', FakeBridge)
    monkeypatch.setattr(module, 'connection', lambda _: {
        'ready': True, 'local': True, 'base': 'http://127.0.0.1:11434/v1', 'key': None})
    yield service, project, bridges
    service.shutdown()
    service.pool.shutdown(wait=True)
    jobs.shutdown()


def context(service, project, req):
    session, run = new_run(project, 'director')
    (run / 'workspace').mkdir()
    row = {'session_id': session, 'project_id': 'demo', 'status': 'running',
           'stage_index': 0, 'completed_stages': [], 'seen_guidance': [], 'outputs': [],
           'execution_engine': req.execution_engine, 'reference_path': req.reference_path}
    return run, row, load_pipeline_readonly(req.pipeline)


def settled(service, initial, timeout=5):
    deadline = time.monotonic() + timeout
    key = ('demo', initial['session_id'])
    while time.monotonic() < deadline:
        row = service.state(*key)
        if row['status'] not in module.ACTIVE and key not in service.owned:
            return row
        time.sleep(.01)
    pytest.fail(f'director did not settle: {row}')


def fake_models(monkeypatch):
    monkeypatch.setattr(module, 'tool_catalog', lambda: {'tools': []})
    monkeypatch.setattr(module, 'hypit_capabilities', lambda: {'available': True})
    monkeypatch.setattr(module.httpx.Client, 'get', lambda self, url: httpx.Response(
        200, request=httpx.Request('GET', url), json={'data': [{'id': 'test'}]}))


def model_actions(monkeypatch, actions):
    answers = iter(actions)
    monkeypatch.setattr(module, 'preflight_director', lambda *args: {'can_execute': True, 'status': 'ready'})
    monkeypatch.setattr(module, 'request_model', lambda *args, **kwargs:
                        (json.dumps(next(answers)), {'input': 1, 'output': 1}))


def write_report(run, path):
    artifacts = run / 'workspace' / 'artifacts'
    artifacts.mkdir(exist_ok=True)
    save_json(artifacts / 'render_report.json', {'version': '1.0', 'outputs': [
        {'path': path, 'format': 'mp4', 'resolution': '720x1280', 'duration_seconds': 1}]})


@pytest.mark.parametrize('action', [
    hypit('build', run='main.svrun'),
    hypit('register_component', name='@openmontage/piece', activation='activation.js'),
])
def test_openmontage_default_cannot_invoke_hypit(director, monkeypatch, action):
    service, project, bridges = director
    req = request()
    assert req.execution_engine == 'openmontage'
    fake_models(monkeypatch)
    monkeypatch.setattr(module, 'hypit_capabilities', lambda: pytest.fail('OpenMontage preflight must not depend on Hypit'))
    plan = preflight_director(req, project.parent)
    assert plan['can_execute'] is True and plan['reference'] is None
    assert plan['hypit'] is None
    run, row, manifest = context(service, project, req)
    with pytest.raises(ValueError, match='未选择 Hypit'):
        service._act(req, project, run, row, manifest, action, approved=True)
    assert bridges == []
    assert not (run / 'hypit-workspace').exists()
    result = service._act(req, project, run, row, manifest,
                          {'action': 'write', 'arguments': {'path': 'notes.txt', 'content': '本地制作记录'}})
    assert result['written'].endswith('/workspace/notes.txt')
    assert (run / 'workspace' / 'notes.txt').read_text() == '本地制作记录'


@pytest.mark.parametrize('entry', [None, 'render.js'])
def test_register_component_is_local_authoring_without_approval_or_execution(director, entry):
    service, project, bridges = director
    req = request(execution_engine='hypit')
    run, row, manifest = context(service, project, req)
    service._act(req, project, run, row, manifest,
                 hypit('write', path='packages/piece/activation.js', content='export const register = () => {};'))
    arguments = {'name': '@openmontage/piece', 'activation': 'activation.js'}
    if entry is not None:
        service._act(req, project, run, row, manifest,
                     hypit('write', path='packages/piece/render.js', content='export const render = () => {};'))
        arguments['entry'] = entry
    result = service._act(req, project, run, row, manifest, hypit('register_component', **arguments))
    assert result['status'] == 'component_registered'
    assert result['author_path'] == 'packages/piece/package.json'
    assert result['component'] == {'name': '@openmontage/piece', 'activation': 'activation.js', 'entry': entry}
    assert bridges[0].calls == [('register_component', '@openmontage/piece', 'activation.js', entry)]
    assert row['status'] == 'running' and 'pending' not in row
    assert row['outputs'] == [] and service.hypit_cancellations == {}


@pytest.mark.parametrize('extra', [
    {'paid_approval': {'approved': True}}, {'profile': 'remote.json'},
    {'native_cli': ['build']}, {'dependencies': {'untrusted': '*'}},
    {'path': '../package.json'},
])
def test_register_component_rejects_extra_runtime_and_metadata_fields(director, extra):
    service, project, bridges = director
    req = request(execution_engine='hypit')
    run, row, manifest = context(service, project, req)
    action = hypit('register_component', name='@openmontage/piece', activation='activation.js', **extra)
    with pytest.raises(ValueError, match='组件注册只接受'):
        service._act(req, project, run, row, manifest, action)
    assert all(bridge.calls == [] for bridge in bridges)
    assert 'pending' not in row and row['outputs'] == []
    assert not (run / 'hypit-workspace').exists()


@pytest.mark.parametrize('operation,arguments', [
    ('check', {'source': 'main.svml'}), ('plan', {'run': 'main.svrun'}),
    ('build', {'run': 'main.svrun'}), ('inspect', {'build_id': 'build-test'}),
    ('get', {'build_id': 'build-test', 'output': 'film.video'}),
])
def test_every_native_hypit_operation_waits_for_specific_approval(director, operation, arguments):
    service, project, bridges = director
    req = request(execution_engine='hypit')
    run, row, manifest = context(service, project, req)
    action = hypit(operation, **arguments)
    assert service._act(req, project, run, row, manifest, action) is None
    assert row['status'] == 'waiting_approval'
    assert row['pending']['action'] == action
    assert row['pending']['hypit_fingerprint'] == bridges[0].fingerprint()
    assert row['pending']['artifacts'] == bridges[0].status()['files']
    assert len(row['pending']['approval_id']) == 32
    persisted = service.state('demo', row['session_id'], internal=True)
    assert persisted['pending'] == row['pending']
    assert bridges[0].calls == []
    with pytest.raises(ValueError, match='待确认步骤已变化'):
        service.resume('demo', row['session_id'], 'wrong-approval', True)
    assert bridges[0].calls == []
    # The approved flag alone is not an authorization receipt.
    bypass = service._act(req, project, run, row, manifest, action, approved=True)
    assert 'error' in bypass and bridges[0].calls == []


def test_hypit_approval_exposes_source_files_and_actual_plan(director):
    service, project, bridges = director
    req = request(execution_engine='hypit')
    run, row, manifest = context(service, project, req)
    service._act(req, project, run, row, manifest, hypit('write', path='main.svml', content='source for review'))
    bridge = bridges[0]
    bridge.plan = {'format': 'hypit.cli-plan@1', 'localRequestCount': 1, 'providerRequestCount': 0}
    assert service._act(req, project, run, row, manifest, hypit('build', run='main.svrun')) is None
    artifacts = row['pending']['artifacts']
    assert len(artifacts) == 1
    assert (project / artifacts[0]['path']).read_text() == 'source for review'
    assert row['pending']['plan'] == bridge.plan
    assert bridge.calls == []


@pytest.mark.parametrize('extra', [
    {'paid_approval': {'approved': True, 'max_cost_usd': 100}},
    {'allow_paid': True}, {'profile': 'remote.json'}, {'native_cli': ['build']},
])
def test_model_cannot_forge_paid_or_runtime_authorization(director, extra):
    service, project, bridges = director
    req = request(execution_engine='hypit', allow_paid=True, max_cost_usd=100)
    run, row, manifest = context(service, project, req)
    action = hypit('build', run='main.svrun', **extra)
    with pytest.raises(ValueError, match='额外运行、网络或付费授权'):
        service._act(req, project, run, row, manifest, action, approved=True)
    assert not row.get('pending')
    assert all(not bridge.calls for bridge in bridges)
    with pytest.raises(ValueError, match='没有这个 Hypit'):
        service._act(req, project, run, row, manifest, hypit('native_cli', argv=['build']))


def test_source_edit_invalidates_approved_action_after_resume(director, monkeypatch):
    service, project, bridges = director
    model_actions(monkeypatch, [hypit('write', path='main.svml', content='first source'),
        hypit('check', source='main.svml'), {'action': 'blocked', 'arguments': {'message': '重新审阅源码'}}])
    initial = service.start(request(execution_engine='hypit', confirm=True))
    waiting = settled(service, initial)
    assert waiting['status'] == 'waiting_approval'
    approved_hash = waiting['pending']['hypit_fingerprint']
    bridges[0].write('main.svml', 'changed after review')
    assert bridges[0].fingerprint() != approved_hash
    resumed = service.resume('demo', initial['session_id'], waiting['pending']['approval_id'], True)
    final = settled(service, resumed)
    assert final['status'] == 'blocked'
    assert bridges[0].calls == []
    internal = service.state('demo', initial['session_id'], internal=True)
    observations = [m['content'] for m in internal['messages'] if m['role'] == 'user']
    assert any('工程在确认后发生变化' in str(value) for value in observations)
    assert final['outputs'] == []


@pytest.mark.parametrize('model,reference,missing', [
    ('', 'reference.mp4', '模型名'), ('test', None, '参考视频'), ('', None, '模型名'),
])
def test_preflight_missing_configuration_never_starts_or_writes(director, monkeypatch, model, reference, missing):
    service, project, bridges = director
    fake_models(monkeypatch)
    if reference:
        (project / reference).write_bytes(b'local-reference-fixture')
    monkeypatch.setattr(media_module, '_probe_media', lambda path: {'video': True, 'duration': 1})
    monkeypatch.setattr(module, 'request_model', lambda *args, **kwargs: pytest.fail('preflight must not call a model'))
    before = sorted(path.relative_to(project).as_posix() for path in project.rglob('*'))
    req = request(execution_engine='hypit', model=model, reference_path=reference, confirm=True)
    plan = preflight_director(req, project.parent)
    assert plan['status'] == 'needs_setup' and plan['would_write'] is False
    assert any(missing in item for item in plan['requirements'])
    assert service.start(req)['status'] == 'needs_setup'
    assert sorted(path.relative_to(project).as_posix() for path in project.rglob('*')) == before
    assert bridges == [] and service.owned == set()


@pytest.mark.parametrize('path_kind', ['parent', 'absolute', 'symlink'])
def test_reference_preflight_rejects_paths_outside_current_project(director, monkeypatch, tmp_path, path_kind):
    service, project, bridges = director
    fake_models(monkeypatch)
    outside = tmp_path / 'outside.mp4'
    outside.write_bytes(b'private-outside-fixture')
    reference = '../outside.mp4' if path_kind == 'parent' else str(outside)
    if path_kind == 'symlink':
        (project / 'linked.mp4').symlink_to(outside)
        reference = 'linked.mp4'
    monkeypatch.setattr(media_module, '_probe_media', lambda path: pytest.fail('escaped media must not be probed'))
    result = service.start(request(execution_engine='hypit', reference_path=reference, confirm=True))
    assert result['status'] == 'needs_setup' and result['can_execute'] is False
    assert result['reference'] is None
    assert not (project / 'analysis').exists()
    assert outside.read_bytes() == b'private-outside-fixture'
    assert bridges == []


@pytest.mark.parametrize('extension', ['.ogv', '.ts'])
@pytest.mark.parametrize('has_video', [True, False])
def test_uploaded_video_extensions_still_require_playable_video_evidence(director, monkeypatch, extension, has_video):
    service, project, bridges = director
    fake_models(monkeypatch)
    path = project / ('reference' + extension)
    path.write_bytes(b'local-format-protocol-fixture')
    probed = []

    def probe(candidate):
        probed.append(candidate)
        return {'video': has_video, 'audio': not has_video, 'duration': 1}

    monkeypatch.setattr(media_module, '_probe_media', probe)
    req = request(execution_engine='hypit', reference_path=path.name)
    plan = preflight_director(req, project.parent)
    assert probed == [path]
    assert plan['can_execute'] is has_video
    assert plan['status'] == ('ready' if has_video else 'needs_setup')
    if has_video:
        assert plan['reference']['path'] == path.name
        assert plan['reference']['media']['video'] is True
    else:
        assert plan['reference'] is None
        assert any('可播放' in requirement for requirement in plan['requirements'])
    assert plan['would_write'] is False and not (project / 'analysis').exists()
    assert bridges == []


@pytest.mark.parametrize('asset_state', ['unchanged', 'replaced', 'missing', 'source_changed', 'build_unknown'])
def test_get_receipt_and_finish_verify_unchanged_download(director, monkeypatch, asset_state):
    service, project, bridges = director
    model_actions(monkeypatch, [hypit('write', path='main.svml', content='reviewed source'),
        hypit('get', build_id='build-test', output='film.video'),
        {'action': 'blocked', 'arguments': {'message': '等待最终审核'}}])
    initial = service.start(request(execution_engine='hypit', confirm=True))
    waiting = settled(service, initial)
    bridge = bridges[0]
    exported = bridge.workspace / 'exports' / 'downloaded.mp4'
    exported.parent.mkdir()
    exported.write_bytes(b'mocked-get-media')
    bridge.export = {'path': exported.relative_to(project).as_posix(), 'kind': 'video',
                     'playable': True, 'sha256': hashlib.sha256(exported.read_bytes()).hexdigest()}
    resumed = service.resume('demo', initial['session_id'], waiting['pending']['approval_id'], True)
    final = settled(service, resumed)
    assert len(bridge.calls) == 1
    assert bridge.calls[0][1]['operation'] == 'get'
    assert bridge.calls[0][2] == waiting['pending']['hypit_fingerprint']
    assert any(output['path'] == bridge.export['path'] for output in final['outputs'])
    history = service.list('demo')['sessions']
    assert history[0]['outputs'] == final['outputs']
    assert history[0]['hypit']['build_id'] == 'build-test'
    assert history[0]['hypit_exports'][0]['path'] == bridge.export['path']
    assert history[0]['hypit_exports'][0]['build_id'] == 'build-test'
    assert history[0]['hypit_exports'][0]['output'] == 'film.video'
    assert exported.read_bytes() == b'mocked-get-media'
    # Isolate the finish gate from stage production: only its durable Get
    # provenance and the (mocked) decoder check are under test here.
    row = service.state('demo', final['session_id'], internal=True)
    manifest = load_pipeline_readonly('documentary-montage')
    row['stage_index'] = len(manifest['stages'])
    run = bridge.run
    write_report(run, bridge.export['path'])
    monkeypatch.setattr(media_module, '_probe_media', lambda path: {'video': path == exported})
    if asset_state == 'replaced':
        exported.write_bytes(b'different-playable-file-after-get')
    elif asset_state == 'missing':
        exported.rename(exported.with_suffix('.kept'))
    elif asset_state == 'source_changed':
        bridge.write('main.svml', 'new source after the old Get')
    elif asset_state == 'build_unknown':
        original_status = bridge.status
        monkeypatch.setattr(bridge, 'status', lambda: {**original_status(), 'unresolved_submission': {'state': 'unknown'}})
    result = service._act(request(execution_engine='hypit'), project, run, row, manifest, {'action': 'finish'})
    if asset_state == 'unchanged':
        assert result is None
        assert row['status'] == 'completed'
    else:
        assert result and 'error' in result
        assert row['status'] != 'completed'


@pytest.mark.parametrize('command_succeeded', [False, None])
def test_unsuccessful_get_receipt_never_authorizes_delivery(director, monkeypatch, command_succeeded):
    service, project, bridges = director
    model_actions(monkeypatch, [hypit('write', path='main.svml', content='reviewed source'),
        hypit('get', build_id='build-test', output='film.video'),
        {'action': 'blocked', 'arguments': {'message': 'Get未成功'}}])
    initial = service.start(request(execution_engine='hypit', confirm=True))
    waiting = settled(service, initial)
    bridge = bridges[0]
    candidate = bridge.workspace / 'unconfirmed.mp4'
    candidate.write_bytes(b'unconfirmed-protocol-fixture')
    output = {'path': candidate.relative_to(project).as_posix(), 'kind': 'video', 'playable': True}

    def failed_get(arguments, cancel_event, on_job):
        result = {'engine': 'hypit', 'status': 'failed', 'outputs': [output],
                  'build_id': 'build-test', 'output': 'film.video'}
        if command_succeeded is not None:
            result['command_succeeded'] = command_succeeded
        return result

    bridge.handler = failed_get
    final = settled(service, service.resume('demo', initial['session_id'], waiting['pending']['approval_id'], True))
    assert not final.get('hypit_exports')
    row = service.state('demo', final['session_id'], internal=True)
    manifest = load_pipeline_readonly('documentary-montage')
    row['stage_index'] = len(manifest['stages'])
    write_report(bridge.run, output['path'])
    monkeypatch.setattr(media_module, '_probe_media', lambda path: {'video': True})
    result = service._act(request(execution_engine='hypit'), project, bridge.run, row, manifest, {'action': 'finish'})
    assert result and 'error' in result
    assert row['status'] != 'completed'


@pytest.mark.parametrize('candidate', ['reference', 'native_tool', 'unplayable_get'])
def test_finish_cannot_turn_reference_or_non_get_media_into_hypit_delivery(director, monkeypatch, candidate):
    service, project, bridges = director
    req = request(execution_engine='hypit', reference_path='reference.mp4')
    run, row, manifest = context(service, project, req)
    row['stage_index'] = len(manifest['stages'])
    path = 'reference.mp4' if candidate == 'reference' else 'native-tool.mp4'
    (project / path).write_bytes(b'not-a-new-hypit-get-export')
    row['outputs'] = [{'path': path, 'kind': 'video', 'playable': candidate != 'unplayable_get'}]
    if candidate != 'native_tool':
        # Even a legacy Get record cannot turn the input reference into a new
        # work, or promote a media file that failed its decoder check.
        row['hypit_exports'] = [{**row['outputs'][0], 'build_id': 'build-test', 'output': 'film.video'}]
    write_report(run, path)
    monkeypatch.setattr(media_module, '_probe_media', lambda path: {'video': True})
    result = service._act(req, project, run, row, manifest, {'action': 'finish'})
    assert result and 'error' in result
    assert row['status'] != 'completed'
    assert bridges == []


def test_cancel_reaches_inflight_hypit_executor_and_retains_source(director, monkeypatch):
    service, project, bridges = director
    model_actions(monkeypatch, [hypit('write', path='main.svml', content='keep authored source'),
        hypit('build', run='main.svrun'), {'action': 'blocked', 'arguments': {'message': 'cancelled'}}])
    initial = service.start(request(execution_engine='hypit', confirm=True))
    waiting = settled(service, initial)
    bridge = bridges[0]

    def blocked_executor(arguments, cancel_event, on_job):
        assert cancel_event.wait(3), 'director cancel did not reach Hypit'
        return {'engine': 'hypit', 'status': 'cancelled', 'outputs': [],
                'build_id': 'build-test', 'official_cancellation': 'unknown'}

    bridge.handler = blocked_executor
    resumed = service.resume('demo', initial['session_id'], waiting['pending']['approval_id'], True)
    assert bridge.entered.wait(2)
    cancelling = service.cancel('demo', initial['session_id'])
    assert cancelling['status'] in {'cancelling', 'cancelled'}
    final = settled(service, resumed)
    assert final['status'] == 'cancelled'
    assert bridge.calls[0][3].is_set()
    assert (bridge.workspace / 'main.svml').read_text() == 'keep authored source'
    assert final['hypit']['build_id'] == 'build-test'
    assert '尚未确认' in final['message']


def test_hypit_system_reads_pinned_skill_and_distinguishes_semantic_analysis(director, monkeypatch):
    service, project, bridges = director
    paths = []
    monkeypatch.setattr(module, 'instruction', lambda path: paths.append(path) or f'instruction:{path}')
    monkeypatch.setattr(module, 'native_tool_names', lambda: [])
    req = request(execution_engine='hypit', reference_path='reference.mp4')
    run, row, manifest = context(service, project, req)
    text = service._system(manifest, row)
    assert '.agents/skills/hypit/SKILL.md' in paths
    assert '.agents/skills/hypit/references/creation/reference-video.md' in paths
    assert 'reference.mp4' in text
    assert '不得把抽帧' in text and '语义' in text
    paths.clear()
    row['execution_engine'] = 'openmontage'
    service._system(manifest, row)
    assert not any('/hypit/' in path for path in paths)
    assert bridges == []
