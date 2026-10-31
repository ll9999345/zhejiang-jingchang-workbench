import json
from pathlib import Path
import time

import pytest
from PIL import Image

import web_api.montage_director as module
from web_api.montage_director import DirectorRequest, MontageDirector, connection, preflight_director, transport_messages
from web_api.montage_jobs import MontageJobs, new_run
from lib.pipeline_loader import load_pipeline_readonly


@pytest.fixture
def director(tmp_path):
    project = tmp_path / 'demo'; project.mkdir()
    jobs = MontageJobs(tmp_path)
    service = MontageDirector(tmp_path,jobs)
    yield service,project
    service.shutdown();jobs.shutdown()


def request(**kwargs):
    return DirectorRequest(project_id='demo',pipeline='documentary-montage',brief='做一条真实素材纪录片',provider='ollama',model='test',**kwargs)


def test_missing_model_check_skips_expensive_optional_dependency_probes(director, monkeypatch):
    service, project = director
    monkeypatch.setattr(module, 'connection', lambda _: {'ready': True, 'local': True})
    def forbidden_catalog():
        raise AssertionError('a missing model must not trigger every optional tool probe')
    monkeypatch.setattr(module, 'tool_catalog', forbidden_catalog)
    req = DirectorRequest(project_id='demo', pipeline='documentary-montage',
                          brief='先检查当前配置', provider='ollama', model='')
    before = list(project.rglob('*'))
    result = preflight_director(req, project.parent)
    assert result['status'] == 'needs_setup'
    assert not result['can_execute'] and not result['tool_dependencies_checked']
    assert any('模型名' in message for message in result['requirements'])
    assert list(project.rglob('*')) == before


def test_configuration_never_returns_credentials_and_invalid_url_safe(monkeypatch):
    monkeypatch.setenv('OPENMONTAGE_DIRECTOR_API_KEY','test-private-credential')
    assert 'test-private-credential' not in json.dumps(module.director_capabilities())
    monkeypatch.setenv('OPENMONTAGE_DIRECTOR_BASE_URL','https:///missing-host')
    assert connection('custom')['ready'] is False
    monkeypatch.setenv('OPENMONTAGE_DIRECTOR_BASE_URL','http://external.invalid/v1')
    assert connection('custom')['ready'] is False
    assert connection('ollama')['base'] == 'http://127.0.0.1:11434/v1'


def test_missing_local_server_cannot_start_fake_production(director,monkeypatch):
    service,project = director
    def fail(*args,**kwargs): raise RuntimeError('offline')
    monkeypatch.setattr(module.httpx.Client,'get',fail)
    result=preflight_director(request(),project.parent)
    assert not result['can_execute']
    assert service.start(request(confirm=True))['status']=='needs_setup'
    assert not (project/'analysis').exists()


def test_loop_is_agent_driven_with_durable_blocker_not_template_fallback(director,monkeypatch):
    service,project = director
    monkeypatch.setattr(module,'preflight_director',lambda *args: {'can_execute':True,'status':'ready'})
    responses=iter([json.dumps({'action':'write','arguments':{'path':'notes.txt','content':'真实制作计划'}}),
                    json.dumps({'action':'blocked','arguments':{'message':'需要选择旁白声音'}})])
    calls=[]
    def model(req,messages,system,**kwargs):
        calls.append(system)
        return next(responses),{'input':10,'output':10}
    monkeypatch.setattr(module,'request_model',model)
    row=service.start(request(confirm=True))
    end=time.monotonic()+5
    while row['status'] in module.ACTIVE and time.monotonic()<end:
        time.sleep(.03);row=service.state('demo',row['session_id'])
    assert row['status']=='blocked',row
    assert '原版管线' in calls[0] and 'documentary-montage' in calls[0]
    run=project/'analysis/montage/director'/row['session_id']
    assert (run/'workspace/notes.txt').read_text()=='真实制作计划'
    assert 'messages' not in row and 'request' not in row


