"""Fresh project-scoped outputs for the explicitly selected free composer."""
from __future__ import annotations

from pathlib import Path
import uuid

from backlot.server import notify_project_changed
from lib.events import emit_event
from tools.audio.local_music import LocalMusic
from web_api.media_pipeline import (_probe_media, _relative, _resolve_project, _sha256, _utc_now, _write_manifest)


def render_local_music(request, *, project_root):
    # Import lazily to keep the request model and this adapter independent.
    from web_api.music_pipeline import _reference_info, _duration_for, _normalise_cues
    try:
        project = _resolve_project(project_root, request.project_id)
        reference = _reference_info(project, request)
        duration, duration_source = _duration_for(request, reference)
        cues = _normalise_cues(request, duration)
        run_id = uuid.uuid4().hex
        directory = project / 'assets/music' / ('local-' + run_id)
        directory.mkdir(parents=True, exist_ok=False)
        output = directory / request.output_name
        result = LocalMusic().execute({'prompt': request.prompt, 'duration_seconds': duration,
            'style': request.local_style, 'tempo_bpm': request.local_tempo_bpm,
            'force_instrumental': request.force_instrumental, 'cue_sheet': cues, 'output_path': str(output)})
        if not result.success:
            return {'status': 'provider_error', 'project_id': request.project_id,
                    'error': result.error, 'would_generate': False, 'paid_calls': 0}
        probe = _probe_media(output)
        if not probe or not probe.get('audio'):
            raise ValueError('本机合成文件不能解码，未标记为完成；已有产物保留')
        # Every rerun has a separate directory and manifest; accepted tracks are kept.
        relative, checksum = _relative(project, output), _sha256(output)
        manifest, manifest_hash = _write_manifest(project, f'local_music_manifest_{run_id}.json', {
            'schema_version': '1.0', 'project_id': request.project_id, 'status': 'completed',
            'stage': 'local_instrumental_composition', 'created_at': _utc_now(),
            'provider': 'local_synthesis', 'creative_method': 'procedural_synthesis_not_trained_ai',
            'duration_source': duration_source, 'cue_sheet': cues, 'reference': reference,
            'reference_support': 'local_metadata_and_explicit_energy_cues_only',
            'output': {'path': relative, 'sha256': checksum, 'probe': probe},
            'data': {k: v for k, v in result.data.items() if k != 'output'},
            'cost_usd': 0, 'private_media_uploaded': False,
        })
        emit_event(project, {'event': 'music_generation', 'status': 'completed',
            'provider': 'local_synthesis', 'artifact': relative, 'manifest': _relative(project, manifest), 'cost_usd': 0})
        notify_project_changed(project.name)
        return {'status': 'completed', 'project_id': request.project_id,
            'provider': {'name': 'local_music', 'provider': 'local_synthesis', 'model': None, 'runtime': 'local'},
            'music': {'path': relative, 'sha256': checksum, 'size_bytes': output.stat().st_size,
                'duration_seconds': duration, 'format': output.suffix.lstrip('.')},
            'output': {'path': relative, 'kind': 'audio', 'sha256': checksum},
            'manifest': {'path': _relative(project, manifest), 'sha256': manifest_hash},
            'reference': reference, 'reference_support': 'local_metadata_and_explicit_energy_cues_only',
            'cost_cny': 0, 'estimated_cost_usd': 0, 'paid_calls': 0,
            'data': {k: v for k, v in result.data.items() if k != 'output'},
            'message': '本机器乐已合成，可试听并带入混音；没有调用 ElevenLabs。'}
    except (ValueError, FileNotFoundError, OSError) as exc:
        return {'status': 'invalid_request', 'project_id': request.project_id,
                'error': str(exc)[:400], 'would_generate': False, 'paid_calls': 0}
