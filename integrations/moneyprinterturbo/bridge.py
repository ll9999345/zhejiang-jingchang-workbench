"""Run the pinned upstream in a fresh process, with project-scoped outputs.

Input is non-secret JSON on stdin. Credentials are inherited environment only.
No upstream config.toml is read/written; no upstream task auto-publish is used.
"""
from __future__ import annotations
import contextlib
import ast
from dataclasses import asdict
from functools import partial
import importlib
import json
import os
import re
from pathlib import Path
import sys
import subprocess
import types

HERE = Path(__file__).resolve().parent
UPSTREAM = HERE / 'upstream'


TTS_RETRY_FUNCTIONS = frozenset(('azure_tts_v1', 'azure_tts_v2', 'siliconflow_tts',
    'mimo_tts', 'minimax_tts', 'elevenlabs_tts', '_openai_compatible_tts',
    'fish_audio_tts', 'voxcpm_tts'))


def limit_tts_retries(voice):
    """Adapt only the pinned leaf functions' explicit three-attempt loops."""
    if getattr(voice, '_openmontage_single_attempt', False):
        return
    source = UPSTREAM / 'app/services/voice.py'
    tree = ast.parse(source.read_text(encoding='utf-8'), filename=str(source))
    functions = []
    for node in tree.body:
        if not isinstance(node, ast.FunctionDef) or node.name not in TTS_RETRY_FUNCTIONS:
            continue
        retries = [statement for statement in node.body if isinstance(statement, ast.For)
            and isinstance(statement.iter, ast.Call) and isinstance(statement.iter.func, ast.Name)
            and statement.iter.func.id == 'range' and len(statement.iter.args) == 1
            and isinstance(statement.iter.args[0], ast.Constant) and statement.iter.args[0].value == 3]
        if len(retries) != 1:
            raise ValueError('pinned TTS retry contract changed')
        retries[0].iter.args[0] = ast.copy_location(ast.Constant(value=1), retries[0].iter.args[0])
        functions.append(node)
    if {node.name for node in functions} != TTS_RETRY_FUNCTIONS:
        raise ValueError('pinned TTS retry functions changed')
    code = compile(ast.fix_missing_locations(ast.Module(body=functions, type_ignores=[])), str(source), 'exec')
    exec(code, voice.__dict__)
    voice.OpenAI = partial(voice.OpenAI, max_retries=0)
    voice._openmontage_single_attempt = True


def apply_voice_volume(source: Path, target: Path, volume: float, binary: str):
    """Keep the generated source and apply provider-independent local gain."""
    if not 0 <= volume <= 2:
        raise ValueError('invalid voice volume')
    subprocess.run([binary, '-nostdin', '-n', '-i', str(source), '-af', f'volume={volume}',
        '-codec:a', 'libmp3lame', '-q:a', '2', str(target)],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=180)


def setup(output: Path):
    sys.path.insert(0, str(HERE.parents[1]))
    sys.path.insert(0, str(UPSTREAM))
    import toml
    from loguru import logger
    logger.remove()
    settings = toml.load(UPSTREAM / 'config.example.toml')
    # Load explicit MPT_* environment settings only. Double underscore denotes
    # a TOML section, e.g. MPT_KOKORO__BASE_URL. Never write this mapping to disk.
    for key, value in os.environ.items():
        if not key.startswith('MPT_'):
            continue
        name = key[4:].lower()
        section, field = name.split('__', 1) if '__' in name else ('app', name)
        try:
            parsed = json.loads(value)
        except (ValueError, TypeError):
            parsed = value
        settings.setdefault(section, {})[field] = parsed
    settings['app'].update(tls_verify=True, upload_post_auto_upload=False, twelvelabs_enabled=False)
    config = types.ModuleType('app.config.config')
    for name, value in settings.items():
        setattr(config, name, value)
    for section in ('app', 'ui', 'proxy', 'whisper', 'azure', 'siliconflow', 'elevenlabs', 'fish_audio', 'kokoro', 'chatterbox', 'minimax_tts', 'voxcpm'):
        if not hasattr(config, section):
            setattr(config, section, {})
    config.toml = settings
    config.root_dir = str(output)
    config.config_file = str(output / 'config-not-persisted.toml')
    config.save_config = lambda *a, **k: None
    config.runtime_config_lock = contextlib.nullcontext
    config.snapshot_config_with_pending = lambda obj: dict(obj)
    config.get_default_ollama_base_url = lambda: 'http://127.0.0.1:11434/v1'
    sys.modules['app.config.config'] = config
    from app.config import config as loaded
    assert loaded is config
    from app.utils import utils
    utils.root_dir = lambda: str(output)
    utils.font_dir = lambda: '/System/Library/Fonts'
    import imageio_ffmpeg
    binary = imageio_ffmpeg.get_ffmpeg_exe()
    os.environ['IMAGEIO_FFMPEG_EXE'] = binary
    config.app['ffmpeg_path'] = binary
    return config


