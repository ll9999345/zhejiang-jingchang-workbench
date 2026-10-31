import hashlib
import json
from pathlib import Path
import sqlite3
import urllib.error

import pytest

from web_api.canvas_director import DeepSeekCanvas, DirectorError, MODEL, ORIGIN, NoRedirect
from web_api.director_settings import existing_deepseek_credential

KEY = 'synthetic-canvas-only-credential'
PROFILE = {'version': 1, 'provider': 'deepseek', 'model': MODEL,
           'credential_source': {'kind': 'cc_switch', 'path': '/test/cc-switch.db', 'provider_id': 'chosen'}}


class Response:
    def __init__(self, data, url=ORIGIN + '/chat/completions'):
        self.data = data
        self.url = url

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def read(self, limit):
        return json.dumps(self.data).encode()[:limit]

    def geturl(self):
        return self.url


class Opener:
    def __init__(self):
        self.calls = []
        self.result = {'choices': [{'finish_reason': 'stop', 'message': {'content': '{"summary":"完成","actions":[]}'}}],
                       'usage': {'prompt_tokens': 200, 'completion_tokens': 80, 'total_tokens': 280}}
        self.error = None
        self.url = ORIGIN + '/chat/completions'

    def open(self, req, timeout):
        self.calls.append(req)
        if self.error:
            raise self.error
        return Response(self.result, self.url)


@pytest.fixture
def fixture():
    opener = Opener()
    service = DeepSeekCanvas(lambda: PROFILE, lambda p, b: {'key': KEY}, opener)
    state = service.status()
    body = {'consent': True, 'messages': [{'role': 'system', 'content': 'Only JSON'}, {'role': 'user', 'content': '虚构画布'}],
            'maxTokens': 6000, 'jsonOutput': True, 'thinking': 'off',
            'authorization': {'provider': 'deepseek', 'model': MODEL, 'origin': ORIGIN, 'currency': 'USD', 'budget': .10,
                              'requestLimit': 1, 'sendText': True, 'sendMedia': False, 'profileRevision': state['profileRevision']}}
    return service, opener, body


def test_status_exposes_metadata_without_key_or_source_path(fixture):
    service, opener, _ = fixture
    value = json.dumps(service.status())
    assert KEY not in value and PROFILE['credential_source']['path'] not in value
    assert service.status()['configured'] is True
    assert opener.calls == []


@pytest.mark.parametrize('target', ['consent', 'origin', 'model', 'sendMedia', 'sendText', 'budget', 'requestLimit', 'currency', 'profileRevision'])
def test_invalid_authorization_stops_before_any_request(fixture, target):
    service, opener, body = fixture
    if target == 'consent':
        body[target] = False
    else:
        body['authorization'][target] = {'origin': 'https://example.test', 'model': 'other-model', 'sendMedia': True,
                                         'sendText': False, 'budget': 0, 'requestLimit': 2, 'currency': 'CNY',
                                         'profileRevision': 'stale'}[target]
    with pytest.raises(DirectorError):
        service.complete(body)
    assert opener.calls == []


def test_insufficient_budget_and_large_input_are_local_failures(fixture):
    service, opener, body = fixture
    body['authorization']['budget'] = .00001
    with pytest.raises(DirectorError, match='预算不足'):
        service.complete(body)
    body['authorization']['budget'] = .10
    body['messages'][1]['content'] = '文' * 100_000
    with pytest.raises(DirectorError, match='文字过多'):
        service.complete(body)
    assert opener.calls == []


def test_complete_fixed_official_target_explicit_thinking_and_usage(fixture):
    service, opener, body = fixture
    result = service.complete(body)
    assert result['finish_reason'] == 'stop' and result['usage']['total_tokens'] == 280
    assert len(opener.calls) == 1
    request = opener.calls[0]
    assert request.full_url == ORIGIN + '/chat/completions'
    assert request.get_header('Authorization') == 'Bearer ' + KEY
    payload = json.loads(request.data)
    assert payload['model'] == MODEL and payload['thinking'] == {'type': 'disabled'}
    assert payload['response_format'] == {'type': 'json_object'} and payload['stream'] is False
    assert 'reasoning_content' not in json.dumps(result)


