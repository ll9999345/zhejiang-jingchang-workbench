"""Protocol tests use a mocked official CLI runner, never production media work."""
from __future__ import annotations

import json
from pathlib import Path
import threading

from PIL import Image
import pytest

import web_api.montage_hypit as bridge_module
from web_api.hypit_runtime import CommandResult, HypitRuntime, HypitSettings
from web_api.montage_hypit import HypitDirectorBridge, hypit_capabilities


BUILD = 'bld_20261002T000000000Z_TEST'


def local_plan(*, external=False):
    return {'format': 'hypit.cli-plan@1', 'ok': True, 'run': 'build.svrun',
            'requestCount': 1, 'localRequestCount': 0 if external else 1,
            'providerRequestCount': 1 if external else 0, 'requestIssueCount': 0,
            'unresolvedRequestCount': 0, 'unsupportedRequestCount': 0,
            'preflight': {'ok': True, 'diagnostics': []},
            'providers': [{'status': 'resolved', 'endpoint': 'remote' if external else 'media.local',
                'use': '@hypit/provider-hypihub' if external else '@hypit/provider-media-local',
                'pricing': {'kind': 'page', 'url': 'https://example.invalid/pricing'} if external else {'kind': 'local'}}]}


def build_view(*, active=False, cancelled=False, failed=False):
    outcome = 'cancelled' if cancelled else 'failed' if failed else 'complete'
    return {'id': BUILD, 'work': {'state': 'working' if active else 'done', **({} if active else {'outcome': outcome})},
            'result': {'state': 'open' if active else outcome, 'outputCount': 0 if active else 1}}


def inspect_view(*, outcome='complete', output='film.video'):
    return {'format': 'hypit.cli-inspect@1', 'build': {'id': BUILD, 'outcome': outcome,
        'outputs': [{'name': output, 'kind': 'resource', 'type': '@hypit/artifact@1/Blob',
                     'mediaType': 'video/mp4', 'size': 12}], 'outputCount': 1}}


@pytest.fixture
def setup(tmp_path):
    project = tmp_path / 'projects' / 'demo'
    run = project / 'analysis' / 'montage' / 'director' / 'test-run'
    run.mkdir(parents=True)
    checkout = tmp_path / 'pinned-checkout'
    (checkout / 'bin').mkdir(parents=True)
    (checkout / 'bin' / 'hypit.mjs').write_text('// protocol test launcher', encoding='utf-8')
    (checkout / 'node_modules').mkdir()
    calls = []
    instances = []
    behavior = {}

    def runner(argv, *, cwd, env, cancel_event):
        calls.append((list(argv), cwd))
        command = argv[2]
        handler = behavior.get(command)
        if handler:
            result = handler(argv, cwd, cancel_event)
            if isinstance(result, CommandResult):
                return result
            data = result
        elif command == 'plan':
            data = local_plan()
        elif command == 'build':
            data = {'format': 'hypit.cli-build@1', 'build': build_view()}
        elif command == 'status':
            data = {'format': 'hypit.cli-status@1', 'build': build_view()}
        elif command == 'inspect':
            data = inspect_view()
        elif command == 'get':
            target = cwd / argv[argv.index('--to') + 1]
            target.write_bytes(b'real-export')
            data = {'format': 'hypit.cli-get@1', 'build': BUILD, 'output': argv[argv.index('--output') + 1],
                    'path': str(target), 'type': '@hypit/artifact@1/Blob', 'kind': 'resource'}
        elif command == 'cancel':
            data = {'format': 'hypit.cli-cancel@1', 'requested': True, 'build': build_view(cancelled=True)}
        else:
            data = {'format': 'hypit.cli-check@1', 'ok': True}
        return CommandResult(tuple(argv), 0, stdout=json.dumps(data))

    def factory(*, project_root):
        runtime = HypitRuntime(project_root, hypit_root=checkout, runner=runner,
            settings=HypitSettings(project_root=project_root, hypit_root=checkout,
                                   command_timeout_seconds=2))
        instances.append(runtime)
        return runtime

    bridge = HypitDirectorBridge(project, run, runtime_factory=factory)
    yield bridge, calls, behavior, instances
    bridge.close(wait=True)


def author(bridge):
    bridge.write('main.svml', '<?svml using="@hypit/markup@1"?>\n')
    bridge.write('build.svrun', '<?svml using="@hypit/run-markup@1"?>\n<svrun version="1"/>\n')
    return bridge.fingerprint()


def test_status_is_readonly_and_reports_separate_static_availability(setup):
    bridge, calls, behavior, instances = setup
    before = list(bridge.run.rglob('*'))
    status = bridge.status()
    assert status['status'] == 'ready'
    assert status['author_workspace_exists'] is False
    assert status['runtime_execution_verified'] is False
    assert status['external_builds'] == 'blocked'
    assert status['workspace_root'].endswith('/test-run/hypit-workspace')
    assert status['files'] == []
    assert status['last_plan'] is None
    assert list(bridge.run.rglob('*')) == before
    assert calls == []


def test_global_capabilities_are_readonly(monkeypatch, tmp_path):
    root = tmp_path / 'absent-checkout'
    monkeypatch.setattr(bridge_module, 'HYPIT_ROOT', root)
    result = hypit_capabilities()
    assert result['available'] is False
    assert result['execution_scope'] == 'local_only'
    assert result['runtime_execution_verified'] is False
    assert not root.exists()


