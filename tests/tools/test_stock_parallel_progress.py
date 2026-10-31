"""Bounded real threads and actual decoded local video; no provider requests."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
import shutil
import subprocess
import threading
import time

import pytest
import requests

import tools.video.direct_clip_search as direct
from tools.video.stock_sources.base import Candidate, SearchFilters, SourceAPIError


def test_deadlines_do_not_cross_threads_or_touch_unrelated_calls(monkeypatch):
    seen = {}
    def get(name, **kwargs):
        seen[name] = kwargs.get('timeout')
        return SimpleNamespace()
    monkeypatch.setattr(requests, 'get', get)
    monkeypatch.setattr(direct.time, 'time', lambda: 0.)
    long_ready, short_ready, allow_short_exit, short_exited = [threading.Event() for _ in range(4)]
    def long_task():
        with direct._requests_deadline(50):
            long_ready.set()
            assert short_ready.wait(5)
            requests.get('long', timeout=100)
            allow_short_exit.set()
            assert short_exited.wait(5)
            requests.get('long_after', timeout=(75, 90))
    def short_task():
        assert long_ready.wait(5)
        with direct._requests_deadline(5):
            short_ready.set()
            assert allow_short_exit.wait(5)
            requests.get('short', timeout=100)
        short_exited.set()
    with ThreadPoolExecutor(max_workers=2) as pool:
        one, two = pool.submit(long_task), pool.submit(short_task)
        assert short_ready.wait(5)
        requests.get('outside', timeout=100)
        one.result(6); two.result(6)
    assert seen == {'long': 50., 'long_after': (50., 50.), 'short': 5., 'outside': 100}
    assert requests.get is get
    assert direct._TRANSPORT_USERS == 0


def test_nested_budget_cannot_extend_and_stream_keeps_original_deadline(monkeypatch):
    clock = [0.]
    seen = []
    class Response:
        def iter_content(self):
            yield b'first'
            clock[0] = 11.
            yield b'late'
    def get(*args, **kwargs):
        seen.append(kwargs['timeout']); return Response()
    monkeypatch.setattr(requests, 'get', get)
    monkeypatch.setattr(direct.time, 'time', lambda: clock[0])
    with direct._requests_deadline(10):
        with direct._requests_deadline(30):
            response = requests.get('fixture', timeout=99)
        with pytest.raises(ValueError):
            with direct._requests_deadline(3):
                requests.get('fixture', timeout=99)
                raise ValueError('fixture')
        requests.get('fixture', timeout=99)
    assert seen == [10, 3, 10]
    stream = response.iter_content(); assert next(stream) == b'first'
    with pytest.raises(direct._DeadlineExceeded): next(stream)
    assert requests.get is get


def test_external_transport_replacement_is_not_overwritten(monkeypatch):
    original = lambda *a, **k: SimpleNamespace()
    other = lambda *a, **k: SimpleNamespace()
    monkeypatch.setattr(requests, 'get', original)
    with direct._requests_deadline(time.time() + 30):
        requests.get = other
        with pytest.raises(RuntimeError, match='transport changed'):
            with direct._requests_deadline(time.time() + 30): pass
    assert requests.get is other
    assert direct._TRANSPORT_USERS == 0


@pytest.fixture(scope='module')
def media(tmp_path_factory):
    path = tmp_path_factory.mktemp('parallel-stock') / 'blue.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-n', '-f', 'lavfi', '-i',
                    'color=c=blue:s=160x90:r=12:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(path)],
                   check=True, timeout=20)
    return path


def source(name, media, search=None):
    def find(query, filters):
        return [Candidate(source=name, source_id=query, source_url=f'https://example.test/{name}/{query}',
                          download_url=f'https://example.test/{name}/{query}.mp4', kind='video', duration=1)]
    def download(item, out):
        shutil.copyfile(media, out); return out
    return SimpleNamespace(name=name, is_available=lambda: True, search=search or find, download=download)


def run(monkeypatch, tmp_path, sources, **kwargs):
    import tools.video.stock_sources as registry
    monkeypatch.setattr(registry, 'all_sources', lambda: sources)
    return direct.DirectClipSearch().execute(dict(output_dir=str(tmp_path), queries=[{'query': 'blue'}],
             sources=[s.name for s in sources], extract_thumbnails=False, **kwargs))


def test_parallel_completion_keeps_priority_quota_and_skips_next_batch(monkeypatch, tmp_path, media):
    second_done = threading.Event()
    first = source('first', media); first_search = first.search
    second = source('second', media); second_search = second.search
    def a(query, filters):
        assert second_done.wait(5), 'second source must run concurrently'
        return first_search(query, filters)
    def b(query, filters):
        second_done.set(); return second_search(query, filters)
    first.search, second.search = a, b
    third = source('third', media, lambda *a: pytest.fail('unneeded batch was searched'))
    events = []
    with direct.stock_progress_context(lambda row: events.append((threading.get_ident(), row))):
        result = run(monkeypatch, tmp_path, [first, second, third], clips_per_query=1, search_concurrency=2)
    assert result.success, result.error
    assert [c['source'] for c in result.data['clips']] == ['first']
    assert all(ident == threading.get_ident() for ident, _ in events)
    ready = [row for _, row in events if row['phase'] == 'clip_ready']
    assert len(ready) == 1 and ready[0]['clips_ready'] == 1
    assert {row['source'] for _, row in events if row['phase'] == 'search_completed'} == {'first','second'}


def test_fanout_is_bounded_and_results_are_priority_ordered():
    lock = threading.Lock(); active = 0; peak = 0; calls = []
    barrier = threading.Barrier(2)
    def find(name):
        def search(query, filters):
            nonlocal active, peak
            with lock: active += 1; peak = max(peak, active); calls.append(name)
            if name != 'last': barrier.wait(timeout=5)
            with lock: active -= 1
            return [name]
        return search
    sources = [SimpleNamespace(name=n, search=find(n)) for n in ['a','b','c','d','last']]
    rows = list(direct._search_source_batches(sources, 'q', SearchFilters(), time.time()+10, 2, set(), lambda: True))
    assert peak == 2 and [src.name for src, _, _ in rows] == ['a','b','c','d','last']
    assert all(error is None for _, _, error in rows)
    assert len(calls) == 5


def test_rate_limit_in_speculative_sibling_is_not_hidden_after_quota(monkeypatch, tmp_path, media):
    calls = []
    first = source('first', media)
    def limited(query, filters):
        calls.append(query); raise SourceAPIError('rate_limited')
    second = source('second', media, limited)
    import tools.video.stock_sources as registry
    monkeypatch.setattr(registry, 'all_sources', lambda: [first, second])
    result = direct.DirectClipSearch().execute({'output_dir': str(tmp_path), 'sources':['first','second'],
        'queries':[{'query':'blue'},{'query':'sky'}], 'clips_per_query':1,
        'search_concurrency':2, 'extract_thumbnails':False})
    assert result.success and len(result.data['clips']) == 2
    assert calls == ['blue']
    assert result.data['errors'][0]['source'] == 'second'
    assert result.data['errors'][0]['error_kind'] == 'rate_limited'


def test_serial_default_does_not_speculatively_search(monkeypatch, tmp_path, media):
    first = source('first', media)
    second = source('second', media, lambda *a: pytest.fail('serial default searched unused provider'))
    assert run(monkeypatch, tmp_path, [first, second], clips_per_query=1).success


def test_bad_media_never_reports_ready_and_broken_ui_callback_is_nonfatal(monkeypatch, tmp_path, media):
    fixture = source('fixture', media)
    fixture.download = lambda c, p: p.write_bytes(b'not a video')
    events = []
    with direct.stock_progress_context(events.append):
        result = run(monkeypatch, tmp_path / 'bad', [fixture], clips_per_query=1, search_concurrency=2)
    assert not result.data['clips']
    assert not any(e['phase'] == 'clip_ready' for e in events)
    fixture = source('fixture', media)
    def broken(row): raise RuntimeError('UI disconnected')
    with direct.stock_progress_context(broken):
        good = run(monkeypatch, tmp_path / 'good', [fixture], clips_per_query=1, search_concurrency=2)
    assert good.success and len(good.data['clips']) == 1
    assert direct._PROGRESS_CALLBACK.get() is None


@pytest.mark.parametrize('value', [0,5,True,2.5,'2'])
def test_invalid_concurrency_rejected_before_search(monkeypatch, tmp_path, media, value):
    fixture = source('fixture', media, lambda *a: pytest.fail('must validate first'))
    result = run(monkeypatch, tmp_path, [fixture], clips_per_query=1, search_concurrency=value)
    assert not result.success and 'search_concurrency' in result.error


def test_real_local_http_timeouts_are_independent_between_tasks():
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_GET(self):
            time.sleep(.15)
            try:
                self.send_response(200); self.end_headers(); self.wfile.write(b'local fixture')
            except (BrokenPipeError, ConnectionResetError): pass
    server = ThreadingHTTPServer(('127.0.0.1',0),Handler)
    thread = threading.Thread(target=server.serve_forever,daemon=True); thread.start()
    barrier = threading.Barrier(2)
    def fetch(seconds):
        with direct._requests_deadline(time.time()+seconds):
            barrier.wait(timeout=5)
            return requests.get(f'http://127.0.0.1:{server.server_port}', timeout=5).status_code
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            short, long = pool.submit(fetch,.04), pool.submit(fetch,2.)
            with pytest.raises(requests.Timeout): short.result(timeout=5)
            assert long.result(timeout=5) == 200
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=5)


def test_many_bad_media_errors_cannot_hide_rate_limit_from_next_keyword_caller(monkeypatch, tmp_path, media):
    broken = source('broken', media)
    def candidates(query, filters):
        return [Candidate(source='broken',source_id=str(i),source_url='https://example.test/one',
                          download_url='https://example.test/one.mp4',kind='video') for i in range(26)]
    broken.search = candidates
    def reject(*args): raise ValueError('synthetic bad media')
    monkeypatch.setattr(direct.StockDownloadStore, 'complete', reject)
    limited = source('limited', media, lambda *a: (_ for _ in ()).throw(SourceAPIError('rate_limited')))
    result = run(monkeypatch, tmp_path, [broken,limited],clips_per_query=1,search_concurrency=2)
    assert len(result.data['errors']) == 25
    assert not result.data['clips']
    assert any(e.get('source') == 'limited' and e.get('error_kind') == 'rate_limited' for e in result.data['errors'])
