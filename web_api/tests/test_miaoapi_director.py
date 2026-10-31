"""Isolated protocol/authorization tests: no live model or Keychain writes."""
import copy
import io
import json
from pathlib import Path
import urllib.error

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from web_api import miaoapi_director as m
from web_api.montage_api import create_montage_router
from web_api.montage_director import DirectorRequest, request_model, connection

KEY = 'synthetic-key-for-isolated-tests'


class Reply(io.BytesIO):
    def __init__(self, result, endpoint):
        super().__init__(json.dumps(result).encode())
        self.endpoint = endpoint
    def geturl(self):
        return self.endpoint


class Transport:
    def __init__(self, result):
        self.calls = []
        self.result = result
    def open(self, req, timeout):
        self.calls.append(req)
        if isinstance(self.result, Exception):
            raise self.result
        return Reply(self.result, req.full_url)


def response(text='{"summary":"虚构测试","actions":[]}'):
    return {'status': 'completed', 'output': [{'type': 'message', 'status': 'completed',
        'role': 'assistant', 'content': [{'type': 'output_text', 'text': text}]}],
        'usage': {'input_tokens': 50, 'output_tokens': 20, 'total_tokens': 70}}


def fixture(protocol='responses', result=None):
    transport = Transport(result if result is not None else response())
    service = m.MiaoCanvas(profile_reader=lambda: {'version': 1, 'model': 'gpt-5.4-mini', 'protocol': protocol},
                           credential_reader=lambda: KEY, opener=transport)
    status = service.status()
    body = {'messages': [{'role': 'system', 'content': '请返回 JSON'}, {'role': 'user', 'content': '虚构山水故事'}],
            'maxTokens': 600, 'consent': True, 'jsonOutput': True, 'thinking': 'off',
            'authorization': {k: status[k] for k in ['provider', 'origin', 'model', 'profileRevision']}}
    body['authorization'].update(sendText=True, sendMedia=False, requestLimit=1, currency='USD', budget=.10)
    return service, transport, body


def test_responses_exact_origin_bounded_output_and_no_storage():
    service, transport, body = fixture()
    before = copy.deepcopy(body)
    result = service.complete(body)
    assert body == before
    assert len(transport.calls) == 1
    req = transport.calls[0]
    assert req.full_url == 'https://miaoapi.xyz/v1/responses'
    payload = json.loads(req.data)
    assert payload['store'] is False and payload['stream'] is False
    assert payload['max_output_tokens'] == 600
    assert payload['text']['format'] == {'type': 'json_object'}
    assert 'thinking' not in payload and 'reasoning_effort' not in payload
    assert result['provider'] == 'miaoapi' and result['usage']['total_tokens'] == 70
    assert KEY not in json.dumps(result)


def test_chat_protocol_is_explicit_not_automatic_fallback():
    service, transport, body = fixture('chat-completions', {'choices': [{'finish_reason': 'stop',
        'message': {'content': '完整回答'}}], 'usage': {'total_tokens': 12}})
    assert service.complete(body)['content'] == '完整回答'
    payload = json.loads(transport.calls[0].data)
    assert transport.calls[0].full_url.endswith('/chat/completions')
    assert payload['max_completion_tokens'] == 600 and payload['store'] is False


@pytest.mark.parametrize('patch', [
    {'consent': False}, {'thinking': 'high'}, {'maxTokens': True},
    {'messages': [{'role': 'user', 'content': [{'type': 'image_url', 'url': 'private'}]}]},
    {'messages': [{'role': 'user', 'content': KEY}]},
    {'authorization': {'provider': 'openai'}},
    {'authPatch': {'origin': 'https://other.example'}}, {'authPatch': {'budget': 0}},
    {'authPatch': {'budget': .0001}}, {'authPatch': {'sendMedia': True}},
    {'authPatch': {'requestLimit': 2}}, {'authPatch': {'model': 'gpt-6.1-sol'}},
    {'authPatch': {'profileRevision': 'f' * 64}},
])
def test_unauthorized_stale_or_unpriced_requests_stop_before_network(patch):
    service, transport, body = fixture()
    patch = copy.deepcopy(patch)
    body['authorization'].update(patch.pop('authPatch', {}))
    body.update(patch)
    with pytest.raises(m.DirectorError):
        service.complete(body)
    assert not transport.calls


@pytest.mark.parametrize('patch', [
    {'status': 'incomplete'}, {'status': 'queued'}, {'incomplete_details': {'reason': 'max_output_tokens'}},
    {'error': {'message': KEY}}, {'output': []},
    {'output': [{'type': 'function_call', 'name': 'delete'}]},
    {'output': [{'type': 'message', 'role': 'assistant', 'content': [{'type': 'refusal', 'refusal': 'no'}]}]},
])
def test_incomplete_and_tool_answers_cannot_be_applied_or_retried(patch):
    result = response(); result.update(patch)
    service, transport, body = fixture(result=result)
    with pytest.raises(m.DirectorError) as error:
        service.complete(body)
    assert KEY not in str(error.value)
    assert len(transport.calls) == 1