def test_first_write_static_profile_and_versions_never_run_init(setup):
    bridge, calls, behavior, instances = setup
    first = bridge.write('notes/Brief.md', '第一版')
    second = bridge.write('notes/Brief.md', '第二版')
    assert first['previous_version'] is None
    assert (bridge.project / second['previous_version']).read_text('utf-8') == '第一版'
    assert (bridge.project / second['path']).read_text('utf-8') == '第二版'
    assert (bridge.workspace / '.hypit' / 'runtime').read_text('utf-8') == 'hypit.runtime.json\n'
    assert first['fingerprint'] != second['fingerprint']
    assert calls == []
    assert instances == []


@pytest.mark.parametrize('path', ['../x.svml', '/tmp/x.svml', '.secret.json', 'a/.hidden.md',
    'hypit.runtime.json', 'package.json', 'packages/my/package.json', 'credentials.json',
    'provider-secret.ts', 'assets/a.json', 'exports/a.svml', 'node_modules/a.js', 'a.py',
    'tsconfig.json', 'a\\b.svml'])
def test_authoring_rejects_escape_execution_config_and_secret_paths(setup, path):
    bridge, calls, behavior, instances = setup
    with pytest.raises(ValueError):
        bridge.write(path, 'not allowed')
    assert not bridge.workspace.exists()
    assert calls == []


def test_authoring_and_fingerprint_limits(setup, monkeypatch):
    bridge, calls, behavior, instances = setup
    with pytest.raises(ValueError, match='大小上限'):
        bridge.write('large.md', 'a' * (bridge_module.MAX_AUTHOR_BYTES + 1))
    author(bridge)
    monkeypatch.setattr(bridge_module, 'MAX_AUTHOR_FILES', 2)
    with pytest.raises(ValueError, match='上限'):
        bridge.write('third.md', 'third')
    assert not (bridge.workspace / 'third.md').exists()


def test_fingerprint_binds_source_profile_and_media_and_rejects_links(setup):
    bridge, calls, behavior, instances = setup
    approved = author(bridge)
    (bridge.workspace / 'main.svml').write_text('changed', encoding='utf-8')
    with pytest.raises(ValueError, match='审批失效'):
        bridge.execute({'operation': 'check', 'source': 'main.svml'}, approved)
    new = bridge.fingerprint()
    (bridge.workspace / 'linked.md').symlink_to(bridge.workspace / 'main.svml')
    with pytest.raises(ValueError, match='符号链接'):
        bridge.fingerprint()
    assert calls == []


def test_profile_tampering_fails_before_any_execution(setup):
    bridge, calls, behavior, instances = setup
    approved = author(bridge)
    (bridge.workspace / 'hypit.runtime.json').write_text('{}', encoding='utf-8')
    with pytest.raises(ValueError, match='Profile 已改变'):
        bridge.execute({'operation': 'plan', 'run': 'build.svrun'}, approved)
    assert calls == []


def test_runtime_data_root_cannot_redirect_outside_session(setup, tmp_path):
    bridge, calls, behavior, instances = setup
    approved = author(bridge)
    outside = tmp_path / 'unrelated-data'
    outside.mkdir()
    (bridge.workspace / '.hypit' / 'runtimes').symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match='符号链接'):
        bridge.execute({'operation': 'plan', 'run': 'build.svrun'}, approved)
    assert calls == []


def test_import_is_project_scoped_probed_and_allocates_fresh_file(setup, tmp_path):
    bridge, calls, behavior, instances = setup
    source = bridge.project / 'assets' / 'reference.png'
    source.parent.mkdir()
    Image.new('RGB', (4, 4), 'red').save(source)
    first = bridge.import_media('assets/reference.png')
    second = bridge.import_media('assets/reference.png')
    assert first['outputs'][0]['path'] != second['outputs'][0]['path']
    assert first['outputs'][0]['sha256'] == second['outputs'][0]['sha256']
    assert first['outputs'][0]['kind'] == 'image'
    assert first['outputs'][0]['playable'] is True
    assert source.is_file()
    assert calls == []
    with pytest.raises(ValueError):
        bridge.import_media('../outside.png')
    outside = tmp_path / 'outside.png'
    Image.new('RGB', (4, 4), 'blue').save(outside)
    (bridge.project / 'link.png').symlink_to(outside)
    with pytest.raises(ValueError, match='符号链接'):
        bridge.import_media('link.png')
    (bridge.project / 'bad.mp4').write_text('not video', encoding='utf-8')
    with pytest.raises(ValueError, match='媒体探测'):
        bridge.import_media('bad.mp4')
    approved = second['fingerprint']
    copied = bridge.project / second['outputs'][0]['path']
    copied.write_bytes(b'changed bytes')
    assert bridge.fingerprint() != approved


