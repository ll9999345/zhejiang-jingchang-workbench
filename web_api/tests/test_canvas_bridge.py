"""Real native Node API, isolated data, no model providers or cloud uploads."""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import time
import uuid
import wave

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from web_api.canvas_bridge import CanvasBridge, BridgeError, PushRequest, PullRequest, create_canvas_router, CANVAS_ROOT
from backlot.state import _scan_media

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6N1QAAAAASUVORK5CYII=')


@pytest.fixture(scope='module', params=['legacy', 'versioned'])
def engine(tmp_path_factory, request):
    if not shutil.which('node') or not (CANVAS_ROOT / 'node_modules').is_dir():
        pytest.skip('existing native canvas runtime is not installed')
    directory = tmp_path_factory.mktemp('canvas-native')
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    log = (directory / 'node.log').open('wb')
    process = subprocess.Popen([shutil.which('node'), 'server.mjs'], cwd=CANVAS_ROOT,
                               env={**os.environ, 'PORT': str(port), 'JINGCHANG_DATA_DIR': str(directory / 'data'),
                                    'JINGCHANG_NATIVE_MEDIA_MODE': request.param,
                                    'JINGCHANG_LLM_URL': '', 'JINGCHANG_LLM_MODEL': '',
                                    'NODE_OPTIONS': '--import ' + str(CANVAS_ROOT/'tests/helpers/local-network-only.mjs')},
                               stdout=log, stderr=subprocess.STDOUT)
    bridge = CanvasBridge(directory / 'projects', runtime=directory / 'bridge', port=port)
    try:
        for _ in range(60):
            if bridge.status()['ready']:
                break
            if process.poll() is not None:
                pytest.fail((directory / 'node.log').read_text()[:1000])
            time.sleep(.1)
        else:
            pytest.fail('isolated Node server not ready')
        yield port
    finally:
        process.terminate()
        process.wait(timeout=15)
        log.close()


@pytest.fixture
def fixture(tmp_path, engine):
    root = tmp_path / 'projects'
    project = root / 'demo'
    (project / 'artifacts').mkdir(parents=True)
    (project / 'assets/frames').mkdir(parents=True)
    (project / 'project.json').write_text(json.dumps({'title':'本机画布验证'}))
    (project / 'artifacts/script.json').write_text(json.dumps({'title':'杭州', 'sections':[{'text':'看见西湖的晨光'}]}))
    (project / 'artifacts/scene_plan.json').write_text(json.dumps({'scenes':[{'id':'shot-1','description':'湖面晨光','movement':'缓慢推进','start_seconds':0,'end_seconds':3}]}))
    (project / 'assets/frames/shot-1.png').write_bytes(PNG)
    with wave.open(str(project / 'assets/voice.wav'), 'wb') as audio:
        audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(16000); audio.writeframes(b'\0\0'*16000)
    bridge = CanvasBridge(root, runtime=tmp_path / 'bridge', port=engine)
    return bridge, project


def request(bridge, **extra):
    inventory = bridge.inventory('demo')
    return PushRequest(project_id='demo', confirm=True, source_revision=inventory['source_revision'],
                       files=[{'path':f['path'],'token':f['token']} for f in inventory['media']], **extra)


def before_files(project):
    return {p.relative_to(project).as_posix():p.read_bytes() for p in project.rglob('*') if p.is_file()}


def test_readonly_inventory_does_not_create_records(fixture):
    bridge, project = fixture
    before = before_files(project)
    data = bridge.inventory('demo')
    assert data['has_script'] and data['scene_count'] == 1 and len(data['media']) == 2
    assert data['link'] is None and not bridge.runtime.exists()
    assert bridge.outputs('demo') == {'assets': [], 'link': None}
    assert before_files(project) == before


def test_native_shared_browser_modules_are_served_as_javascript(engine):
    import http.client
    for name in ['native-prompt-core.js','native-loop-core.js','source-index-core.js']:
        conn=http.client.HTTPConnection('127.0.0.1',engine)
        conn.request('GET','/public/'+name)
        response=conn.getresponse()
        assert response.status==200
        assert response.getheader('Content-Type').startswith('text/javascript')
        assert b'export ' in response.read()
        conn.close()


def test_unreadable_image_does_not_hide_other_project_media(fixture):
    bridge, project = fixture
    invalid = project / 'assets/frames/broken.png'
    invalid.write_bytes(b'not an image')
    before = before_files(project)
    inventory = bridge.inventory('demo')
    assert inventory['media_skipped'] == 1
    assert len(inventory['media']) == 2
    assert invalid.relative_to(project).as_posix() not in [m['path'] for m in inventory['media']]
    assert before_files(project) == before


