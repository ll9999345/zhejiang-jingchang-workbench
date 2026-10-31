"""Failure vs empty-result semantics, with no outbound provider access."""
import json
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
import requests

from tools.video.stock_sources import SearchFilters, get_source


def response(payload, status=200):
    result = requests.Response(); result.status_code = status
    result.url = 'https://example.test/fixture'
    result.json = lambda: payload
    return result


def commons_page():
    return {'query': {'pages': {'1': {'pageid': 1, 'title': 'File:Forest.webm', 'index': 1,
        'imageinfo': [{'url': 'https://example.test/forest.webm', 'descriptionurl': 'https://example.test/forest',
                       'mime': 'video/webm', 'width': 320, 'height': 180, 'duration': 10}]}}}}


def archive_metadata():
    return {'files': [{'name': 'forest.mp4', 'format': 'MPEG4', 'length': '10',
                        'width': '320', 'height': '180', 'size': '2048'}]}


@pytest.mark.parametrize('name', ['archive_org', 'wikimedia', 'pond5_pd'])
def test_transport_failure_is_not_retried_with_broader_query_or_empty_fallback(monkeypatch, name):
    get = Mock(side_effect=requests.ConnectionError('synthetic transport failure'))
    monkeypatch.setattr('requests.get', get)
    with pytest.raises(requests.ConnectionError):
        get_source(name).search('forest cloudy mountains', SearchFilters(kind='video'))
    assert get.call_count == 1


def test_failure_reaches_workbench_without_remote_url_or_auth_string(tmp_path, monkeypatch):
    from web_api.media_pipeline import search_stock_media
    project = tmp_path / 'demo'; project.mkdir()
    secret = 'synthetic-secret-not-user-key'
    response = requests.Response(); response.status_code = 401
    response.url = 'https://example.test/search?api_key=' + secret
    get = Mock(side_effect=requests.HTTPError('401 Unauthorized ' + response.url, response=response))
    monkeypatch.setattr('requests.get', get)
    result = search_stock_media({'project_id': 'demo', 'queries': ['forest cloudy mountains'],
        'sources': ['wikimedia'], 'execute': True, 'dry_run': False, 'confirm': True}, project_root=tmp_path)
    assert result['status'] == 'failed'
    assert '认证未通过' in result['message']
    manifest = json.loads((project / 'artifacts/stock_search_manifest.json').read_text())
    assert manifest['status'] == 'failed'
    assert secret not in json.dumps(result) and secret not in json.dumps(manifest)
    assert get.call_count == 1


def test_successful_empty_commons_query_still_broadens_and_returns_candidate(monkeypatch):
    data = commons_page(); data['warnings'] = {'query': {'*': 'ordinary nonfatal warning'}}
    get = Mock(side_effect=[response({}), response(data)])
    monkeypatch.setattr('requests.get', get)
    rows = get_source('wikimedia').search('forest cloudy mountains', SearchFilters(kind='video'))
    assert len(rows) == 1 and rows[0].source_id == '1'
    assert get.call_count == 2


def test_successful_empty_archive_query_still_broadens_and_hydrates(monkeypatch):
    get = Mock(side_effect=[response({}), response({'response': {'docs': [{'identifier': 'ok'}]}}),
                            response(archive_metadata())])
    monkeypatch.setattr('requests.get', get)
    rows = get_source('archive_org').search('forest cloudy mountains', SearchFilters(kind='video'))
    assert len(rows) == 1 and rows[0].source_id == 'ok'
    assert get.call_count == 3


def test_archive_removed_item_does_not_discard_another_valid_candidate(monkeypatch):
    docs = {'response': {'docs': [{'identifier': 'removed'}, {'identifier': 'ok'}]}}
    get = Mock(side_effect=[response(docs), response({}, 404), response(archive_metadata())])
    monkeypatch.setattr('requests.get', get)
    rows = get_source('archive_org').search('forest cloudy mountains', SearchFilters(kind='video'))
    assert [r.source_id for r in rows] == ['ok'] and get.call_count == 3