def test_every_execute_needs_fingerprint_and_same_runtime_job_manager(setup):
    bridge, calls, behavior, instances = setup
    approved = author(bridge)
    with pytest.raises(ValueError, match='审批失效'):
        bridge.execute({'operation': 'plan', 'run': 'build.svrun'}, 'bad')
    updates = []
    checked = bridge.execute({'operation': 'check', 'source': 'main.svml'}, approved, on_job=updates.append)
    planned = bridge.execute({'operation': 'plan', 'run': 'build.svrun'}, approved)
    assert checked['status'] == 'completed'
    assert planned['plan']['format'] == 'hypit.cli-plan@1'
    assert len(instances) == 1
    assert all(cwd == bridge.workspace for argv, cwd in calls)
    assert updates[-1]['job_id'] == checked['job_id']
    assert bridge.fingerprint() == approved  # generated adapter files are excluded
    assert not any(argv[2] == 'runtime' for argv, cwd in calls)


def test_review_files_and_plan_are_bound_to_current_fingerprint(setup):
    bridge, calls, behavior, instances = setup
    approved = author(bridge)
    checked = bridge.execute({'operation': 'check', 'source': 'build.svrun'}, approved)
    assert checked['status'] == 'completed'
    bridge.execute({'operation': 'plan', 'run': 'build.svrun'}, approved)
    status = bridge.status()
    assert status['fingerprint'] == approved
    assert status['last_plan']['fingerprint'] == approved
    assert status['last_plan']['run'] == 'build.svrun'
    assert status['plan']['format'] == 'hypit.cli-plan@1'
    assert {row['path'].split('/')[-1] for row in status['files']} == {'main.svml', 'build.svrun', 'hypit.runtime.json'}
    assert all(row['kind'] == 'file' and len(row['sha256']) == 64 for row in status['files'])
    bridge.write('main.svml', 'Changed creative Source')
    changed = bridge.status()
    assert changed['last_plan'] is None
    assert changed['plan'] is None


def test_inspecting_old_build_cannot_unlock_lost_new_submission(setup):
    bridge, calls, behavior, instances = setup
    approved = author(bridge)
    bridge.execute({'operation': 'build', 'run': 'build.svrun'}, approved)
    behavior['build'] = lambda argv, cwd, event: CommandResult(tuple(argv), 1, stderr='new receipt lost')
    lost = bridge.execute({'operation': 'build', 'run': 'build.svrun'}, approved)
    assert lost['build_id'] is None
    bridge.execute({'operation': 'inspect', 'build_id': BUILD}, approved)
    assert bridge._ledger().get('unresolved_submission')
    count = len(calls)
    duplicate = bridge.execute({'operation': 'build', 'run': 'build.svrun'}, approved)
    assert duplicate['status'] == 'blocked'
    assert len(calls) == count


def test_confirmed_preflight_cancellation_does_not_lock_future_build(setup, monkeypatch):
    bridge, calls, behavior, instances = setup
    approved = author(bridge)
    original_job = bridge._job
    def cancelled_before_submission(operation, args, event, on_job, **options):
        assert operation == 'build'
        return {'status': 'cancelled', 'command_succeeded': False, 'build_submitted': False}
    monkeypatch.setattr(bridge, '_job', cancelled_before_submission)
    result = bridge.execute({'operation': 'build', 'run': 'build.svrun'}, approved)
    assert result['status'] == 'cancelled'
    assert result['official_execution_state'] == 'not_submitted'
    assert not bridge._ledger().get('unresolved_submission')
    assert calls == []
    monkeypatch.setattr(bridge, '_job', original_job)
    assert bridge.execute({'operation': 'build', 'run': 'build.svrun'}, approved)['command_succeeded']


def test_get_provenance_keeps_original_build_version_after_source_changes(setup, monkeypatch):
    bridge, calls, behavior, instances = setup
    approved = author(bridge)
    bridge.execute({'operation': 'build', 'run': 'build.svrun'}, approved)
    assert bridge._ledger()['builds'][BUILD]['fingerprint'] == approved
    bridge.write('main.svml', 'new author source')
    newer = bridge.fingerprint()
    assert newer != approved
    monkeypatch.setattr('web_api.media_pipeline._probe_media', lambda _: {'video': True})
    result = bridge.execute({'operation': 'get', 'build_id': BUILD, 'output': 'film.video'}, newer)
    assert result['command_succeeded']
    assert result['build_fingerprint'] == approved
    assert bridge._ledger()['builds'][BUILD]['fingerprint'] == approved


@pytest.mark.parametrize('arguments', [
    {'operation': 'native_cli', 'command_line': 'build x'},
    {'operation': 'build', 'run': 'build.svrun', 'paid_approval': {'approved': True}},
    {'operation': 'plan', 'run': 'build.svrun', 'runtime': '/tmp/profile.json'},
    {'operation': 'check', 'source': 'main.svml', 'follow': True},
    {'operation': 'inspect', 'build_id': 'other-session-build'},
    {'operation': 'get', 'build_id': BUILD, 'output': 'film.video', 'to': 'main.svml'},
])
def test_execute_has_closed_operation_parameters(setup, arguments):
    bridge, calls, behavior, instances = setup
    approved = author(bridge)
    with pytest.raises(ValueError):
        bridge.execute(arguments, approved)
    assert calls == []


def test_external_build_is_blocked_without_submission_or_fake_budget(setup):
    bridge, calls, behavior, instances = setup
    approved = author(bridge)
    behavior['plan'] = lambda *args: local_plan(external=True)
    result = bridge.execute({'operation': 'build', 'run': 'build.svrun'}, approved)
    assert result['status'] == 'blocked'
    assert result['external_build_blocked'] is True
    assert result['cost_classification'] == 'external'
    assert [argv[2] for argv, cwd in calls] == ['plan']
    assert bridge._ledger()['builds'] == {}
    assert not bridge._ledger().get('unresolved_submission')
    assert 'budget' not in str(result)


