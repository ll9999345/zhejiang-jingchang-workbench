import json
from pathlib import Path
from types import SimpleNamespace
import sys

import pytest

import lib.stock_readiness as readiness
import tools.video.stock_sources as sources
from tools.base_tool import ToolResult
from tools.video.corpus_builder import CorpusBuilder
from web_api.montage_registry import NativeToolRequest, native_inputs, preflight_tool, tool_catalog


def configure(monkeypatch, available=1, total=2, embedding=True):
    monkeypatch.setattr(sources,'all_sources',lambda:[SimpleNamespace(name=f'fixture{i}',is_available=lambda i=i:i<available) for i in range(total)])
    monkeypatch.setattr(readiness.shutil,'which',lambda _: '/existing-tool')
    monkeypatch.setattr(readiness,'embedding_readiness',lambda:{'ready':embedding,'evidence':'local_files_and_module_discovery_not_inference'})


def test_partial_sources_do_not_claim_local_components_missing(monkeypatch):
    configure(monkeypatch)
    row=readiness.stock_readiness(True)
    assert row['state']=='degraded' and not row['requirements']
    assert row['configured_sources']==1 and '1/2' in row['summary']
    assert '未配置的来源不影响' in row['summary'] and '不代表平台当前连通' in row['note']
    assert CorpusBuilder().get_status().value=='degraded'


def test_missing_clip_and_no_sources_are_separate_requirements(monkeypatch):
    configure(monkeypatch,available=0,embedding=False)
    row=readiness.stock_readiness(True)
    assert row['state']=='unavailable'
    assert any('语义模型' in text for text in row['requirements'])
    assert any('素材来源' in text for text in row['requirements'])
    assert readiness.stock_readiness(False)['embedding'] is None


def test_broken_source_discovery_is_not_misreported_as_missing_credentials(monkeypatch):
    configure(monkeypatch)
    monkeypatch.setattr(sources,'all_sources',lambda:(_ for _ in ()).throw(RuntimeError('synthetic-private-message')))
    row=readiness.stock_readiness(True)
    assert row['state']=='unavailable' and '无法读取' in row['summary']
    assert 'synthetic-private-message' not in str(row)


@pytest.mark.parametrize('stdout,code,expected',[(json.dumps({n:True for n in ['torch','transformers','PIL','numpy']}),0,True),('[]',0,False),('{}',0,False),('not json',0,False),('ignored',1,False)])
def test_runtime_probe_is_only_local_module_discovery(monkeypatch,stdout,code,expected):
    commands=[]
    def run(command,**kwargs):
        commands.append(command)
        assert kwargs['timeout']==8 and kwargs['env']['HF_HUB_OFFLINE']=='1'
        assert 'from_pretrained' not in command[-1] and 'import torch' not in command[-1]
        return SimpleNamespace(stdout=stdout,returncode=code)
    readiness._probe_python.cache_clear()
    monkeypatch.setattr(readiness.subprocess,'run',run)
    assert readiness._probe_python('/configured-python',(1,2),7) is expected
    assert readiness._probe_python('/configured-python',(1,2),7) is expected
    assert len(commands)==1 and commands[0][1:3]==['-I','-c']
    readiness._probe_python.cache_clear()


def test_host_dependencies_do_not_require_an_unused_bridge_interpreter(tmp_path,monkeypatch):
    import lib.clip_embedder as embedder
    model=tmp_path/'model';model.mkdir()
    for name in ('model.safetensors','config.json','vocab.json','merges.txt','preprocessor_config.json'):(model/name).write_text('fixture')
    monkeypatch.setattr(embedder,'local_runtime',lambda:(tmp_path/'missing-python',model))
    monkeypatch.setattr(embedder,'_needs_bridge',lambda:False)
    calls=[]
    monkeypatch.setattr(readiness,'_probe_python',lambda python,*_:calls.append(python) or True)
    assert readiness.embedding_readiness()['ready']
    assert calls==[sys.executable]
    monkeypatch.setattr(embedder,'_needs_bridge',lambda:True)
    assert not readiness.embedding_readiness()['ready']


def test_catalog_hides_only_server_managed_corpus_destination(monkeypatch):
    configure(monkeypatch)
    row=next(row for row in tool_catalog()['tools'] if row['name']=='corpus_builder')
    assert 'corpus_dir' not in row['input_schema']['properties'] and 'corpus_dir' not in row['input_schema']['required']
    assert 'corpus_dir' in CorpusBuilder.input_schema['properties']
    assert row['readiness']['configured_sources']==1
    direct=next(row for row in tool_catalog()['tools'] if row['name']=='direct_clip_search')
    from tools.video.direct_clip_search import DirectClipSearch
    assert direct['input_schema']['properties']['unique_across_queries']['default'] is True
    assert DirectClipSearch.input_schema['properties']['unique_across_queries']['default'] is False


def test_preflight_without_destination_and_real_worker_default_preserve_original(tmp_path,monkeypatch):
    import web_api.montage_worker as worker
    configure(monkeypatch)
    project=tmp_path/'demo';project.mkdir();original=project/'corpus';original.mkdir();(original/'accepted.json').write_text('accepted')
    request=NativeToolRequest(project_id='demo',tool='corpus_builder',inputs={'queries':[{'query':'local'}]},allow_network=True)
    assert preflight_tool(request,tmp_path)['can_execute']
    assert 'corpus_dir' not in request.inputs
    seen=[]
    def execute(self,inputs):
        seen.append(inputs['corpus_dir']);return ToolResult(success=True)
    monkeypatch.setattr(CorpusBuilder,'execute',execute)
    output=project/'fresh/outputs';output.mkdir(parents=True)
    assert worker.execute_native(request,project,output)['status']=='completed'
    assert seen==[str(output/'corpus')] and (original/'accepted.json').read_text()=='accepted'
    assert native_inputs(CorpusBuilder(),{'queries':[],'corpus_dir':'legacy'})['corpus_dir']=='legacy'