@pytest.mark.parametrize('failed_first', [False, True])
def test_archive_partial_item_failure_keeps_valid_candidate_and_warning(monkeypatch, failed_first):
    docs = [{'identifier': name} for name in (['failed', 'ok'] if failed_first else ['ok', 'failed'])]
    def get(url, **kwargs):
        if 'advancedsearch' in url:
            return response({'response': {'docs': docs}})
        return response({}, 500) if url.endswith('/failed') else response(archive_metadata())
    mocked = Mock(side_effect=get)
    monkeypatch.setattr('requests.get', mocked)
    rows = get_source('archive_org').search('forest cloudy mountains', SearchFilters(kind='video'))
    assert [r.source_id for r in rows] == ['ok']
    assert rows.errors == [{'error_type': 'HTTPError', 'error': 'HTTPError: HTTP 500', 'status_code': 500}]
    assert mocked.call_count == 3


def test_direct_downloads_partial_candidates_and_keeps_failure_record(tmp_path, monkeypatch):
    from tools.video.direct_clip_search import DirectClipSearch
    import tools.video.stock_sources as sources
    source = get_source('archive_org')
    import subprocess, shutil
    fixture = tmp_path / 'fixture.mp4'
    subprocess.run(['ffmpeg','-v','error','-n','-f','lavfi','-i','color=c=blue:s=160x90:r=12:d=1',
                    '-c:v','libx264','-pix_fmt','yuv420p',str(fixture)],check=True,timeout=20)
    def get(url, **kwargs):
        if 'advancedsearch' in url:
            return response({'response': {'docs': [{'identifier': 'ok'}, {'identifier': 'failed'}]}})
        return response({}, 500) if url.endswith('/failed') else response(archive_metadata())
    monkeypatch.setattr('requests.get', Mock(side_effect=get))
    monkeypatch.setattr(sources, 'all_sources', lambda: [source])
    def copy_fixture(candidate, destination):
        shutil.copyfile(fixture, destination)
        return destination
    monkeypatch.setattr(source, 'download', copy_fixture)
    result = DirectClipSearch().execute({'output_dir': str(tmp_path), 'queries': [{'query': 'forest cloudy mountains'}],
        'sources': ['archive_org'], 'extract_thumbnails': False})
    assert result.success and result.data['total_clips'] == 1
    assert len(result.data['errors']) == 1 and result.data['errors'][0]['status_code'] == 500
    from pathlib import Path
    assert Path(result.data['clips'][0]['path']).read_bytes() == fixture.read_bytes()


@pytest.mark.parametrize('status', [401, 403, 429, 503])
def test_archive_metadata_transport_or_service_failure_is_not_an_empty_item(monkeypatch, status):
    get = Mock(return_value=response({}, status))
    monkeypatch.setattr('requests.get', get)
    with pytest.raises(requests.HTTPError):
        get_source('archive_org')._hydrate_candidate({'identifier': 'one'}, SearchFilters(kind='video'))
    assert get.call_count == 1


@pytest.mark.parametrize('data', [{'error': {'code': 'maxlag', 'info': 'synthetic-private-body'}},
                                  {'errors': [{'code': 'ratelimited', 'text': 'synthetic-private-body'}]}])
def test_commons_http_200_fatal_api_error_is_not_empty_search(monkeypatch, data):
    get = Mock(return_value=response(data))
    monkeypatch.setattr('requests.get', get)
    with pytest.raises(ValueError) as error:
        get_source('wikimedia').search('forest cloudy mountains', SearchFilters(kind='video'))
    assert 'synthetic-private-body' not in str(error.value)
    assert get.call_count == 1


