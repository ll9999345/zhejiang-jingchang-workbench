import io,json,wave,threading,urllib.request,urllib.error
from pathlib import Path
from types import SimpleNamespace
import pytest
from tools.analysis.hypit_speech_service import Adapter,IDENTITY,REVISION,audio_bytes,handler,response_from_result,ThreadingHTTPServer

@pytest.fixture
def wav(tmp_path):
    p=tmp_path/'voice.wav'
    with wave.open(str(p),'wb') as w:w.setparams((1,2,16000,0,'NONE',''));w.writeframes(b'\0\0'*16000)
    return p

def result():return SimpleNamespace(success=True,data={'language':'zh','device':'cpu','compute_type':'int8','alignment':{'engine':'whisperx_forced_ctc','source_revision':REVISION,'interpolated_timestamps':False},'segments':[{'text':'你好','words':[{'word':'你','start':.1,'end':.3,'score':.9},{'word':'好','start':.4,'end':.8,'score':.8}]}]})

class Transcriber:
    def __init__(self):self.calls=[]
    def execute(self,args):self.calls.append(args);return result()

def test_contract_preserves_actual_words_scores_and_requires_true_ctc():
    r=result();assert response_from_result(r,1)['segments'][0]['words'][0]=={'text':'你','start':.1,'end':.3,'score':.9}
    r.data['alignment']['interpolated_timestamps']=True
    with pytest.raises(RuntimeError):response_from_result(r,1)

@pytest.mark.parametrize('field,value',[('start',float('nan')),('end',2),('score',-1),('start',True),('word','')])
def test_no_fabricated_or_invalid_evidence(field,value):
    r=result();r.data['segments'][0]['words'][1][field]=value
    with pytest.raises(RuntimeError):response_from_result(r,1)

def test_original_audio_preserved_and_no_script_input(wav,tmp_path):
    t=Transcriber();a=Adapter([tmp_path],tmp_path/'out',t);before=wav.read_bytes()
    response=a.transcribe({'audio_path':str(wav),'language':'zh'})
    assert response['segments'][0]['text']=='你好' and wav.read_bytes()==before
    assert len(t.calls)==1 and t.calls[0]['alignment']=='whisperx_zh' and 'text' not in t.calls[0]
    copied=Path(t.calls[0]['input_path']);assert copied!=wav and copied.read_bytes()==before
    receipt=json.loads((copied.parent/'receipt.json').read_text());assert receipt['authored_text_supplied'] is False
    with pytest.raises(ValueError):a.transcribe({'audio_path':str(wav),'language':'zh','text':'预设答案'})
    with pytest.raises(ValueError):a.transcribe({'audio_path':str(wav),'language':'en'})
    assert len(t.calls)==1

def test_path_escape_symlink_and_wrong_audio_format_rejected(wav,tmp_path):
    other=tmp_path/'allowed';other.mkdir();(other/'link.wav').symlink_to(wav)
    with pytest.raises(ValueError):audio_bytes(str(other/'link.wav'),[other])
    with wave.open(str(tmp_path/'stereo.wav'),'wb') as w:w.setparams((2,2,16000,0,'NONE',''));w.writeframes(b'\0'*64000)
    with pytest.raises(ValueError):audio_bytes(str(tmp_path/'stereo.wav'),[tmp_path])

def test_busy_fails_without_duplicate_execution(wav,tmp_path):
    t=Transcriber();a=Adapter([tmp_path],tmp_path/'out',t);a.lock.acquire()
    try:
        with pytest.raises(BlockingIOError):a.transcribe({'audio_path':str(wav),'language':'zh'})
    finally:a.lock.release()
    assert t.calls==[]

def test_http_identity_origin_boundary_and_payload(wav,tmp_path):
    t=Transcriber();a=Adapter([tmp_path],tmp_path/'out',t);server=ThreadingHTTPServer(('127.0.0.1',0),handler(a));thread=threading.Thread(target=server.serve_forever);thread.start()
    root=f'http://127.0.0.1:{server.server_port}'
    try:
        with urllib.request.urlopen(root+'/health') as r:identity=json.load(r)
        assert all(identity[k]==v for k,v in IDENTITY.items()) and identity['officialDistribution'] is False and identity['whisperxVersion']!='3.8.6'
        assert identity['instanceId']==a.instance_id and identity['busy'] is False
        payload=json.dumps({'audio_path':str(wav),'language':'zh'}).encode()
        req=urllib.request.Request(root+'/transcribe',data=payload,headers={'Content-Type':'application/json','Origin':'https://external.invalid'})
        with pytest.raises(urllib.error.HTTPError) as e:urllib.request.urlopen(req)
        assert e.value.code==403 and not t.calls
        req=urllib.request.Request(root+'/transcribe',data=payload,headers={'Content-Type':'application/json'})
        with urllib.request.urlopen(req) as r:assert json.load(r)['language']=='zh'
        assert len(t.calls)==1
    finally:server.shutdown();server.server_close();thread.join()


def test_shutdown_rejects_wrong_owner_and_busy_work_before_graceful_exit(wav,tmp_path):
    t=Transcriber();a=Adapter([tmp_path],tmp_path/'out',t,instance_id='owned-test')
    server=ThreadingHTTPServer(('127.0.0.1',0),handler(a));thread=threading.Thread(target=server.serve_forever);thread.start()
    root=f'http://127.0.0.1:{server.server_port}'
    def stop(instance):
        return urllib.request.urlopen(urllib.request.Request(root+'/shutdown',data=json.dumps({'instance_id':instance}).encode(),headers={'Content-Type':'application/json'}))
    try:
        with pytest.raises(urllib.error.HTTPError) as wrong:stop('external-test')
        assert wrong.value.code==400 and not a.closing.is_set()
        a.lock.acquire()
        try:
            with pytest.raises(urllib.error.HTTPError) as busy:stop('owned-test')
            assert busy.value.code==503 and not a.closing.is_set()
        finally:a.lock.release()
        with stop('owned-test') as response:assert response.status==202
        thread.join(timeout=2);assert not thread.is_alive() and a.closing.is_set()
        with pytest.raises(BlockingIOError):a.transcribe({'audio_path':str(wav),'language':'zh'})
        assert not t.calls
    finally:server.shutdown();server.server_close();thread.join()
