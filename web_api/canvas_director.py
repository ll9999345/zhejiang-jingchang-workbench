"""Bounded text-only DeepSeek adapter. Secrets never cross the subprocess pipe."""
from __future__ import annotations

import hashlib
import json
import math
import re
from typing import Callable
import urllib.error
import urllib.request

from .director_settings import existing_deepseek_credential, local_profile

ORIGIN = 'https://api.deepseek.com'
MODEL = 'deepseek-flash'
INPUT_LIMIT = 200_000
OUTPUT_LIMIT = 8192
PRICING = {'currency': 'USD', 'input_per_million': 0.30, 'output_per_million': 1.20,
           'checkedOn': '2026-10-03',
           'source': 'https://api-docs.deepseek.com/quick_start/pricing/'}


class DirectorError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise DirectorError('DeepSeek 接口发生跳转，已停止；没有转发认证或自动重试', 502)


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _redact(value: str, key: str = '') -> str:
    if key:
        value = value.replace(key, '[已隐藏密钥]')
    return re.sub(r'(?i)(?:bearer\s+\S+|sk-[a-z0-9_-]{16,})', '[已隐藏密钥]', value)


class DeepSeekCanvas:
    def __init__(self, profile_reader: Callable = local_profile,
                 credential_reader: Callable = existing_deepseek_credential, opener=None):
        self.profile_reader = profile_reader
        self.credential_reader = credential_reader
        self.opener = opener or urllib.request.build_opener(NoRedirect())

    def _settings(self):
        profile = self.profile_reader()
        if profile.get('configuration_error'):
            raise DirectorError(profile['configuration_error'])
        if (profile.get('provider') != 'deepseek' or profile.get('model') != MODEL
                or (profile.get('credential_source') or {}).get('kind') != 'cc_switch'):
            raise DirectorError('未找到已选择的官方 DeepSeek Flash 配置；请检查工作台导演配置')
        credential = self.credential_reader(profile, ORIGIN)
        if credential.get('error') or not credential.get('key'):
            raise DirectorError(credential.get('error') or '已选择的 DeepSeek 配置缺少密钥')
        revision = hashlib.sha256(json.dumps(profile, sort_keys=True).encode()).hexdigest()
        return credential['key'], revision

    def status(self):
        state = {'provider': 'deepseek', 'origin': ORIGIN, 'model': MODEL,
                 'label': 'DeepSeek V4.1 Flash', 'remote': True, 'textOnly': True,
                 'pricing': PRICING, 'sourceLabel': 'Claude Code 已存 DeepSeek 配置（只读）'}
        try:
            key, revision = self._settings()
            key = ''
            return {**state, 'configured': True, 'profileRevision': revision}
        except DirectorError as error:
            return {**state, 'configured': False, 'error': str(error)}

    def complete(self, body):
        if not isinstance(body, dict) or body.get('consent') is not True:
            raise DirectorError('请确认本次 DeepSeek 调用的文字发送范围和预算')
        messages = body.get('messages')
        if (not isinstance(messages, list) or not 1 <= len(messages) <= 16
                or any(not isinstance(m, dict) or set(m) != {'role', 'content'}
                       or m['role'] not in {'system', 'user', 'assistant'}
                       or not isinstance(m['content'], str) for m in messages)):
            raise DirectorError('DeepSeek 助理仅接收明确列出的文字，不接收素材文件或任意请求参数')
        encoded = json.dumps(messages, ensure_ascii=False).encode('utf-8')
        if len(encoded) > INPUT_LIMIT:
            raise DirectorError('本次画布文字过多，请精简文字后再规划；没有提交请求')
        maximum = body.get('maxTokens')
        if not isinstance(maximum, int) or isinstance(maximum, bool) or not 128 <= maximum <= OUTPUT_LIMIT:
            raise DirectorError('输出上限须为 128–8192 tokens')
        thinking = body.get('thinking', 'off')
        if thinking not in {'off', 'low', 'high', 'max'}:
            raise DirectorError('DeepSeek 思考方式无效')
        if not isinstance(body.get('jsonOutput', False), bool):
            raise DirectorError('模型输出格式无效')
        a = body.get('authorization')
        if (not isinstance(a, dict) or a.get('provider') != 'deepseek'
                or a.get('origin') != ORIGIN or a.get('model') != MODEL
                or a.get('sendText') is not True or a.get('sendMedia') is not False
                or a.get('requestLimit') != 1 or a.get('currency') != 'USD'
                or not _number(a.get('budget')) or not 0 < a['budget'] <= 100):
            raise DirectorError('请明确确认官方 DeepSeek、只发送文字、1 次请求及美元预算')
        # UTF-8 byte count deliberately overestimates input token count. Include
        # chat framing overhead; reserve all output, including thinking tokens.
        estimated = math.ceil(((len(encoded) + 4096) * .30 + maximum * 1.20)) / 1_000_000
        if a['budget'] < estimated:
            raise DirectorError(f'本次预算不足：按高峰单价预留约 ${estimated:.6f}；没有提交请求')
        key, revision = self._settings()
        try:
            if a.get('profileRevision') != revision:
                raise DirectorError('DeepSeek 配置已变化，请重新检查服务和发送范围；没有提交请求', 409)
            if key in encoded.decode('utf-8') or re.search(rb'(?i)bearer\s+\S+|sk-[a-z0-9_-]{16,}', encoded):
                raise DirectorError('待发送文字疑似含密钥，请先移除；没有提交请求')
            payload = {'model': MODEL, 'messages': messages, 'max_tokens': maximum,
                       'stream': False, 'thinking': {'type': 'disabled' if thinking == 'off' else 'enabled'}}
            if thinking != 'off':
                payload['reasoning_effort'] = thinking
            if body.get('jsonOutput') is True:
                payload['response_format'] = {'type': 'json_object'}
            req = urllib.request.Request(ORIGIN + '/chat/completions', method='POST',
                                         headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key},
                                         data=json.dumps(payload, ensure_ascii=False).encode())
            try:
                with self.opener.open(req, timeout=110) as response:
                    if response.geturl() != ORIGIN + '/chat/completions':
                        raise DirectorError('DeepSeek 返回地址不符，已停止；没有自动重试', 502)
                    raw = response.read(2_000_001)
                if len(raw) > 2_000_000:
                    raise DirectorError('模型返回内容过大，未应用；没有自动重试', 502)
                result = json.loads(raw)
            except DirectorError:
                raise
            except urllib.error.HTTPError as error:
                raise DirectorError(f'DeepSeek 请求失败（HTTP {error.code}）；请核对服务与余额，没有自动重试', 502) from None
            except Exception:
                raise DirectorError('DeepSeek 请求未确认，请核对官方账单；没有自动重试', 502) from None
            choices = result.get('choices') if isinstance(result, dict) else None
            if not isinstance(choices, list) or len(choices) != 1 or not isinstance(choices[0], dict):
                raise DirectorError('DeepSeek 没有返回有效回答，项目未修改；没有自动重试', 502)
            choice = choices[0]
            if choice.get('finish_reason') != 'stop':
                raise DirectorError('DeepSeek 回答未完整结束，未应用任何操作；没有自动续写或重试', 502)
            content = (choice.get('message') or {}).get('content')
            if not isinstance(content, str) or not content.strip() or len(content) > 100_000:
                raise DirectorError('DeepSeek 没有返回有效正文，未应用；没有自动重试', 502)
            usage = result.get('usage') or {}
            clean_usage = {k: v for k, v in usage.items() if k in {'prompt_tokens', 'completion_tokens', 'total_tokens'}
                           and isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= 2_000_000}
            return {'content': _redact(content.strip(), key), 'finish_reason': 'stop', 'model': MODEL,
                    'provider': 'deepseek', 'usage': clean_usage, 'estimatedMaximumUSD': estimated}
        finally:
            key = ''
