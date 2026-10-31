"""Explicit, one-request ElevenLabs music for a footage video's measured cut.

This module carries no credentials. Collection and intermediate stages return
before constructing a music request, and failed music never triggers a fallback.
"""
from __future__ import annotations

import math
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from web_api.music_pipeline import MusicPipelineRequest, estimate_music, render_music


MUSIC_MODEL_IDS = frozenset({'music_v1', 'music_v2', 'music_v2_5'})
_RENDER_FAILURE = (
    'ElevenLabs 配乐未完成；已有旁白和素材已保留，不会自动重试。'
    '请先核对服务商任务与账单。'
)
_AUDIO_FAILURE = (
    'ElevenLabs 返回的配乐未通过项目内音频验证；已有旁白和素材已保留，'
    '不会自动重试。请先核对服务商任务与账单。'
)
_PREVIEW_FIELDS = frozenset({
    'status', 'project_id', 'provider', 'model_id', 'duration_seconds',
    'duration_source', 'reference', 'reference_support', 'cue_sheet',
    'prompt_preview', 'force_instrumental', 'output', 'estimated_cost_usd',
    'estimated_cost_cny', 'would_generate', 'authorization_required',
    'requires_confirmation', 'message', 'pricing', 'pricing_source',
})


def _value(item: Any, name: str, default: Any = None) -> Any:
    return item.get(name, default) if isinstance(item, Mapping) else getattr(item, name, default)


def paid_music_requested(request: Any) -> bool:
    """Whether this operation actually reaches paid music before video editing."""
    return (
        _value(request, 'action') != 'collect'
        and _value(request, 'stop_at') == 'video'
        and _value(_value(request, 'options'), 'bgm_mode') == 'elevenlabs'
    )


def _music_request(request: Any, duration_seconds: Any, *, output_name: str | None = None,
                   execute: bool = False) -> MusicPipelineRequest:
    options = _value(request, 'options')
    prompt = _value(options, 'bgm_prompt')
    if not isinstance(prompt, str):
        raise ValueError('请填写 4—3100 字符的 ElevenLabs 配乐提示词')
    prompt = ' '.join(prompt.split()).strip()
    if not 4 <= len(prompt) <= 3100:
        raise ValueError('ElevenLabs 配乐提示词须为 4—3100 个非空白字符')
    model_id = _value(options, 'bgm_model_id')
    if not isinstance(model_id, str) or model_id not in MUSIC_MODEL_IDS:
        raise ValueError('ElevenLabs 配乐模型须为 music_v1、music_v2 或 music_v2_5')
    if isinstance(duration_seconds, bool):
        raise ValueError('ElevenLabs 配乐实际时长须为 3—600 秒')
    try:
        duration = float(duration_seconds)
    except (TypeError, ValueError, OverflowError):
        raise ValueError('ElevenLabs 配乐实际时长须为 3—600 秒') from None
    if not math.isfinite(duration) or not 3 <= duration <= 600:
        raise ValueError('ElevenLabs 配乐实际时长须为 3—600 秒')
    fields = dict(
        project_id=_value(request, 'project_id'), prompt=prompt,
        duration_seconds=duration, preferred_provider='elevenlabs', model_id=model_id,
        force_instrumental=True, allow_fallback=False,
        dry_run=not execute, execute=execute, confirm=execute,
    )
    if output_name is not None:
        fields['output_name'] = output_name
    return MusicPipelineRequest(**fields)