def test_provider_error_body_is_not_exposed_and_key_echo_is_redacted():
    failure = urllib.error.HTTPError(m.BASE + '/responses', 401, KEY, {}, io.BytesIO(KEY.encode()))
    service, transport, body = fixture(result=failure)
    with pytest.raises(m.DirectorError) as error:
        service.complete(body)
    assert KEY not in str(error.value) and '401' in str(error.value)
    assert len(transport.calls) == 1
    service, _, body = fixture(result=response('模型意外复述 ' + KEY))
    assert KEY not in service.complete(body)['content']


def test_no_other_provider_key_or_endpoint_can_leak(monkeypatch):
    monkeypatch.delenv('MIAO_API_KEY', raising=False)
    monkeypatch.delenv('MIAOAPI_API_KEY', raising=False)
    monkeypatch.setenv('OPENAI_API_KEY', KEY)
    monkeypatch.setenv('OPENMONTAGE_DIRECTOR_API_KEY', KEY)
    monkeypatch.setenv('OPENMONTAGE_DIRECTOR_PROVIDER', 'miaoapi')
    monkeypatch.setenv('OPENMONTAGE_DIRECTOR_BASE_URL', 'https://other.example/v1')
    monkeypatch.setattr(m, 'keychain_key', lambda: '')
    assert connection('miaoapi')['ready'] is False
    assert connection('miaoapi')['base'] == m.BASE
    monkeypatch.setenv('MIAO_API_KEY', KEY)
    cfg = connection('miaoapi')
    assert cfg['ready'] and 'key' not in cfg


def test_profile_and_history_never_contain_a_key_and_require_storage_consent(tmp_path):
    profile = tmp_path / 'miaoapi-director.json'
    writes = []
    body = {'model': 'gpt-5.4-mini', 'protocol': 'responses', 'apiKey': KEY}
    with pytest.raises(m.DirectorError):
        m.configure(body, profile, writes.append)
    assert not writes and not profile.exists()
    m.configure({**body, 'saveToKeychain': True}, profile, writes.append)
    assert writes == [KEY]
    before = profile.read_text()
    m.configure({'model': 'gpt-5.6-sol', 'protocol': 'chat-completions'}, profile, writes.append)
    assert KEY not in ''.join(p.read_text() for p in tmp_path.rglob('*.json'))
    assert next((tmp_path / 'miaoapi-profile-history').glob('*.json')).read_text() == before
    with pytest.raises(m.DirectorError):
        m.configure({'model': 'gpt-6.1-sol', 'protocol': 'responses'}, profile, writes.append)


def test_settings_routes_refuse_remote_or_unconfirmed_writes_without_reading_secrets(tmp_path, monkeypatch):
    app = FastAPI(); app.include_router(create_montage_router(tmp_path))
    calls = []; monkeypatch.setattr(m, 'configure', lambda body: calls.append(body) or {'saved': True})
    with TestClient(app) as client:
        route = '/model-api/montage/director/miaoapi/config'
        for headers in [{}, {'Origin': 'https://other.example'}, {'Host': 'evil.example', 'Origin': 'http://evil.example'}]:
            assert client.post(route, json={'apiKey': KEY}, headers=headers).status_code == 403
        assert not calls
        assert client.get('/model-api/montage/director/miaoapi/setup').status_code == 200
        assert client.post(route, json={'model': 'gpt-5.4-mini', 'protocol': 'responses'},
                           headers={'Origin': 'http://testserver'}).status_code == 200
        assert len(calls) == 1


def test_montage_uses_same_text_adapter_and_blocks_images(monkeypatch):
    service, transport, _ = fixture()
    monkeypatch.setattr(m, 'MiaoCanvas', lambda: service)
    request = DirectorRequest(project_id='test', pipeline='documentary-montage', brief='虚构素材剪辑',
        provider='miaoapi', model='gpt-5.4-mini', input_price_per_million=.525,
        output_price_per_million=3.15, max_output_tokens=600, max_cost_usd=.1,
        allow_paid=True, allow_network=True)
    text, usage = request_model(request, [{'role': 'user', 'content': '虚构素材'}], '请返回 JSON')
    assert json.loads(text)['actions'] == [] and usage['output'] == 20
    with pytest.raises(ValueError, match='文字范围'):
        request_model(request, [{'role': 'user', 'content': [{'type': 'image_reference', 'path': 'private.jpg'}]}], 'test')
    assert len(transport.calls) == 1
