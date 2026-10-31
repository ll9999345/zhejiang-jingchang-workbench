import json
from pathlib import Path
import sqlite3

import httpx
from PIL import Image
import pytest

import web_api.director_settings as settings
import web_api.montage_director as director


@pytest.fixture
def profile(tmp_path, monkeypatch):
    for key in ('OPENMONTAGE_DIRECTOR_PROVIDER', 'OPENMONTAGE_DIRECTOR_MODEL',
                'OPENMONTAGE_DIRECTOR_BASE_URL', 'OPENMONTAGE_DIRECTOR_API_KEY',
                'DEEPSEEK_API_KEY'):
        monkeypatch.delenv(key, raising=False)
    config = tmp_path / 'director-model.json'
    database = tmp_path / 'providers.db'
    with sqlite3.connect(database) as db:
        db.execute('CREATE TABLE providers (id TEXT, app_type TEXT, settings_config TEXT)')
        db.execute('INSERT INTO providers VALUES (?, ?, ?)', ('selected-deepseek', 'claude', json.dumps({
            'env': {'ANTHROPIC_BASE_URL': 'https://api.deepseek.com/anthropic',
                    'ANTHROPIC_AUTH_TOKEN': 'fixture-private-key', 'ANTHROPIC_MODEL': 'deepseek-flash'}})))
        db.execute('INSERT INTO providers VALUES (?, ?, ?)', ('other-provider', 'claude', json.dumps({
            'env': {'ANTHROPIC_BASE_URL': 'https://unrelated.invalid',
                    'ANTHROPIC_AUTH_TOKEN': 'unrelated-private-key'}})))
    data = {'version': 1, 'provider': 'deepseek', 'model': 'deepseek-flash', 'reasoning_effort': 'high',
            'credential_source': {'kind': 'cc_switch', 'path': str(database), 'provider_id': 'selected-deepseek'}}
    config.write_text(json.dumps(data))
    monkeypatch.setattr(settings, 'LOCAL_CONFIG_PATH', config)
    return config, database, data


def modify_provider(database, env=None, raw=None, app='claude'):
    with sqlite3.connect(database) as db:
        db.execute('UPDATE providers SET app_type=?, settings_config=? WHERE id=?',
                   (app, raw if raw is not None else json.dumps({'env': env}), 'selected-deepseek'))


def test_reuses_only_selected_deepseek_key_without_changing_database(profile):
    config, database, data = profile
    previous = database.read_bytes()
    cfg = director.connection('deepseek')
    assert cfg['ready'] and not cfg['local']
    assert cfg['base'] == 'https://api.deepseek.com'
    assert cfg['key'] == 'fixture-private-key'
    assert 'CC Switch' in cfg['credential_source']
    assert database.read_bytes() == previous
    assert 'fixture-private-key' not in config.read_text()
    assert 'unrelated-private-key' not in json.dumps(cfg)


def test_public_capabilities_use_safe_defaults_and_metadata_without_credentials(profile):
    caps = director.director_capabilities()
    text = json.dumps(caps)
    assert 'fixture-private-key' not in text and 'unrelated-private-key' not in text
    assert str(profile[1]) not in text
    assert caps['provider_default'] == 'deepseek' and caps['model_default'] == 'deepseek-flash'
    assert not caps['external_account_verified']
    row = next(row for row in caps['providers'] if row['id'] == 'deepseek')
    assert row['configured'] and row['endpoint'] == 'https://api.deepseek.com'
    assert row['models'][0]['vision']
    assert row['models'][0]['pricing']['input_per_million'] == .30
    assert row['models'][0]['pricing']['output_per_million'] == 1.20


def test_explicit_environment_overrides_profile_without_inheriting_its_model(profile, monkeypatch):
    monkeypatch.setenv('OPENMONTAGE_DIRECTOR_PROVIDER', 'openai')
    assert settings.defaults()['provider'] == 'openai'
    assert settings.defaults()['model'] == ''
    monkeypatch.setenv('OPENMONTAGE_DIRECTOR_MODEL', 'user-selected-model')
    assert settings.defaults()['model'] == 'user-selected-model'
    monkeypatch.setenv('DEEPSEEK_API_KEY', 'environment-key')
    assert director.connection('deepseek')['key'] == 'environment-key'


def test_no_local_profile_does_not_search_other_personal_credentials(profile):
    settings.LOCAL_CONFIG_PATH.write_text('{}')
    assert not director.connection('deepseek')['ready']
    assert '格式无效' in director.connection('deepseek')['error']
    missing = settings.LOCAL_CONFIG_PATH.with_name('no-profile.json')
    settings.LOCAL_CONFIG_PATH = missing
    assert settings.defaults()['provider'] == 'ollama'
    assert not director.connection('deepseek')['ready']


@pytest.mark.parametrize('base', [
    'https://unrelated.invalid/v1', 'http://api.deepseek.com',
    'https://api.deepseek.com.evil.invalid', 'https://api.deepseek.com/?api_key=hidden',
    'https://user:password@api.deepseek.com', 'https://api.deepseek.com:444/anthropic',
    'https://api.deepseek.com/unsupported', 'https://api.deepseek.com/#fragment',
])
def test_existing_credential_never_follows_changed_origin(profile, monkeypatch, base):
    monkeypatch.setenv('OPENMONTAGE_DIRECTOR_PROVIDER', 'deepseek')
    monkeypatch.setenv('OPENMONTAGE_DIRECTOR_BASE_URL', base)
    cfg = director.connection('deepseek')
    assert not cfg['ready']
    assert 'key' not in cfg or not cfg['key']
    assert 'fixture-private-key' not in json.dumps(cfg)