def test_build_id_is_durable_and_active_build_observed_via_official_status(setup):
    bridge, calls, behavior, instances = setup
    approved = author(bridge)
    behavior['build'] = lambda *args: {'format': 'hypit.cli-build@1', 'build': build_view(active=True)}
    result = bridge.execute({'operation': 'build', 'run': 'build.svrun'}, approved)
    assert result['status'] == 'build_completed'
    assert result['build_id'] == BUILD
    assert result['delivery_verified'] is False
    assert bridge._ledger()['builds'][BUILD]['execution_state'] == 'terminal'
    assert [argv[2] for argv, cwd in calls] == ['plan', 'build', 'status']
    assert '--follow' not in calls[1][0]
    recovered = HypitDirectorBridge(bridge.project, bridge.run, runtime_factory=bridge.runtime_factory)
    assert BUILD in recovered._ledger()['builds']
    inspected = recovered.execute({'operation': 'inspect', 'build_id': BUILD}, approved)
    assert inspected['native_result']['build']['outputs'][0]['name'] == 'film.video'
    recovered.close(wait=True)


def test_unknown_submission_blocks_duplicate_build(setup):
    bridge, calls, behavior, instances = setup
    approved = author(bridge)
    behavior['build'] = lambda argv, cwd, event: CommandResult(tuple(argv), 1, stderr='response lost')
    first = bridge.execute({'operation': 'build', 'run': 'build.svrun'}, approved)
    count = len(calls)
    second = bridge.execute({'operation': 'build', 'run': 'build.svrun'}, approved)
    assert first['official_execution_state'] == 'unknown'
    assert second['status'] == 'blocked'
    assert len(calls) == count
    assert bridge._ledger()['unresolved_submission']['state'] == 'unknown'


def test_cancel_known_build_uses_official_cancel_and_confirms_status(setup):
    bridge, calls, behavior, instances = setup
    approved = author(bridge)
    event = threading.Event()
    behavior['build'] = lambda *args: {'format': 'hypit.cli-build@1', 'build': build_view(active=True)}
    behavior['cancel'] = lambda *args: {'format': 'hypit.cli-cancel@1', 'requested': True, 'build': build_view(active=True)}
    behavior['status'] = lambda *args: {'format': 'hypit.cli-status@1', 'build': build_view(cancelled=True)}

    def cancel_after_receipt(row):
        if row.get('parsed', {}).get('format') == 'hypit.cli-build@1':
            event.set()

    result = bridge.execute({'operation': 'build', 'run': 'build.svrun'}, approved, event, cancel_after_receipt)
    assert result['build_id'] == BUILD
    assert result['status'] == 'cancelled'
    assert result['official_cancellation'] == 'confirmed'
    assert bridge._ledger()['builds'][BUILD]['official_cancellation'] == 'confirmed'
    assert [argv[2] for argv, cwd in calls] == ['plan', 'build', 'cancel', 'status']


def test_cancel_without_build_receipt_does_not_claim_official_cancel(setup):
    bridge, calls, behavior, instances = setup
    approved = author(bridge)
    event = threading.Event()

    def lost_receipt(argv, cwd, cancel_event):
        event.set()
        return CommandResult(tuple(argv), None, cancelled=True)

    behavior['build'] = lost_receipt
    result = bridge.execute({'operation': 'build', 'run': 'build.svrun'}, approved, event)
    assert result['build_id'] is None
    assert result['official_cancellation'] == 'unknown'
    assert result['observer_stopped'] is True
    assert 'cancel' not in [argv[2] for argv, cwd in calls]
    assert bridge._ledger().get('unresolved_submission')
    assert bridge._ledger()['unresolved_submission']['official_cancellation'] == 'unknown'
    assert result['status'] == 'interrupted'
    assert '官方 Build 已取消' not in result['message']


def test_cancel_request_without_confirmation_preserves_nonterminal_build(setup):
    bridge, calls, behavior, instances = setup
    approved = author(bridge)
    event = threading.Event()
    behavior['build'] = lambda *args: {'format': 'hypit.cli-build@1', 'build': build_view(active=True)}
    behavior['cancel'] = lambda *args: {'format': 'hypit.cli-cancel@1', 'requested': True, 'build': build_view(active=True)}
    behavior['status'] = lambda *args: {'format': 'hypit.cli-status@1', 'build': build_view(active=True)}

    def stop(row):
        if row.get('parsed', {}).get('format') == 'hypit.cli-build@1':
            event.set()

    result = bridge.execute({'operation': 'build', 'run': 'build.svrun'}, approved, event, stop)
    assert result['status'] == 'interrupted'
    assert result['official_cancellation'] == 'requested'
    assert bridge._ledger()['builds'][BUILD]['execution_state'] == 'active'
    count = len(calls)
    duplicate = bridge.execute({'operation': 'build', 'run': 'build.svrun'}, approved)
    assert duplicate['status'] == 'blocked'
    assert len(calls) == count


