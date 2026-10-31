import hashlib
import json
from pathlib import Path
import shutil
import sys
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
import web_api.hypit_migration as migration
from web_api.hypit_runtime import HypitRuntime,HypitSettings,HypitRuntimeError,CommandResult
from web_api.hypit_workbench import create_hypit_workbench_router

OLD='''<?svml using="@hypit/markup@1"?>
<svml>
 <import as="time" from="@hypit/timeline-author@1"/>
 <import as="spatial" from="@hypit/spatial@1"/>
 <import as="fonts" from="@hypit/fonts-open@1"/>
 <import as="chat" from="@example/chat-scene@1"/>
 <import as="film" from="@hypit/film@1"/>
 <import as="render" from="@hypit/render-hyperframes@1"/>
 <import as="style" source="./chat.svs"/>
 <time:Clock id="clock" frame-rate="30"/>
 <time:Timeline id="timeline" clock={clock} end="8s"/>
 <spatial:Canvas id="canvas" width="540" height="960"/>
 <fonts:Stack id="font" family="inter" weight="600" style="normal"/>
 <chat:Scene id="scene" timeline={timeline.timeline} canvas={canvas} font={font} during="program" title="My &amp; title">
  <chat:Message id="a" sender="A" side="left" at="0.5s" text="Keep this text"/>
  <chat:Message id="b" sender="B" side="right" at="2s" text="Different text &amp; symbols"/>
 </chat:Scene>
 <film:Film id="film" canvas={canvas} timeline={timeline.timeline} appearance={style.film.main}><film:Track source={scene.track}/></film:Film>
 <render:Video id="final" composition={film.composition} timeline={timeline.timeline}/>
</svml>
'''
RUN='<?svml using="@hypit/run-markup@1"?>\n<svrun version="1"><author source="./chat.svml"/><target output="final.video"/></svrun>\n'
RECIPE='<?svml using="@hypit/svs@1"?>\n<sheet version="1">film.main { background: #142b32; }</sheet>\n'


@pytest.fixture
def pair(tmp_path,monkeypatch):
    old_root=tmp_path/'old-projects';old_root.mkdir();project=old_root/'old-demo';project.mkdir()
    managers=[]
    for version in ['0.2.12','0.3.1']:
        sdk=tmp_path/('sdk-'+version);sdk.mkdir();(sdk/'package.json').write_text(json.dumps({'version':version}));(sdk/'bin').mkdir();(sdk/'bin/hypit.mjs').write_text('fixture')
        component=sdk/'examples/semantic-composition/packages/chat-scene';(component/'src').mkdir(parents=True)
        (component/'src/activation.ts').write_text('export const fixture = true;')
        (component/'src/render.ts').write_text('export const renderFixture = true;')
        (component/'package.json').write_text(json.dumps({'name':'@example/chat-scene','version':'0.0.0-dev'}))
        (component/'tsconfig.json').write_text('{}')
        compiler=sdk/'node_modules/typescript/bin/tsc';compiler.parent.mkdir(parents=True);compiler.write_text('fixture compiler')
        root=old_root if version=='0.2.12' else tmp_path/'new-projects';root.mkdir(exist_ok=True)
        managers.append(HypitRuntime(settings=HypitSettings(root,sdk,node_executable=sys.executable)))
    old,new=managers
    for name,body in [('chat.svml',OLD),('chat.svrun',RUN),('chat.svs',RECIPE)]: (project/name).write_text(body)
    shutil.copytree(old.hypit_root/'examples/semantic-composition/packages',project/'packages')
    (project/'hypit.runtime.json').write_text(json.dumps({'format':'hypit.runtime-local@1','dataRoot':'.hypit/runtimes/local','endpoints':{'media.local':{'use':'@hypit/provider-media-local','config':{'defaultConcurrency':1}},'hyperframes.local':{'use':'@hypit/provider-hyperframes-local','config':{'workers':1}}}}))
    (project/'exports').mkdir();(project/'exports/old.mp4').write_bytes(b'unit-test-media-bytes-not-real-video')
    result=project/'.hypit/results/old/result.json';result.parent.mkdir(parents=True);result.write_text('{"old_type":"must-not-rewrite"}')
    def compiler(argv,**kw):
        assert argv[0]==sys.executable and argv[2]=='-p'
        output=Path(argv[3]).parent/'dist';output.mkdir()
        for name in ['activation.js','render.js']:(output/name).write_text('compiled fixture')
        return CommandResult(tuple(argv),0,'','')
    monkeypatch.setattr(migration,'_run_subprocess',compiler)
    yield old,new,project
    for manager in managers:manager.close()