@pytest.mark.parametrize('base', ['https://miaoapi.xyz', 'https://api.deepseek.com.evil.invalid',
                                 'http://api.deepseek.com/anthropic', 'https://api.deepseek.com?token=hidden'])
def test_selected_cc_provider_changed_to_another_service_fails_closed(profile, base):
    modify_provider(profile[1], env={'ANTHROPIC_BASE_URL': base, 'ANTHROPIC_AUTH_TOKEN': 'fixture-private-key'})
    cfg = director.connection('deepseek')
    assert not cfg['ready'] and 'key' not in cfg
    assert 'fixture-private-key' not in json.dumps(cfg)


@pytest.mark.parametrize('raw,app', [('not-json', 'claude'), ('[]', 'claude'),
                                   ('{"env": null}', 'claude'), ('{}', 'codex')])
def test_missing_or_malformed_selected_provider_does_not_use_another_key(profile, raw, app):
    modify_provider(profile[1], raw=raw, app=app)
    cfg = director.connection('deepseek')
    assert not cfg['ready'] and 'key' not in cfg


@pytest.mark.parametrize('key', ['', None, 42, 'line1\nline2', 'line1\rline2'])
def test_invalid_saved_credentials_fail_before_http(profile, key):
    modify_provider(profile[1], env={'ANTHROPIC_BASE_URL': 'https://api.deepseek.com/anthropic', 'ANTHROPIC_AUTH_TOKEN': key})
    assert not director.connection('deepseek')['ready']


@pytest.mark.parametrize('update', [
    {'api_key': 'must-not-be-stored'}, {'model': '../model with spaces'},
    {'credential_source': {'kind': 'file', 'path': '/tmp/key'}},
    {'provider': 'openai'}, {'reasoning_effort': 'unsupported'}, {'version': 2},
])
def test_bad_or_secret_bearing_profiles_are_not_accepted(profile, update):
    data = dict(profile[2], **update)
    profile[0].write_text(json.dumps(data))
    value = settings.local_profile()
    assert value.get('configuration_error')
    assert 'must-not-be-stored' not in json.dumps(value)


@pytest.mark.parametrize('effort', ['off', 'low', 'high', 'max'])
def test_deepseek_transport_has_explicit_thinking_json_and_real_image_pixels(profile, tmp_path, monkeypatch, effort):
    Image.new('RGB', (20, 10), 'green').save(tmp_path / 'frame.jpg')
    messages = [{'role': 'user', 'content': [{'type': 'text', 'text': '核对画面'}, {'type': 'image_reference', 'path': 'frame.jpg'}]}]
    calls = []
    def response(request):
        calls.append(request)
        return httpx.Response(200, json={'choices': [{'finish_reason': 'stop', 'message': {
            'content': '{"action":"blocked","arguments":{"message":"待人工核对"}}',
            'reasoning_content': 'private provider reasoning'}}],
            'usage': {'prompt_tokens': 123, 'completion_tokens': 45, 'completion_tokens_details': {'reasoning_tokens': 20}}})
    client = httpx.Client
    def isolated_client(**kwargs):
        assert kwargs['trust_env'] is False and kwargs['follow_redirects'] is False
        return client(transport=httpx.MockTransport(response), **kwargs)
    monkeypatch.setattr(director.httpx, 'Client', isolated_client)
    req = director.DirectorRequest(project_id='demo', pipeline='documentary-montage', brief='分析参考片',
        provider='deepseek', model='deepseek-flash', reasoning_effort=effort,
        allow_network=True, allow_paid=True, max_cost_usd=1, max_output_tokens=8192)
    text, usage = director.request_model(req, messages, '返回 JSON 动作', project=tmp_path)
    assert len(calls) == 1
    call = calls[0]
    assert str(call.url) == 'https://api.deepseek.com/chat/completions'
    assert call.headers['Authorization'] == 'Bearer fixture-private-key'
    body = json.loads(call.content)
    assert body['model'] == 'deepseek-flash' and body['max_tokens'] == 8192
    assert body['response_format'] == {'type': 'json_object'}
    assert body['thinking'] == {'type': 'disabled' if effort == 'off' else 'enabled'}
    assert ('reasoning_effort' in body) == (effort != 'off')
    if effort != 'off': assert body['reasoning_effort'] == effort
    assert body['messages'][1]['content'][1]['image_url']['url'].startswith('data:image/jpeg;base64,')
    assert messages[0]['content'][1]['type'] == 'image_reference'
    assert 'private provider reasoning' not in text
    assert usage == {'input': 123, 'output': 45}


def test_generation_permissions_remain_required_with_reused_key(profile, monkeypatch):
    def forbidden(*args, **kwargs): raise AssertionError('No HTTP request allowed')
    monkeypatch.setattr(director.httpx, 'Client', forbidden)
    req = director.DirectorRequest(project_id='demo', pipeline='documentary-montage', brief='分析参考片',
                                   provider='deepseek', model='deepseek-flash')
    with pytest.raises(ValueError, match='授权'):
        director.request_model(req, [], 'JSON')


def test_truncated_reply_is_not_executed_or_silently_retried(profile, monkeypatch):
    calls = []
    def response(request):
        calls.append(request)
        return httpx.Response(200, json={'choices': [{'finish_reason': 'length', 'message': {'content': '{"action":'}}]})
    client = httpx.Client
    monkeypatch.setattr(director.httpx, 'Client', lambda **kwargs: client(transport=httpx.MockTransport(response), **kwargs))
    req = director.DirectorRequest(project_id='demo', pipeline='documentary-montage', brief='检查',
        provider='deepseek', model='deepseek-flash', allow_network=True, allow_paid=True)
    with pytest.raises(ValueError, match='上限'):
        director.request_model(req, [], 'JSON')
    assert len(calls) == 1
