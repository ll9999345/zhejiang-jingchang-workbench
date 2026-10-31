"""Installed HyperFrames must work offline without npm installation at discovery."""
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from tools.video.hyperframes_compose import HyperFramesCompose as HF


@pytest.fixture(autouse=True)
def reset_probe(monkeypatch):
    monkeypatch.delenv('HYPERFRAMES_CLI', raising=False)
    monkeypatch.setattr(HF, '_npm_resolve_cache', None)
    monkeypatch.setattr(HF, '_cli_probe_cache', None)


def test_missing_local_cli_never_runs_npm_or_npx(monkeypatch, tmp_path):
    monkeypatch.setattr(HF, '_project_cli', tmp_path / 'not-installed')
    monkeypatch.setattr('tools.video.hyperframes_compose.shutil.which',
                        lambda name: '/usr/bin/' + name if name in {'node', 'ffmpeg', 'npm', 'npx'} else None)
    run = Mock(return_value=SimpleNamespace(returncode=0, stdout='0.8.17\n'))
    monkeypatch.setattr('tools.video.hyperframes_compose.subprocess.run', run)
    assert 'error' in HF._resolve_npm_package()
    run.assert_not_called()


def test_project_cli_used_for_probe_and_execution_without_npx(monkeypatch, tmp_path):
    cli = tmp_path / 'hyperframes'
    cli.touch()
    monkeypatch.setattr(HF, '_project_cli', cli)
    run = Mock(return_value=SimpleNamespace(returncode=0, stdout='0.8.17\n'))
    monkeypatch.setattr('tools.video.hyperframes_compose.subprocess.run', run)
    assert HF._resolve_npm_package() == {'version': '0.8.17'}
    assert HF._probe_cli()['status'] == 'ok'
    assert run.call_count == 1
    assert run.call_args.args[0] == [str(cli), '--version']
    assert run.call_args.kwargs['env']['HYPERFRAMES_NO_TELEMETRY'] == '1'
    HF()._run_hf(['lint', '--json'], cwd=tmp_path, timeout=30, check=False)
    assert run.call_args.args[0] == [str(cli), 'lint', '--json']
    assert run.call_args.kwargs['env']['HYPERFRAMES_NO_TELEMETRY'] == '1'


def test_explicit_missing_cli_does_not_fall_back(monkeypatch, tmp_path):
    cli = tmp_path / 'installed'
    cli.touch()
    monkeypatch.setattr(HF, '_project_cli', cli)
    monkeypatch.setenv('HYPERFRAMES_CLI', str(tmp_path / 'missing'))
    run = Mock(side_effect=FileNotFoundError)
    monkeypatch.setattr('tools.video.hyperframes_compose.subprocess.run', run)
    assert 'error' in HF._resolve_npm_package()
    assert run.call_count == 1
    assert run.call_args.args[0][0] == str(tmp_path / 'missing')


def test_probe_invalidates_when_cli_selection_or_file_changes(monkeypatch, tmp_path):
    first, second = tmp_path / 'one', tmp_path / 'two'
    first.write_text('one')
    second.write_text('two')
    run = Mock(side_effect=[SimpleNamespace(returncode=0, stdout=v) for v in ['0.8.17', '0.8.18', '0.8.19']])
    monkeypatch.setattr('tools.video.hyperframes_compose.subprocess.run', run)
    monkeypatch.setenv('HYPERFRAMES_CLI', str(first))
    assert HF._resolve_npm_package()['version'] == '0.8.17'
    assert HF._resolve_npm_package()['version'] == '0.8.17'
    monkeypatch.setenv('HYPERFRAMES_CLI', str(second))
    assert HF._resolve_npm_package()['version'] == '0.8.18'
    second.write_text('changed executable')
    assert HF._resolve_npm_package()['version'] == '0.8.19'


def test_missing_cli_execution_never_installs(monkeypatch, tmp_path):
    monkeypatch.setattr(HF, '_project_cli', tmp_path / 'missing')
    monkeypatch.setattr('tools.video.hyperframes_compose.shutil.which', lambda _: None)
    run = Mock()
    monkeypatch.setattr('tools.video.hyperframes_compose.subprocess.run', run)
    with pytest.raises(FileNotFoundError, match='HyperFrames'):
        HF()._run_hf(['render'], cwd=tmp_path, timeout=30, check=False)
    run.assert_not_called()


def test_bad_bootstrap_is_not_available(monkeypatch, tmp_path):
    monkeypatch.setenv('HYPERFRAMES_CLI', str(tmp_path / 'broken'))
    monkeypatch.setattr('tools.video.hyperframes_compose.subprocess.run',
                        Mock(return_value=SimpleNamespace(returncode=1, stdout='')))
    assert 'error' in HF._resolve_npm_package()
    assert 'error' in HF._probe_cli()


