import json
from pathlib import Path
import threading

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from web_api.hypit_runtime import HypitRuntime, HypitSettings
from web_api.hypit_workbench import create_hypit_workbench_router, prepare_imported_local_example
from web_api.tests.test_hypit_runtime import checkout, project


def manager(tmp_path, version):
    sdk=checkout(tmp_path)
    (sdk/'package.json').write_text(json.dumps({'version':version}))
    (sdk/'node_modules').mkdir()
    selected=project(tmp_path)
    # The executable's existence is all this discovery fixture validates.
    import sys
    return HypitRuntime(settings=HypitSettings(selected.parent,sdk,node_executable=sys.executable)),selected


def test_version_routes_cannot_select_arbitrary_checkout_or_cross_version_project(tmp_path):
    old,old_project=manager(tmp_path/'old','0.2.12')
    new,new_project=manager(tmp_path/'new','0.3.1')
    app=FastAPI();app.include_router(create_hypit_workbench_router(old_project.parent,services={'0.2.12':old,'0.3.1':new}))
    try:
        with TestClient(app) as client:
            versions=client.get('/model-api/hypit/versions').json()
            assert versions['default']=='0.2.12'
            assert [row['version'] for row in versions['versions']]==['0.2.12','0.3.1']
            assert all(row['available'] for row in versions['versions'])
            assert client.get('/model-api/hypit/status').json()['checkout']['version']=='0.2.12'
            assert client.get('/model-api/hypit-v031/status').json()['checkout']['version']=='0.3.1'
            blocked=client.post('/model-api/hypit-v031/action',json={'action':'project_select','project_id':'demo','project_path':str(old_project)})
            assert blocked.status_code==422
            extra=client.post('/model-api/hypit-v031/local-examples',json={'example_id':'minimal','hypit_root':'/arbitrary'})
            assert extra.status_code==422
    finally:
        old.close();new.close()


def test_local_example_keeps_upstream_profile_and_never_rewrites_existing_project(tmp_path):
    service,selected=manager(tmp_path,'0.3.1')
    example=service.hypit_root/'examples/minimal'
    profile=example/'hypit.runtime.json'
    profile.write_text(json.dumps({'format':'hypit.runtime-local@1','dataRoot':'/do-not-reuse','endpoints':{'media.local':{'use':'@hypit/media-local','config':{'ffmpegPath':'/explicit/custom/ffmpeg'}}}}))
    original=profile.read_bytes();before=(selected/'hypit.runtime.json').read_bytes()
    try:
        result=prepare_imported_local_example(service,'minimal')
        new=service.project(result['hypit_project_id'])
        configured=json.loads((new/'hypit.runtime.json').read_text())
        assert configured['dataRoot']=='.hypit/runtimes/workbench-local'
        assert configured['endpoints']['media.local']['config']['ffmpegPath']=='/explicit/custom/ffmpeg'
        assert (new/'hypit.upstream.runtime.json').read_bytes()==original
        assert profile.read_bytes()==original
        assert (selected/'hypit.runtime.json').read_bytes()==before
    finally:service.close()


def test_remote_example_rejected_before_any_copy(tmp_path):
    service,selected=manager(tmp_path,'0.3.1')
    profile=service.hypit_root/'examples/minimal/hypit.runtime.json'
    profile.write_text(json.dumps({'endpoints':{'remote':{'use':'@hypit/provider-hypihub'}}}))
    before=set(service.project_root.iterdir())
    try:
        with pytest.raises(ValueError,match='纯本机'):
            prepare_imported_local_example(service,'minimal')
        assert set(service.project_root.iterdir())==before
    finally:service.close()


def test_media_download_supports_range_and_rejects_private_or_link_escape(tmp_path):
    service,selected=manager(tmp_path,'0.3.1')
    exports=selected/'exports';exports.mkdir()
    (exports/'actual.mp4').write_bytes(b'0123456789')
    outside=tmp_path/'private.mp4';outside.write_bytes(b'private')
    (exports/'escape.mp4').symlink_to(outside)
    app=FastAPI();app.include_router(create_hypit_workbench_router(selected.parent,services={'0.3.1':service}))
    try:
        with TestClient(app) as client:
            base='/model-api/hypit-v031/projects/demo/files/'
            response=client.get(base+'exports/actual.mp4',headers={'Range':'bytes=2-5'})
            assert response.status_code==206 and response.content==b'2345'
            assert response.headers['content-range']=='bytes 2-5/10'
            for path in ['hypit.runtime.json','exports/escape.mp4','exports/.secret.mp4']:
                assert client.get(base+path).status_code==404
            blocked=client.post('/model-api/hypit-v031/local-examples',json={'example_id':'minimal'},headers={'Origin':'https://external.example'})
            assert blocked.status_code==403
    finally:service.close()