def test_real_import_roundtrip_and_repeat_preserve_user_edits(fixture):
    bridge, project = fixture
    before = before_files(project)
    body = request(bridge)
    result = bridge.push(body)
    assert result['added_nodes'] == 4 and result['media_count'] == 2
    cid = result['canvas_project_id']
    canvas = bridge.rpc('GET', '/api/projects/'+cid)
    assert len(canvas['edges']) == 2 and len(canvas['assets']) == 2
    assert canvas['shots'] == []  # Old callers have not opted into timeline edits.
    script = next(n for n in canvas['nodes'] if n['type'] == 'script')
    script['text'] = '用户在画布里的新编辑'
    original = next(n for n in canvas['nodes'] if n['type']=='image' and not n['assetId'])
    original['title'] = '原节点保留'
    bridge.rpc('PUT', '/api/projects/'+cid, canvas)
    again = bridge.push(body)
    assert again['added_nodes'] == 0
    latest = bridge.rpc('GET', '/api/projects/'+cid)
    assert next(n for n in latest['nodes'] if n['id']==script['id'])['text'] == script['text']
    assert next(n for n in latest['nodes'] if n['id']==original['id'])['title'] == '原节点保留'
    assert before_files(project) == before
    output = bridge.outputs('demo')['assets']
    imported = bridge.pull(PullRequest(project_id='demo',confirm=True,asset_ids=[a['id'] for a in output]))
    assert len(imported['assets']) == 2
    for item in imported['assets']:
        assert hashlib.sha256((project/item['path']).read_bytes()).hexdigest() == item['sha256']
    preserved = before_files(project)
    assert bridge.pull(PullRequest(project_id='demo',confirm=True,asset_ids=[a['id'] for a in output]))['assets'] == imported['assets']
    assert before_files(project) == preserved
    for path, content in before.items():
        assert (project/path).read_bytes() == content
    media = _scan_media(project)
    assert any(p.get('source')=='canvas' for p in media['snapshots'])
    assert any(p.get('source')=='canvas' for p in media['audio'])
    # A freshly constructed service recovers the same link without creation.
    restarted = CanvasBridge(bridge.root,runtime=bridge.runtime,port=bridge.port)
    assert restarted.open('demo')['canvas_project_id'] == cid


def test_updated_sources_append_versions_without_replacing_canvas_nodes(fixture):
    bridge, project = fixture
    first = bridge.push(request(bridge))
    cid = first['canvas_project_id']
    saved = bridge.rpc('GET','/api/projects/'+cid)
    old = [(n['id'],n['text']) for n in saved['nodes']]
    file = project/'artifacts/script.json'
    file.write_text(json.dumps({'title':'新版本','sections':[{'text':'改为古镇日暮'}]}))
    second = bridge.push(request(bridge))
    assert second['added_nodes'] == 1
    nodes = {n['id']:n for n in bridge.rpc('GET','/api/projects/'+cid)['nodes']}
    assert all(nodes[nid]['text']==text for nid,text in old)


def test_timeline_carries_exact_lengths_and_captions_and_preserves_edits(fixture):
    bridge, project = fixture
    scene_file = project/'artifacts/scene_plan.json'
    scene_file.write_text(json.dumps({'scenes':[
        {'id':'shot-1','description':'湖面晨光','start_seconds':0,'end_seconds':2.75,'script_section_id':'s1'},
        {'id':0,'description':'没有所选画面的镜头','start_seconds':2.75,'end_seconds':4,'script_section_id':'s2'}]}))
    (project/'artifacts/script.json').write_text(json.dumps({'sections':[
        {'id':'s1','text':'看见晨光'},{'id':'s2','text':'留一点想象'}]}))
    (project/'artifacts/asset_manifest.json').write_text(json.dumps({'assets':[
        {'scene_id':'shot-1','type':'narration','path':'assets/voice.wav'}]}))
    before = before_files(project)
    body = request(bridge,include_timeline=True)
    result = bridge.push(body)
    assert result['added_shots'] == 2 and result['unassigned_shots'] == 1
    route = '/api/projects/'+result['canvas_project_id']
    canvas = bridge.rpc('GET',route)
    shots = canvas['shots']
    assert [s['duration'] for s in shots] == [2.75,1.25]
    assert [s['dialogue'] for s in shots] == ['看见晨光','留一点想象']
    assert shots[0]['assetId'] and shots[0]['audioId']
    assert shots[0]['edit']['endMode'] == 'hold'
    assert shots[1]['assetId'] is None and shots[1]['workbenchSource']['sceneId'] == '0'
    shots[0].update(duration=1.5,dialogue='用户新字幕',edit={'sourceAudio':'mute'})
    canvas['shots'].reverse()
    bridge.rpc('PUT',route,canvas)
    edited = bridge.rpc('GET',route)['shots']
    # Source updates never replace, reorder or duplicate edited native shots.
    plan=json.loads(scene_file.read_text());plan['scenes'][0]['end_seconds']=2
    scene_file.write_text(json.dumps(plan))
    updated = request(bridge,include_timeline=True)
    again = bridge.push(updated)
    assert again['added_shots'] == 0 and again['preserved_shots'] == 2
    assert bridge.rpc('GET',route)['shots'] == edited
    for path, raw in before.items():
        if path!='artifacts/scene_plan.json':
            assert (project/path).read_bytes() == raw


