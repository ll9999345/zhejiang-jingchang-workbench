"""Server-only director preferences and references to existing credentials.

The project profile contains no secret. CC Switch is opened read-only, and only
the explicitly selected DeepSeek provider can supply its credential. Neither a
browser nor an agent action can choose a credential file or change its origin.
"""
from __future__ import annotations

import json
import os
from contextlib import closing
from pathlib import Path
import re
import sqlite3
from urllib.parse import urlsplit

LOCAL_CONFIG_PATH = Path(__file__).resolve().parents[1] / '.runtime' / 'director-model.json'
MODEL_PATTERN = re.compile(r'^[A-Za-z0-9_.:/-]{1,160}$')
DEEPSEEK_PRESET = {
    'id': 'deepseek-flash', 'label': 'DeepSeek V4.1 Flash',
    'vision': True, 'json_output': True,
    'reasoning_efforts': ['off', 'low', 'high', 'max'],
    'max_output_tokens': 8192,
    'pricing': {
        'currency': 'USD', 'input_per_million': 0.30, 'output_per_million': 1.20,
        'basis': '2026-10-02 官方高峰、未命中缓存价格；用于保守预算，实际账单为准',
        'source': 'https://api-docs.deepseek.com/quick_start/pricing/',
    },
    'documentation': 'https://api-docs.deepseek.com/zh-cn/guides/vision/',
}


def local_profile() -> dict:
    """Read only preferences. Malformed or secret-bearing profiles fail closed."""
    try:
        if not LOCAL_CONFIG_PATH.is_file():
            return {}
        if LOCAL_CONFIG_PATH.stat().st_size > 32_768:
            return {'configuration_error': '本机导演配置过大，请检查配置文件'}
        value = json.loads(LOCAL_CONFIG_PATH.read_text(encoding='utf-8'))
        if not isinstance(value, dict) or value.get('version') != 1:
            raise ValueError()
        if set(value) - {'version', 'provider', 'model', 'credential_source', 'reasoning_effort'}:
            raise ValueError()
        if value.get('provider') not in {'openai', 'openrouter', 'deepseek', 'doubao', 'anthropic', 'ollama', 'custom'}:
            raise ValueError()
        if not isinstance(value.get('model'), str) or not MODEL_PATTERN.fullmatch(value['model']):
            raise ValueError()
        if value.get('reasoning_effort', 'high') not in {'off', 'low', 'high', 'max'}:
            raise ValueError()
        source = value.get('credential_source')
        if source is not None:
            if value['provider'] != 'deepseek' or not isinstance(source, dict):
                raise ValueError()
            if set(source) != {'kind', 'path', 'provider_id'} or source['kind'] != 'cc_switch':
                raise ValueError()
            if not isinstance(source['path'], str) or not Path(source['path']).is_absolute():
                raise ValueError()
            if not isinstance(source['provider_id'], str) or not 1 <= len(source['provider_id']) <= 200:
                raise ValueError()
        return value
    except (OSError, ValueError, TypeError):
        return {'configuration_error': '本机导演配置格式无效；未读取任何密钥'}


def defaults(profile: dict | None = None) -> dict:
    profile = local_profile() if profile is None else profile
    # Explicit environment settings keep their precedence and never inherit a
    # model from a different provider in the project profile.
    provider = os.environ.get('OPENMONTAGE_DIRECTOR_PROVIDER') or profile.get('provider', 'ollama')
    model = os.environ.get('OPENMONTAGE_DIRECTOR_MODEL')
    if model is None:
        model = profile.get('model', '') if provider == profile.get('provider') else ''
    return {'provider': provider, 'model': model,
            'reasoning_effort': profile.get('reasoning_effort', 'high'),
            'configuration_error': profile.get('configuration_error')}


def _official_deepseek_url(value: object) -> bool:
    if not isinstance(value, str):
        return False
    try:
        uri = urlsplit(value)
        return (uri.scheme == 'https' and uri.hostname == 'api.deepseek.com'
                and uri.port in {None, 443} and not uri.username and not uri.password
                and not uri.query and not uri.fragment
                and uri.path.rstrip('/') in {'', '/v1', '/anthropic', '/anthropic/v1'})
    except ValueError:
        return False


def existing_deepseek_credential(profile: dict, base: str) -> dict:
    """Return a credential internally; caller must expose only allowlisted fields."""
    source = profile.get('credential_source')
    if not source:
        return {'error': None}
    if profile.get('provider') != 'deepseek' or not _official_deepseek_url(base):
        return {'error': '已存 DeepSeek 密钥只可用于官方 DeepSeek 接口；未向其他地址传递'}
    database = Path(source['path'])
    if not database.is_file():
        return {'error': '已选择的 CC Switch 配置文件不存在，请恢复配置或设置 DEEPSEEK_API_KEY'}
    try:
        with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=2)) as db:
            row = db.execute('SELECT settings_config FROM providers WHERE id = ? AND app_type = ?',
                             (source['provider_id'], 'claude')).fetchone()
        if not row or not isinstance(row[0], str) or len(row[0]) > 2_000_000:
            raise ValueError()
        data = json.loads(row[0])
        env = data.get('env', {})
        if not isinstance(env, dict) or not _official_deepseek_url(env.get('ANTHROPIC_BASE_URL')):
            return {'error': '所选配置已不指向官方 DeepSeek，未复用认证；请检查 CC Switch 的 DeepSeek 项'}
        key = env.get('ANTHROPIC_AUTH_TOKEN') or env.get('ANTHROPIC_API_KEY')
        if not isinstance(key, str) or not key.strip() or '\n' in key or '\r' in key:
            return {'error': '所选 DeepSeek 配置缺少有效密钥，请在原配置中补充'}
        return {'key': key.strip(), 'error': None,
                'credential_source': 'Claude Code 已存 DeepSeek 配置（CC Switch，只读）'}
    except (OSError, sqlite3.Error, ValueError, TypeError, AttributeError):
        return {'error': '所选 DeepSeek 配置不可读取；未改写原配置，也未改用其他密钥'}
