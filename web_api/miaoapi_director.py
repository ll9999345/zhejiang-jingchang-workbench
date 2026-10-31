"""MiaoAPI text director. Provider-specific Keychain entry, no shared keys.

The marketplace model names are gateway aliases, not verified upstream identity.
Configuration and status are local-only; completion is explicitly budgeted.
"""
from __future__ import annotations

import ctypes
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import threading
import urllib.error
import urllib.request

from .canvas_director import DirectorError, INPUT_LIMIT, OUTPUT_LIMIT, _number, _redact

ORIGIN = 'https://miaoapi.xyz'
BASE = ORIGIN + '/v1'
KEYCHAIN_SERVICE = 'cn.zhejiang-tourism.workbench.miaoapi'
KEYCHAIN_ACCOUNT = 'director-text'
PROFILE = Path(__file__).resolve().parents[1] / '.runtime' / 'miaoapi-director.json'
MODELS = {
    'gpt-5.4-mini': (.2625, 1.575),
    # Highest displayed context tier, no cache discount assumed.
    'gpt-5.6-sol': (3.5, 15.75),
}
LOCK = threading.RLock()


def _security():
    if sys.platform != 'darwin':
        raise DirectorError('请在本机设置 MIAO_API_KEY；macOS 钥匙串在此系统不可用')
    lib = ctypes.CDLL('/System/Library/Frameworks/Security.framework/Security')
    lib.SecKeychainFindGenericPassword.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_char_p,
        ctypes.c_uint32, ctypes.c_char_p, ctypes.POINTER(ctypes.c_uint32),
        ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
    lib.SecKeychainFindGenericPassword.restype = ctypes.c_int32
    lib.SecKeychainAddGenericPassword.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_char_p,
        ctypes.c_uint32, ctypes.c_char_p, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_void_p]
    lib.SecKeychainAddGenericPassword.restype = ctypes.c_int32
    lib.SecKeychainItemFreeContent.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    lib.SecKeychainSetUserInteractionAllowed.argtypes = [ctypes.c_bool]
    # Server processes never trigger an OS password/permission dialog.
    lib.SecKeychainSetUserInteractionAllowed(False)
    return lib


def keychain_key():
    lib = _security()
    service, account = KEYCHAIN_SERVICE.encode(), KEYCHAIN_ACCOUNT.encode()
    length, data = ctypes.c_uint32(), ctypes.c_void_p()
    status = lib.SecKeychainFindGenericPassword(None, len(service), service, len(account), account,
                                               ctypes.byref(length), ctypes.byref(data), None)
    if status == -25300:
        return ''
    if status != 0:
        raise DirectorError('喵喵 API 钥匙串不可读取；请在本机检查授权，未改用其他密钥')
    try:
        return ctypes.string_at(data, length.value).decode('utf-8')
    finally:
        lib.SecKeychainItemFreeContent(None, data)


def read_key():
    # No OPENAI_API_KEY, Ark, DeepSeek or generic gateway credential fallback.
    key = os.environ.get('MIAO_API_KEY') or os.environ.get('MIAOAPI_API_KEY') or keychain_key()
    if not isinstance(key, str) or not key or len(key) > 1024 or any(c.isspace() for c in key):
        raise DirectorError('尚未配置喵喵 API 专用密钥；现有 DeepSeek、火山和 OpenAI 密钥不会被复用')
    return key


def save_key(key):
    if not isinstance(key, str) or not 16 <= len(key) <= 1024 or any(c.isspace() for c in key):
        raise DirectorError('密钥格式无效')
    existing_env = os.environ.get('MIAO_API_KEY') or os.environ.get('MIAOAPI_API_KEY')
    if existing_env and existing_env != key:
        raise DirectorError('本机环境变量已指定另一把喵喵密钥；没有保存或覆盖', 409)
    previous = keychain_key()
    if previous:
        if previous != key:
            raise DirectorError('本机已保存另一把喵喵密钥；本次没有覆盖，请先明确批准更换', 409)
        return
    lib = _security()
    service, account, secret = KEYCHAIN_SERVICE.encode(), KEYCHAIN_ACCOUNT.encode(), key.encode()
    status = lib.SecKeychainAddGenericPassword(None, len(service), service, len(account), account,
                                              len(secret), secret, None)
    if status != 0:
        raise DirectorError('未能写入本机钥匙串；没有写入明文配置或其他凭据')


def profile(path=PROFILE):
    if not path.is_file():
        return {'version': 1, 'model': 'gpt-5.4-mini', 'protocol': 'responses'}
    try:
        if path.stat().st_size > 4096:
            raise ValueError()
        p = json.loads(path.read_text())
        if (not isinstance(p, dict) or set(p) != {'version', 'model', 'protocol'}
                or p['version'] != 1 or p['model'] not in MODELS
                or p['protocol'] not in {'responses', 'chat-completions'}):
            raise ValueError()
        return p
    except (OSError, ValueError, TypeError):
        raise DirectorError('喵喵导演配置无效；没有改用其他服务') from None