def test_timeline_can_be_added_to_previously_imported_nodes_without_reupload(fixture):
    bridge, _ = fixture
    first = bridge.push(request(bridge))
    result = bridge.push(request(bridge,include_timeline=True))
    assert result['canvas_project_id'] == first['canvas_project_id']
    assert result['added_nodes'] == 0 and result['added_shots'] == 1
    canvas = bridge.rpc('GET','/api/projects/'+result['canvas_project_id'])
    assert len(canvas['assets']) == 2 and len(canvas['shots']) == 1
    assert bridge.push(request(bridge,include_timeline=True))['added_shots'] == 0


def test_ambiguous_images_are_not_automatically_assigned(fixture):
    bridge, project = fixture
    (project/'assets/takes').mkdir()
    (project/'assets/takes/shot-1.png').write_bytes(PNG)
    result = bridge.push(request(bridge,include_timeline=True))
    assert result['unassigned_shots'] == 1
    canvas = bridge.rpc('GET','/api/projects/'+result['canvas_project_id'])
    assert canvas['shots'][0]['assetId'] is None
    # A source manifest makes the explicit selected take unambiguous.
    data,_ = bridge.source_data('demo')
    data['image_manifest']={'images':[{'shot_id':'shot-1','path':'assets/takes/shot-1.png'}]}
    selected={p:{'asset':{'id':str(i),'type':'image/png'},'sha256':'actual'} for i,p in enumerate(['assets/frames/shot-1.png','assets/takes/shot-1.png'])}
    assert bridge.shot_media(data,'shot-1',selected) == ('1',None)
    data['image_manifest']['images'][0]['sha256']='outdated'
    # The outdated manifest cannot bind its file; the other explicitly selected
    # filename candidate remains available, but no stale asset is accepted.
    assert bridge.shot_media(data,'shot-1',selected) == ('0',None)


def test_only_selected_files_can_become_shot_media(fixture):
    bridge, _ = fixture
    imported = bridge.push(request(bridge))
    body = request(bridge,include_timeline=True)
    body.files=[]
    result = bridge.push(body)
    assert result['canvas_project_id']==imported['canvas_project_id']
    assert result['added_shots']==1 and result['unassigned_shots']==1
    # Existing library files are not silently selected by the bridge.
    assert bridge.rpc('GET','/api/projects/'+result['canvas_project_id'])['shots'][0]['assetId'] is None


def test_selected_shot_video_precedes_its_still_but_explicit_binding_wins(fixture):
    bridge,_=fixture
    data,_=bridge.source_data('demo')
    data['image_manifest']={'images':[{'shot_id':'shot-1','path':'assets/frames/shot-1.png'}]}
    selected={'assets/frames/shot-1.png':{'asset':{'id':'still','type':'image/png'},'sha256':'one'},
              'assets/video/shot-1.mp4':{'asset':{'id':'clip','type':'video/mp4'},'sha256':'two'}}
    assert bridge.shot_media(data,'shot-1',selected)==('clip',None)
    # The project's explicitly chosen take remains authoritative.
    data['asset_manifest']={'assets':[{'scene_id':'shot-1','path':'assets/frames/shot-1.png'}]}
    assert bridge.shot_media(data,'shot-1',selected)==('still',None)


@pytest.mark.parametrize('duration',[0,-1,601,float('nan'),'3',True])
def test_invalid_scene_lengths_reject_before_creating_or_copying(fixture,duration):
    bridge, project=fixture
    (project/'artifacts/scene_plan.json').write_text(json.dumps({'scenes':[{'id':'one','duration':duration}]}))
    with pytest.raises(BridgeError,match='时长'):
        bridge.push(request(bridge,include_timeline=True))
    assert not bridge.link_path('demo').exists()


def test_scene_cap_and_duplicate_ids_are_not_silently_truncated(fixture):
    bridge, project=fixture
    scene=project/'artifacts/scene_plan.json'
    for scenes,error in [([{'id':str(i),'duration':1} for i in range(201)],'最多'),([{'id':0},{'id':0}],'重复')]:
        scene.write_text(json.dumps({'scenes':scenes}))
        with pytest.raises(BridgeError,match=error):
            bridge.push(request(bridge,include_timeline=True))
        assert not bridge.link_path('demo').exists()


