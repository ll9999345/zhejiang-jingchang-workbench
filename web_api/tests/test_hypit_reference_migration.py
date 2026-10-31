import json
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from web_api.tests.test_hypit_bridge import source_project, _fake_probe
from web_api.tests.test_hypit_migration import pair
import web_api.hypit_bridge as bridge
import web_api.hypit_migration as migration
from web_api.hypit_runtime import HypitRuntimeError
from web_api.hypit_workbench import create_hypit_workbench_router

@pytest.fixture
def reference(pair,source_project,monkeypatch):
    old,new,_=pair
    monkeypatch.setattr(bridge,'probe',_fake_probe)
    project=old.project_root/'reference-demo'
    bridge.export_hypit_package(source_project,project,bridge.HypitBridgeOptions(asset_mode='copy',variant_count=2))
    (project/'exports').mkdir();(project/'exports/accepted.mp4').write_bytes(b'unit-fixture-not-real-video')
    result=project/'.hypit/results/old/result.json';result.parent.mkdir(parents=True);result.write_text('{"original":true}')
    return old,new,project

def test_copy_preserves_all_assets_variants_recipe_bindings_and_originals(reference):
    old,new,source=reference;before=migration._inventory(source)
    preview=migration.inspect_legacy(old,source.name)
    assert preview['supported'],preview
    assert preview['requires_speech_alignment'] and preview['runtime_check']=='pending'
    response=migration.migrate_legacy(old,new,source.name,preview['fingerprint'])
    target=new.project(response['hypit_project_id']);receipt=response['receipt']
    assert migration._inventory(source)==before
    assert response['author_source']=='reference.svml' and response['run_source']=='reference.svrun'
    assert receipt['authoring_summary']['tracks']==['picture','soundtrack','captions']
    assert receipt['authoring_summary']['segment_ids']==['shot-1','shot-2']
    for row in receipt['copied_assets']:assert (target/row['path']).read_bytes()==(source/row['path']).read_bytes()
    assert len(receipt['copied_assets'])==3 # each A-roll declaration plus B-roll
    for name in ['variants.json','bridge.manifest.json','assets.manifest.json','NEEDS.md']:
        assert (target/name).read_bytes()==(source/name).read_bytes()
    assert (target/'.migration/original/reference.svml').read_bytes()==(source/'reference.svml').read_bytes()
    profile=json.loads((target/'hypit.runtime.json').read_text())
    assert profile['bindings']==json.loads((source/'hypit.runtime.json').read_text())['bindings']
    assert profile['endpoints']['hyperframes.local']['use']=='@hypit/provider-html-local'
    assert not (target/'.hypit/results').exists()
    assert not receipt['generation_submitted'] and receipt['source_check']=='pending'
    export=receipt['accepted_media'][0]
    assert (target/export['path']).read_bytes()==(source/export['source_path']).read_bytes()

@pytest.mark.parametrize('change', ['asset','extra-author','odd-canvas','credentials','binding','variant','running','symlink'])
def test_unsupported_or_changed_input_never_creates_partial_success(reference,change):
    old,new,source=reference
    if change=='asset':next((source/'assets').glob('*.mp4')).write_bytes(b'changed')
    elif change=='extra-author':(source/'extra.svml').write_text('<svml/>')
    elif change=='odd-canvas':
        p=source/'reference.svml';p.write_text(p.read_text().replace('width="720"','width="721"'))
    elif change in {'credentials','binding'}:
        p=source/'hypit.runtime.json';d=json.loads(p.read_text())
        if change=='credentials':d['credentials']={'secret':'test-placeholder'}
        else:d['bindings']['@hypit/whisperx@1#whisperx-alignment']='media.local'
        p.write_text(json.dumps(d))
    elif change=='variant':
        p=source/'variants.json';d=json.loads(p.read_text());d['variants'][1]['run']='other.svrun';p.write_text(json.dumps(d))
    elif change=='running':
        p=source/'artifacts/hypit_jobs/hypit-live/job.json';p.parent.mkdir(parents=True);p.write_text('{"status":"running"}')
    else:(source/'exports/link.mp4').symlink_to(source/'exports/accepted.mp4')
    preview=migration.inspect_legacy(old,source.name)
    assert not preview['supported'],(change,preview)
    with pytest.raises(HypitRuntimeError):migration.migrate_legacy(old,new,source.name,preview['fingerprint'])
    assert not list(new.project_root.iterdir())
    assert 'test-placeholder' not in json.dumps(preview)

def test_fingerprint_rejects_changed_project(reference):
    old,new,source=reference;preview=migration.inspect_legacy(old,source.name)
    (source/'NEEDS.md').write_text('New pending requirement')
    with pytest.raises(HypitRuntimeError,match='已变化'):migration.migrate_legacy(old,new,source.name,preview['fingerprint'])
    assert not list(new.project_root.iterdir())

def test_two_author_contracts_are_not_silently_reduced(pair):
    old,new,source=pair;(source/'reference.svml').write_text('<svml/>')
    preview=migration.inspect_legacy(old,source.name)
    assert not preview['supported'] and '多种作者' in preview['diagnostics'][0]

def test_reference_api_copy_receipt_and_asset_read(reference):
    old,new,source=reference;app=FastAPI()
    app.include_router(create_hypit_workbench_router(old.project_root,services={'0.2.12':old,'0.3.1':new}))
    with TestClient(app) as client:
        prefix='/model-api/hypit-v031'
        preview=client.post(prefix+'/migration/inspect',json={'project_id':source.name}).json()
        response=client.post(prefix+'/migration/copy',json={'project_id':source.name,'fingerprint':preview['fingerprint']})
        assert response.status_code==201,response.text
        result=response.json();assert result['author_source']=='reference.svml'
        receipt=client.get(prefix+'/projects/'+result['hypit_project_id']+'/migration').json()
        assert receipt['original_unchanged'] and len(receipt['copied_assets'])==3
        export=receipt['accepted_media'][0]
        assert client.get(prefix+'/projects/'+result['hypit_project_id']+'/files/'+export['path']).content==(source/export['source_path']).read_bytes()