def test_get_only_official_session_outputs_to_fresh_probed_exports(setup, monkeypatch):
    bridge, calls, behavior, instances = setup
    approved = author(bridge)
    bridge.execute({'operation': 'build', 'run': 'build.svrun'}, approved)
    monkeypatch.setattr('web_api.media_pipeline._probe_media', lambda path: {'video': {'codec': 'h264', 'width': 4, 'height': 4}})
    first = bridge.execute({'operation': 'get', 'build_id': BUILD, 'output': 'film.video'}, approved)
    second = bridge.execute({'operation': 'get', 'build_id': BUILD, 'output': 'film.video'}, approved)
    for result in (first, second):
        output = result['outputs'][0]
        assert output['kind'] == 'video'
        assert output['playable'] is True
        assert output['bytes'] == len(b'real-export')
        assert len(output['sha256']) == 64
        assert output['path'].startswith(bridge.workspace_root + '/exports/')
        assert (bridge.project / output['path']).read_bytes() == b'real-export'
        assert result['delivery_verified'] is False
    assert first['outputs'][0]['path'] != second['outputs'][0]['path']
    with pytest.raises(ValueError, match='官方 Inspect'):
        bridge.execute({'operation': 'get', 'build_id': BUILD, 'output': 'invented.video'}, approved)
    assert [argv[2] for argv, cwd in calls].count('get') == 2
    assert bridge.fingerprint() == approved


def test_get_success_without_file_is_failed(setup):
    bridge, calls, behavior, instances = setup
    approved = author(bridge)
    bridge.execute({'operation': 'build', 'run': 'build.svrun'}, approved)
    behavior['get'] = lambda argv, cwd, event: {'format': 'hypit.cli-get@1', 'build': BUILD,
        'output': 'film.video', 'path': str(cwd / argv[argv.index('--to') + 1]), 'kind': 'resource', 'type': '@hypit/artifact@1/Blob'}
    result = bridge.execute({'operation': 'get', 'build_id': BUILD, 'output': 'film.video'}, approved)
    assert result['status'] == 'failed'
    assert result['command_succeeded'] is False
    assert result['outputs'] == []


def test_get_invalid_fresh_inspect_cannot_use_old_output_registry(setup):
    bridge, calls, behavior, instances = setup
    approved = author(bridge)
    bridge.execute({'operation': 'build', 'run': 'build.svrun'}, approved)
    bridge.execute({'operation': 'inspect', 'build_id': BUILD}, approved)
    behavior['inspect'] = lambda *args: {'ok': True}
    with pytest.raises(ValueError, match='有效官方 Inspect'):
        bridge.execute({'operation': 'get', 'build_id': BUILD, 'output': 'film.video'}, approved)
    assert 'get' not in [argv[2] for argv, cwd in calls]


def test_get_does_not_trust_exit_success_as_playable_media(setup, monkeypatch):
    bridge, calls, behavior, instances = setup
    approved = author(bridge)
    bridge.execute({'operation': 'build', 'run': 'build.svrun'}, approved)
    monkeypatch.setattr('web_api.media_pipeline._probe_media', lambda path: None)
    result = bridge.execute({'operation': 'get', 'build_id': BUILD, 'output': 'film.video'}, approved)
    assert result['status'] == 'completed'  # official command, not media acceptance
    assert result['outputs'][0]['playable'] is False
    assert result['outputs'][0]['kind'] == 'file'
    assert result['delivery_verified'] is False


def test_get_receipt_path_must_match_server_allocated_file(setup):
    bridge, calls, behavior, instances = setup
    approved = author(bridge)
    bridge.execute({'operation': 'build', 'run': 'build.svrun'}, approved)

    def wrong_path(argv, cwd, event):
        (cwd / argv[argv.index('--to') + 1]).write_bytes(b'something')
        return {'format': 'hypit.cli-get@1', 'build': BUILD, 'output': 'film.video',
                'path': 'main.svml', 'kind': 'resource', 'type': '@hypit/artifact@1/Blob'}

    behavior['get'] = wrong_path
    with pytest.raises(ValueError, match='服务器分配'):
        bridge.execute({'operation': 'get', 'build_id': BUILD, 'output': 'film.video'}, approved)


def test_register_component_creates_fixed_metadata_without_loading_or_installing(setup):
    bridge, calls, behavior, instances = setup
    bridge.write('packages/chat-scene/src/activation.js', 'export default {register() {}};')
    bridge.write('packages/chat-scene/src/render.js', 'export const render = () => "scene";')
    before = bridge.fingerprint()
    registered = bridge.register_component('@openmontage/chat-scene', 'src/activation.js', 'src/render.js')
    package = bridge.project / registered['path']
    metadata = json.loads(package.read_text('utf-8'))
    assert metadata == {'name': '@openmontage/chat-scene', 'version': '0.0.0', 'private': True,
        'type': 'module', 'hypit': {'activation': './src/activation.js'}, 'exports': {'.': './src/render.js'}}
    assert registered['status'] == 'component_registered'
    assert registered['fingerprint'] != before
    status = bridge.status()
    assert status['components'] == [registered['component']]
    assert registered['path'] in {row['path'] for row in status['files']}
    assert 'register_component' in status['supported_authoring_operations']
    assert not (bridge.workspace / 'node_modules').exists()
    assert not (bridge.workspace / 'package.json').exists()
    assert calls == []