def test_timeline_cas_retry_preserves_concurrent_user_changes_and_does_not_reupload(fixture):
    bridge, _ = fixture
    original=bridge.rpc
    put_conflict,uploads=False,0
    def concurrent(method,route,*args,**kwargs):
        nonlocal put_conflict,uploads
        if method=='POST' and route.startswith('/api/assets/stream'):
            uploads+=1
        if method=='PUT' and route.startswith('/api/projects/') and not put_conflict:
            put_conflict=True
            canvas=original('GET',route)
            canvas['shots'].append({'id':'manual-shot','title':'手动镜头','description':'用户的编辑','duration':1})
            canvas['nodes'][0]['title']='并发改动保留'
            original('PUT',route,canvas)
        return original(method,route,*args,**kwargs)
    bridge.rpc=concurrent
    result=bridge.push(request(bridge,include_timeline=True))
    assert result['added_shots']==1 and uploads==2
    canvas=original('GET','/api/projects/'+result['canvas_project_id'])
    assert canvas['shots'][0]['id']=='manual-shot' and len(canvas['shots'])==2
    assert canvas['nodes'][0]['title']=='并发改动保留'


def test_source_manifest_change_invalidates_saved_selection(fixture):
    bridge, project=fixture
    body=request(bridge,include_timeline=True)
    (project/'artifacts/image_manifest.json').write_text(json.dumps({'images':[]}))
    with pytest.raises(BridgeError,match='已更新'):
        bridge.push(body)
    assert not bridge.link_path('demo').exists()


def test_import_edit_actual_mp4_export_and_return_are_connected(fixture):
    """Real FFmpeg and native jobs, not a claimed export from a mock response."""
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        pytest.skip('local FFmpeg tools are not installed')
    from PIL import Image
    bridge, project=fixture
    Image.new('RGB',(320,180),'#174b45').save(project/'assets/frames/shot-1.png')
    (project/'artifacts/scene_plan.json').write_text(json.dumps({'scenes':[
        {'id':'shot-1','description':'本机剪辑验收','duration':1.25,'script_section_id':'s1'}]}))
    (project/'artifacts/script.json').write_text(json.dumps({'sections':[{'id':'s1','text':'中文字幕 · 画布与工作台'}]}))
    (project/'artifacts/asset_manifest.json').write_text(json.dumps({'assets':[
        {'scene_id':'shot-1','type':'narration','path':'assets/voice.wav'}]}))
    original=before_files(project)
    result=bridge.push(request(bridge,include_timeline=True))
    route='/api/projects/'+result['canvas_project_id']
    canvas=bridge.rpc('GET',route)
    canvas['shots'][0]['duration']=.75
    canvas['shots'][0]['edit'].update(voiceOffset=.1,voiceVolume=.6,fadeIn=.05,fadeOut=.05)
    canvas['settings']['edit']={'burnSubtitles':True,'subtitle':{'fontSize':36},'music':[
        {'id':'test-music','assetId':canvas['shots'][0]['audioId'],'duration':.75,'volume':.2,'loop':True}]}
    canvas=bridge.rpc('PUT',route,canvas)
    plan=bridge.rpc('GET',route+'/render-plan')
    assert plan['duration']==.75 and plan['burnSubtitles'] and plan['shots'][0]['subtitle']=='中文字幕 · 画布与工作台'
    body={'requestId':str(uuid.uuid4()),'revision':canvas['revision']}
    job=bridge.rpc('POST',route+'/render',body)
    assert bridge.rpc('POST',route+'/render',body)['id']==job['id']
    deadline=time.monotonic()+45
    while time.monotonic()<deadline:
        job=bridge.rpc('GET','/api/jobs/'+job['id'])
        if job['status'] in {'completed','failed','cancelled','interrupted'}:
            break
        time.sleep(.05)
    assert job['status']=='completed',job.get('message')
    bridge.rpc('POST',route+'/render-apply',{'jobId':job['id'],'revision':canvas['revision']})
    output=next(a for a in bridge.outputs('demo')['assets'] if a['type'].startswith('video/'))
    pulled=bridge.pull(PullRequest(project_id='demo',confirm=True,asset_ids=[output['id']]))
    target=project/pulled['assets'][0]['path']
    probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(target)]))
    assert {s['codec_type'] for s in probe['streams']}=={'video','audio'}
    assert abs(float(probe['format']['duration'])-.75)<.1
    assert hashlib.sha256(target.read_bytes()).hexdigest()==pulled['assets'][0]['sha256']
    assert any(m['source']=='canvas' and m['path']==pulled['assets'][0]['path'] for m in _scan_media(project)['renders'])
    for path,raw in original.items():
        assert (project/path).read_bytes()==raw
    # Returning a produced video again does not create a second copy.
    assert bridge.pull(PullRequest(project_id='demo',confirm=True,asset_ids=[output['id']]))['assets']==pulled['assets']


def test_stale_source_and_changed_file_reject_before_creating_link(fixture):
    bridge, project = fixture
    existing_projects = bridge.rpc('GET', '/api/projects')
    body = request(bridge)
    (project/'project.json').write_text('{"title":"new"}')
    with pytest.raises(BridgeError,match='已更新'):
        bridge.push(body)
    assert not bridge.link_path('demo').exists()
    assert bridge.rpc('GET', '/api/projects') == existing_projects
    body = request(bridge)
    (project/'assets/frames/shot-1.png').write_bytes(PNG+b'changed')
    with pytest.raises(BridgeError,match='已变化'):
        bridge.push(body)
    assert not bridge.link_path('demo').exists()


