import os
from pathlib import Path
import subprocess

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from integrations.moneyprinterturbo.catalog import catalog
from web_api.footage_api import create_footage_router
from web_api.footage_pipeline import candidate_matches_query, FootageRequest, project_context, save_footage_draft, write_json
from web_api.mpt_extensions import ExtensionRequest, ExtensionJobs, artifact_evidence, preflight


@pytest.fixture
def project(tmp_path, monkeypatch):
    for key in list(os.environ):
        if key.startswith('MPT_'):
            monkeypatch.delenv(key)
    p = tmp_path / 'demo'
    write_json(p / 'artifacts/workflow_state.json', {'prompt': '三清山', 'storyboard': {'shots': [{'id': 's1', 'title': '山色'}]}})
    write_json(p / 'artifacts/script.json', {'sections': [{'text': '原有脚本。'}]})
    return p


def test_preflight_never_calls_network_and_never_reveals_secrets(project, monkeypatch):
    monkeypatch.setenv('MPT_OPENAI_API_KEY', 'unit-test-secret')
    monkeypatch.setattr(subprocess, 'Popen', lambda *a, **kw: pytest.fail('preflight must not launch a provider'))
    result = preflight(project.parent, ExtensionRequest(project_id='demo', operation='script', provider='openai', text='山水'))
    assert not result['ready'] and result['approvals'] and result['network_used'] is False
    assert 'unit-test-secret' not in str(catalog())
    assert len(catalog()['operations'][0]['providers']) == 27


def test_remote_execution_needs_scoped_authorization(project, monkeypatch):
    monkeypatch.setenv('MPT_OPENAI_API_KEY', 'test-not-a-real-key')
    jobs = ExtensionJobs(project.parent)
    with pytest.raises(ValueError, match='确认'):
        jobs.submit(ExtensionRequest(project_id='demo', operation='script', provider='openai', text='三清山'))
    assert not list(project.glob('artifacts/footage_jobs/mpt-*'))


def test_connection_catalog_and_preflight_do_not_make_provider_requests(project, monkeypatch):
    monkeypatch.setenv('MPT_OPENAI_API_KEY', 'contract-placeholder')
    monkeypatch.setattr(subprocess, 'Popen', lambda *a, **kw: pytest.fail('preflight must not test a connection'))
    rows = next(op['providers'] for op in catalog()['operations'] if op['id'] == 'connection')
    assert len(rows) == 27 and all(row['supports_model'] for row in rows)
    checked = preflight(project.parent, ExtensionRequest(project_id='demo', operation='connection', provider='openai', model='chosen-model'))
    assert checked['network_used'] is False and checked['network'] and checked['paid']
    assert not checked['errors'] and checked['approvals']


@pytest.mark.parametrize('url,local', [('http://127.0.0.1:11434/v1', True),
                                    ('http://localhost:11434/v1', True), ('http://[::1]:11434/v1', True),
                                    ('https://model.example.org/v1', False),
                                    ('http://127.0.0.1.example.org/v1', False),
                                    ('http://user:pass@127.0.0.1:11434/v1', False)])
def test_local_model_endpoints_do_not_require_cloud_budget_but_remote_endpoints_do(project, monkeypatch, url, local):
    monkeypatch.setenv('MPT_LOCAL_LLM_ENABLED', '1')
    monkeypatch.setenv('MPT_OLLAMA_BASE_URL', url)
    checked = preflight(project.parent, ExtensionRequest(project_id='demo', operation='connection', provider='ollama', model='local-model'))
    assert checked['network'] is not local and checked['paid'] is not local
    assert checked['ready'] is local
    assert url not in str(catalog())


@pytest.mark.parametrize('provider,port', [('chatterbox', 4123), ('kokoro', 8880)])
def test_local_tts_services_need_no_cloud_budget(project, monkeypatch, provider, port):
    from integrations.moneyprinterturbo.catalog import PROVIDERS
    monkeypatch.setenv(f'MPT_{provider.upper()}__BASE_URL', f'http://127.0.0.1:{port}/v1')
    checked = preflight(project.parent, ExtensionRequest(project_id='demo', operation='tts', provider=provider,
                                                        text='本机声音。', voice=PROVIDERS['tts'][provider][2]))
    assert checked['ready'] and not checked['network'] and not checked['paid'] and not checked['upload']