def configure(body, path=PROFILE, key_writer=save_key):
    if not isinstance(body, dict) or set(body) - {'model', 'protocol', 'apiKey', 'saveToKeychain'}:
        raise DirectorError('配置字段无效')
    p = {'version': 1, 'model': body.get('model'), 'protocol': body.get('protocol')}
    if p['model'] not in MODELS or p['protocol'] not in {'responses', 'chat-completions'}:
        raise DirectorError('请选择已核对价格的模型和接口')
    with LOCK:
        if body.get('apiKey'):
            if body.get('saveToKeychain') is not True:
                raise DirectorError('请明确同意把喵喵专用密钥保存到本机 macOS 钥匙串')
            key_writer(body['apiKey'])
        path.parent.mkdir(parents=True, exist_ok=True)
        # Normal preference edits retain the previous version; credentials never
        # enter either this file or its history.
        if path.exists():
            old = path.read_bytes()
            history = path.parent / 'miaoapi-profile-history'
            history.mkdir(exist_ok=True)
            snapshot = history / (hashlib.sha256(old).hexdigest() + '.json')
            if not snapshot.exists():
                snapshot.write_bytes(old)
        temp = path.with_suffix('.pending')
        temp.write_text(json.dumps(p, ensure_ascii=False, indent=2))
        temp.replace(path)
    return {'saved': True, 'model': p['model'], 'protocol': p['protocol'], 'calledModel': False}


def pricing(model):
    i, o = MODELS[model]
    return {'currency': 'USD', 'input_per_million': i * 2, 'output_per_million': o * 2,
            'displayed_input_per_million': i, 'displayed_output_per_million': o,
            'safetyMultiplier': 2, 'checkedOn': '2026-10-04',
            'basis': '不降智的GPT 分组0.35x；按页面最高档单价加倍预留，平台账单为准',
            'source': ORIGIN + '/model-plaza?embedded=1'}


def parse_response(result, protocol, key=''):
    if not isinstance(result, dict):
        raise DirectorError('喵喵返回格式无效；没有自动重试', 502)
    if protocol == 'responses':
        if result.get('status') != 'completed' or result.get('error') or result.get('incomplete_details'):
            raise DirectorError('喵喵回答未完整结束，未应用；没有自动续写或重试', 502)
        output = result.get('output')
        if not isinstance(output, list):
            raise DirectorError('喵喵没有返回有效正文', 502)
        texts = []
        for item in output:
            if not isinstance(item, dict):
                raise DirectorError('模型输出结构无效', 502)
            if item.get('type') == 'reasoning':
                continue
            if (item.get('type') != 'message' or item.get('role') != 'assistant'
                    or item.get('status', 'completed') != 'completed' or not isinstance(item.get('content'), list)):
                raise DirectorError('模型返回未支持的动作，未应用', 502)
            for block in item['content']:
                if not isinstance(block, dict) or block.get('type') != 'output_text' or not isinstance(block.get('text'), str):
                    raise DirectorError('模型没有返回可应用的完整正文', 502)
                texts.append(block['text'])
        content = ''.join(texts)
        aliases = {'input_tokens': 'prompt_tokens', 'output_tokens': 'completion_tokens', 'total_tokens': 'total_tokens'}
    else:
        choices = result.get('choices')
        if not isinstance(choices, list) or len(choices) != 1 or not isinstance(choices[0], dict) or choices[0].get('finish_reason') != 'stop':
            raise DirectorError('喵喵回答未完整结束，未应用；没有自动续写或重试', 502)
        message = choices[0].get('message')
        if not isinstance(message, dict) or message.get('tool_calls') or message.get('refusal'):
            raise DirectorError('模型返回未支持的动作，未应用', 502)
        content = message.get('content')
        aliases = {k: k for k in ('prompt_tokens', 'completion_tokens', 'total_tokens')}
    if not isinstance(content, str) or not content.strip() or len(content) > 100_000:
        raise DirectorError('喵喵正文无效或过大；没有自动重试', 502)
    usage = result.get('usage') or {}
    if not isinstance(usage, dict):
        raise DirectorError('模型用量记录无效', 502)
    clean = {out: usage[src] for src, out in aliases.items() if isinstance(usage.get(src), int)
             and not isinstance(usage[src], bool) and 0 <= usage[src] <= 2_000_000}
    return _redact(content.strip(), key), clean


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise DirectorError('喵喵接口发生跳转，认证未转发；没有自动重试', 502)


