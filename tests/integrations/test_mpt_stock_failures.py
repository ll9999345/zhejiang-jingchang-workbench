"""Safe cross-process stock failures; no account, real provider or billing."""
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from integrations.moneyprinterturbo.stock import MoneyPrinterStockSource, UPSTREAM_FUNCTIONS
from tools.video.stock_sources.base import SearchFilters, source_failure


def failed_receipt(provider='pexels',status=429,kind='rate_limited',**extra):
    return {'status':'failed','engine':'moneyprinterturbo','provider':provider,
        'upstream_function':UPSTREAM_FUNCTIONS[provider],
        'failure':{'schema_version':1,'status_code':status,'error_kind':kind},**extra}


def adapter(tmp_path,monkeypatch,receipt,returncode=0):
    from integrations.moneyprinterturbo import stock
    source=SimpleNamespace(name='pexels',is_available=lambda:True,
        search=Mock(side_effect=AssertionError('no native fallback')),download=Mock())
    monkeypatch.setattr(stock,'PYTHON',Path(__file__))
    def runner(command,**kwargs):
        payload=json.loads(kwargs['input']);output=Path(payload['output'])
        (output/'result.json').write_text(json.dumps(receipt))
        return SimpleNamespace(returncode=returncode)
    return MoneyPrinterStockSource(source,tmp_path,deadline=__import__('time').time()+30,runner=runner),source


@pytest.mark.parametrize('status,kind',[(401,'permission_denied'),(403,'permission_denied'),(429,'rate_limited'),(503,'temporarily_unavailable')])
def test_failed_receipt_retains_http_category_in_host_exception(tmp_path,monkeypatch,status,kind):
    wrapped,source=adapter(tmp_path,monkeypatch,failed_receipt(status=status,kind=kind))
    with pytest.raises(ValueError) as error:wrapped.search('clouds',SearchFilters())
    failure=source_failure(error.value)
    assert failure.get('status_code')==status and failure.get('error_kind')==kind
    source.search.assert_not_called();source.download.assert_not_called()


@pytest.mark.parametrize('change',[
    {'provider':'pixabay_video'}, {'upstream_function':'search_videos_coverr'}, {'engine':'native'},
    {'failure':{'schema_version':True,'error_kind':'rate_limited','status_code':429}},
    {'failure':{'schema_version':1,'error_kind':'rate_limited','status_code':'429'}},
    {'failure':{'schema_version':1,'error_kind':'rate_limited','status_code':True}},
    {'failure':{'schema_version':1,'error_kind':'api_error','status_code':401}},
    {'failure':{'schema_version':1,'error_kind':['rate_limited']}},
    {'failure':{'schema_version':1,'error_kind':'untrusted-private-url'}},
])
def test_mismatched_or_malformed_receipt_cannot_inject_source_failure(tmp_path,monkeypatch,change):
    payload=failed_receipt();payload.update(change)
    wrapped,source=adapter(tmp_path,monkeypatch,payload)
    with pytest.raises(ValueError) as error:wrapped.search('clouds',SearchFilters())
    failure=source_failure(error.value)
    assert 'status_code' not in failure and 'error_kind' not in failure
    assert 'untrusted-private-url' not in str(error.value)


def test_uncontrolled_response_fields_are_not_echoed(tmp_path,monkeypatch):
    payload=failed_receipt(message='synthetic-body-do-not-copy',url='https://example.test/?key=synthetic')
    payload['failure'].update(error='synthetic-body-do-not-copy',headers={'Authorization':'synthetic'})
    wrapped,source=adapter(tmp_path,monkeypatch,payload)
    with pytest.raises(ValueError) as error:wrapped.search('clouds',SearchFilters())
    assert 'synthetic' not in json.dumps(source_failure(error.value))