def run(req: dict, project: Path, output: Path):
    config = setup(output)
    op, provider = req['operation'], req['provider']
    from integrations.moneyprinterturbo.catalog import loopback_provider, model_config_key, supports_model
    if loopback_provider(op, provider):
        # Changes stay in this isolated worker. A global proxy must not turn a
        # deliberately local LLM/TTS request into an external transfer.
        for name in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'):
            os.environ.pop(name, None)
        config.proxy = {}
    requested_model = req.get('model', '').strip()
    if requested_model and not supports_model(op, provider):
        raise ValueError('selected service does not accept a model override')
    model_field = model_config_key(op, provider)
    if requested_model and model_field:
        config.app[model_field] = requested_model
    from app.models.schema import VideoAspect, VideoParams, VideoConcatMode, VideoFitMode, VideoTransitionMode
    from app.utils import utils
    aspect = VideoAspect(req.get('aspect_ratio', '16:9'))
    def local(value):
        path = (project / value).resolve()
        if not value or not path.is_relative_to(project) or not path.is_file():
            raise ValueError('invalid project input')
        return str(path)
    def result_files(paths):
        result = []
        for p in paths:
            path = Path(p).resolve()
            if not path.is_relative_to(output) or not path.is_file() or not path.stat().st_size:
                raise ValueError('upstream did not produce a local artifact')
            result.append(path.relative_to(project).as_posix())
        return {'files': result}
    text = req.get('text', '')
    if op == 'stock_search':
        # Execute the pinned upstream's real stock search, not generated media.
        # Download, location review and manual selection remain in the host.
        from app.services import material
        functions = {'pexels': material.search_videos_pexels,
                     'pixabay_video': material.search_videos_pixabay,
                     'coverr': material.search_videos_coverr}
        if provider not in functions:
            raise ValueError('unsupported stock provider')
        for env_name, field in [('PEXELS_API_KEY', 'pexels_api_keys'),
                                ('PIXABAY_API_KEY', 'pixabay_api_keys'),
                                ('COVERR_API_KEY', 'coverr_api_keys')]:
            if os.environ.get(env_name) and not os.environ.get('MPT_' + field.upper()):
                config.app[field] = [os.environ[env_name]]
        minimum = float(req.get('minimum_duration', 0))
        if not 0 <= minimum <= 120 or not isinstance(text, str) or not text.strip() or len(text) > 1000:
            raise ValueError('invalid stock search request')
        # Pinned searches catch transport/HTTP errors and return []. Preserve
        # the distinction from a successful search with no matching assets.
        original_get = material.requests.get
        transport_errors = []
        from integrations.moneyprinterturbo.stock_errors import StockSearchError, transport_error, valid_status
        response_json_methods = []
        from integrations.moneyprinterturbo.stock_metadata import index_response_metadata
        source_metadata = {}
        def strict_stock_get(*args, **kwargs):
            if transport_errors:
                raise transport_errors[0] from None
            try:
                kwargs['allow_redirects'] = False
                response = original_get(*args, **kwargs)
                if not valid_status(response.status_code):
                    raise StockSearchError(provider, error_kind='invalid_response')
                if not 200 <= response.status_code < 300:
                    raise StockSearchError(provider, status_code=response.status_code)
                original_json = response.json
                if not callable(original_json):
                    raise StockSearchError(provider, error_kind='invalid_response')
                response_json_methods.append((response, original_json))
                def checked_json(*json_args, **json_kwargs):
                    if transport_errors:
                        raise transport_errors[0] from None
                    try:
                        payload = original_json(*json_args, **json_kwargs)
                        key = 'videos' if provider == 'pexels' else 'hits'
                        if not isinstance(payload, dict) or not isinstance(payload.get(key), list):
                            raise ValueError('invalid stock response')
                        index_response_metadata(provider, payload, source_metadata)
                        return payload
                    except Exception:
                        error = StockSearchError(provider, status_code=response.status_code, error_kind='invalid_response')
                        transport_errors.append(error)
                        raise error from None
                response.json = checked_json
                return response
            except Exception as exc:
                error = transport_error(provider, exc)
                transport_errors.append(error)
                raise error from None
        material.requests.get = strict_stock_get
        try:
            rows = functions[provider](search_term=text, minimum_duration=minimum, video_aspect=aspect)
        finally:
            material.requests.get = original_get
            for response, original_json in response_json_methods:
                response.json = original_json
        if transport_errors:
            raise transport_errors[0] from None
        items = []
        seen = set()
        for row in rows[:100]:
            if not row.url or row.url in seen:
                continue
            seen.add(row.url)
            info = getattr(row, 'source_info', {}) or {}
            # Never echo credentials/config or a query as asserted source tags.
            items.append({'url': row.url, 'duration': row.duration,
                          'source_metadata': source_metadata.get((str(info.get('asset_id') or ''), row.url), {}),
                          'source_info': {k: info.get(k) for k in
                                          ('asset_id', 'source_page', 'creator', 'rendition')}})
        return {'items': items, 'engine': 'moneyprinterturbo',
                'upstream_function': functions[provider].__name__}
    if op in ('tts', 'image', 'video'):
        text = text or req.get('topic', '')
    if op in ('script', 'terms', 'social', 'connection'):
        from app.services import llm
        llm._max_retries = 1
        # The SDK retries independently of upstream's loop. A transient failure
        # must not create additional billable requests without another approval.
        llm.OpenAI = partial(llm.OpenAI, max_retries=0)
        llm.AzureOpenAI = partial(llm.AzureOpenAI, max_retries=0)
        def no_fallback(*args, **kwargs):
            raise ValueError('model did not return valid publishing text')
        llm._fallback_social_metadata = no_fallback
        config.app['llm_provider'] = provider
        if op == 'connection':
            connected, _, elapsed = llm.test_connection()
            if not connected:
                raise ValueError('selected model connection test failed')
            return {'value': {'connected': True, 'provider': provider,
                              'elapsed_seconds': round(elapsed, 3),
                              'test_prompt': 'Reply with exactly: OK'}, 'files': []}
        if op == 'script':
            value = llm.generate_script(req.get('topic') or text, language=req['language'],
                    paragraph_number=req['paragraphs'], video_script_prompt=text if req.get('topic') else '',
                    custom_system_prompt=req.get('system_prompt', ''))
        elif op == 'terms':
            value = llm.generate_terms(req.get('topic') or text, text, amount=req['terms_count'], match_script_order=True)
        else:
            value = llm.generate_social_metadata(req.get('topic') or text, text, language=req['language'], platform=req['social_platform'])
        if not value or isinstance(value, str) and value.lstrip().startswith('Error:'):
            raise ValueError('provider returned no content')
        return {'value': value, 'files': []}
    if op == 'tts':
        from app.services import voice
        limit_tts_retries(voice)
        if provider in ('gemini', 'mimo', 'elevenlabs', 'voxcpm') and req['voice_rate'] != 1:
            raise ValueError('selected TTS adapter does not apply speech rate')
        name = req.get('voice')
        # Prevent a voice name from silently dispatching to a different service.
        predicates = {'edge': voice.is_azure_v1_voice, 'azure': voice.is_azure_v2_voice,
            'siliconflow': voice.is_siliconflow_voice, 'gemini': voice.is_gemini_voice,
            'mimo': voice.is_mimo_voice, 'minimax': voice.is_minimax_voice,
            'elevenlabs': voice.is_elevenlabs_voice, 'chatterbox': voice.is_chatterbox_voice,
            'kokoro': voice.is_kokoro_voice, 'fish': voice.is_fish_audio_voice, 'voxcpm': voice.is_voxcpm_voice}
        if not name or not predicates[provider](name):
            raise ValueError('voice does not belong to selected service')
        path = output / 'voice.mp3'
        volume = req.get('voice_volume', 1)
        source_audio = output / 'voice-source.mp3' if volume != 1 else path
        reference = Path(local(req['reference_audio'])).read_bytes() if req.get('reference_audio') else None
        reference_text = req.get('reference_text', '').strip()
        if reference_text and not reference:
            raise ValueError('reference text requires reference audio')
        maker = voice.tts(text, name, req['voice_rate'], str(source_audio),
                          voxcpm_reference_audio=reference, voxcpm_prompt_audio=reference if reference_text else None,
                          voxcpm_prompt_text=reference_text)
        if maker is None:
            raise ValueError('voice service returned no audio')
        if source_audio != path:
            apply_voice_volume(source_audio, path, volume, config.app['ffmpeg_path'])
        paths = [path]
        sub = output / 'voice.srt'
        voice.create_subtitle(maker, text, str(sub), word_level=req["word_level"])
        if sub.is_file():
            paths.append(sub)
        result = result_files(paths)
        result['voice_volume'] = volume
        if source_audio != path:
            result['source_audio'] = source_audio.relative_to(project).as_posix()
        result['subtitle_timing'] = 'speech_boundaries' if provider == 'edge' else 'provider_or_estimated'
        if provider != 'edge':
            result['notice'] = '此服务的字幕时间轴可能是估计值；需要逐词校准时，请使用本机 Whisper 转录音频。'
        return result
    if op in ('image', 'video'):
        from app.services import material
        if op == 'image':
            material.OPENAI_IMAGE_MAX_ATTEMPTS = 1
            rows = material.generate_images_openai(text, req['duration'], aspect, save_dir=str(output))
        else:
            service = material if provider == 'wavespeed' else importlib.import_module('app.services.' + provider)
            func = service.generate_videos_wavespeed if provider == 'wavespeed' else service.generate_videos
            rows = func(text, req['duration'], aspect)
        if not rows:
            raise ValueError('generation returned no media')
        paths, sources = [], []
        for row in rows:
            path = ''
            if Path(row.url).is_file():
                path = row.url
            else:
                path = material.save_video(row.url, save_dir=str(output))
            if path:
                paths.append(path)
                if isinstance(getattr(row, 'source_info', None), dict):
                    sources.append(material._material_source_record(row, path))
        if not paths:
            raise ValueError('generation not downloaded')
        result = result_files(paths)
        result['material_sources'] = sources
        if requested_model:
            result['model'] = requested_model
        return result
    if op == 'music':
        from app.services import material
        mod = importlib.import_module('app.services.' + ('elevenlabs_music' if provider == 'elevenlabs' else 'sonilo'))
        path = output / ('music.mp3' if provider == 'elevenlabs' else 'music.m4a')
        source_video = local(req['video_path'])
        source_duration = material._get_downloaded_video_duration(source_video)
        if source_duration <= 0:
            raise ValueError('music source video has no playable duration')
        mod.generate_bgm(source_video, str(path), source_duration, prompt=text)
        result = result_files([path])
        result['source_duration'] = source_duration
        return result
    if op == 'transcribe':
        from app.services import subtitle
        from faster_whisper import WhisperModel
        model_root = HERE.parents[1] / '.runtime/models'
        default_model = model_root / ('whisper-small' if (model_root/'whisper-small/model.bin').is_file() else 'whisper-base')
        model_path = Path(os.getenv('MPT_WHISPER_MODEL_PATH') or default_model).resolve()
        if not (model_path / 'model.bin').is_file():
            raise ValueError('local Whisper model not installed')
        model = WhisperModel(str(model_path), device='cpu', compute_type='int8', local_files_only=True)
        language = req.get('language', 'zh-CN').split('-')[0]
        class Recognizer:
            def transcribe(self, *args, **kwargs):
                return model.transcribe(*args, language=None if language == 'auto' else language, **kwargs)
        subtitle.model = Recognizer()
        # Full-script prompts can bias a small recognizer into repeating words.
        # Keep the reference separate and expose a comparison for human review.
        subtitle.initial_prompt = '以下是普通话，使用简体中文。' if language == 'zh' else None
        path = output / 'transcript.srt'
        subtitle.create(local(req['audio_path']), str(path), word_level=req['word_level'], log_details=False)
        rows = subtitle.file_to_subtitles(str(path))
        if not rows:
            raise ValueError('no speech recognized')
        result = result_files([path])
        recognized = ''.join(row[2] for row in rows) if language == 'zh' else ' '.join(row[2] for row in rows)
        normalize = lambda value: re.sub(r'[\W_]+', '', value).lower()
        result['value'] = {'recognized_text': recognized, 'reference_text': text,
                           'matches_reference': normalize(recognized) == normalize(text) if text.strip() else None}
        result['recognition_model'] = model_path.name
        result['notice'] = '字幕来自本机语音识别，专有名词仍需校对。原稿用于对照，不会直接替换识别文字和时间。'
        return result
    if op == 'edit':
        from app.services import video
        video.delete_files = lambda *a, **k: None  # Retain input and intermediate evidence.
        paths = [local(p) for p in req['video_paths']]
        if not paths:
            paths = [local(req['video_path'])]
        audio = local(req['audio_path'])
        combined = output / 'combined.mp4'
        transition = VideoTransitionMode(req['transition']) if req['transition'] != 'none' else None
        video.combine_videos(str(combined), paths, audio, aspect, VideoConcatMode(req['order']), transition,
                max_clip_duration=req['clip_duration'], threads=2, clip_speed=req['clip_speed'],
                video_fit_mode=VideoFitMode(req['fit']))
        final = output / 'advanced-edit.mp4'
        params = VideoParams(video_subject=req.get('topic') or '高级剪辑', video_aspect=aspect,
                bgm_type='custom' if req.get('bgm_path') else '', bgm_file=local(req['bgm_path']) if req.get('bgm_path') else '',
                bgm_volume=req['bgm_volume'], subtitle_enabled=bool(req.get('subtitle_path')),
                subtitle_display_mode='word_by_word' if req['word_level'] else 'sentence',
                subtitle_animation=req['subtitle_animation'], subtitle_position=req['subtitle_position'],
                font_name=req.get('font_name', 'PingFang.ttc'), font_size=req['font_size'], text_fore_color=req['text_color'],
                text_background_color=req['background_color'] or False,
                stroke_color=req.get('stroke_color', '#000000'), stroke_width=req.get('stroke_width', 1.5),
                rounded_subtitle_background=req.get('rounded_subtitle_background', True),
                custom_position=req.get('custom_position', 70), voice_volume=req.get('voice_volume', 1),
                n_threads=2)
        selected_subtitle = ''
        if req.get('subtitle_path'):
            # MoviePy's SRT reader only commits a cue on a blank line. Common
            # SRT files end directly after the final cue; preserve the original
            # and normalize a project-scoped rendering copy, including BOM/CRLF.
            content = Path(local(req['subtitle_path'])).read_text(encoding='utf-8-sig')
            selected_subtitle = str(output / 'selected-subtitles.srt')
            Path(selected_subtitle).write_text(content.replace('\r\n', '\n').replace('\r', '\n').rstrip() + '\n\n', encoding='utf-8')
        ok = video.generate_video(str(combined), audio, selected_subtitle, str(final), params)
        if not ok:
            raise ValueError('requested music was not mixed successfully')
        result = result_files([final])
        result['subtitle_timing'] = 'from_selected_srt' if req.get('subtitle_path') else 'disabled'
        if req['word_level'] and req.get('subtitle_path'):
            result['notice'] = '字幕按所选 SRT 的文字和时间轴渲染；逐词显示需要先选择或转录生成逐词 SRT。'
        return result
    if op == 'analyze':
        from app.services import twelvelabs
        config.app['twelvelabs_enabled'] = True
        value = twelvelabs.analyze_clip(req['public_video_url'], prompt=text or 'Describe this video.', model=requested_model or None)
        if not value:
            raise ValueError('no analysis returned')
        return {'value': value, 'files': []}
    if op == 'rerank':
        from app.services import twelvelabs
        config.app.update(twelvelabs_enabled=True, twelvelabs_rerank_terms=True)
        embed = twelvelabs.embed_text
        def strict_embed(*args, **kwargs):
            value = embed(*args, **kwargs)
            if value is None:
                raise ValueError('embedding did not complete')
            return value
        twelvelabs.embed_text = strict_embed
        terms = [line.strip() for line in text.splitlines() if line.strip()]
        if not req['topic'].strip() or not 2 <= len(terms) <= 12:
            raise ValueError('reranking requires a subject and two to twelve non-empty terms')
        return {'value': twelvelabs.rerank_terms_by_subject(req['topic'], terms, model=requested_model or None), 'files': []}
    if op == 'publish_status':
        from app.services.upload_post import UploadPostService
        value = UploadPostService().check_status(req['remote_request_id'])
        if value.get('error'):
            raise ValueError('publication status unavailable')
        return {'value': {k:value[k] for k in ('status','success','request_id') if k in value}, 'files': []}
    if op == 'publish':
        if req['privacy'] != 'public' and any(p != 'youtube' for p in req['platforms']):
            raise ValueError('non-public publishing is only supported for YouTube')
        from app.services.upload_post import UploadPostService
        config.app['upload_post_enabled'] = True
        service = UploadPostService()
        value = service.upload_video(local(req['video_path']), text, platforms=req['platforms'],
            privacy_level='PUBLIC_TO_EVERYONE' if req['privacy'] == 'public' else None,
            youtube_extra={'privacyStatus': req['privacy'], 'selfDeclaredMadeForKids': req['made_for_kids']})
        if not value.get('success'):
            raise ValueError('publication not accepted')
        # Accepted is not delivered. Preserve a receipt ID for explicit status checks.
        return {'value': {k: value[k] for k in ('success', 'request_id') if k in value}, 'files': [], 'status': 'accepted'}
    if op.startswith('loomloom_'):
        from app.services.loomloom import LoomLoomVideoBackend, video_settings_from_mapping, LoomLoomSettings, LoomLoomScriptBackend
        script_mode = op.startswith('loomloom_script')
        if script_mode:
            service = LoomLoomScriptBackend(LoomLoomSettings.from_mapping(config.app))
            batch = service.prepare_script_batch(subject=req.get('topic') or text, candidate_count=min(req['paragraphs'],3),
                    language=req['language'], duration_seconds=req['duration'], style=text)
        else:
            service = LoomLoomVideoBackend(video_settings_from_mapping(config.app))
            batch = service.prepare_video_batch(subject=req.get('topic') or text, scene_prompts=[text],
                                                model_id=req['model'], aspect_ratio=aspect.value)
        if op.endswith('_quote'):
            return {'value': asdict(service.quote(batch)), 'files': []}
        execution = service.execute(batch, client_request_id=req['request_id'],
                    listing_version_id=req['listing_version_id'], confirm=True)
        service.wait_for_run(execution.run_id)
        if script_mode:
            batch_result = service.get_script_results(execution.run_id)
            if not batch_result.candidates:
                raise ValueError('no script candidates returned')
            return {'value': {'candidates':[asdict(c) for c in batch_result.candidates], 'failed_count':len(batch_result.errors)}, 'files': []}
        paths = service.download_video_results(execution.run_id, str(output))
        return result_files(paths)
    raise ValueError('unsupported operation')


