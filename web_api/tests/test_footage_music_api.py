"""Same-origin music preflight and submission guards, entirely local."""
from pathlib import Path
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from web_api.footage_api import create_footage_router
from web_api.footage_pipeline import write_json

class LocalJobs:
    def __init__(self,root): self.root=root; self.requests=[]
    def submit(self,request):
        self.requests.append(request)
        return {'project_id':request.project_id,'job_id':'fixture-job','status':'queued'}

@pytest.fixture
def setup(tmp_path):
    project=tmp_path/'isolated'
    write_json(project/'project.json',{'title':'isolated music fixture'})
    jobs=LocalJobs(tmp_path)
    app=FastAPI(); app.include_router(create_footage_router(tmp_path,jobs=jobs))
    return TestClient(app),jobs,project

def payload(**changes):
    return {'project_id':'isolated','action':'render','material_mode':'local','shots':[{'id':'one','text':'清晨的湖水','duration_seconds':6}],
            'options':{'narration':'none','bgm_mode':'elevenlabs','bgm_prompt':'安静的器乐，给旁白留出空间','bgm_model_id':'music_v2_5'},**changes}

def test_missing_key_preflight_is_read_only_and_does_not_submit(setup,monkeypatch):
    client,jobs,project=setup
    monkeypatch.delenv('ELEVENLABS_API_KEY',raising=False)
    monkeypatch.setattr('tools.audio.music_gen.MusicGen.execute',lambda *a:pytest.fail('preview must not execute'))
    before={p.relative_to(project).as_posix():p.read_bytes() for p in project.rglob('*') if p.is_file()}
    response=client.post('/model-api/footage/music/preflight',json=payload(stop_at='video'))
    assert response.status_code==200 and not response.json()['ready']
    assert 'ELEVENLABS_API_KEY' in ' '.join(response.json()['errors'])
    assert response.json()['model_id']=='music_v2_5' and response.json()['prompt_preview'].startswith('安静的器乐')
    submitted=client.post('/model-api/footage/jobs',json=payload())
    assert submitted.status_code==422 and not jobs.requests
    assert before=={p.relative_to(project).as_posix():p.read_bytes() for p in project.rglob('*') if p.is_file()}

@pytest.mark.parametrize('action,stage',[('collect','video'),('create','materials'),('render','audio'),('render','script'),('render','subtitle')])
def test_provider_unavailable_never_blocks_free_or_intermediate_paths(setup,monkeypatch,action,stage):
    client,jobs,_=setup
    monkeypatch.setattr('web_api.footage_api.preflight_footage_music',lambda *a,**k:pytest.fail('free path must not check provider'))
    response=client.post('/model-api/footage/jobs',json=payload(action=action,stop_at=stage))
    assert response.status_code==202 and len(jobs.requests)==1
    assert jobs.requests[0].options.bgm_confirm_paid is False

def test_payment_approvals_must_be_checked_before_submit(setup,monkeypatch):
    client,jobs,_=setup
    monkeypatch.setenv('ELEVENLABS_API_KEY','local-fake-only')
    raw=payload()
    assert client.post('/model-api/footage/jobs',json=raw).status_code==422
    assert not jobs.requests
    raw['options'].update(bgm_confirm_paid=True,bgm_confirm_text=True,bgm_billing_limit_configured=True,bgm_budget_usd=.1)
    assert client.post('/model-api/footage/jobs',json=raw).status_code==202
    assert jobs.requests[0].options.bgm_confirm_paid is True
    assert jobs.requests[0].options.bgm_model_id=='music_v2_5'
    assert not any('confirm' in k or 'budget' in k or 'billing' in k for k in jobs.requests[0].options.model_dump())

@pytest.mark.parametrize('endpoint',['/batches/preflight','/batches'])
def test_batch_cannot_expand_single_music_authorization_even_with_default_stage(setup,endpoint):
    client,jobs,project=setup
    raw=payload(); raw.pop('stop_at',None)
    raw['options'].update(bgm_confirm_paid=True,bgm_confirm_text=True,bgm_billing_limit_configured=True,bgm_budget_usd=100)
    response=client.post('/model-api/footage'+endpoint,json={'requests':[raw,raw],'confirm':True})
    assert response.status_code==422 and '逐个任务' in response.json()['detail']
    assert not jobs.requests and not (project/'artifacts/footage_batches').exists()

def test_music_text_and_fee_preview_reject_cross_origin(setup):
    client,jobs,_=setup
    response=client.post('/model-api/footage/music/preflight',json=payload(),headers={'Origin':'https://foreign.example'})
    assert response.status_code==403 and not jobs.requests

def test_saving_options_never_persists_one_request_approval(setup):
    client,_,project=setup
    raw=payload()['options']
    raw.update(bgm_confirm_paid=True,bgm_confirm_text=True,bgm_billing_limit_configured=True,bgm_budget_usd=10)
    response=client.post('/model-api/footage/settings/isolated',json=raw)
    assert response.status_code==200
    saved=(project/'artifacts/footage_settings.json').read_text()
    assert 'bgm_confirm' not in saved and 'bgm_budget' not in saved and 'bgm_billing' not in saved
