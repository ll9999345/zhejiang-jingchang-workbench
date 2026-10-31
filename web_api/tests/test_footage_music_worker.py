"""The actual footage worker associates one music result before variant rendering."""
import pytest
from web_api.footage_pipeline import FootageJobs, FootageRequest, write_json

class Deferred:
    def __init__(self): self.calls=[]
    def submit(self,fn,*args): self.calls.append((fn,args))
    def run(self):
        fn,args=self.calls.pop(0); fn(*args)

@pytest.fixture
def setup(tmp_path,monkeypatch):
    project=tmp_path/'isolated'
    source=project/'assets/source.mp4'; source.parent.mkdir(parents=True);source.write_bytes(b'local-source')
    write_json(project/'project.json',{'title':'Music worker fixture'})
    monkeypatch.setattr('web_api.footage_pipeline.probe',lambda _: {'has_video':True,'has_audio':True,'duration':20})
    executor=Deferred(); rendered=[]
    def renderer(project_dir,job_dir,shots,options,**kwargs):
        job_dir.mkdir(parents=True); output=job_dir/'film.mp4';output.write_bytes(b'local-render-fixture')
        rendered.append({'options':dict(options),'duration':sum(s['duration_seconds'] for s in shots)})
        return {'status':'completed','output_path':output.relative_to(project_dir).as_posix()}
    jobs=FootageJobs(tmp_path,executor=executor,renderer=renderer)
    def narrate(project_dir,directory,shots,request,event):
        shots[0]['duration_seconds']=12
        audio=directory/'narration.wav'; audio.write_bytes(b'keep-this-narration');return audio
    monkeypatch.setattr(jobs,'_narrate',narrate)
    request=FootageRequest(project_id='isolated',action='render',material_mode='local',
        shots=[{'id':'one','source_path':'assets/source.mp4','text':'湖面晨光','duration_seconds':5}],
        options={'bgm_mode':'elevenlabs','bgm_prompt':'温暖的江南器乐','bgm_model_id':'music_v2_5','variants':3,
            'bgm_confirm_paid':True,'bgm_confirm_text':True,'bgm_billing_limit_configured':True,'bgm_budget_usd':1})
    return project,jobs,executor,rendered,request

def test_measured_narration_calls_music_once_and_associates_all_variants(setup,monkeypatch):
    project,jobs,executor,rendered,request=setup; music_calls=[]
    def music(root,body,duration,output_name,tool=None):
        music_calls.append((body.options.bgm_model_id,duration,output_name))
        target=project/'assets/music'/output_name;target.parent.mkdir(parents=True);target.write_bytes(b'local-music-fixture')
        return {'status':'completed','provider':{'provider':'elevenlabs','model':body.options.bgm_model_id},'music':{'path':target.relative_to(project).as_posix()}}
    monkeypatch.setattr('web_api.footage_music.render_footage_music',music)
    queued=jobs.submit(request); executor.run(); result=jobs.get('isolated',queued['job_id'])
    assert result['status']=='completed' and len(result['outputs'])==3
    assert len(music_calls)==1 and music_calls[0][:2]==('music_v2_5',12)
    assert music_calls[0][2]==f"footage-{queued['job_id']}-bgm.mp3"
    assert all(row['options']['bgm_path']==result['music']['music']['path'] for row in rendered)
    assert all(row['duration']==12 for row in rendered)
    persisted=(jobs.directory('isolated',queued['job_id'])/'job.json').read_text()
    assert 'bgm_confirm_paid' not in persisted and 'bgm_budget_usd' not in persisted

def test_music_failure_keeps_existing_narration_and_materials(setup,monkeypatch):
    project,jobs,executor,rendered,request=setup; original=(project/'assets/source.mp4').read_bytes()
    def fail(*a,**k): raise ValueError('本地模拟配乐失败；不会自动重试')
    monkeypatch.setattr('web_api.footage_music.render_footage_music',fail)
    queued=jobs.submit(request);executor.run();result=jobs.get('isolated',queued['job_id'])
    assert result['status']=='failed' and not rendered and not result['outputs']
    assert (jobs.directory('isolated',queued['job_id'])/'narration.wav').read_bytes()==b'keep-this-narration'
    assert (project/'assets/source.mp4').read_bytes()==original
