from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading

import pytest

from scripts import local_workbench as launcher


def test_start_reuses_ready_service_without_spawning(tmp_path, monkeypatch):
    monkeypatch.setattr(launcher, 'service_state', lambda _: 'ready')
    monkeypatch.setattr(launcher.subprocess, 'Popen', lambda *a, **kw: pytest.fail('must reuse existing service'))
    assert launcher.start(tmp_path, 4750)['started'] is False
    assert not (tmp_path / 'artifacts').exists()


def test_foreign_listener_is_identified_and_never_replaced(tmp_path, monkeypatch):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200); self.end_headers(); self.wfile.write(b'another application')
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    monkeypatch.setattr(launcher.subprocess, 'Popen', lambda *a, **kw: pytest.fail('must preserve other listener'))
    try:
        port = server.server_port
        assert launcher.service_state(port) == 'occupied'
        with pytest.raises(RuntimeError, match='其他服务'):
            launcher.start(tmp_path, port)
        assert launcher.service_state(port) == 'occupied'
    finally:
        server.shutdown(); server.server_close(); thread.join()


def test_fresh_start_detaches_and_keeps_unique_logs(tmp_path, monkeypatch):
    captured = []
    class Child:
        pid = 123456
        def poll(self):
            return None
    def spawn(*args, **kwargs):
        captured.append(kwargs)
        return Child()
    monkeypatch.setattr(launcher.subprocess, 'Popen', spawn)
    monkeypatch.setattr(launcher.time, 'sleep', lambda _: None)
    for _ in range(2):
        states = iter(['stopped', 'ready'])
        monkeypatch.setattr(launcher, 'service_state', lambda _: next(states))
        result = launcher.start(tmp_path, 4750)
        assert result['started'] and result['pid'] == 123456
    assert len(list((tmp_path / 'artifacts/local-server').glob('*.log'))) == 2
    assert len(list((tmp_path / 'artifacts/local-server').glob('start-*.json'))) == 2
    assert all(item['start_new_session'] and item['stdin'] == launcher.subprocess.DEVNULL for item in captured)
    assert all(item['env']['HOST'] == '127.0.0.1' for item in captured)
