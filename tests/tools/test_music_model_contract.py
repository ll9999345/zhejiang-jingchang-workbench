"""Captured provider payload only; never sends a real request."""
import sys
import types
import pytest
from tools.audio.music_gen import MusicGen
from web_api.music_pipeline import MusicPipelineRequest, estimate_music

@pytest.mark.parametrize('model_id', ['music_v1', 'music_v2', 'music_v2_5'])
def test_actual_compose_payload_has_exact_model_and_single_call(monkeypatch, tmp_path, model_id):
    calls=[]
    def post(url, **kwargs):
        calls.append((url,kwargs['json']))
        return types.SimpleNamespace(content=b'local-fixture',raise_for_status=lambda:None)
    monkeypatch.setitem(sys.modules,'requests',types.SimpleNamespace(post=post))
    result=MusicGen()._generate({'prompt':'instrumental lake ambience','duration_seconds':12.5,'model_id':model_id,'output_path':str(tmp_path/'fixture.mp3')},'fixture-not-a-real-secret')
    assert result.success and len(calls)==1
    assert calls[0]==('https://api.elevenlabs.io/v1/music',{'prompt':'instrumental lake ambience','model_id':model_id,'music_length_ms':12500,'force_instrumental':True})

@pytest.mark.parametrize('change', [{'prompt':'x'*4101},{'duration_seconds':2},{'duration_seconds':float('inf')},{'duration_seconds':True},{'model_id':'invented-model'}])
def test_invalid_contract_never_posts(monkeypatch,tmp_path,change):
    calls=[]
    monkeypatch.setitem(sys.modules,'requests',types.SimpleNamespace(post=lambda *a,**k:calls.append(1)))
    result=MusicGen()._generate({'prompt':'quiet instrumental','duration_seconds':10,'output_path':str(tmp_path/'fixture.mp3'),**change},'fixture')
    assert not result.success and not calls

def test_full_prompt_limit_is_checked_without_silently_cutting_user_text(tmp_path):
    (tmp_path/'isolated').mkdir()
    request=MusicPipelineRequest(project_id='isolated',prompt='x'*4100,duration_seconds=10)
    result=estimate_music(request,project_root=tmp_path)
    assert result['status']=='invalid_request' and result['would_generate'] is False
    assert '4100' in result['error']
