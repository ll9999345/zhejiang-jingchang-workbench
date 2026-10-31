import copy
import hashlib
import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from tools.analysis.hypit_speech_service import IDENTITY
from web_api.hypit_runtime import HypitRuntimeError
from web_api.hypit_speech import SpeechServiceController, CAPABILITY, ENDPOINT
from web_api.hypit_workbench import create_hypit_workbench_router
from web_api.tests.test_hypit_workbench import manager


class Process:
    returncode = None
    def poll(self):return self.returncode
    def wait(self,timeout):assert self.returncode==0;return self.returncode


@pytest.fixture
def owned(tmp_path,monkeypatch):
    service,project=manager(tmp_path,'0.3.1')
    # Minimal known local Profile; preserve its dataRoot and endpoint verbatim.
    profile=project/'hypit.runtime.json'
    profile.write_text(json.dumps({'format':'hypit.runtime-local@1','dataRoot':'.hypit/original-data',
        'endpoints':{'media.local':{'use':'@hypit/media-local','config':{}}},'bindings':{}}))
    calls=[]
    def popen(command,**options):
        calls.append((command,options));return Process()
    control=SpeechServiceController(service,popen=popen)
    monkeypatch.setattr(control,'_port_used',lambda:False)
    monkeypatch.setattr(control,'_health',lambda:({**IDENTITY,'instanceId':control.instance,'busy':False,'stopping':False}
                         if control.process and control.process.poll() is None else None))
    def shutdown(path,body=None):
        assert path=='/shutdown' and body=={'instance_id':control.instance}
        control.process.returncode=0
        return {'stopping':True}
    monkeypatch.setattr(control,'_http',shutdown)
    try:yield control,service,project,profile,calls
    finally:service.close()


def test_explicit_enable_preserves_original_and_every_other_setting(owned,monkeypatch):
    control,_,project,profile,calls=owned;original=profile.read_bytes();value=json.loads(original)
    state=control.status(project.name)
    assert state['state']=='stopped' and not state['configured'] and state['can_start']
    monkeypatch.setenv('TEST_API_KEY','not-a-real-secret')
    started=control.start(project.name,fingerprint=state['profile_sha256'],configure=True)
    updated=json.loads(profile.read_bytes());assert updated['dataRoot']==value['dataRoot']
    assert updated['endpoints']['media.local']==value['endpoints']['media.local']
    assert updated['bindings'][CAPABILITY]==ENDPOINT
    assert updated['endpoints'][ENDPOINT]==control._endpoint()
    backups=list((project/'artifacts/hypit_speech').glob('configuration-*/original.runtime.json'))
    assert len(backups)==1 and backups[0].read_bytes()==original
    receipt=json.loads(backups[0].with_name('receipt.json').read_text())
    assert receipt['before_sha256']==hashlib.sha256(original).hexdigest()
    assert receipt['after_sha256']==hashlib.sha256(profile.read_bytes()).hexdigest()
    assert started['state']=='running' and started['can_stop']
    assert len(calls)==1 and calls[0][0][:3]==[str(control.python),'-m','tools.analysis.hypit_speech_service']
    assert '--input-root' in calls[0][0] and str(project) in calls[0][0]
    assert 'TEST_API_KEY' not in calls[0][1]['env']
    control.start(project.name,fingerprint=state['profile_sha256'],configure=True)
    assert len(calls)==1
    stopped=control.stop(project.name)
    assert stopped['state']=='stopped' and stopped['configured'] and not stopped['can_stop']
    assert len(list((project/'artifacts/hypit_speech').glob('configuration-*')))==1


@pytest.mark.parametrize('configure,stale',[(False,False),(True,True)])
def test_missing_explicit_selection_or_stale_fingerprint_never_changes_project(owned,configure,stale):
    control,_,project,profile,calls=owned;original=profile.read_bytes();state=control.status(project.name)
    with pytest.raises(HypitRuntimeError):control.start(project.name,fingerprint='0'*64 if stale else state['profile_sha256'],configure=configure)
    assert profile.read_bytes()==original and calls==[] and not (project/'artifacts/hypit_speech').exists()