@pytest.fixture(scope='module')
def worker_fixture(tmp_path_factory):
    path=tmp_path_factory.mktemp('mpt-fixture-worker')/'worker.py'
    path.write_text(r'''
import io,json,socket,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
provider,status,mode=sys.argv[2],int(sys.argv[3]),sys.argv[4]
raw=sys.stdin.read();payload=json.loads(raw);sys.stdin=io.StringIO(raw)
def blocked(*args,**kwargs):raise AssertionError('external network forbidden in fixture worker')
socket.socket.connect=blocked;socket.socket.connect_ex=blocked;socket.create_connection=blocked
import requests
calls=[]
def get(*args,**kwargs):
    calls.append({'allow_redirects':kwargs.get('allow_redirects')})
    if mode=='timeout':raise requests.ReadTimeout('synthetic-private-body https://example.test/?key=synthetic')
    if mode=='connection':raise requests.ConnectionError('synthetic-private-body')
    response=requests.Response();response.status_code=status
    response.url='https://example.test/?key=synthetic-private-body'
    response.headers['Content-Type']='application/json'
    response._content=(b'<html>synthetic-private-body</html>' if mode=='bad_json' else
                       json.dumps({'error':'synthetic-private-body'} if mode=='bad_shape' else
                                  {'videos' if provider=='pexels' else 'hits':[]}).encode())
    return response
requests.get=get
from integrations.moneyprinterturbo import bridge
try:bridge.main()
finally:
    (Path(payload['output'])/'fixture-http-count.json').write_text(json.dumps({'requests':len(calls),
        'redirects_disabled':all(x['allow_redirects'] is False for x in calls),'outbound_sockets_blocked':True,
        'actual_provider_calls':0,'source_http_simulated':True}))
''')
    return path


def real_runner(worker_fixture,provider,status,mode):
    import os,shutil,subprocess
    root=Path(__file__).resolve().parents[2]
    binary=shutil.which('ffmpeg')
    environment={'PATH':str(Path(binary).parent)+os.pathsep+os.defpath,'IMAGEIO_FFMPEG_EXE':binary,
        'PEXELS_API_KEY':'synthetic-local-only','PIXABAY_API_KEY':'synthetic-local-only','COVERR_API_KEY':'synthetic-local-only'}
    def run(command,**kwargs):
        kwargs['env']=environment
        return subprocess.run([command[0],str(worker_fixture),str(root),provider,str(status),mode],**kwargs)
    return run


def actual_adapter(tmp_path,worker_fixture,provider='pexels',status=429,mode='http'):
    import time
    source=SimpleNamespace(name=provider,is_available=lambda:True,
        search=Mock(side_effect=AssertionError('native search must not replace MPT')),download=Mock())
    return MoneyPrinterStockSource(source,tmp_path,deadline=time.time()+40,
        runner=real_runner(worker_fixture,provider,status,mode)),source


@pytest.mark.parametrize('provider',['pexels','pixabay_video','coverr'])
@pytest.mark.parametrize('status,kind',[(401,'permission_denied'),(403,'permission_denied'),(429,'rate_limited'),(503,'temporarily_unavailable')])
def test_real_isolated_worker_pinned_function_failure_crosses_process_boundary(tmp_path,worker_fixture,provider,status,kind):
    wrapped,source=actual_adapter(tmp_path,worker_fixture,provider,status)
    with pytest.raises(ValueError) as error:wrapped.search('forest',SearchFilters())
    failure=source_failure(error.value)
    assert failure['status_code']==status and failure['error_kind']==kind
    result_path=next(tmp_path.glob('upstream-search/*/result.json'));receipt=json.loads(result_path.read_text())
    assert receipt['provider']==provider and receipt['upstream_function']==UPSTREAM_FUNCTIONS[provider]
    count=json.loads((result_path.parent/'fixture-http-count.json').read_text())
    assert count['requests']==1 and count['redirects_disabled'] and count['outbound_sockets_blocked']
    assert 'synthetic-private-body' not in result_path.read_text() and 'example.test' not in result_path.read_text()
    source.search.assert_not_called();source.download.assert_not_called()


@pytest.mark.parametrize('mode,kind',[('timeout','timeout'),('connection','connection_failed'),('bad_json','invalid_response'),('bad_shape','invalid_response')])
def test_real_worker_retains_transport_or_payload_category_without_body(tmp_path,worker_fixture,mode,kind):
    wrapped,source=actual_adapter(tmp_path,worker_fixture,status=200,mode=mode)
    with pytest.raises(ValueError) as error:wrapped.search('forest',SearchFilters())
    failure=source_failure(error.value);assert failure['error_kind']==kind
    if mode in {'timeout','connection'}:assert 'status_code' not in failure
    else:assert failure['status_code']==200
    assert 'synthetic-private-body' not in json.dumps(failure)


def test_real_worker_valid_empty_results_remain_success(tmp_path,worker_fixture):
    wrapped,source=actual_adapter(tmp_path,worker_fixture,status=200,mode='empty')
    assert wrapped.search('forest',SearchFilters())==[]
    path=next(tmp_path.glob('upstream-search/*/result.json'))
    assert json.loads(path.read_text())['status']=='completed'