def test_image_upload_waits_for_exact_action_approval_and_uses_actual_pixels(director,monkeypatch):
    service,project=director
    Image.new('RGB',(20,10),'red').save(project/'frame.jpg')
    monkeypatch.setattr(module,'connection',lambda _: {'ready':True,'local':False})
    run_id,run=new_run(project,'director');(run/'workspace').mkdir()
    row={'session_id':run_id,'status':'running','seen_guidance':[]}
    action={'action':'inspect_images','arguments':{'paths':['frame.jpg'],'question':'核对主体'}}
    assert service._act(request(),project,run,row,load_pipeline_readonly('documentary-montage'),action) is None
    assert row['status']=='waiting_approval'
    assert row['pending']['action']==action and len(row['pending']['approval_id'])==32
    result=service._act(request(),project,run,row,load_pipeline_readonly('documentary-montage'),action,approved=True)
    assert result['image_refs']==['frame.jpg']
    messages=[{'role':'user','content':[{'type':'image_reference','path':'frame.jpg'}]}]
    payload=transport_messages(messages,project,'openai')
    assert payload[0]['content'][0]['image_url']['url'].startswith('data:image/jpeg;base64,')
    assert messages[0]['content'][0]['type']=='image_reference'


def test_budget_guard_stops_before_any_model_call(director,monkeypatch):
    service,project=director
    monkeypatch.setattr(module,'preflight_director',lambda *args: {'can_execute':True,'status':'ready'})
    monkeypatch.setattr(module,'connection',lambda _: {'local':False,'ready':True})
    def must_not_call(*a,**kw): raise AssertionError('No billable call allowed')
    monkeypatch.setattr(module,'request_model',must_not_call)
    row=service.start(request(confirm=True,max_cost_usd=.000001,input_price_per_million=1,output_price_per_million=1))
    end=time.monotonic()+5
    while row['status'] in module.ACTIVE and time.monotonic()<end:
        time.sleep(.03);row=service.state('demo',row['session_id'])
    assert row['status']=='budget_exhausted'
    assert row['step_count']==0


def test_fake_artifact_and_missing_movie_cannot_complete(director):
    service,project=director
    session,run=new_run(project,'director');(run/'workspace').mkdir()
    row={'session_id':session,'stage_index':0,'completed_stages':[]}
    manifest=load_pipeline_readonly('documentary-montage')
    with pytest.raises(Exception):
        service._act(request(),project,run,row,manifest,{'action':'artifact','arguments':{'name':'render_report','data':{'outputs':[{'path':'not-real.mp4'}]}}})
    result=service._act(request(),project,run,row,manifest,{'action':'finish'})
    assert '未完成阶段' in result['error']


def test_overwriting_authored_source_retains_previous_version(director):
    service,project=director
    session,run=new_run(project,'director');(run/'workspace').mkdir()
    row={'session_id':session};manifest=load_pipeline_readonly('documentary-montage')
    for text in ['first','second']:
        service._act(request(),project,run,row,manifest,{'action':'write','arguments':{'path':'scene.js','content':text}})
    assert (run/'workspace/scene.js').read_text()=='second'
    assert next((run/'workspace').glob('scene-previous-*.js')).read_text()=='first'


def test_native_review_schema_covers_every_real_pipeline_stage():
    from lib.pipeline_loader import list_pipelines
    from schemas.artifacts import validate_artifact
    for pipeline in list_pipelines():
        if pipeline=='framework-smoke': continue
        for stage in load_pipeline_readonly(pipeline)['stages']:
            validate_artifact('review',{'version':'1.0','stage':stage['name'],'findings':[
                {'id':'follow-up','severity':'investigation','description':'核对地点'},
                {'id':'fix','severity':'critical','description':'修改时长','proposed_fix':'缩至十秒'}]})


def test_stage_approval_exposes_actual_artifacts_and_requires_matching_review(director):
    from schemas.artifacts import load_schema
    service,project=director
    session,run=new_run(project,'director');artifacts=run/'workspace/artifacts';artifacts.mkdir(parents=True)
    # A custom empty-producing stage exercises the gate without a fake brief.
    manifest={'stages':[{'name':'idea','produces':[],'human_approval_default':True}]}
    row={'session_id':session,'stage_index':0,'completed_stages':[]}
    wrong={'action':'complete_stage','arguments':{'review':{'version':'1.0','stage':'script','findings':[]}}}
    assert '不一致' in service._act(request(),project,run,row,manifest,wrong)['error']
    (artifacts/'notes.json').write_text('{}')
    manifest['stages'][0]['produces']=['notes']
    action={'action':'complete_stage','arguments':{'review':{'version':'1.0','stage':'idea','findings':[]}}}
    assert service._act(request(),project,run,row,manifest,action) is None
    assert row['pending']['artifacts'][0]['path'].endswith('/workspace/artifacts/notes.json')