@pytest.mark.parametrize('bad',['credentials','command','collision','remote'])
def test_unknown_or_private_profile_is_not_copied_or_executed(owned,bad):
    control,_,project,profile,calls=owned;value=json.loads(profile.read_text())
    if bad=='credentials':value['credentials']={'private':{'api_key':'not-a-real-secret'}}
    if bad=='command':value['endpoints']['speech']={'use':'@hypit/provider-whisperx-local','config':{'serviceCommand':['untrusted']}}
    if bad=='collision':value['endpoints'][ENDPOINT]={'use':'@hypit/media-local','config':{}}
    if bad=='remote':value['endpoints']['remote']={'use':'@hypit/provider-hypihub','config':{}}
    profile.write_text(json.dumps(value));original=profile.read_bytes();state=control.status(project.name)
    assert not state['can_start'] and 'not-a-real-secret' not in json.dumps(state)
    with pytest.raises(HypitRuntimeError):control.start(project.name,fingerprint=state['profile_sha256'],configure=True)
    assert calls==[] and profile.read_bytes()==original and not (project/'artifacts/hypit_speech').exists()


def test_unowned_service_is_observed_but_never_adopted_or_stopped(owned,monkeypatch):
    control,_,project,profile,calls=owned;before=profile.read_bytes()
    monkeypatch.setattr(control,'_health',lambda:{**IDENTITY,'instanceId':'external','busy':False})
    state=control.status(project.name);assert state['state']=='unmanaged' and not state['can_stop'] and not state['can_start']
    with pytest.raises(HypitRuntimeError):control.stop(project.name)
    with pytest.raises(HypitRuntimeError):control.start(project.name,fingerprint=state['profile_sha256'],configure=True)
    assert calls==[] and profile.read_bytes()==before


def test_busy_inference_and_active_jobs_refuse_stop_without_killing(owned,monkeypatch):
    control,service,project,profile,calls=owned;state=control.status(project.name)
    control.start(project.name,fingerprint=state['profile_sha256'],configure=True)
    monkeypatch.setattr(control,'_health',lambda:{**IDENTITY,'instanceId':control.instance,'busy':True,'stopping':False})
    assert not control.status(project.name)['can_stop']
    with pytest.raises(HypitRuntimeError):control.stop(project.name)
    assert control.process.poll() is None
    monkeypatch.setattr(control,'_health',lambda:{**IDENTITY,'instanceId':control.instance,'busy':False,'stopping':False})
    monkeypatch.setattr(service,'list',lambda project:[{'status':'running'}])
    with pytest.raises(HypitRuntimeError,match='任务执行中'):control.stop(project.name)
    assert control.process.poll() is None


def test_active_job_refuses_configuration_change(owned,monkeypatch):
    control,service,project,profile,calls=owned;before=profile.read_bytes();state=control.status(project.name)
    monkeypatch.setattr(service,'list',lambda project:[{'status':'queued'}])
    with pytest.raises(HypitRuntimeError,match='任务执行中'):control.start(project.name,fingerprint=state['profile_sha256'],configure=True)
    assert profile.read_bytes()==before and not calls


def test_project_boundary_and_other_project_cannot_stop_owned_process(owned):
    control,service,project,_,_=owned
    with pytest.raises(HypitRuntimeError):control.status('../outside')
    state=control.status(project.name);control.start(project.name,fingerprint=state['profile_sha256'],configure=True)
    other=project.with_name('second');other.mkdir();(other/'hypit.runtime.json').write_text(json.dumps({'format':'hypit.runtime-local@1','endpoints':{'media':{'use':'@hypit/media-local'}}}))
    assert control.status('second')['state']=='other_project'
    with pytest.raises(HypitRuntimeError):control.stop('second')
    assert control.process.poll() is None


def test_same_origin_http_and_no_command_or_model_injection(owned):
    control,service,project,profile,calls=owned
    app=FastAPI();app.include_router(create_hypit_workbench_router(project.parent,services={'0.3.1':service},speech_controller=control))
    prefix='/model-api/hypit-v031/speech'
    with TestClient(app) as client:
        state=client.get(prefix+'/status',params={'project_id':project.name}).json()
        body={'project_id':project.name,'configure':True,'profile_sha256':state['profile_sha256']}
        assert client.post(prefix+'/start',json=body,headers={'Origin':'https://outside.invalid'}).status_code==403
        assert client.post(prefix+'/start',json={**body,'command':'untrusted'}).status_code==422
        assert client.post(prefix+'/start',json=body).json()['state']=='running'
        assert client.post(prefix+'/stop',json={'project_id':project.name}).json()['state']=='stopped'
        assert len(calls)==1