def test_real_worker_failure_blocks_later_queries_in_direct_search(tmp_path,worker_fixture,monkeypatch):
    from integrations.moneyprinterturbo import stock
    from tools.video.direct_clip_search import DirectClipSearch
    import tools.video.stock_sources as registry
    wrapped,source=actual_adapter(tmp_path,worker_fixture)
    monkeypatch.setattr(registry,'all_sources',lambda:[source])
    monkeypatch.setattr(stock,'MoneyPrinterStockSource',lambda *a,**k:wrapped)
    result=DirectClipSearch().execute({'output_dir':str(tmp_path),'queries':[{'query':'forest'},{'query':'clouds'}],
        'sources':['pexels'],'stock_engine':'moneyprinterturbo','extract_thumbnails':False})
    assert result.data['clips']==[] and len(result.data['errors'])==1
    assert result.data['errors'][0]['status_code']==429
    assert len(list(tmp_path.glob('upstream-search/*/result.json')))==1
    source.search.assert_not_called()


@pytest.mark.parametrize('status,kind',[(401,'permission_denied'),(403,'permission_denied'),(429,'rate_limited'),(503,'temporarily_unavailable')])
def test_footage_collection_keeps_source_block_for_entire_task_and_safe_manifest(tmp_path,monkeypatch,status,kind):
    import threading
    from web_api.footage_pipeline import FootageJobs,FootageRequest
    import tools.video.stock_sources as registry
    project=tmp_path/'demo';project.mkdir();calls=[]
    def search(inputs):
        calls.append(inputs)
        return {'clips':[],'errors':[{'source':'pexels','phase':'search','status_code':status,'error_kind':kind,
            'error_type':'StockSearchError','error':'synthetic-private-body','response':{'key':'synthetic-private-body'}}]}
    monkeypatch.setattr(registry,'source_catalog',lambda:[{'name':'pexels','status':'available'}])
    manager=FootageJobs(tmp_path,search=search);manager.update=Mock()
    plan={'shots':[{'id':'cloud','text':'云','duration_seconds':1,'source_path':'','candidates':[],
                    'queries':[{'text':'Mount Sanqing clouds','kind':'place_intent'},{'text':'Mount Sanqing forest','kind':'place_intent'}]}]}
    job='footage-'+'d'*24;warnings=[]
    manager._collect(FootageRequest(project_id='demo',action='collect',sources=['pexels'],confirm_network=True),plan,job,threading.Event(),warnings)
    assert len(calls)==1
    manifest=json.loads((manager.directory('demo',job)/'stock_manifest.json').read_text())
    assert manifest['blocked_sources']==['pexels'] and manifest['source_errors'][0]['status_code']==status
    assert 'synthetic-private-body' not in json.dumps(manifest)
    assert any('已停止本次任务' in text for text in warnings)


def test_footage_collection_continues_other_sources_after_blocking_failed_source(tmp_path,monkeypatch):
    import threading
    from web_api.footage_pipeline import FootageJobs,FootageRequest
    import tools.video.stock_sources as registry
    (tmp_path/'demo').mkdir();calls=[]
    def search(inputs):
        calls.append(inputs['sources'])
        return {'clips':[],'errors':[{'source':'pexels','phase':'search','status_code':429,'error_kind':'rate_limited'}]} if len(calls)==1 else {'clips':[]}
    monkeypatch.setattr(registry,'source_catalog',lambda:[{'name':name,'status':'available'} for name in ['pexels','wikimedia']])
    manager=FootageJobs(tmp_path,search=search);manager.update=Mock()
    plan={'shots':[{'id':'cloud','text':'云','duration_seconds':1,'source_path':'','candidates':[],
                    'queries':[{'text':'Mount Sanqing clouds','kind':'place_intent'},{'text':'Mount Sanqing forest','kind':'place_intent'}]}]}
    manager._collect(FootageRequest(project_id='demo',action='collect',sources=['pexels','wikimedia'],confirm_network=True),
        plan,'footage-'+'e'*24,threading.Event(),[])
    assert calls==[['pexels','wikimedia'],['wikimedia']]