def test_explicit_local_cli_does_not_need_npx(monkeypatch, tmp_path):
    monkeypatch.setenv('HYPERFRAMES_CLI', str(tmp_path / 'local'))
    monkeypatch.setattr(HF, '_node_major_version', classmethod(lambda cls: 22))
    monkeypatch.setattr('tools.video.hyperframes_compose.shutil.which',
                        lambda name: '/bin/' + name if name in {'node', 'ffmpeg'} else None)
    run = Mock(return_value=SimpleNamespace(returncode=0, stdout='0.8.17'))
    monkeypatch.setattr('tools.video.hyperframes_compose.subprocess.run', run)
    result = HF()._runtime_check()
    assert result['runtime_available']
    assert not result['npx_available']
    assert result['verification_scope'] == 'local_cli_startup_not_render_acceptance'


def test_probe_cache_expires_and_rechecks_failure(monkeypatch, tmp_path):
    monkeypatch.setenv('HYPERFRAMES_CLI', str(tmp_path / 'cli'))
    clock = [100.0]
    monkeypatch.setattr('tools.video.hyperframes_compose.time.monotonic', lambda: clock[0])
    run = Mock(side_effect=[SimpleNamespace(returncode=1, stdout=''),
                           SimpleNamespace(returncode=0, stdout='0.8.17')])
    monkeypatch.setattr('tools.video.hyperframes_compose.subprocess.run', run)
    assert 'error' in HF._resolve_npm_package()
    assert 'error' in HF._resolve_npm_package()
    assert run.call_count == 1
    clock[0] += 31
    assert HF._resolve_npm_package() == {'version': '0.8.17'}
    assert run.call_count == 2


def test_parallel_catalog_probes_only_start_one_cli(monkeypatch, tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    monkeypatch.setenv('HYPERFRAMES_CLI', str(tmp_path / 'cli'))
    run = Mock(return_value=SimpleNamespace(returncode=0, stdout='0.8.17'))
    monkeypatch.setattr('tools.video.hyperframes_compose.subprocess.run', run)
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda _: HF._resolve_npm_package(), range(12)))
    assert all(row == {'version': '0.8.17'} for row in results)
    assert run.call_count == 1


def scaffold(workspace):
    return HF().execute({'operation': 'scaffold_workspace', 'workspace_path': str(workspace),
                         'edit_decisions': {'cuts': [{'type': 'text_card', 'text': 'Local test',
                                                      'in_seconds': 0, 'out_seconds': 2}]}})


def test_scaffold_preserves_local_script_bytes_and_copyright(monkeypatch, tmp_path):
    script = tmp_path / 'gsap.min.js'
    content = b'/*! GSAP test copyright - retained verbatim */\nwindow.gsap={};'
    script.write_bytes(content)
    monkeypatch.setattr(HF, '_gsap_path', script)
    workspace = tmp_path / 'workspace'
    result = scaffold(workspace)
    assert result.success
    runtime = result.data['animation_runtime']
    assert (workspace / runtime['path']).read_bytes() == content
    html = (workspace / 'index.html').read_text()
    assert f'src="{runtime["path"]}"' in html
    assert 'https://' not in html and 'cdn.' not in html
    assert runtime['automatic_download'] is False


def test_scaffold_missing_gsap_fails_before_writing_workspace(monkeypatch, tmp_path):
    monkeypatch.setattr(HF, '_gsap_path', tmp_path / 'missing')
    workspace = tmp_path / 'workspace'
    result = scaffold(workspace)
    assert not result.success and 'no CDN fallback' in result.error
    assert not workspace.exists()


def test_staging_changed_copy_and_external_symlink_preserves_data(monkeypatch, tmp_path):
    script = tmp_path / 'gsap.min.js'
    script.write_bytes(b'copyright retained')
    monkeypatch.setattr(HF, '_gsap_path', script)
    workspace = tmp_path / 'workspace'
    (workspace / 'assets').mkdir(parents=True)
    runtime = HF()._stage_gsap(workspace)
    target = workspace / runtime['path']
    target.write_bytes(b'existing edited file')
    with pytest.raises(ValueError, match='has changed'):
        HF()._stage_gsap(workspace)
    assert target.read_bytes() == b'existing edited file'
    outside = tmp_path / 'outside'
    outside.mkdir()
    other = tmp_path / 'symlink-workspace'
    other.mkdir()
    (other / 'assets').symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match='stay inside'):
        HF()._stage_gsap(other)
    assert not list(outside.iterdir())


@pytest.mark.parametrize('operation,network', [('render', False), ('render_existing', True), ('check', True),
                                              ('scaffold_workspace', False), ('doctor', True), ('add_block', True)])
def test_explicit_network_operations_remain_separate(operation, network):
    from web_api.montage_registry import effects
    permissions = effects(HF(), {'operation': operation})
    assert permissions['network'] is network
    assert permissions['paid'] is False