class MiaoCanvas:
    def __init__(self, profile_reader=profile, credential_reader=read_key, opener=None):
        self.profile_reader, self.credential_reader = profile_reader, credential_reader
        self.opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def _settings(self):
        p = self.profile_reader()
        if p.get('model') not in MODELS or p.get('protocol') not in {'responses', 'chat-completions'}:
            raise DirectorError('喵喵导演模型或接口无效')
        key = self.credential_reader()
        revision = hashlib.sha256(json.dumps({'profile': p, 'pricing': pricing(p['model']),
            'keyDigest': hashlib.sha256(key.encode()).hexdigest()}, sort_keys=True).encode()).hexdigest()
        return key, p, revision

    def status(self):
        p = self.profile_reader()
        state = {'provider': 'miaoapi', 'origin': ORIGIN, 'model': p['model'], 'protocol': p['protocol'],
                 'label': '喵喵 API · ' + p['model'], 'remote': True, 'textOnly': True,
                 'pricing': pricing(p['model']), 'sourceLabel': '喵喵专用环境变量 / 本机 macOS 钥匙串',
                 'upstreamIdentityVerified': False}
        try:
            key, _, revision = self._settings()
            key = ''
            return {**state, 'configured': True, 'profileRevision': revision}
        except DirectorError as error:
            return {**state, 'configured': False, 'error': str(error)}

    def complete(self, body):
        if not isinstance(body, dict) or body.get('consent') is not True:
            raise DirectorError('请确认本次喵喵调用的文字范围和预算')
        messages = body.get('messages')
        if (not isinstance(messages, list) or not 1 <= len(messages) <= 256
                or any(not isinstance(m, dict) or set(m) != {'role', 'content'}
                       or m['role'] not in {'system', 'user', 'assistant'}
                       or not isinstance(m['content'], str) for m in messages)):
            raise DirectorError('喵喵助理只接收明确列出的文字，不接收素材文件或任意参数')
        encoded = json.dumps(messages, ensure_ascii=False).encode()
        if len(encoded) > INPUT_LIMIT:
            raise DirectorError('画布文字过多，未提交')
        maximum = body.get('maxTokens')
        if not isinstance(maximum, int) or isinstance(maximum, bool) or not 128 <= maximum <= OUTPUT_LIMIT:
            raise DirectorError('输出上限须为 128–8192 tokens')
        if not isinstance(body.get('jsonOutput', False), bool) or body.get('thinking', 'off') != 'off':
            raise DirectorError('喵喵接口不接受 DeepSeek 专用思考参数，请重新检查')
        a = body.get('authorization')
        key, p, revision = self._settings()
        try:
            if (not isinstance(a, dict) or a.get('provider') != 'miaoapi' or a.get('origin') != ORIGIN
                    or a.get('model') != p['model'] or a.get('sendText') is not True
                    or a.get('sendMedia') is not False or a.get('requestLimit') != 1
                    or a.get('currency') != 'USD' or not _number(a.get('budget')) or not 0 < a['budget'] <= 100):
                raise DirectorError('请确认喵喵 API、只发送文字、1 次请求和美元预算')
            if a.get('profileRevision') != revision:
                raise DirectorError('喵喵配置或密钥已变化，请重新检查；没有提交请求', 409)
            price = pricing(p['model'])
            estimated = math.ceil((len(encoded) + 4096) * price['input_per_million'] + maximum * price['output_per_million']) / 1_000_000
            if estimated > a['budget']:
                raise DirectorError(f'预算不足：本次保守预留 ${estimated:.6f}；没有提交请求')
            if key in encoded.decode():
                raise DirectorError('待发送文字包含密钥，未提交')
            if _redact(encoded.decode()) != encoded.decode():
                raise DirectorError('待发送文字疑似含密钥，请先移除')
            if p['protocol'] == 'responses':
                payload = {'model': p['model'], 'input': messages, 'max_output_tokens': maximum,
                           'store': False, 'stream': False}
                if body.get('jsonOutput'):
                    payload['text'] = {'format': {'type': 'json_object'}}
                endpoint = BASE + '/responses'
            else:
                payload = {'model': p['model'], 'messages': messages, 'max_completion_tokens': maximum,
                           'store': False, 'stream': False}
                if body.get('jsonOutput'):
                    payload['response_format'] = {'type': 'json_object'}
                endpoint = BASE + '/chat/completions'
            req = urllib.request.Request(endpoint, method='POST', headers={
                'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key},
                data=json.dumps(payload, ensure_ascii=False).encode())
            try:
                with self.opener.open(req, timeout=110) as response:
                    if response.geturl() != endpoint:
                        raise DirectorError('模型返回地址不符，认证未转发；没有自动重试', 502)
                    raw = response.read(2_000_001)
                if len(raw) > 2_000_000:
                    raise DirectorError('模型返回过大，未应用', 502)
                result = json.loads(raw)
            except DirectorError:
                raise
            except urllib.error.HTTPError as error:
                raise DirectorError(f'喵喵请求失败（HTTP {error.code}）；请核对权限与余额，没有自动重试', 502) from None
            except Exception:
                raise DirectorError('喵喵请求未确认，请核对平台账单；没有自动重试', 502) from None
            content, usage = parse_response(result, p['protocol'], key)
            return {'content': content, 'usage': usage, 'provider': 'miaoapi', 'model': p['model'],
                    'finish_reason': 'stop', 'estimatedMaximumUSD': estimated}
        finally:
            key = ''