def test_author_migration_preserves_text_ids_timing_canvas_and_recipe():
    source=OLD.replace('Keep this text','你好 &quot;A&quot; &lt;tag&gt; &amp; intact')
    model=migration.chat_model(source);converted=migration.render_chat(model);tree=migration._parse(converted,author=True)
    messages=tree.findall('.//'+migration._tag('chat','Message'))
    assert [m.get('id') for m in messages]==['a','b']
    assert messages[0].get('text')=='你好 "A" <tag> & intact'
    instants=tree.findall('.//'+migration._tag('time','Instant'))
    assert [n.get('at') for n in instants]==['0.5s','2s']
    assert 'within={canvas.bounds}' in converted and 'source={scene.visual}' in converted
    assert 'width="540" height="960"' in converted and 'end="8s"' in converted


@pytest.mark.parametrize('source',[
    OLD.replace('<film:Track source={scene.track}/>','<film:Track source={scene.track}/><film:Track source={extra}/>'),
    OLD.replace('during="program"','during="another-window"'),
    OLD.replace('at="2s"','at="20s"'),
    OLD.replace('width="540"','width="unknown"'),
    OLD.replace('<svml>','<!DOCTYPE svml [<!ENTITY hidden "bad">]><svml>'),
    OLD.replace('</chat:Scene>','EXTRA TEXT</chat:Scene>'),
    OLD.replace('id="b"','id="a"'),
])
def test_unknown_relationships_are_not_silently_simplified(source):
    with pytest.raises(HypitRuntimeError):migration.chat_model(source)


def test_copy_keeps_every_original_and_raw_result_without_claiming_new_result(pair):
    old,new,source=pair;before=migration._inventory(source)
    preview=migration.inspect_legacy(old,'old-demo');assert preview['supported']
    response=migration.migrate_legacy(old,new,'old-demo',preview['fingerprint']);target=new.project(response['hypit_project_id'])
    assert migration._inventory(source)==before
    assert (target/'.migration/original/chat.svml').read_text()==OLD
    assert (target/'chat.svrun').read_text().startswith('<?svml using="@hypit/markup/run@1"?>')
    assert (target/'chat.svs').read_text().splitlines()[1:]==RECIPE.splitlines()[1:]
    reused=response['receipt']['accepted_media'][0]
    assert (target/reused['path']).read_bytes()==(source/'exports/old.mp4').read_bytes()
    assert reused['reused_without_generation'] is True
    assert response['receipt']['source_check']=='pending' and response['receipt']['generation_submitted'] is False
    assert not (target/'.hypit/results').exists()
    assert json.loads((target/'.migration/job.json').read_text())['status']=='completed'