@pytest.mark.parametrize('status', [401, 403, 429, 503])
@pytest.mark.parametrize('phase', ['search', 'download'])
def test_auth_and_limit_failures_stop_this_source_for_remaining_queries(tmp_path, monkeypatch, status, phase):
    from tools.video.direct_clip_search import DirectClipSearch
    from tools.video.stock_sources.base import Candidate
    import tools.video.stock_sources as sources
    error = requests.HTTPError('synthetic-private-response-body', response=response({}, status))
    items = [Candidate(source='wikimedia', source_id=str(i), source_url=f'https://example.test/page/{i}',
                       kind='video', download_url=f'https://example.test/{i}.mp4')
             for i in [1, 2]]
    search = Mock(side_effect=error) if phase == 'search' else Mock(return_value=items)
    download = Mock(side_effect=error)
    source = SimpleNamespace(name='wikimedia', is_available=lambda: True, search=search, download=download)
    monkeypatch.setattr(sources, 'all_sources', lambda: [source])
    result = DirectClipSearch().execute({'output_dir': str(tmp_path), 'queries': [{'query': 'forest'}, {'query': 'clouds'}],
        'sources': ['wikimedia'], 'extract_thumbnails': False})
    assert result.success, result.error
    assert search.call_count == 1
    assert download.call_count == (1 if phase == 'download' else 0)
    assert len(result.data['errors']) == 1 and result.data['errors'][0]['status_code'] == status
    assert 'synthetic-private-response-body' not in json.dumps(result.data)


@pytest.mark.parametrize('code,kind', [('ratelimited', 'rate_limited'), ('maxlag', 'temporarily_unavailable'),
                                     ('readapidenied', 'permission_denied')])
def test_commons_fatal_limits_stop_this_source_without_faking_http_status(tmp_path, monkeypatch, code, kind):
    from tools.video.direct_clip_search import DirectClipSearch
    get = Mock(return_value=response({'error': {'code': code, 'info': 'synthetic-private-response-body'}}))
    monkeypatch.setattr('requests.get', get)
    result = DirectClipSearch().execute({'output_dir': str(tmp_path), 'queries': [{'query': 'forest'}, {'query': 'clouds'}],
        'sources': ['wikimedia'], 'extract_thumbnails': False})
    assert result.success, result.error
    assert get.call_count == 1
    failure = result.data['errors'][0]
    assert failure['error_kind'] == kind and 'status_code' not in failure
    assert 'synthetic-private-response-body' not in json.dumps(result.data)


@pytest.mark.asyncio
@pytest.mark.parametrize('limited', [False, True])
async def test_actual_media_route_persists_failed_status_and_safe_summary(tmp_path, monkeypatch, limited):
    import httpx
    from web_api.media_pipeline import create_media_app
    project = tmp_path / 'demo'; project.mkdir()
    secret = 'synthetic-private-api-response'
    if limited:
        get = Mock(return_value=response({'error': {'code': 'ratelimited', 'info': secret}}))
    else:
        failure = response({}, 401); failure.url = 'https://example.test/?api_key=' + secret
        get = Mock(side_effect=requests.HTTPError(failure.url, response=failure))
    monkeypatch.setattr('requests.get', get)
    app = create_media_app(project_root=tmp_path)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        reply = await client.post('/api/media/stock/search', json={'project_id': 'demo',
            'queries': ['forest', 'clouds'], 'sources': ['wikimedia'],
            'execute': True, 'dry_run': False, 'confirm': True})
    assert reply.status_code == 200
    result = reply.json()
    assert result['status'] == 'failed'
    assert ('限流' if limited else '认证未通过') in result['message']
    manifest = json.loads((project / 'artifacts/stock_search_manifest.json').read_text())
    assert manifest['status'] == 'failed' and get.call_count == 1
    assert secret not in json.dumps(manifest) and secret not in json.dumps(result)
    (tmp_path / 'api-receipt.json').write_text(json.dumps({'status': 'passed', 'api_status': reply.status_code,
        'task_status': result['status'], 'message': result['message'], 'error_fields': result['errors'],
        'provider_requests_simulated': True, 'actual_provider_calls': 0}, ensure_ascii=False, indent=2))