def test_component_registration_can_use_authored_typescript_without_compilation(setup):
    bridge, calls, behavior, instances = setup
    bridge.write('packages/scene/src/activation.ts', 'export const activation: object = {};')
    result = bridge.register_component('@openmontage/scene', 'src/activation.ts')
    metadata = json.loads((bridge.project / result['path']).read_text('utf-8'))
    assert metadata['hypit']['activation'] == './src/activation.ts'
    assert 'exports' not in metadata
    assert not (bridge.workspace / 'packages/scene/dist').exists()
    assert calls == []


@pytest.mark.parametrize('name', ['@hypit/scene', '@example/scene', 'scene', '@openmontage/../escape',
                                 '@openmontage/Scene', '@openmontage/', '@openmontage/a.b'])
def test_component_registration_name_cannot_shadow_pinned_packages(setup, name):
    bridge, calls, behavior, instances = setup
    with pytest.raises(ValueError, match='组件名称'):
        bridge.register_component(name, 'src/activation.js')
    assert not bridge.workspace.exists()
    assert calls == []


@pytest.mark.parametrize('activation', ['../outside.js', '/tmp/outside.js', '.hidden.js',
                                      'src/../outside.js', 'src/activation.py', 'src/missing.js'])
def test_component_registration_requires_scoped_authored_entry(setup, activation):
    bridge, calls, behavior, instances = setup
    bridge.write('packages/scene/src/activation.js', 'export default {};')
    with pytest.raises(ValueError):
        bridge.register_component('@openmontage/scene', activation)
    assert not (bridge.workspace / 'packages/scene/package.json').exists()
    assert calls == []


def test_component_registration_requires_write_receipt_not_just_existing_file(setup):
    bridge, calls, behavior, instances = setup
    bridge.write('Brief.md', 'Scoped local work')
    activation = bridge.workspace / 'packages/scene/src/activation.js'
    activation.parent.mkdir(parents=True)
    activation.write_text('export default {};', encoding='utf-8')
    with pytest.raises(ValueError, match='write 记录'):
        bridge.register_component('@openmontage/scene', 'src/activation.js')
    bridge.write('packages/scene/src/activation.js', 'export default {};')
    assert bridge.register_component('@openmontage/scene', 'src/activation.js')['status'] == 'component_registered'
    assert calls == []


def test_component_registration_rejects_symlink_even_inside_own_package(setup):
    bridge, calls, behavior, instances = setup
    bridge.write('packages/scene/src/real-activation.js', 'export default {};')
    (bridge.workspace / 'packages/scene/src/activation.js').symlink_to('real-activation.js')
    with pytest.raises(ValueError, match='符号链接'):
        bridge.register_component('@openmontage/scene', 'src/activation.js')
    assert calls == []


def test_reregister_preserves_metadata_and_invalidates_plan_approval(setup):
    bridge, calls, behavior, instances = setup
    author(bridge)
    bridge.write('packages/scene/src/activation.js', 'export default {};')
    bridge.write('packages/scene/src/render.js', 'export const render = () => true;')
    first = bridge.register_component('@openmontage/scene', 'src/activation.js')
    original = (bridge.project / first['path']).read_bytes()
    bridge.execute({'operation': 'plan', 'run': 'build.svrun'}, first['fingerprint'])
    assert bridge.status()['last_plan'] is not None
    second = bridge.register_component('@openmontage/scene', 'src/activation.js', 'src/render.js')
    assert (bridge.project / second['previous_version']).read_bytes() == original
    assert second['fingerprint'] != first['fingerprint']
    assert bridge.status()['last_plan'] is None
    with pytest.raises(ValueError, match='审批失效'):
        bridge.execute({'operation': 'plan', 'run': 'build.svrun'}, first['fingerprint'])
    with pytest.raises(ValueError, match='执行配置'):
        bridge.write('packages/scene/package.json', '{"scripts":{"build":"anything"}}')


def test_registered_metadata_tampering_blocks_execution(setup):
    bridge, calls, behavior, instances = setup
    author(bridge)
    bridge.write('packages/scene/src/activation.js', 'export default {};')
    registered = bridge.register_component('@openmontage/scene', 'src/activation.js')
    package = bridge.project / registered['path']
    metadata = json.loads(package.read_text('utf-8'))
    metadata['scripts'] = {'build': 'not permitted'}
    package.write_text(json.dumps(metadata), encoding='utf-8')
    with pytest.raises(ValueError, match='服务端组件配置'):
        bridge.execute({'operation': 'check', 'source': 'main.svml'}, registered['fingerprint'])
    assert calls == []


def test_registered_component_rehydrates_from_session_ledger(setup):
    bridge, calls, behavior, instances = setup
    bridge.write('packages/scene/src/activation.js', 'export default {};')
    registered = bridge.register_component('@openmontage/scene', 'src/activation.js')
    recovered = HypitDirectorBridge(bridge.project, bridge.run, runtime_factory=bridge.runtime_factory)
    assert recovered.fingerprint() == registered['fingerprint']
    assert recovered.status()['components'] == [registered['component']]
    recovered.close(wait=True)
    assert calls == []


def test_register_component_is_authoring_not_an_executable_operation(setup):
    bridge, calls, behavior, instances = setup
    approved = author(bridge)
    with pytest.raises(ValueError):
        bridge.execute({'operation': 'register_component', 'name': '@openmontage/scene',
                        'activation': 'src/activation.js'}, approved)
    with pytest.raises(TypeError):
        bridge.register_component('@openmontage/scene', 'src/activation.js', scripts={'build': 'anything'})
    assert calls == []


