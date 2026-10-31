"""Offline regression fixtures; no user projects or provider requests."""
from copy import deepcopy
import threading

import pytest

from web_api.footage_selection import assign_automatic, asset_key, deduplicate_records
from web_api.footage_pipeline import (FootageJobs, FootageRequest, _queries,
    candidate_matches_query, plan_footage, write_json, read_json)


def clip(name, duration=12, tags='Sanqing mountain', **extra):
    return dict(path=f'assets/{name}.mp4', source='wikimedia', clip_id='wikimedia_'+name,
                source_url=f'https://commons.wikimedia.org/wiki/File:{name}.mp4',
                source_tags=tags, duration=duration, license='CC BY-SA 3.0',
                match_kind='place_candidate', **extra)


def shot(name, candidates, duration=4, text=''):
    return dict(id=name, source_path='', start_seconds=0, duration_seconds=duration,
                title=name, text=text, candidates=deepcopy(candidates))


def test_queries_retain_location_and_differ_by_shot_intent():
    cloud = _queries('三清山', '云海在峰林中翻涌')
    trees = _queries('三清山', '森林里的树叶')
    assert cloud[0] == {'text': '三清山', 'kind': 'place'}
    assert 'Mount Sanqing cloud mist' in [q['text'] for q in cloud]
    assert 'Mount Sanqing forest' in [q['text'] for q in trees]
    assert 'Mount Sanqing forest' not in [q['text'] for q in cloud]
    assert all('Sanqing' in q['text'] or '三清山' in q['text']
               for q in cloud if q['kind'] != 'generic')
    assert _queries('三清山', '湖面', 'lake')[0]['text'] == '三清山 lake'


@pytest.mark.parametrize('tags,query,expected', [
    ('Sanqing Shan clouds', 'Mount Sanqing cloud mist', True),
    ('Sanqing forest', '三清山 森林', True),
    ('lake mountain forest', 'Mount Sanqing', False),
    ('Nanbei Lake sunset', '三清山 湖面', False),
    ('Sanqing mountain', '三清山 云海', False),
    ('Sanqing mountain', 'Mount Sanqing', True),
    ('Sanqing mountain', 'Mount Sanqing restaurant', False),
    ('Sanqing restaurant interior', 'Mount Sanqing restaurant', True),
    ('Linux filesystem mount', 'Mount Sanqing', False),
])
def test_metadata_gate_never_uses_input_query_as_location_proof(tags, query, expected):
    assert candidate_matches_query({'source_tags': tags, 'query': query}, query) is expected


def test_global_assignment_preserves_constrained_shots_unique_option():
    a, b = clip('a'), clip('b')
    rows = [shot('flexible', [a, b]), shot('constrained', [a])]
    receipt = assign_automatic(rows)
    assert [s['source_path'] for s in rows] == [b['path'], a['path']]
    assert receipt['missing_shots'] == []
    assert len({asset_key(s['selected_source']) for s in rows}) == 2


def test_metadata_affinity_selects_distinct_cloud_and_forest_assets():
    cloud, forest = clip('cloud', tags='Sanqing clouds mist'), clip('forest', tags='Sanqing forest trees')
    rows = [shot('cloud-shot', [forest, cloud], text='云海'),
            shot('forest-shot', [cloud, forest], text='森林')]
    assign_automatic(rows)
    assert [s['source_path'] for s in rows] == [cloud['path'], forest['path']]


def test_duplicate_download_paths_are_one_asset_and_reuse_is_bounded():
    original = clip('same', duration=8)
    alias = dict(original, path='assets/other-job/same.mp4')
    assert len(deduplicate_records([original, alias])) == 1
    rows = [shot(str(i), [original, alias]) for i in range(3)]
    receipt = assign_automatic(rows)
    assert [s['start_seconds'] for s in rows[:2]] == [0, 4]
    assert rows[2]['source_path'] == ''
    assert receipt['unique_assets_available'] == 1
    assert receipt['missing_shots'] == ['2']
    assert receipt['reused_source_shots'] == ['1']
    assert any('只有 1 个' in w for w in receipt['warnings'])
    assert all(s['start_seconds'] + s['duration_seconds'] <= s['selected_source']['duration']
               for s in rows if s['source_path'])