def _positive_amount(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        amount = float(value)
    except (ValueError, OverflowError):
        return None
    return amount if math.isfinite(amount) and amount > 0 else None


def preflight_footage_music(root: str | Path, request: Any, duration_seconds: Any,
                           tool: Any | None = None, require_approval: bool = False) -> dict[str, Any]:
    """Return a free provider preview plus readiness and missing approvals.

    ``ready`` means a valid available provider and known positive estimate; with
    ``require_approval`` it also requires all three opt-ins and sufficient USD
    budget for the actual supplied cut duration. No tool is executed here.
    """
    if not paid_music_requested(request):
        return {'required': False, 'ready': True, 'errors': [], 'approvals': []}
    errors: list[str] = []
    approvals: list[str] = []
    try:
        music_request = _music_request(request, duration_seconds)
    except ValueError as exc:
        return {'required': True, 'ready': False, 'errors': [str(exc)], 'approvals': []}
    try:
        estimate = estimate_music(music_request, tool=tool, project_root=root)
    except Exception:
        estimate = {}
    if not isinstance(estimate, Mapping):
        estimate = {}
    result = {name: value for name, value in estimate.items() if name in _PREVIEW_FIELDS}
    provider = estimate.get('provider')
    available = (
        estimate.get('status') == 'dry_run' and estimate.get('would_generate') is True
        and isinstance(provider, Mapping) and provider.get('status') == 'available'
    )
    if not available:
        if isinstance(provider, Mapping) and provider.get('status') == 'unavailable':
            errors.append('ElevenLabs Music 不可用：ELEVENLABS_API_KEY 未配置；没有发起付费生成')
        else:
            errors.append('ElevenLabs Music 预检未通过；没有发起付费生成')
    cost = _positive_amount(estimate.get('estimated_cost_usd'))
    if cost is None:
        errors.append('ElevenLabs 配乐价格未知或估算无效；不能将其视为免费，也不能执行付费生成')
    if require_approval:
        options = _value(request, 'options')
        for field, message in (
            ('bgm_confirm_paid', '请明确确认 ElevenLabs 配乐会产生费用'),
            ('bgm_confirm_text', '请确认将配乐提示词发送给 ElevenLabs，不发送视频或音频文件'),
            ('bgm_billing_limit_configured', '请确认已在服务商配置实际账单上限'),
        ):
            if _value(options, field) is not True:
                approvals.append(message)
        budget = _positive_amount(_value(options, 'bgm_budget_usd'))
        if budget is None:
            approvals.append('本次 ElevenLabs 配乐预算须为有限且大于 0 的美元金额')
        elif cost is not None and budget < cost:
            approvals.append(f'实际片长对应配乐估算 US${cost:.4f} 超过本次预算 US${budget:.4f}')
    return {**result, 'required': True, 'ready': not errors and not approvals,
            'errors': errors, 'approvals': approvals, 'model_id': music_request.model_id}


def render_footage_music(root: str | Path, request: Any, duration_seconds: Any,
                        output_name: str, tool: Any | None = None) -> dict[str, Any]:
    """Generate exactly once after approval and verify a project-local audio file."""
    if not paid_music_requested(request):
        raise ValueError('当前阶段没有请求付费配乐；不会发起 ElevenLabs 生成')
    checked = preflight_footage_music(root, request, duration_seconds, tool=tool, require_approval=True)
    if not checked['ready']:
        raise ValueError('；'.join(checked['errors'] + checked['approvals']))
    try:
        music_request = _music_request(request, duration_seconds, output_name=output_name, execute=True)
    except ValueError:
        raise ValueError('ElevenLabs 配乐输出文件名或请求无效；没有发起付费生成') from None
    # Lazy imports avoid a cycle when FootageJobs imports this helper.
    from web_api.footage_pipeline import local_path, probe, project_path
    project = project_path(Path(root), _value(request, 'project_id'))
    destination = local_path(project, f'assets/music/{music_request.output_name}', exists=False)
    if destination.exists():
        raise ValueError('已有同名配乐文件，请使用新的运行文件名；不会覆盖已有配乐')
    try:
        result = render_music(music_request, tool=tool, project_root=root, authorized=True)
    except Exception:
        raise ValueError(_RENDER_FAILURE) from None
    if not isinstance(result, dict) or result.get('status') != 'completed':
        raise ValueError(_RENDER_FAILURE)
    try:
        music = result.get('music')
        path_value = music.get('path') if isinstance(music, Mapping) else None
        if not isinstance(path_value, str) or not path_value:
            raise ValueError()
        output = local_path(project, path_value)
        if not output.is_file() or output.stat().st_size <= 0:
            raise ValueError()
        details = probe(output)
        measured = _positive_amount(details.get('duration')) if isinstance(details, Mapping) else None
        if not isinstance(details, Mapping) or details.get('has_audio') is not True or measured is None:
            raise ValueError()
    except Exception:
        raise ValueError(_AUDIO_FAILURE) from None
    return result


__all__ = ['paid_music_requested', 'preflight_footage_music', 'render_footage_music']