@pytest.mark.parametrize('reason', ['length', 'content_filter', 'vendor_unknown', None])
def test_incomplete_reply_never_becomes_a_plan_or_a_retry(fixture, reason):
    service, opener, body = fixture
    opener.result['choices'][0]['finish_reason'] = reason
    with pytest.raises(DirectorError, match='未完整结束'):
        service.complete(body)
    assert len(opener.calls) == 1


def test_high_thinking_and_text_rewrite_use_same_bounded_single_call(fixture):
    service, opener, body = fixture
    body['thinking'] = 'high'
    body['jsonOutput'] = False
    opener.result['choices'][0]['message']['content'] = '改写后的镜头'
    assert service.complete(body)['content'] == '改写后的镜头'
    sent = json.loads(opener.calls[0].data)
    assert sent['reasoning_effort'] == 'high' and sent['thinking']['type'] == 'enabled'
    assert 'response_format' not in sent


def test_secret_in_input_is_rejected_and_echoed_secret_is_redacted(fixture):
    service, opener, body = fixture
    body['messages'][1]['content'] = KEY
    with pytest.raises(DirectorError, match='密钥'):
        service.complete(body)
    assert opener.calls == []
    body['messages'][1]['content'] = '虚构内容'
    opener.result['choices'][0]['message']['content'] = KEY + ' sk-syntheticsecondcredential123'
    result = service.complete(body)
    assert KEY not in json.dumps(result)
    assert 'sk-syntheticsecondcredential123' not in result['content']


def test_media_payloads_and_parameter_injection_cannot_be_submitted(fixture):
    service, opener, body = fixture
    body['messages'][1]['content'] = [{'type': 'image_url', 'image_url': {'url': 'https://example.test'}}]
    with pytest.raises(DirectorError, match='仅接收'):
        service.complete(body)
    assert opener.calls == []


def test_failures_do_not_echo_provider_body_or_retry(fixture):
    service, opener, body = fixture
    opener.error = urllib.error.HTTPError(ORIGIN, 401, KEY, {}, None)
    with pytest.raises(DirectorError) as error:
        service.complete(body)
    assert KEY not in str(error.value) and 'HTTP 401' in str(error.value)
    assert len(opener.calls) == 1


def test_redirect_handler_and_unexpected_response_destination_fail_closed(fixture):
    with pytest.raises(DirectorError, match='跳转'):
        NoRedirect().redirect_request(None, None, 302, '', {}, 'https://example.test')
    service, opener, body = fixture
    opener.url = 'https://example.test'
    with pytest.raises(DirectorError, match='地址不符'):
        service.complete(body)
    assert len(opener.calls) == 1


def test_selected_sqlite_record_is_read_only_and_changed_target_stops(tmp_path):
    db_path = tmp_path / 'cc.db'
    db = sqlite3.connect(db_path)
    db.execute('CREATE TABLE providers (id TEXT, app_type TEXT, settings_config TEXT)')
    db.execute('INSERT INTO providers VALUES (?,?,?)', ('chosen', 'claude', json.dumps({'env': {'ANTHROPIC_BASE_URL': ORIGIN + '/anthropic', 'ANTHROPIC_AUTH_TOKEN': KEY}})))
    db.commit(); db.close()
    profile = {**PROFILE, 'credential_source': {**PROFILE['credential_source'], 'path': str(db_path)}}
    before = hashlib.sha256(db_path.read_bytes()).hexdigest()
    service = DeepSeekCanvas(lambda: profile, existing_deepseek_credential, Opener())
    assert service.status()['configured']
    assert hashlib.sha256(db_path.read_bytes()).hexdigest() == before
    db = sqlite3.connect(db_path)
    db.execute('UPDATE providers SET settings_config=?', (json.dumps({'env': {'ANTHROPIC_BASE_URL': 'https://example.test', 'ANTHROPIC_AUTH_TOKEN': KEY}}),))
    db.commit(); db.close()
    assert service.status()['configured'] is False
    assert KEY not in json.dumps(service.status())