def test_extensions_share_origin_and_secret_validation(project):
    app = FastAPI();app.include_router(create_footage_router(project.parent));client = TestClient(app)
    payload = {'project_id':'demo', 'operation':'script','provider':'openai','text':'山水'}
    assert client.post('/model-api/footage/extensions/preflight', json=payload, headers={'Origin':'https://attacker.invalid'}).status_code == 403
    assert client.post('/model-api/footage/extensions/preflight', json=dict(payload, api_key='forbidden')).status_code == 422
    payload.update(operation='edit',provider='moviepy',video_path='../outside.mp4')
    assert client.post('/model-api/footage/extensions/preflight', json=payload).status_code == 422


def test_existing_draft_is_separate_and_invalidates_when_main_proposal_changes(project):
    original = (project / 'artifacts/script.json').read_bytes()
    req = FootageRequest(project_id='demo', script='新配音第一句。\n新配音第二句。')
    save_footage_draft(project.parent, req)
    assert len(project_context(project.parent,'demo')['shots']) == 2
    assert (project / 'artifacts/script.json').read_bytes() == original
    write_json(project / 'artifacts/script.json', {'sections':[{'text':'主工作台新方案。'}]})
    assert project_context(project.parent,'demo')['script'] == '主工作台新方案。'


def test_search_query_is_not_evidence_of_location():
    wrong = {'query':'Mount Sanqing','source_url':'https://archive.org/details/mountingxfsfilesystemsusingthemountcommand','source_tags':'mount Linux filesystems'}
    assert not candidate_matches_query(wrong,'Mount Sanqing')
    assert candidate_matches_query({'source_url':'https://commons.wikimedia.org/wiki/File:Sanqing_Shan_2013.ogv'},'三清山')
    assert not candidate_matches_query({'source_tags':'Dal Lake Srinagar'},'三清山')


def test_audio_import_has_explicit_role_not_every_audio_is_random_music(project):
    p = project/'assets/footage/imports/a.wav';p.parent.mkdir(parents=True);p.write_bytes(b'dummy')
    write_json(p.with_suffix('.json'), {'role':'voice','label':'旁白'})
    assert not project_context(project.parent,'demo')['assets'][0]['is_music']
    write_json(p.with_suffix('.json'), {'role':'music','label':'配乐'})
    assert project_context(project.parent,'demo')['assets'][0]['is_music']


def test_private_url_and_mismatched_service_blocked(project):
    with pytest.raises(ValueError):
        preflight(project.parent, ExtensionRequest(project_id='demo',operation='music',provider='moviepy'))
    check=preflight(project.parent,ExtensionRequest(project_id='demo',operation='analyze',provider='twelvelabs',public_video_url='https://127.0.0.1/private.mp4'))
    assert any('HTTPS' in e for e in check['errors'])


def test_narration_and_extension_music_are_reusable_but_distinct(project):
    narration=project/'artifacts/footage_jobs/footage-example/narration.wav'
    narration.parent.mkdir(parents=True);narration.write_bytes(b'voice')
    music=project/'assets/footage/mpt-example/music.mp3'
    music.parent.mkdir(parents=True);music.write_bytes(b'music')
    write_json(music.parent/'verified-result.json',{'operation':'music','files':['assets/footage/mpt-example/music.mp3']})
    assets={a['label']:a for a in project_context(project.parent,'demo')['assets']}
    assert not assets['narration.wav']['is_music']
    assert assets['music.mp3']['is_music']


def test_cancel_queued_job_never_starts_worker_or_loses_prior_assets(project, monkeypatch):
    import web_api.mpt_extensions as module
    jobs=ExtensionJobs(project.parent)
    pending=[]
    monkeypatch.setattr(jobs.pool,'submit',lambda fn,*args:pending.append((fn,args)))
    audio=project/'narration.wav';audio.write_bytes(b'untouched input')
    job=jobs.submit(ExtensionRequest(project_id='demo',operation='transcribe',provider='whisper',audio_path='narration.wav',request_id='cancel-test'))
    assert jobs.cancel('demo',job['job_id'])['status']=='cancelled'
    monkeypatch.setattr(module.subprocess,'Popen',lambda *a,**k:pytest.fail('cancelled queued job must never run'))
    pending[0][0](*pending[0][1])
    assert jobs.get('demo',job['job_id'])['status']=='cancelled'
    assert audio.read_bytes()==b'untouched input'