@pytest.mark.parametrize('path',['../project.json','/tmp/image.png','artifacts/script.json'])
def test_path_traversal_and_nonmedia_blocked(fixture,path):
    bridge,_ = fixture
    with pytest.raises(BridgeError):
        bridge.media_file('demo',path)


def test_symlink_media_cannot_escape_project(fixture,tmp_path):
    bridge,project = fixture
    external=tmp_path/'outside.png'; external.write_bytes(PNG)
    (project/'assets/outside.png').symlink_to(external)
    assert not any(m['path']=='assets/outside.png' for m in bridge.inventory('demo')['media'])


def test_jpeg_bytes_named_png_are_copied_without_renaming_original(fixture):
    from PIL import Image
    bridge, project = fixture
    source = project/'assets/frames/shot-1.png'
    Image.new('RGB',(8,8),'green').save(source,format='JPEG')
    original = source.read_bytes()
    inventory = bridge.inventory('demo')
    assert next(m for m in inventory['media'] if m['path'].endswith('shot-1.png'))['type']=='image/jpeg'
    bridge.push(request(bridge))
    outputs = bridge.outputs('demo')['assets']
    copied = next(a for a in outputs if a['name']=='shot-1.png')
    assert copied['type']=='image/jpeg' and source.read_bytes()==original
    result = bridge.pull(PullRequest(project_id='demo',asset_ids=[copied['id']],confirm=True))
    assert result['assets'][0]['path'].endswith('.jpg')
    assert (project/result['assets'][0]['path']).read_bytes()==original


def test_pull_cannot_access_another_project_or_overwrite_changed_copy(fixture):
    bridge,project = fixture
    bridge.push(request(bridge))
    with pytest.raises(BridgeError,match='不属于'):
        bridge.pull(PullRequest(project_id='demo',asset_ids=[str(uuid.uuid4())],confirm=True))
    aid=bridge.outputs('demo')['assets'][0]['id']
    output=bridge.pull(PullRequest(project_id='demo',asset_ids=[aid],confirm=True))
    target=project/output['assets'][0]['path'];target.write_bytes(b'edited original stays')
    with pytest.raises(BridgeError,match='被修改'):
        bridge.pull(PullRequest(project_id='demo',asset_ids=[aid],confirm=True))
    assert target.read_bytes()==b'edited original stays'


def test_accepted_creation_with_lost_pointer_is_recovered_once(fixture):
    bridge,_ = fixture
    original=bridge.rpc
    def lost(method,route,*args,**kwargs):
        value=original(method,route,*args,**kwargs)
        if method=='POST' and route=='/api/projects':
            raise BridgeError('reply lost',503)
        return value
    bridge.rpc=lost
    with pytest.raises(BridgeError,match='reply lost'):
        bridge.open('demo')
    bridge.rpc=original
    link=bridge.read_link('demo')
    reopened=bridge.open('demo')
    assert len([p for p in bridge.rpc('GET','/api/projects') if p['name']==link['name']])==1
    assert reopened['canvas_project_id']


def test_api_confirmation_origin_and_closed_schema(fixture):
    bridge,_ = fixture
    app=FastAPI();app.include_router(create_canvas_router(bridge.root,runtime=bridge.runtime,port=bridge.port))
    client=TestClient(app)
    assert client.get('/model-api/canvas/projects/demo').status_code==200
    assert client.post('/model-api/canvas/open',json={'project_id':'demo'}).status_code==422
    assert client.post('/model-api/canvas/open',json={'project_id':'demo','confirm':True},headers={'origin':'https://untrusted.example'}).status_code==403
    assert client.post('/model-api/canvas/open',json={'project_id':'demo','confirm':True,'url':'https://evil'}).status_code==422
    assert not bridge.runtime.exists()