def test_source_identity_and_same_page_aliases_cannot_be_counted_as_new_assets():
    original=clip('same',duration=8,source_id='original-id')
    another_url=dict(original,path='assets/different.mp4',source_url='https://example.test/another-url')
    same_page_other_id=dict(original,path='assets/third.mp4',clip_id='wikimedia_alias',source_id='alias-id')
    unique=deduplicate_records([original,another_url,same_page_other_id])
    assert len(unique)==1
    rows=[shot('one',[original]),shot('two',[another_url]),shot('three',[same_page_other_id])]
    result=assign_automatic(rows)
    assert result['unique_assets_available']==1
    assert result['missing_shots']==['three']
    assert [s['start_seconds'] for s in rows[:2]]==[0,4]


def test_manual_unknown_and_locked_selections_are_preserved_and_reserve_ranges():
    a = clip('same', duration=12)
    manual = dict(shot('manual', [a], duration=4), source_path=a['path'], start_seconds=1,
                  selected_source=deepcopy(a))
    locked = dict(shot('locked', []), source_locked=True)
    before = deepcopy([manual, locked])
    rows = [manual, locked, shot('auto', [a], duration=4)]
    assign_automatic(rows)
    assert rows[:2] == before
    assert rows[2]['start_seconds'] == 5


def test_fractional_manual_range_does_not_round_cut_in_beyond_source_duration():
    c=clip('fraction',duration=10.66665)
    manual=dict(shot('manual',[c],duration=2),source_path=c['path'],start_seconds=1.33335,selected_source=c)
    rows=[manual,shot('auto',[c],duration=7.3333)]
    result=assign_automatic(rows)
    assert result['missing_shots']==[]
    assert rows[1]['start_seconds']==pytest.approx(3.33335)
    assert rows[1]['start_seconds']+rows[1]['duration_seconds']<=c['duration']


@pytest.mark.parametrize('candidate', [clip('short', duration=3), clip('unknown', duration=0),
                                       clip('bad', duration=float('nan')),
                                       dict(clip('nd'), license='CC BY-ND 4.0')])
def test_unusable_candidates_leave_missing_instead_of_looping(candidate):
    rows = [shot('one', [candidate], duration=5)]
    assert assign_automatic(rows)['missing_shots'] == ['one']
    assert rows[0]['source_path'] == ''


def test_same_still_cannot_be_disguised_as_different_temporal_segments():
    still = dict(clip('photo'), path='assets/photo.jpg')
    rows = [shot('one', [still]), shot('two', [still])]
    assert assign_automatic(rows)['missing_shots'] == ['two']


@pytest.fixture
def project(tmp_path):
    p = tmp_path/'demo'
    write_json(p/'artifacts/workflow_state.json', {'prompt':'三清山', 'storyboard':{'shots':[
        {'id':'cloud', 'title':'云海', 'narration':'三清山云海', 'duration_seconds':4},
        {'id':'forest', 'title':'森林', 'narration':'三清山树林', 'duration_seconds':4},
        {'id':'rocks', 'title':'峰林', 'narration':'三清山岩峰', 'duration_seconds':4}]}})
    for name in ('old','cloud','forest','rocks','unrelated'):
        target=p/f'assets/{name}.mp4';target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(b'fixture')
    old=clip('old',tags='Sanqing mountain')
    write_json(p/'artifacts/stock_search_manifest.json',{'clips':[old]})
    return p


def collect(project, monkeypatch, search, request=None):
    monkeypatch.setattr('web_api.footage_pipeline.probe',lambda p:{'duration':12,'width':1920,'height':1080,'has_video':True})
    request=request or FootageRequest(project_id='demo',action='collect',sources=['wikimedia'],confirm_network=True)
    manager=FootageJobs(project.parent,search=search)
    monkeypatch.setattr(manager,'update',lambda *a,**k:None)
    plan=plan_footage(project.parent,request)
    warnings=[]
    manager._collect(request,plan,'footage-'+'a'*24,threading.Event(),warnings)
    return plan,warnings


