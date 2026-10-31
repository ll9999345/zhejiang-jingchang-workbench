import io
import json

import pytest

from scripts import footage_workbench as cli


def install_fake_api(monkeypatch, responses):
    calls = []
    class Opener:
        def open(self, request, timeout):
            body = json.loads(request.data) if request.data is not None else None
            calls.append((request.full_url, body))
            return io.BytesIO(json.dumps(responses.pop(0)).encode())
    monkeypatch.setattr(cli, 'build_opener', lambda *args: Opener())
    monkeypatch.setattr(cli.time, 'sleep', lambda _: None)
    return calls


def test_cli_submits_large_batch_once_to_durable_queue(tmp_path, monkeypatch, capsys):
    path = tmp_path / 'jobs.jsonl'
    path.write_text('\n'.join(json.dumps({'project_id': 'demo', 'script': f'镜头{i}。'}) for i in range(100)), 'utf-8')
    calls = install_fake_api(monkeypatch, [{'ready': True}, {'batch_id': 'batch-abc', 'project_id': 'demo', 'status': 'queued'}])
    assert cli.main(['batch', '--file', str(path), '--stop-at', 'terms']) == 0
    assert len(calls) == 2
    assert calls[0][0].endswith('/batches/preflight') and calls[1][0].endswith('/batches')
    assert all(row['stop_at'] == 'terms' for row in calls[1][1]['requests'])
    assert len(calls[1][1]['requests']) == 100
    assert calls[0][1]['confirm'] is False and calls[1][1]['confirm'] is True
    assert json.loads(capsys.readouterr().out)['batch_id'] == 'batch-abc'


@pytest.mark.parametrize('check,ready', [(True, True), (True, False), (False, False)])
def test_cli_invalid_or_check_only_batch_never_submits(tmp_path, monkeypatch, capsys, check, ready):
    path = tmp_path / 'jobs.json'; path.write_text('[{"project_id":"demo"}]', 'utf-8')
    calls = install_fake_api(monkeypatch, [{'ready': ready, 'items': []}])
    assert cli.main(['batch', '--file', str(path)] + (['--check'] if check else [])) == int(not ready)
    assert len(calls) == 1 and calls[0][0].endswith('/batches/preflight')


def test_cli_wait_polls_batch_not_resubmitting_rows(tmp_path, monkeypatch, capsys):
    path = tmp_path / 'jobs.json'; path.write_text('[{"project_id":"demo"}]', 'utf-8')
    calls = install_fake_api(monkeypatch, [{'ready': True}, {'status': 'queued', 'batch_id': 'batch-abc', 'project_id': 'demo', 'progress': 0, 'message': 'queued'},
                                        {'status': 'partial', 'batch_id': 'batch-abc', 'project_id': 'demo', 'items': [{'status': 'failed'}]}])
    assert cli.main(['batch', '--file', str(path), '--wait']) == 1
    assert len(calls) == 3 and calls[-1][0].endswith('/batches/batch-abc?project_id=demo')
    assert calls[-1][1] is None


@pytest.mark.parametrize('command,suffix', [('batch-list', '/batches?project_id=demo'),
                                         ('batch-status', '/batches/batch-abc?project_id=demo'),
                                         ('batch-cancel', '/batches/batch-abc/cancel')])
def test_cli_batch_records_and_cancellation(monkeypatch, capsys, command, suffix):
    calls = install_fake_api(monkeypatch, [{'status': 'cancelled'}])
    assert cli.main([command, '--project', 'demo'] + (['--batch', 'batch-abc'] if command != 'batch-list' else [])) == 0
    assert calls[0][0].endswith(suffix)
    assert calls[0][1] == ({'project_id': 'demo'} if command == 'batch-cancel' else None)


def test_cli_script_stage_and_proxy_bypass(tmp_path, monkeypatch, capsys):
    path = tmp_path / 'request.json'; path.write_text('{"project_id":"demo","action":"create"}', 'utf-8')
    calls = install_fake_api(monkeypatch, [{'status': 'stage_completed'}])
    assert cli.main(['run', '--request', str(path), '--stop-at', 'script']) == 0
    assert calls[0][1]['stop_at'] == 'script'


def test_cli_rejects_non_local_or_ambiguous_servers_before_request(monkeypatch):
    monkeypatch.setattr(cli, 'build_opener', lambda *args: pytest.fail('must not connect'))
    for url in ('https://example.org', 'http://localhost/another-service', 'http://localhost?token=abc'):
        with pytest.raises(SystemExit):
            cli.main(['--server', url, 'list', '--project', 'demo'])