@pytest.mark.parametrize('suffix', ['.ogv', '.ts'])
def test_extended_media_suffix_import_requires_successful_probe(setup, monkeypatch, suffix):
    bridge, calls, behavior, instances = setup
    source = bridge.project / ('reference' + suffix)
    source.write_bytes(b'media-sample')
    monkeypatch.setattr('web_api.media_pipeline._probe_media', lambda path: None)
    with pytest.raises(ValueError, match='媒体探测'):
        bridge.import_media(source.name)
    monkeypatch.setattr('web_api.media_pipeline._probe_media', lambda path: {'video': {'codec': 'test', 'width': 4, 'height': 4}})
    result = bridge.import_media(source.name)
    assert result['outputs'][0]['kind'] == 'video'
    assert result['outputs'][0]['playable'] is True
    assert result['author_path'].endswith(suffix)
    assert calls == []


def test_author_typescript_is_not_treated_as_media_during_write_or_review(setup, monkeypatch):
    bridge, calls, behavior, instances = setup
    probed = []
    monkeypatch.setattr('web_api.media_pipeline._probe_media', lambda path: probed.append(path))
    written = bridge.write('packages/scene/src/activation.ts', 'export const activation: object = {};')
    bridge.register_component('@openmontage/scene', 'src/activation.ts')
    record = next(row for row in bridge.status()['files'] if row['path'] == written['path'])
    assert record['kind'] == 'file'
    assert not probed
    project_source = bridge.project / 'source.ts'
    project_source.write_text('export const source = 1;', encoding='utf-8')
    with pytest.raises(ValueError, match='媒体探测'):
        bridge.import_media('source.ts')
    assert probed == [project_source]


def isolated_browser_selection(monkeypatch, tmp_path):
    """Tests never rely on a real CI/host Chrome installation."""
    monkeypatch.delenv('OPENMONTAGE_HYPIT_CHROME_PATH', raising=False)
    monkeypatch.setattr(bridge_module, 'STANDARD_MAC_CHROME', tmp_path / 'absent-standard-chrome')
    original_which = bridge_module.shutil.which
    monkeypatch.setattr(bridge_module.shutil, 'which',
        lambda name: None if name in {'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'} else original_which(name))