def test_existing_one_clip_does_not_suppress_intent_search_and_enough_assets_diversify(project, monkeypatch):
    calls=[]
    def search(data):
        calls.append(data)
        records=[clip('cloud',tags='Sanqing clouds mist'),clip('forest',tags='Sanqing forest trees'),clip('rocks',tags='Sanqing peaks granite')]
        return {'clips':[dict(c,path=str(project/c['path'])) for c in records]}
    plan,warnings=collect(project,monkeypatch,search)
    assert calls
    assert calls[0]['queries'][0]['query'] != '三清山'
    assert 'wikimedia_old' in calls[0]['exclude_clip_ids']
    assert calls[0]['metadata_groups'][0]
    assert len({asset_key(s['selected_source']) for s in plan['shots']})==3
    assert [s['selected_source']['clip_id'] for s in plan['shots']]==['wikimedia_cloud','wikimedia_forest','wikimedia_rocks']
    assert all(s['selection_mode']=='auto' and not s['selected_source']['location_verified'] for s in plan['shots'])
    manifest=read_json(project/'artifacts/footage_jobs'/('footage-'+'a'*24)/'stock_manifest.json')
    assert manifest['assignment']['missing_shots']==[]


def test_unrelated_returned_footage_cannot_fill_place_shots(project, monkeypatch):
    (project/'artifacts/stock_search_manifest.json').write_text('{"clips":[]}',encoding='utf8')
    def search(data):
        c=clip('unrelated',tags='beautiful lake mountain forest')
        return {'clips':[dict(c,path=str(project/c['path']))]}
    plan,warnings=collect(project,monkeypatch,search)
    assert all(not s['source_path'] for s in plan['shots'])
    assert plan['material_assignment']['missing_shots']==['cloud','forest','rocks']
    assert any('无关画面' in w for w in warnings)


def test_non_derivative_old_candidate_does_not_suppress_search(project,monkeypatch):
    write_json(project/'artifacts/stock_search_manifest.json',{'clips':[dict(clip('old'),license='CC BY-ND 4.0')]})
    calls=[]
    def search(data):
        calls.append(data)
        return {'clips':[dict(clip('cloud',tags='Sanqing clouds'),path=str(project/'assets/cloud.mp4'))]}
    request=FootageRequest(project_id='demo',action='collect',sources=['wikimedia'],confirm_network=True,
        shots=[{'id':'one','text':'三清山','duration_seconds':4}])
    plan,_=collect(project,monkeypatch,search,request)
    assert calls and plan['shots'][0]['selected_source']['clip_id']=='wikimedia_cloud'


def test_collect_does_not_overwrite_explicit_manual_or_locked_material(project, monkeypatch):
    request=FootageRequest(project_id='demo',action='collect',sources=['wikimedia'],confirm_network=True,
        shots=[{'id':'cloud','source_path':'assets/old.mp4','start_seconds':2,'duration_seconds':4},
               {'id':'forest','source_path':'assets/forest.mp4','start_seconds':3,'duration_seconds':4,
                'selection_mode':'auto','source_locked':True}])
    def forbidden(data):
        pytest.fail('protected shots must not trigger search')
    plan,_=collect(project,monkeypatch,forbidden,request)
    assert [(s['source_path'],s['start_seconds']) for s in plan['shots']]==[('assets/old.mp4',2),('assets/forest.mp4',3)]


class Deferred:
    def submit(self, fn, *args):self.task=(fn,args)
    def run(self):self.task[0](*self.task[1])