def footage_cut_fixture(bridge, project, options_override=None):
    """Actual local film with two trims, voice, subtitles and generated music."""
    from web_api.footage_pipeline import FootageJobs, FootageRequest, write_json
    from web_api.tests.test_footage_pipeline import Deferred
    source=project/'assets/footage/imports/real-local-fixture.mp4'
    source.parent.mkdir(parents=True)
    subprocess.run(['ffmpeg','-v','error','-n','-f','lavfi','-i','testsrc2=size=160x90:rate=24',
                    '-t','5','-c:v','libx264','-pix_fmt','yuv420p',str(source)],check=True,capture_output=True)
    # A tone is deliberately a synthetic acceptance voice, not a real narrator.
    voice=project/'assets/footage/imports/test-voice.wav'
    subprocess.run(['ffmpeg','-v','error','-n','-f','lavfi','-i','sine=frequency=330:sample_rate=24000',
                    '-t','3',str(voice)],check=True,capture_output=True)
    executor=Deferred();jobs=FootageJobs(project.parent,executor=executor)
    request=FootageRequest(project_id='demo',action='render',material_mode='local',
        shots=[{'id':'one','text':'真实选片入画布','source_path':source.relative_to(project).as_posix(),'start_seconds':.5,'duration_seconds':1.5},
               {'id':'two','text':'音乐与旁白保留','source_path':source.relative_to(project).as_posix(),'start_seconds':2,'duration_seconds':1.5}],
        options={'narration':'uploaded','audio_path':voice.relative_to(project).as_posix(),'bgm_mode':'local',
                 'bgm_style':'guofeng_ambient','resolution':480,'transition':'cut','fit':'crop','fps':24,'bgm_volume':.12,
                 **(options_override or {})})
    state=jobs.submit(request);executor.run();done=jobs.get('demo',state['job_id'])
    assert done['status']=='completed',done['message']
    assert done['music']['provider']['provider']=='local_synthesis'
    assert done['music']['paid_calls']==0 and done['outputs'][0]['canvas_cut_path']
    cut_id=done['job_id'];inventory=bridge.inventory('demo',cut_id,1)
    body=PushRequest(project_id='demo',cut_id=cut_id,cut_version=1,confirm=True,
        source_revision=inventory['source_revision'],include_timeline=True,
        files=[{'path':f['path'],'token':f['token']} for f in inventory['media']])
    return done,inventory,body


def test_fine_subtitles_transitions_and_ducking_survive_real_cut_handoff_and_export(fixture):
    import urllib.request
    bridge, project = fixture
    srt = project / 'fine-captions.srt'
    original_srt = '1\n00:00:00,150 --> 00:00:00,650\n第一句\n\n2\n00:00:00,800 --> 00:00:01,800\n跨镜的第二句\n\n3\n00:00:02,000 --> 00:00:02,700\n第三句\n'
    srt.write_text(original_srt, encoding='utf-8')
    done, inventory, body = footage_cut_fixture(bridge, project, {
        'subtitle_path': 'fine-captions.srt', 'transition': 'crossfade', 'transition_seconds': .35,
        'duck_bgm': True, 'subtitles': {'font_size': 30, 'outline_color': '#106040', 'position': 'top'}})
    original = before_files(project)
    pushed = bridge.push(body)
    route = '/api/projects/' + pushed['canvas_project_id']
    native = bridge.rpc('GET', route)
    assert native['shots'][0]['edit']['subtitleCues'] == [
        {'start': .15, 'end': .65, 'text': '第一句'}, {'start': .8, 'end': 1.5, 'text': '跨镜的第二句'}]
    assert native['shots'][1]['edit']['subtitleCues'] == [
        {'start': 0, 'end': .3, 'text': '跨镜的第二句'}, {'start': .5, 'end': 1.2, 'text': '第三句'}]
    edit = native['settings']['edit']
    assert edit['transition'] == {'mode': 'crossfade', 'seconds': .35} and edit['duckMusic'] is True
    assert edit['subtitle']['fontSize'] == 45 and edit['subtitle']['position'] == 'top'
    assert edit['subtitle']['outlineColor'] == '#106040'
    assert edit['music'][0]['fadeOut'] == 1
    plan = bridge.rpc('GET', route + '/render-plan')
    assert plan['subtitleCount'] == 4 and plan['duration'] == 3 and plan['duckMusic']
    job = bridge.rpc('POST', route + '/render', {'requestId': str(uuid.uuid4()), 'revision': native['revision']})
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        job = bridge.rpc('GET', '/api/jobs/' + job['id'])
        if job['status'] in {'completed', 'failed', 'cancelled', 'interrupted'}:
            break
        time.sleep(.1)
    assert job['status'] == 'completed', job.get('message')
    assert job['result']['transition']['mode'] == 'crossfade'
    assert job['result']['subtitleCount'] == 4 and job['result']['duckMusic']
    with urllib.request.urlopen(f'http://127.0.0.1:{bridge.port}' + job['result']['subtitleUrl']) as response:
        exported = response.read().decode('utf-8')
    assert '00:00:00,150 --> 00:00:00,650' in exported
    assert '00:00:01,500 --> 00:00:01,800' in exported
    assert '00:00:02,000 --> 00:00:02,700' in exported
    assert srt.read_text() == original_srt
    native['shots'][0]['edit']['subtitleCues'][0]['text'] = '用户修改后的逐句字幕'
    native['settings']['edit']['transition']['mode'] = 'cut'
    native['settings']['edit']['duckMusic'] = False
    bridge.rpc('PUT', route, native)
    assert bridge.push(body)['added_shots'] == 0
    latest = bridge.rpc('GET', route)
    assert latest['shots'][0]['edit']['subtitleCues'][0]['text'] == '用户修改后的逐句字幕'
    assert latest['settings']['edit']['transition']['mode'] == 'cut'
    assert latest['settings']['edit']['duckMusic'] is False
    for path, raw in original.items():
        assert (project / path).read_bytes() == raw


