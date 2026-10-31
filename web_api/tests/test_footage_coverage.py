import hashlib,json,shutil,subprocess,threading
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from web_api.footage_coverage import selected_window_coverage
from web_api.footage_pipeline import FootageJobs
from web_api.footage_api import create_footage_router
from tools.video.stock_sources.base import Candidate


def test_only_complete_probed_windows_count_and_measurement_is_cached():
    calls=[]
    def measure(path):calls.append(path);return {'duration':5,'has_video':True}
    rows=[{'id':'one','source_path':'one.mp4','start_seconds':1,'duration_seconds':3},
          {'id':'two','source_path':'one.mp4','start_seconds':4,'duration_seconds':3},
          {'id':'three','duration_seconds':2}]
    result=selected_window_coverage(rows,measure)
    assert result['required_seconds']==8 and result['covered_seconds']==3
    assert result['missing_shot_ids']==['two','three']
    assert calls==['one.mp4'] and result['quality_review_required'] and not result['location_verified']


def test_source_claims_cannot_override_failed_real_probe():
    shots=[{'id':'one','source_path':'bad.mp4','duration_seconds':4,'selected_source':{'duration':999}}]
    def measure(path):raise ValueError('do not persist private exception body')
    result=selected_window_coverage(shots,measure)
    assert result['covered_seconds']==0 and result['rows'][0]['reason']=='probe_failed'
    assert 'private' not in json.dumps(result)


def test_still_image_hold_is_labeled_and_does_not_become_video_duration():
    result=selected_window_coverage([{'id':'one','source_path':'image.png','duration_seconds':3}],
        lambda p:{'duration':0,'has_video':True,'is_still':True})
    assert result['covered_seconds']==3 and result['rows'][0]['reason']=='probed_still_image_hold'


@pytest.mark.parametrize('value',[float('nan'),float('inf'),-1,True])
def test_invalid_time_never_produces_full_coverage(value):
    result=selected_window_coverage([{'id':'one','source_path':'one.mp4','duration_seconds':value}],lambda p:None)
    assert result['fraction']==0 and result['ready_shots']==0


@pytest.mark.parametrize('shot_duration,expected,covered',[(1.5,'awaiting_review',3),(3,'needs_materials',0)])
def test_actual_parallel_download_api_reports_selected_duration_and_not_declared_duration(tmp_path,monkeypatch,shot_duration,expected,covered):
    import tools.video.stock_sources as registry
    project=tmp_path/'demo';project.mkdir()
    media={}
    for identity,color in [('one','blue'),('two','red')]:
        path=tmp_path/(identity+'.mp4')
        subprocess.run(['ffmpeg','-v','error','-n','-f','lavfi','-i',f'color=c={color}:s=160x90:r=12:d=2',
                        '-c:v','libx264','-pix_fmt','yuv420p',str(path)],check=True,timeout=20)
        media[identity]=path
    before={key:hashlib.sha256(path.read_bytes()).hexdigest() for key,path in media.items()}
    barrier=threading.Barrier(2);calls=[]
    class Source:
        name='wikimedia'
        def is_available(self):return True
        def search(self,query,filters):
            return [Candidate(source=self.name,source_id=key,source_tags=query,kind='video',duration=999,
                    source_url=f'https://example.test/{key}',download_url=f'https://example.test/{key}.mp4') for key in media]
        def download(self,candidate,out):
            calls.append(candidate.source_id)
            barrier.wait(timeout=5)
            shutil.copyfile(media[candidate.source_id],out);return out
    source=Source()
    monkeypatch.setattr(registry,'all_sources',lambda:[source])
    monkeypatch.setattr(registry,'source_catalog',lambda:[{'name':'wikimedia','status':'available'}])
    class Inline:
        def submit(self,fn,*args):fn(*args)
    manager=FootageJobs(tmp_path,executor=Inline())
    app=FastAPI();app.include_router(create_footage_router(tmp_path,jobs=manager))
    with TestClient(app) as client:
        response=client.post('/model-api/footage/jobs',json={'project_id':'demo','topic':'三清山','script':'云雾升起。','action':'collect',
            'sources':['wikimedia'],'confirm_network':True,'options':{'narration':'none','bgm_mode':'none'},
            'shots':[{'id':key,'text':'云雾','query':'Mount Sanqing clouds','duration_seconds':shot_duration,'selection_mode':'auto'} for key in media]})
        assert response.status_code==202,response.text
        state=client.get('/model-api/footage/jobs/'+response.json()['job_id'],params={'project_id':'demo'}).json()
        assert state['status']==expected,state['message']
        result=state['material_coverage']
        assert result['required_seconds']==2*shot_duration and result['covered_seconds']==covered
        assert result['evidence']=='probed_selected_windows' and result['location_verified'] is False
        assert set(calls)=={'one','two'} and len(calls)==2
        assert '片段时长核对' in state['message']
        assert {key:hashlib.sha256(path.read_bytes()).hexdigest() for key,path in media.items()}==before
        manifest=json.loads((manager.directory('demo',state['job_id'])/'stock_manifest.json').read_text())
        assert manifest['material_coverage']==result
        if expected=='awaiting_review':assert len({s['source_path'] for s in state['shots']})==2
        else:assert set(result['missing_shot_ids'])=={'one','two'}
        (tmp_path/'actual-coverage-receipt.json').write_text(json.dumps({'status':'passed','job_status':state['status'],
            'declared_source_duration':999,'decoded_source_durations':[c['duration'] for c in manifest['clips']],
            'material_coverage':result,'actual_parallel_downloads':2,'original_media_unchanged':True,
            'source_responses_simulated':True,'provider_calls':0,'paid_calls':0},ensure_ascii=False,indent=2))