def test_image_preflight_requires_a_real_model_or_request_override(project, monkeypatch):
    monkeypatch.setenv('MPT_OPENAI_IMAGE_API_KEYS', 'contract-placeholder')
    monkeypatch.setenv('MPT_OPENAI_IMAGE_BASE_URL', 'https://example.org/v1')
    args = dict(project_id='demo',operation='image',provider='openai_image',text='山水',
                confirm_network=True,confirm_paid=True,budget=1,billing_limit_configured=True)
    missing = preflight(project.parent,ExtensionRequest(**args))
    assert any('MPT_OPENAI_IMAGE_MODEL' in error for error in missing['errors'])
    assert preflight(project.parent,ExtensionRequest(**args,model='selected-image-model'))['ready']


def test_request_model_satisfies_llm_model_requirement(project, monkeypatch):
    monkeypatch.setenv('MPT_ONEAPI_API_KEY', 'contract-placeholder')
    monkeypatch.setenv('MPT_ONEAPI_BASE_URL', 'https://example.org/v1')
    check=preflight(project.parent,ExtensionRequest(project_id='demo',operation='script',provider='oneapi',
        topic='山水',model='selected-model',confirm_network=True,confirm_paid=True,budget=1,billing_limit_configured=True))
    assert check['ready']


@pytest.mark.parametrize('privacy',['private','unlisted'])
@pytest.mark.parametrize('platform',['tiktok','instagram','facebook'])
def test_nonpublic_publishing_is_rejected_for_unsupported_platforms(project, privacy, platform):
    video=project/'clip.mp4';video.write_bytes(b'contract fixture')
    check=preflight(project.parent,ExtensionRequest(project_id='demo',operation='publish',provider='upload_post',
        video_path='clip.mp4',text='山水',privacy=privacy,platforms=['youtube',platform]))
    assert any('仅支持 YouTube' in error for error in check['errors'])


def test_semantic_reranking_requires_subject_and_nonempty_terms(project):
    check=preflight(project.parent,ExtensionRequest(project_id='demo',operation='rerank',provider='twelvelabs',text='山水\n森林'))
    assert any('视频主题' in error for error in check['errors'])
    blank=preflight(project.parent,ExtensionRequest(project_id='demo',operation='rerank',provider='twelvelabs',topic='山水',text='山水\n \n'))
    assert any('非空关键词' in error for error in blank['errors'])


def test_tts_catalog_matches_upstream_defaults_and_required_models(project, monkeypatch):
    operations={row['id']:row for row in catalog()['operations']}
    tts={row['id']:row for row in operations['tts']['providers']}
    assert tts['mimo']['default']=='mimo:mimo_default'
    monkeypatch.setenv('MPT_VOXCPM__API_KEY','contract-placeholder')
    check=preflight(project.parent,ExtensionRequest(project_id='demo',operation='tts',provider='voxcpm',text='山水',voice='voxcpm:default'))
    assert any('MPT_VOXCPM__MODEL_ID' in error for error in check['errors'])
    music={row['id']:row for row in operations['music']['providers']}
    assert music['elevenlabs']['required_env']==['MPT_ELEVENLABS__API_KEY']


def test_inapplicable_model_and_unpaired_reference_text_are_rejected(project):
    check=preflight(project.parent,ExtensionRequest(project_id='demo',operation='video',provider='metaso_minimax',text='山水',model='other-model'))
    assert any('不接受模型 ID' in error for error in check['errors'])
    check=preflight(project.parent,ExtensionRequest(project_id='demo',operation='tts',provider='voxcpm',text='山水',voice='voxcpm:default',reference_text='参考音频文字'))
    assert any('同时选择' in error for error in check['errors'])