def test_real_collection_job_preserves_other_source_media_after_isolated_mpt_rate_limit(tmp_path,worker_fixture,monkeypatch):
    import hashlib,shutil,subprocess
    from integrations.moneyprinterturbo import stock
    from tools.video.stock_sources.base import Candidate
    from web_api.footage_pipeline import FootageJobs,FootageRequest
    import tools.video.stock_sources as registry
    project=tmp_path/'demo';project.mkdir()
    media={}
    for intent,color in [('clouds','blue'),('forest','red')]:
        media[intent]=tmp_path/('local-'+intent+'.mp4')
        subprocess.run(['ffmpeg','-v','error','-n','-f','lavfi','-i',f'color=c={color}:s=160x90:r=12:d=1.5',
                        '-c:v','libx264','-pix_fmt','yuv420p',str(media[intent])],check=True,timeout=20)
    before={key:hashlib.sha256(path.read_bytes()).hexdigest() for key,path in media.items()}
    failed=SimpleNamespace(name='pexels',is_available=lambda:True,
        search=Mock(side_effect=AssertionError('no fallback')),download=Mock())
    class HealthySource:
        name='wikimedia'
        def __init__(self):self.queries=[];self.downloads=[]
        def is_available(self):return True
        def search(self,query,filters):
            self.queries.append(query)
            identity='forest' if 'forest' in query else 'clouds'
            return [Candidate(source=self.name,source_id=identity,
                source_url='https://example.test/local-fixture/'+identity,download_url='https://example.test/'+identity+'.mp4',
                source_tags=query,kind='video',width=160,height=90,duration=1.5)]
        def download(self,candidate,out):self.downloads.append(candidate.clip_id);shutil.copyfile(media[candidate.source_id],out);return out
    healthy=HealthySource();original_class=MoneyPrinterStockSource
    def factory(source,output_dir,*,deadline):
        assert source is failed
        return original_class(source,output_dir,deadline=deadline,runner=real_runner(worker_fixture,'pexels',429,'http'))
    monkeypatch.setattr(stock,'MoneyPrinterStockSource',factory)
    monkeypatch.setattr(registry,'all_sources',lambda:[failed,healthy])
    monkeypatch.setattr(registry,'source_catalog',lambda:[{'name':name,'status':'available'} for name in ['pexels','wikimedia']])
    class Inline:
        def submit(self,function,*args):function(*args)
    manager=FootageJobs(tmp_path,executor=Inline())
    request=FootageRequest(project_id='demo',topic='三清山',script='云雾与树林。',action='collect',
        sources=['pexels','wikimedia'],confirm_network=True,options={'narration':'none','bgm_mode':'none'},
        shots=[{'id':'cloud','text':'云雾','title':'云雾','query':'Mount Sanqing clouds','duration_seconds':1,'selection_mode':'auto'},
               {'id':'forest','text':'树林','title':'树林','query':'Mount Sanqing forest','duration_seconds':1,'selection_mode':'auto'}])
    queued=manager.submit(request);result=manager.get('demo',queued['job_id'])
    assert result['status']=='awaiting_review',result.get('message')
    assert result['blocked_sources']==['pexels']
    assert result['source_errors'][0]['status_code']==429
    assert len(list(project.glob('assets/footage/*/stock/upstream-search/*/result.json')))==1
    assert len(healthy.downloads)>=2
    assert len({shot['source_path'] for shot in result['shots']})==2
    assert all((project/shot['source_path']).is_file() for shot in result['shots'])
    assert {key:hashlib.sha256(path.read_bytes()).hexdigest() for key,path in media.items()}==before
    assert 'synthetic-private-body' not in json.dumps(result)
    manifest=json.loads((manager.directory('demo',queued['job_id'])/'stock_manifest.json').read_text())
    assert len(manifest['clips'])>=2 and manifest['blocked_sources']==['pexels']
    failed.search.assert_not_called();failed.download.assert_not_called()
    (tmp_path/'collection-receipt.json').write_text(json.dumps({'status':result['status'],
        'blocked_sources':result['blocked_sources'],'source_errors':result['source_errors'],
        'selected_source_ids':[shot['selected_source']['source_id'] for shot in result['shots']],
        'selected_paths':[shot['source_path'] for shot in result['shots']],
        'healthy_local_downloads':len(healthy.downloads),'isolated_workers_started':1,
        'original_fixture_sha256':before,'original_fixture_unchanged':True,'actual_provider_calls':0,
        'source_http_simulated':True,'real_local_media_and_decode':True},ensure_ascii=False,indent=2))
