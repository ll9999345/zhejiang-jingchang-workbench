"""Version contracts, ownership and authorization across the two fixed SDKs."""
import json
import threading
from pathlib import Path

import pytest

from web_api.hypit_runtime import HypitRuntime, HypitRuntimeError, HypitSettings, CommandResult
from web_api.tests.test_hypit_runtime import checkout, project, plan_payload, wait_for


def runtime_for(tmp_path, version, runner=None, **settings):
    source = checkout(tmp_path)
    (source / 'package.json').write_text(json.dumps({'name': '@hypit/hypit', 'version': version}))
    selected = project(tmp_path)
    config = HypitSettings(tmp_path / 'projects', source, **settings)
    return HypitRuntime(settings=config, runner=runner), selected


COMMANDS = [
    ('doctor', {}), ('check', {'source': 'main.svml'}),
    ('plan', {'run': 'build.svrun'}), ('build', {'run': 'build.svrun', 'follow': True}),
    ('studio', {'run': 'build.svrun'}), ('builds', {}),
    ('history', {'output': 'final.video'}), ('inspect', {'build_id': 'bld_test'}),
    ('build_status', {'build_id': 'bld_test'}), ('cancel', {'build_id': 'bld_test'}),
    ('get', {'build_id': 'bld_test', 'output': 'final.video', 'to': 'new/result.mp4'}),
]


@pytest.mark.parametrize('version,flag', [('0.2.12', '--workspace'), ('0.3.1', '--project')])
@pytest.mark.parametrize('operation,params', COMMANDS)
def test_named_commands_match_fixed_dialect(tmp_path, version, flag, operation, params):
    runtime, selected = runtime_for(tmp_path, version)
    try:
        argv = runtime.command_for(operation, selected, **params)
        assert argv[argv.index(flag) + 1] == str(selected)
        assert ('--project' if flag == '--workspace' else '--workspace') not in argv
        assert ('--runtime' in argv) == (version == '0.3.1' and operation in {'plan', 'build'})
        if '--runtime' in argv:
            assert argv[argv.index('--runtime') + 1] == str(selected / 'hypit.runtime.json')
        assert runtime.status(selected)['checkout']['version'] == version
        assert runtime.catalog(selected)['version'] == version
    finally:
        runtime.close()


@pytest.mark.parametrize('flag', ['--project', '--workspace'])
@pytest.mark.parametrize('inline', [True, False])
def test_native_both_project_selectors_are_bounded(tmp_path, flag, inline):
    runtime, selected = runtime_for(tmp_path, '0.3.1')
    try:
        option = flag + ('=../other' if inline else ' ../other')
        with pytest.raises(HypitRuntimeError, match='当前选择的项目'):
            runtime.command_for('native_cli', selected, command_line='check main.svml ' + option)
        exact = f'check main.svml {flag}="{selected}"'
        assert runtime.command_for('native_cli', selected, command_line=exact)[-1] == f'{flag}={selected}'
        # Do not reinterpret a captured child command's arguments after --.
        argv = runtime.command_for('native_cli', selected, command_line=f'capture run -- node child.js {option}')
        assert '../other' in ' '.join(argv)
    finally:
        runtime.close()


def test_unknown_dialect_reports_truth_and_never_executes_or_creates_project(tmp_path):
    runtime, selected = runtime_for(tmp_path, '0.4.0')
    before = set(runtime.project_root.iterdir())
    try:
        assert runtime.status(selected)['status'] == 'degraded'
        assert runtime.status(selected)['checkout']['commit'] is None
        for op, args in [('check', {'source': 'main.svml'}), ('native_cli', {'command_line': '--help'})]:
            with pytest.raises(HypitRuntimeError, match='尚未验证'):
                runtime.command_for(op, selected, **args)
        with pytest.raises(HypitRuntimeError, match='尚未验证'):
            runtime.initialize_project(selected)
        assert set(runtime.project_root.iterdir()) == before
    finally:
        runtime.close()


def test_new_version_cannot_export_old_bridge_format(tmp_path):
    runtime, selected = runtime_for(tmp_path, '0.3.1')
    try:
        with pytest.raises(HypitRuntimeError, match='尚未迁移'):
            runtime.submit('bridge_export', selected)
        with pytest.raises(HypitRuntimeError, match='尚未迁移'):
            runtime.export_openmontage(selected, {}, threading.Event())
        assert not (selected / 'artifacts').exists()
    finally:
        runtime.close()


def test_new_version_jobs_do_not_interrupt_or_list_legacy_active_receipts(tmp_path):
    runtime, selected = runtime_for(tmp_path, '0.3.1')
    old_id = 'hypit-' + 'a' * 24
    old_path = selected / 'artifacts/hypit_jobs' / old_id / 'job.json'
    old_path.parent.mkdir(parents=True)
    old_path.write_text(json.dumps({'job_id': old_id, 'status': 'running'}))
    before = old_path.read_bytes()
    try:
        assert runtime.list(selected) == []
        with pytest.raises(HypitRuntimeError, match='找不到'):
            runtime.get(selected, old_id)
        assert old_path.read_bytes() == before
        job = runtime.submit('manifest', selected)
        assert wait_for(runtime, selected, job['job_id'])['distribution_version'] == '0.3.1'
        assert runtime.list(selected)[0]['job_id'] == job['job_id']
        assert runtime._job_project(job['job_id']) == selected
        assert old_path.read_bytes() == before
    finally:
        runtime.close()