def test_real_footage_music_to_canvas_render_and_return_preserves_both_originals(fixture):
    bridge,project=fixture
    original_canvas=bridge.push(request(bridge,include_timeline=True))
    original_native=bridge.rpc('GET','/api/projects/'+original_canvas['canvas_project_id'])
    done,inventory,body=footage_cut_fixture(bridge,project)
    original=before_files(project)
    assert inventory['scene_count']==2 and len(inventory['media'])==3
    assert inventory['link'] is None
    pushed=bridge.push(body)
    assert pushed['added_shots']==2 and pushed['unassigned_shots']==0
    cid=pushed['canvas_project_id'];assert cid!=original_canvas['canvas_project_id']
    route='/api/projects/'+cid;native=bridge.rpc('GET',route)
    assert [s['duration'] for s in native['shots']]==[1.5,1.5]
    assert [s['edit']['sourceStart'] for s in native['shots']]==[.5,2]
    assert [s['edit']['sourceEnd'] for s in native['shots']]==[2,3.5]
    assert [s['edit']['voiceStart'] for s in native['shots']]==[0,1.5]
    assert native['shots'][0]['audioId']==native['shots'][1]['audioId']
    assert all(s['edit']['fit']=='cover' for s in native['shots'])
    assert native['settings']['edit']['music'][0]['volume']==.12
    plan=bridge.rpc('GET',route+'/render-plan')
    assert plan['duration']==3 and len(plan['music'])==1 and plan['burnSubtitles']
    job=bridge.rpc('POST',route+'/render',{'requestId':str(uuid.uuid4()),'revision':native['revision']})
    deadline=time.monotonic()+45
    while time.monotonic()<deadline:
        job=bridge.rpc('GET','/api/jobs/'+job['id'])
        if job['status'] in {'completed','failed','cancelled','interrupted'}:break
        time.sleep(.1)
    assert job['status']=='completed',job.get('message')
    bridge.rpc('POST',route+'/render-apply',{'jobId':job['id'],'revision':native['revision']})
    output=next(a for a in bridge.outputs('demo',body.cut_id,1)['assets'] if a['name'].endswith('.mp4') and a['name']!='real-local-fixture.mp4')
    returned=bridge.pull(PullRequest(project_id='demo',cut_id=body.cut_id,confirm=True,asset_ids=[output['id']]))
    target=project/returned['assets'][0]['path']
    info=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(target)]))
    assert {s['codec_type'] for s in info['streams']}=={'video','audio'}
    assert abs(float(info['format']['duration'])-3)<.12
    for path,raw in original.items():assert (project/path).read_bytes()==raw
    assert bridge.rpc('GET','/api/projects/'+original_canvas['canvas_project_id'])==original_native
    # Re-import must not replace the user's later trim, text or music gain.
    native=bridge.rpc('GET',route);native['shots'][0]['edit']['sourceStart']=.75
    native['shots'][0]['dialogue']='画布里的手动修改';native['settings']['edit']['music'][0]['volume']=.07
    bridge.rpc('PUT',route,native)
    again=bridge.push(body);assert again['added_shots']==0
    latest=bridge.rpc('GET',route)
    assert latest['shots'][0]['edit']['sourceStart']==.75 and latest['shots'][0]['dialogue']=='画布里的手动修改'
    assert latest['settings']['edit']['music'][0]['volume']==.07


def test_footage_source_fingerprints_and_version_scope_are_checked_before_copy(fixture):
    bridge,project=fixture
    done,inventory,body=footage_cut_fixture(bridge,project)
    existing=bridge.rpc('GET','/api/projects')
    source=project/'assets/footage/imports/real-local-fixture.mp4'
    with source.open('ab') as stream:stream.write(b'changed source')
    with pytest.raises(BridgeError,match='媒体已变化'):bridge.push(body)
    assert not bridge.link_path('demo',body.cut_id,1).exists()
    assert bridge.rpc('GET','/api/projects')==existing
    with pytest.raises(BridgeError):bridge.inventory('demo','../private',1)
    with pytest.raises(BridgeError):bridge.inventory('demo',body.cut_id,6)
    with pytest.raises(BridgeError):bridge.inventory('demo',body.cut_id,2)


def test_slow_local_assistant_configuration_does_not_report_canvas_disconnected(tmp_path):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    import threading

    class DelayedHealth(BaseHTTPRequestHandler):
        def do_GET(self):
            assert self.path == '/api/health'
            time.sleep(2.2)  # Real local helper cold starts can exceed 2 seconds.
            raw = json.dumps({'ok': True, 'version': 'local-protocol-test',
                              'agentConfigured': True}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), DelayedHealth)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        bridge = CanvasBridge(tmp_path/'projects', runtime=tmp_path/'bridge', port=server.server_port)
        status = bridge.status()
        assert status['ready'] and status['agent_configured']
        assert status['version'] == 'local-protocol-test'
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)