def fake_browser(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('protocol fixture; never executed', encoding='utf-8')
    path.chmod(0o755)
    return path


def test_server_configured_chrome_is_in_fixed_local_profile(setup, monkeypatch, tmp_path):
    bridge, calls, behavior, instances = setup
    isolated_browser_selection(monkeypatch, tmp_path)
    browser = fake_browser(tmp_path / 'admin chrome' / 'chrome')
    monkeypatch.setenv('OPENMONTAGE_HYPIT_CHROME_PATH', str(browser))
    template = json.loads(bridge_module.PROFILE_TEMPLATE.read_bytes())
    template_before = bridge_module.PROFILE_TEMPLATE.read_bytes()
    bridge.write('main.svml', 'author source')
    profile = json.loads((bridge.workspace / 'hypit.runtime.json').read_bytes())
    assert profile['endpoints']['hyperframes.local']['config'] == {
        **template['endpoints']['hyperframes.local']['config'], 'chromePath': str(browser)}
    assert profile['endpoints']['media.local'] == template['endpoints']['media.local']
    assert set(profile['endpoints']) == {'media.local', 'hyperframes.local'}
    assert bridge_module.PROFILE_TEMPLATE.read_bytes() == template_before
    status = bridge.status()
    assert status['browser']['chrome_path'] == str(browser)
    assert status['browser']['source'] == 'environment'
    assert status['browser']['execution_verified'] is False
    assert status['runtime_execution_verified'] is False
    assert hypit_capabilities()['browser']['chrome_path'] == str(browser)
    assert calls == []


def test_standard_existing_chrome_is_auto_selected(setup, monkeypatch, tmp_path):
    bridge, calls, behavior, instances = setup
    isolated_browser_selection(monkeypatch, tmp_path)
    browser = fake_browser(tmp_path / 'Applications' / 'Google Chrome.app' / 'Contents' / 'MacOS' / 'Google Chrome')
    monkeypatch.setattr(bridge_module, 'STANDARD_MAC_CHROME', browser)
    bridge.write('main.svml', 'author source')
    profile = json.loads((bridge.workspace / 'hypit.runtime.json').read_bytes())
    assert profile['endpoints']['hyperframes.local']['config']['chromePath'] == str(browser)
    assert bridge.status()['browser']['source'] == 'standard_macos'
    assert calls == []


def test_linux_path_chromium_is_auto_selected(setup, monkeypatch, tmp_path):
    bridge, calls, behavior, instances = setup
    isolated_browser_selection(monkeypatch, tmp_path)
    browser = fake_browser(tmp_path / 'bin' / 'chromium')
    original_which = bridge_module.shutil.which
    monkeypatch.setattr(bridge_module.sys, 'platform', 'linux')
    monkeypatch.setattr(bridge_module.shutil, 'which', lambda name: str(browser) if name == 'chromium' else original_which(name))
    bridge.write('main.svml', 'author source')
    profile = json.loads((bridge.workspace / 'hypit.runtime.json').read_bytes())
    assert profile['endpoints']['hyperframes.local']['config']['chromePath'] == str(browser)
    assert bridge.status()['browser']['source'] == 'host_path'
    assert calls == []


def test_no_existing_browser_preserves_exact_default_profile(setup, monkeypatch, tmp_path):
    bridge, calls, behavior, instances = setup
    isolated_browser_selection(monkeypatch, tmp_path)
    before = bridge_module.PROFILE_TEMPLATE.read_bytes()
    bridge.write('main.svml', 'author source')
    assert (bridge.workspace / 'hypit.runtime.json').read_bytes() == before
    status = bridge.status()
    assert status['browser']['chrome_path'] is None
    assert status['browser']['state'] == 'managed_default'
    assert status['browser']['execution_verified'] is False
    assert calls == []


@pytest.mark.parametrize('configured', ['missing', 'not_executable', 'relative'])
def test_invalid_admin_browser_does_not_become_profile_input(setup, monkeypatch, tmp_path, configured):
    bridge, calls, behavior, instances = setup
    isolated_browser_selection(monkeypatch, tmp_path)
    browser = tmp_path / 'nonexecutable-chrome'
    browser.write_text('not executable', encoding='utf-8')
    browser.chmod(0o644)
    value = str(tmp_path / 'missing-chrome') if configured == 'missing' else str(browser) if configured == 'not_executable' else 'relative/chrome'
    monkeypatch.setenv('OPENMONTAGE_HYPIT_CHROME_PATH', value)
    before = bridge_module.PROFILE_TEMPLATE.read_bytes()
    bridge.write('main.svml', 'author source')
    assert (bridge.workspace / 'hypit.runtime.json').read_bytes() == before
    assert bridge.status()['browser']['configured_path_valid'] is False
    assert calls == []


def test_explicit_template_chrome_fixture_preserves_exact_profile_bytes(setup, monkeypatch, tmp_path):
    bridge, calls, behavior, instances = setup
    isolated_browser_selection(monkeypatch, tmp_path)
    browser = fake_browser(tmp_path / 'admin-chrome')
    monkeypatch.setenv('OPENMONTAGE_HYPIT_CHROME_PATH', str(browser))
    profile = json.loads(bridge_module.PROFILE_TEMPLATE.read_bytes())
    profile['endpoints']['hyperframes.local']['config']['chromePath'] = '/fixture/explicit/chrome'
    payload = json.dumps(profile, separators=(',', ':')).encode('utf-8')
    template = tmp_path / 'fixture.runtime.json'
    template.write_bytes(payload)
    monkeypatch.setattr(bridge_module, 'PROFILE_TEMPLATE', template)
    bridge.write('main.svml', 'author source')
    assert (bridge.workspace / 'hypit.runtime.json').read_bytes() == payload
    assert bridge.fingerprint()
    assert bridge.status()['browser']['chrome_path'] == '/fixture/explicit/chrome'
    assert bridge.status()['browser']['source'] == 'profile_template'
    assert calls == []


def test_model_cannot_replace_selected_chrome_or_insert_external_endpoint(setup, monkeypatch, tmp_path):
    bridge, calls, behavior, instances = setup
    isolated_browser_selection(monkeypatch, tmp_path)
    browser = fake_browser(tmp_path / 'admin-chrome')
    monkeypatch.setenv('OPENMONTAGE_HYPIT_CHROME_PATH', str(browser))
    approved = author(bridge)
    with pytest.raises(ValueError, match='执行参数'):
        bridge.execute({'operation': 'plan', 'run': 'build.svrun', 'chromePath': '/model/chrome'}, approved)
    with pytest.raises(ValueError, match='执行配置'):
        bridge.write('hypit.runtime.json', '{}')
    profile = json.loads((bridge.workspace / 'hypit.runtime.json').read_bytes())
    profile['endpoints']['hyperframes.local']['config']['chromePath'] = '/model/tampered-chrome'
    (bridge.workspace / 'hypit.runtime.json').write_text(json.dumps(profile), encoding='utf-8')
    with pytest.raises(ValueError, match='Profile 已改变'):
        bridge.execute({'operation': 'plan', 'run': 'build.svrun'}, approved)
    profile['endpoints']['remote'] = {'use': '@hypit/provider-hypihub'}
    (bridge.workspace / 'hypit.runtime.json').write_text(json.dumps(profile), encoding='utf-8')
    with pytest.raises(ValueError, match='Profile 已改变'):
        bridge.execute({'operation': 'plan', 'run': 'build.svrun'}, approved)
    assert calls == []


def test_server_template_with_external_endpoint_is_rejected(setup, monkeypatch, tmp_path):
    bridge, calls, behavior, instances = setup
    isolated_browser_selection(monkeypatch, tmp_path)
    profile = json.loads(bridge_module.PROFILE_TEMPLATE.read_bytes())
    profile['endpoints']['remote'] = {'use': '@hypit/provider-hypihub'}
    template = tmp_path / 'bad.runtime.json'
    template.write_text(json.dumps(profile), encoding='utf-8')
    monkeypatch.setattr(bridge_module, 'PROFILE_TEMPLATE', template)
    with pytest.raises(ValueError, match='外部 Provider'):
        bridge.write('main.svml', 'author source')
    assert not bridge.workspace.exists()
    assert calls == []