def test_measured_narration_cannot_make_auto_segments_exceed_source(project,monkeypatch):
    monkeypatch.setattr('web_api.footage_pipeline.probe',lambda p:{'duration':12,'width':1920,'height':1080,'has_video':True})
    executor=Deferred()
    def forbidden(*a,**k):pytest.fail('missing measured-duration material must not render')
    manager=FootageJobs(project.parent,executor=executor,search=lambda _: {'clips':[]},renderer=forbidden)
    def measured(p,directory,shots,request,event):
        for row in shots:row['duration_seconds']=7
        audio=directory/'narration.wav';audio.write_bytes(b'preserved measured narration');return audio
    monkeypatch.setattr(manager,'_narrate',measured)
    request=FootageRequest(project_id='demo',action='create',sources=['wikimedia'],confirm_network=True,
        shots=[{'id':'one','text':'三清山','duration_seconds':4},{'id':'two','text':'三清山','duration_seconds':4}],
        options={'narration':'none'})
    queued=manager.submit(request);executor.run();result=manager.get('demo',queued['job_id'])
    assert result['status']=='needs_materials'
    assert result['missing_shots']==['two'] and result['outputs']==[]
    assert (project/result['audio_path']).read_bytes()==b'preserved measured narration'
    assert all(s['start_seconds']+s['duration_seconds']<=s['selected_source']['duration']
               for s in result['shots'] if s['source_path'])


def test_random_versions_keep_manual_material_and_manual_cut_in(project,monkeypatch):
    monkeypatch.setattr('web_api.footage_pipeline.probe',lambda p:{'duration':12,'width':1920,'height':1080,'has_video':True})
    records=[clip('old'),clip('forest',tags='Sanqing forest')]
    write_json(project/'artifacts/stock_search_manifest.json',{'clips':records})
    captured=[]
    def renderer(p,d,shots,options,**kwargs):
        captured.append([(s['source_path'],s['start_seconds']) for s in shots]);d.mkdir(parents=True)
        output=d/'film.mp4';output.write_bytes(b'fixture-render');return {'status':'completed','output_path':output.relative_to(p).as_posix()}
    executor=Deferred();manager=FootageJobs(project.parent,executor=executor,renderer=renderer)
    request=FootageRequest(project_id='demo',action='render',material_mode='local',
        shots=[{'id':'manual','text':'三清山','source_path':'assets/old.mp4','start_seconds':2,'duration_seconds':4}],
        options={'narration':'none','variants':2,'order':'random'})
    queued=manager.submit(request);executor.run();result=manager.get('demo',queued['job_id'])
    assert result['status']=='completed'
    assert captured==[[('assets/old.mp4',2)],[('assets/old.mp4',2)]]


def test_direct_search_filters_before_download_and_does_not_count_old_or_duplicate_clip(tmp_path,monkeypatch):
    from tools.video.direct_clip_search import DirectClipSearch
    from tools.video.stock_sources.base import Candidate
    import tools.video.stock_sources as sources
    import subprocess, shutil
    fixture = tmp_path / 'fixture.mp4'
    subprocess.run(['ffmpeg','-v','error','-n','-f','lavfi','-i','color=c=blue:s=160x90:r=12:d=1',
                    '-c:v','libx264','-pix_fmt','yuv420p',str(fixture)],check=True,timeout=20)
    downloads=[]
    class FixtureSource:
        name='fixture'
        def is_available(self):return True
        def search(self,query,filters):
            def item(name,tags):
                return Candidate(source=self.name,source_id=name,source_url='https://example.test/'+name,
                    download_url='https://example.test/'+name+'.mp4',kind='video',source_tags=tags,extra={'title':tags})
            old=item('old','Sanqing clouds')
            cloud=item('new','Sanqing clouds')
            return [old,item('unrelated','lake mountains'),cloud,cloud,item('last','Sanqing mist')]
        def download(self,candidate,out):
            downloads.append(candidate.clip_id);shutil.copyfile(fixture,out);return out
    source=FixtureSource()
    monkeypatch.setattr(sources,'all_sources',lambda:[source])
    monkeypatch.setattr(sources,'available_sources',lambda:[source])
    result=DirectClipSearch().execute({'output_dir':str(tmp_path),'queries':[{'query':'Mount Sanqing clouds'}],
        'sources':['fixture'],'clips_per_query':2,'exclude_clip_ids':['fixture_old'],
        'metadata_groups':[['Sanqing','三清山'],['cloud','mist','云海']], 'extract_thumbnails':False})
    assert result.success,result.error
    assert downloads==['fixture_new','fixture_last']
    assert result.data['candidates_filtered']==3
    assert [c['title'] for c in result.data['clips']]==['Sanqing clouds','Sanqing mist']