def test_auto_local_intent_selection_survives_actual_handoff_edit_export_and_return(fixture):
    """Two synthetic colors distinguish the actual sources, never a scenic claim."""
    from web_api.footage_pipeline import FootageJobs, FootageRequest, read_json, write_json
    bridge, project = fixture
    imports = project/'assets/footage/imports'; imports.mkdir(parents=True, exist_ok=True)
    files = []
    for name, color, label in [('01', 'red', '云海 · 合成红色测试'), ('02', 'blue', '森林 · 合成蓝色测试')]:
        file = imports/(name+'.mp4')
        subprocess.run(['ffmpeg','-v','error','-n','-f','lavfi','-i',f'color={color}:s=320x180:r=24:d=3',
                        '-c:v','libx264','-threads','2','-pix_fmt','yuv420p',str(file)], check=True, capture_output=True)
        write_json(file.with_suffix('.json'), {'label': label, 'origin': 'local'})
        files.append(file)
    originals = before_files(project)
    class Deferred:
        def submit(self, fn, *args): self.work = (fn, args)
        def run(self): self.work[0](*self.work[1])
    executor = Deferred()
    def no_search(*args, **kwargs): pytest.fail('local automatic selection must not search remote sources')
    manager = FootageJobs(project.parent, executor=executor, search=no_search)
    queued = manager.submit(FootageRequest(project_id='demo', topic='合成测试 · 云海与普通风光',
        action='create', material_mode='local', shots=[
            {'id':'intent','title':'云海','text':'云海','duration_seconds':1},
            {'id':'neutral','title':'普通风光','text':'风光','duration_seconds':1}],
        options={'narration':'none','resolution':480,'transition':'cut','subtitles':{'enabled':False}}))
    executor.run(); done = manager.get('demo', queued['job_id'])
    assert done['status'] == 'completed', done.get('message')
    assert [s['source_path'] for s in done['shots']] == [p.relative_to(project).as_posix() for p in files]
    assert len({s['selected_source']['asset_key'] for s in done['shots']}) == 2
    assert all(not s['selected_source']['location_verified'] for s in done['shots'])
    output = done['outputs'][0]
    inventory = bridge.inventory('demo', queued['job_id'], 1)
    body = PushRequest(project_id='demo',cut_id=queued['job_id'],cut_version=1,confirm=True,
        source_revision=inventory['source_revision'],include_script=True,include_scenes=True,include_timeline=True,
        files=[{'path':f['path'],'token':f['token']} for f in inventory['media']])
    pushed = bridge.push(body); route = '/api/projects/'+pushed['canvas_project_id']
    native = bridge.rpc('GET', route)
    assert pushed['added_shots'] == 2 and len({s['assetId'] for s in native['shots']}) == 2
    native['shots'][0]['duration'] = .75
    for cue in native['shots'][0]['edit'].get('subtitleCues', []):
        cue['end'] = min(cue['end'], .75)
    native['settings']['edit']['burnSubtitles'] = False
    native = bridge.rpc('PUT', route, native)
    job = bridge.rpc('POST', route+'/render', {'requestId':str(uuid.uuid4()),'revision':native['revision']})
    deadline = time.monotonic()+45
    while time.monotonic() < deadline:
        job = bridge.rpc('GET','/api/jobs/'+job['id'])
        if job['status'] in {'completed','failed','cancelled','interrupted'}: break
        time.sleep(.05)
    assert job['status'] == 'completed', job.get('message')
    bridge.rpc('POST',route+'/render-apply',{'jobId':job['id'],'revision':native['revision']})
    assets = bridge.outputs('demo',queued['job_id'],1)['assets']
    exported_id = bridge.rpc('GET','/api/jobs/'+job['id'])['assetId']
    exported = next(a for a in assets if a['id'] == exported_id)
    pulled = bridge.pull(PullRequest(project_id='demo',cut_id=queued['job_id'],confirm=True,asset_ids=[exported['id']]))
    target = project/pulled['assets'][0]['path']
    def pixel(file, second):
        raw = subprocess.check_output(['ffmpeg','-v','error','-ss',str(second),'-i',str(file),
            '-frames:v','1','-vf','scale=1:1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'])
        return tuple(raw)
    for film, second in [(project/output['output_path'],1.3),(target,1.1)]:
        red, blue = pixel(film,.2), pixel(film,second)
        assert red[0] > red[2]+100 and blue[2] > blue[0]+100
    info = json.loads(subprocess.check_output(['ffprobe','-v','error','-show_format','-of','json',str(target)]))
    assert abs(float(info['format']['duration'])-1.75) < .1
    for path, raw in originals.items(): assert (project/path).read_bytes() == raw
    print('Actual auto-selected two-source film and edited return:', target)