def failure_result(exc):
    from integrations.moneyprinterturbo.stock_errors import StockSearchError
    if isinstance(exc, StockSearchError):
        return {'status': 'failed', 'error_type': 'StockSearchError', **exc.receipt(),
                'message': '素材来源请求失败；本次任务将保留已取得的素材，不会自动切换搜索引擎。'}
    result = {'status': 'failed', 'error_type': type(exc).__name__,
        'message': '服务未产生可用结果，请检查账号权限、模型或输入文件。不会自动重新付费提交。'}
    # The pinned video adapters deliberately attach a task ID to post-submit
    # failures. Keep only that receipt, never the exception text/signed URL.
    task_id = getattr(exc, 'task_id', None)
    if isinstance(task_id, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,160}', task_id):
        result['remote_task_id'] = task_id
        result['message'] = '远端任务可能仍在执行或已计费；请先凭 remote_task_id 核对服务商记录，不会自动重试。'
    if type(exc).__name__.endswith('UnconfirmedTaskError'):
        result['status'] = 'interrupted'
        result['message'] = '远端请求可能已受理，但尚未确认结果；请先核对服务商记录，不会自动重新付费提交。'
    return result


def main():
    payload = json.loads(sys.stdin.read(1_048_576))
    project, output = Path(payload['project']).resolve(), Path(payload['output']).resolve()
    if not output.is_relative_to(project) or output == project:
        raise ValueError('invalid output directory')
    # All uncontrolled upstream output is discarded, including exceptions and
    # provider response bodies which can contain a signed URL or an API token.
    with open(os.devnull, 'w') as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        try:
            value = run(payload['request'], project, output)
            result = {'status': 'completed', **value}
        except Exception as exc:
            result = failure_result(exc)
    (output / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