def test_subtitle_style_fields_are_typed_and_font_stays_in_system_directory():
    req=ExtensionRequest(project_id='demo',operation='edit',provider='moviepy',font_name='PingFang.ttc',
        stroke_color='#123456',stroke_width=2,rounded_subtitle_background=False,subtitle_position='custom',custom_position=55,voice_volume=.8)
    assert req.model_dump()['stroke_width']==2 and req.custom_position==55
    with pytest.raises(ValueError):
        ExtensionRequest(project_id='demo',operation='edit',provider='moviepy',font_name='../font.ttf')


def test_image_result_is_decoded_and_cannot_be_a_renamed_error_body(project):
    from PIL import Image
    image=project/'image.png';Image.new('RGB',(32,24),'white').save(image)
    evidence=artifact_evidence(project,'image.png','image')
    assert evidence['image']=={'width':32,'height':24,'format':'PNG'}
    invalid=project/'invalid.png';invalid.write_bytes(b'provider error page')
    with pytest.raises(Exception):artifact_evidence(project,'invalid.png','image')


def test_media_results_need_the_expected_audio_or_video_stream(project, monkeypatch):
    import web_api.mpt_extensions as module
    (project/'video.mp4').write_bytes(b'contract fixture')
    (project/'voice.mp3').write_bytes(b'contract fixture')
    monkeypatch.setattr(module,'probe',lambda p:{'duration':1,'has_audio':True,'has_video':False})
    with pytest.raises(ValueError,match='视频'):artifact_evidence(project,'video.mp4','video')
    monkeypatch.setattr(module,'probe',lambda p:{'duration':1,'has_audio':False,'has_video':True})
    with pytest.raises(ValueError,match='音频'):artifact_evidence(project,'voice.mp3','tts')


def test_voice_presets_are_local_data_and_exclude_implicit_account_requests(project, monkeypatch):
    import sys
    import requests
    monkeypatch.setattr(requests.sessions.Session,'request',lambda *a,**k:pytest.fail('catalog must not query voice services'))
    before='app.services.voice' in sys.modules
    operations={row['id']:row for row in catalog()['operations']}
    tts={row['id']:row for row in operations['tts']['providers']}
    assert ('app.services.voice' in sys.modules)==before
    assert len(tts['gemini']['voices'])==30 and len(tts['mimo']['voices'])==9
    assert len(tts['siliconflow']['voices'])==8
    assert all(not voice['id'].endswith('-V2-Female') for voice in tts['edge']['voices'])
    assert tts['elevenlabs']['voices']==[]
    assert any(voice['id']=='mimo:mimo_default-Female' for voice in tts['mimo']['voices'])
    assert operations['image']['providers'][0]['required_env'][0]=='MPT_OPENAI_IMAGE_API_KEYS'


@pytest.mark.parametrize('provider',['gemini','mimo','elevenlabs','voxcpm'])
def test_ignored_speech_rate_is_rejected_instead_of_claiming_success(project,provider):
    check=preflight(project.parent,ExtensionRequest(project_id='demo',operation='tts',provider=provider,
        text='山水',voice=f'{provider}:default',voice_rate=1.2))
    assert any('不支持语速调整' in error for error in check['errors'])


def test_music_preflight_measures_selected_video_and_checks_real_service_limit(project,monkeypatch):
    import web_api.mpt_extensions as module
    (project/'clip.mp4').write_bytes(b'contract fixture')
    monkeypatch.setattr(module,'probe',lambda p:{'duration':501,'has_video':True})
    monkeypatch.setenv('MPT_SONILO_API_KEY','contract-placeholder')
    monkeypatch.setenv('MPT_ELEVENLABS__API_KEY','contract-placeholder')
    args=dict(project_id='demo',operation='music',video_path='clip.mp4',duration=5,
        confirm_network=True,confirm_paid=True,budget=1,billing_limit_configured=True,confirm_upload=True)
    sonilo=preflight(project.parent,ExtensionRequest(**args,provider='sonilo'))
    assert sonilo['source_duration']==501 and any('360 秒' in error for error in sonilo['errors'])
    assert preflight(project.parent,ExtensionRequest(**args,provider='elevenlabs'))['ready']