@pytest.mark.parametrize('intent_first', [True, False])
def test_neutral_shot_does_not_take_the_cloud_shots_matching_asset(intent_first):
    cloud = clip('cloud', tags='Sanqing clouds mist')
    forest = clip('forest', tags='Sanqing forest trees')
    rows = [shot('intent', [cloud, forest], text='云海'),
            shot('neutral', [cloud, forest], text='三清山风光')]
    if not intent_first:
        rows.reverse()
    receipt = assign_automatic(rows)
    by_id = {s['id']: s['source_path'] for s in rows}
    assert by_id == {'intent': cloud['path'], 'neutral': forest['path']}
    assert receipt['missing_shots'] == []
    assert receipt['reused_source_shots'] == []


def test_distinct_assignments_match_exhaustive_optimum_on_small_candidate_graphs():
    """An independent exhaustive oracle checks coverage and semantic fit together."""
    import itertools
    import random
    rng = random.Random(4401)
    terms = [('云海', 'cloud mist'), ('森林', 'forest tree'), ('岩峰', 'peaks granite')]
    for case in range(80):
        have = [{k for k in range(3) if rng.choice([True, False])} for _ in range(4)]
        want = [{k for k in range(3) if rng.choice([True, False])} for _ in range(4)]
        assets = [clip(f'case-{case}-{j}', duration=4, tags='Sanqing ' + ' '.join(terms[k][1] for k in have[j])) for j in range(4)]
        available = [[j for j in range(4) if rng.random() < .7] for _ in range(4)]
        rows = [shot(f'shot-{i}', [assets[j] for j in available[i]], duration=4,
                     text=' '.join(terms[k][0] for k in want[i])) for i in range(4)]
        alternatives = []
        for allocation in itertools.product(*(row + [None] for row in available)):
            assigned = [j for j in allocation if j is not None]
            if len(assigned) != len(set(assigned)):
                continue
            alternatives.append((len(assigned), sum(20 * len(want[i] & have[j]) for i, j in enumerate(allocation) if j is not None)))
        receipt = assign_automatic(rows)
        by_path = {c['path']: j for j, c in enumerate(assets)}
        actual = [(i, by_path[s['source_path']]) for i, s in enumerate(rows) if s['source_path']]
        assert (len(actual), sum(20 * len(want[i] & have[j]) for i, j in actual)) == max(alternatives), case
        assert receipt['reused_source_shots'] == []


def test_replanning_missing_shot_clears_the_old_success_reason():
    rows = [shot('one', [clip('one', duration=4)], duration=4)]
    assert assign_automatic(rows)['missing_shots'] == []
    assert rows[0]['selection_reason'] == 'distinct_source'
    rows[0]['duration_seconds'] = 5
    assert assign_automatic(rows)['missing_shots'] == ['one']
    assert rows[0]['source_path'] == '' and 'selected_source' not in rows[0]
    assert 'selection_reason' not in rows[0]


def test_a_new_assignment_uses_edited_shot_text_and_candidate_metadata():
    cloud, forest = clip('cloud', tags='Sanqing clouds'), clip('forest', tags='Sanqing forest')
    rows = [shot('one', [cloud, forest], text='云海')]
    assign_automatic(rows)
    assert rows[0]['source_path'] == cloud['path']
    rows[0]['text'] = '森林'
    assign_automatic(rows)
    assert rows[0]['source_path'] == forest['path']
    rows[0]['candidates'][0]['source_tags'] = 'Sanqing forest'
    rows[0]['candidates'][1]['source_tags'] = 'Sanqing clouds'
    assign_automatic(rows)
    assert rows[0]['source_path'] == cloud['path']