def test_child_env_has_server_selected_node_and_isolated_state_only(tmp_path, monkeypatch):
    seen = []
    def runner(argv, **kw):
        seen.append((argv, kw['env']))
        return CommandResult(tuple(argv), 0, '{}', '')
    node = str(tmp_path / 'node/bin/node')
    runtime, selected = runtime_for(tmp_path, '0.3.1', runner, node_executable=node, state_home=tmp_path / 'host-state')
    monkeypatch.setenv('UNRELATED_API_KEY', 'do-not-copy')
    monkeypatch.setenv('HYPIT_STATE_HOME', 'unrelated-host')
    try:
        runtime._operation('check', selected, {'source': 'main.svml'}, threading.Event())
        argv, env = seen[0]
        assert argv[0] == node
        assert env['HYPIT_STATE_HOME'] == str(tmp_path / 'host-state')
        assert env['PATH'].startswith(str(Path(node).parent))
        assert 'UNRELATED_API_KEY' not in env
    finally:
        runtime.close()


def test_new_version_external_plan_still_requires_paid_approval(tmp_path):
    commands = []
    def runner(argv, **kw):
        commands.append(argv[2])
        return CommandResult(tuple(argv), 0, json.dumps(plan_payload(external=True)), '')
    runtime, selected = runtime_for(tmp_path, '0.3.1', runner)
    try:
        result = runtime._operation('build', selected, {'run': 'build.svrun'}, threading.Event())
        assert result['status'] == 'authorization_required'
        assert result['build_submitted'] is False
        assert commands == ['plan']
    finally:
        runtime.close()


def test_imported_new_example_links_only_declared_installed_dependencies(tmp_path):
    runtime, selected = runtime_for(tmp_path, '0.3.1')
    source = runtime.hypit_root / 'examples/minimal'
    (source / 'package.json').write_text(json.dumps({'dependencies': {'@hypit/composition': 'workspace:*', 'missing': '1', 'outside': '1', '../bad': '1'}}))
    installed = runtime.hypit_root / 'packages/composition'
    installed.mkdir(parents=True)
    (installed / 'package.json').write_text(json.dumps({'name': '@hypit/composition', 'version': '0.1.0'}))
    link = runtime.hypit_root / 'node_modules/@hypit/composition'
    link.parent.mkdir(parents=True)
    link.symlink_to(installed, target_is_directory=True)
    outside = tmp_path / 'external-package'
    outside.mkdir()
    (outside / 'package.json').write_text(json.dumps({'name': 'outside'}))
    (runtime.hypit_root / 'node_modules/outside').symlink_to(outside, target_is_directory=True)
    # An unrelated installed package must not become available in the copy.
    (runtime.hypit_root / 'node_modules/unrelated').mkdir()
    try:
        result = runtime.import_example(selected, 'minimal', threading.Event())
        copied = runtime.project_root / result['hypit_project_id']
        assert (copied / 'node_modules/@hypit/composition').resolve() == installed
        assert result['dependencies']['linked'] == [{'package': 'package.json', 'dependency': '@hypit/composition', 'version': '0.1.0'}]
        assert {r['dependency'] for r in result['dependencies']['unavailable']} == {'missing', 'outside', '../bad'}
        assert not (copied / 'node_modules/outside').exists()
        assert not (copied / 'node_modules/unrelated').exists()
        assert not (source / 'node_modules').exists()
    finally:
        runtime.close()


def test_profile_symlink_cannot_inject_external_credentials_into_named_build(tmp_path, monkeypatch):
    runtime, selected = runtime_for(tmp_path, '0.3.1')
    outside = tmp_path / 'outside.runtime.json'
    outside.write_text(json.dumps({'endpoints': {'x': {'config': {'apiKey': {'store': 'env', 'key': 'OUTSIDE_API_KEY'}}}}}))
    profile = selected / 'hypit.runtime.json'
    # Rename the test fixture to preserve it, then introduce an escaping link.
    profile.rename(selected / 'original.runtime.json')
    profile.symlink_to(outside)
    monkeypatch.setenv('OUTSIDE_API_KEY', 'never-forward')
    try:
        assert runtime._profile_path(selected) is None
        assert 'OUTSIDE_API_KEY' not in runtime._command_env(selected)
    finally:
        runtime.close()


def test_runtime_init_uses_selected_version_and_node(tmp_path):
    seen = []
    def runner(argv, **kw):
        seen.append(argv)
        return CommandResult(tuple(argv), 0, '{}', '')
    runtime, selected = runtime_for(tmp_path, '0.3.1', runner)
    try:
        result = runtime.initialize_project(selected)
        assert result['status'] == 'created'
        assert seen[0][2:4] == ['runtime', 'init']
        assert '--project' in seen[0] and '--workspace' not in seen[0]
    finally:
        runtime.close()