def test_custom_component_secret_profile_and_export_symlinks_need_explicit_adaptation(pair):
    old,new,source=pair
    activation=source/'packages/chat-scene/src/activation.ts';original=activation.read_text();activation.write_text(original+'\ncustom change')
    assert not migration.inspect_legacy(old,'old-demo')['supported'];activation.write_text(original)
    profile=source/'hypit.runtime.json';data=json.loads(profile.read_text());data['apiKey']='DO-NOT-RETURN-THIS';profile.write_text(json.dumps(data))
    result=migration.inspect_legacy(old,'old-demo');assert not result['supported'];assert 'DO-NOT-RETURN-THIS' not in json.dumps(result)
    del data['apiKey'];profile.write_text(json.dumps(data))
    (source/'exports/linked.mp4').symlink_to(source/'exports/old.mp4')
    assert not migration.inspect_legacy(old,'old-demo')['supported']
    assert list(new.project_root.iterdir())==[]


def test_changed_source_is_rejected_before_creating_copy(pair):
    old,new,source=pair;preview=migration.inspect_legacy(old,'old-demo')
    (source/'chat.svml').write_text(OLD.replace('My &amp; title','new title'))
    with pytest.raises(HypitRuntimeError,match='已变化'):migration.migrate_legacy(old,new,'old-demo',preview['fingerprint'])
    assert not list(new.project_root.iterdir())


def test_build_failure_keeps_partial_copy_and_marks_it_terminal(pair,monkeypatch):
    old,new,source=pair;before=migration._inventory(source)
    monkeypatch.setattr(migration,'_run_subprocess',lambda argv,**kw:CommandResult(tuple(argv),1,'private compiler output','private compiler output'))
    with pytest.raises(HypitRuntimeError,match='构建失败'):migration.migrate_legacy(old,new,'old-demo',migration.inspect_legacy(old,'old-demo')['fingerprint'])
    copies=list(new.project_root.iterdir());assert len(copies)==1
    state=(copies[0]/'.migration/job.json').read_text();assert json.loads(state)['status']=='failed';assert 'private compiler output' not in state
    assert migration._inventory(source)==before


def test_api_preview_copy_receipt_media_and_cross_origin_boundary(pair):
    old,new,source=pair;app=FastAPI();app.include_router(create_hypit_workbench_router(old.project_root,services={'0.2.12':old,'0.3.1':new}))
    with TestClient(app) as client:
        root='/model-api/hypit-v031'
        assert client.post(root+'/migration/inspect',json={'project_id':'../outside'}).status_code==422
        preview=client.post(root+'/migration/inspect',json={'project_id':'old-demo'}).json();assert preview['supported']
        assert client.post(root+'/migration/copy',json={'project_id':'old-demo','fingerprint':'0'*64}).status_code==422
        assert client.post(root+'/migration/copy',json={'project_id':'old-demo','fingerprint':preview['fingerprint']},headers={'Origin':'https://foreign.example'}).status_code==403
        response=client.post(root+'/migration/copy',json={'project_id':'old-demo','fingerprint':preview['fingerprint']});assert response.status_code==201
        pid=response.json()['hypit_project_id'];receipt=client.get(root+'/projects/'+pid+'/migration').json()
        assert receipt['original_unchanged'] and receipt['generation_submitted'] is False
        path=receipt['accepted_media'][0]['path'];media=client.get(root+'/projects/'+pid+'/files/'+path);assert media.content==(source/'exports/old.mp4').read_bytes()


def test_repeated_export_names_and_non_ascii_names_remain_distinct_and_playable_paths(pair):
    old,new,source=pair
    nested=source/'exports/nested';nested.mkdir()
    (nested/'old.mp4').write_bytes((source/'exports/old.mp4').read_bytes())
    (source/'exports/中文 : exported.mp4').write_bytes(b'other preserved export')
    result=migration.migrate_legacy(old,new,'old-demo',migration.inspect_legacy(old,'old-demo')['fingerprint'])
    outputs=result['receipt']['accepted_media'];assert len(outputs)==3
    assert len({row['path'] for row in outputs})==3
    assert all(':' not in row['path'] and len(Path(row['path']).name.encode())<255 for row in outputs)
    target=new.project(result['hypit_project_id'])
    for row in outputs:assert (target/row['path']).read_bytes()==(source/row['source_path']).read_bytes()
