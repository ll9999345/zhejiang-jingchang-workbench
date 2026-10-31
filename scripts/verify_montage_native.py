#!/usr/bin/env python3
"""Real offline production checks, keeping every new run and source intact.

Run after sourcing .runtime/local-env.sh. No model API or paid provider is called.
Protocol tests and AI-provider acceptance are deliberately separate.
"""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from datetime import datetime

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from web_api.montage_jobs import MontageJobs
from web_api.montage_registry import NativeToolRequest, tool_catalog, pipeline_catalog
from tools.character.character_animation import SvgRigBuilder, PoseLibraryBuilder, ActionTimelineCompiler


def main():
    os.environ['PATH'] = str(Path(sys.executable).parent) + os.pathsep + os.environ.get('PATH','')
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    directory = ROOT / 'artifacts/montage-completion-20261001' / stamp
    project = directory / 'projects/acceptance'
    project.mkdir(parents=True, exist_ok=False)
    jobs = MontageJobs(project.parent)
    records = []
    def execute(tool, inputs, **permissions):
        row = jobs.submit(NativeToolRequest(project_id=project.name, tool=tool, inputs=inputs,
                    confirm=True, timeout_seconds=300, **permissions))
        if 'job_id' in row:
            deadline = time.monotonic() + 310
            while row['status'] in {'queued','running','cancelling'} and time.monotonic() < deadline:
                time.sleep(.3)
                row = jobs.get(project.name,row['job_id'])
        records.append(row)
        (directory/'acceptance.json').write_text(json.dumps({'project':str(project),'jobs':records,
                    'external_api_calls':0,'paid_calls':0},ensure_ascii=False,indent=2),encoding='utf-8')
        print(tool, row['status'],row.get('native_result',{}).get('error') or row.get('error') or '',flush=True)
        if row['status'] != 'completed': raise RuntimeError(tool + ' did not complete')
        return row
    try:
        images = ROOT / 'projects/draft-20260914-141923-cc721bf9b9/assets/frames'
        originals = [images/'shot-1.png', images/'shot-2.png']
        before = {str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in originals}
        for index,source in enumerate(originals,1): shutil.copyfile(source,project/f'image-{index}.png')
        imported = execute('corpus_importer',{'files':[
            {'input_path':'image-1.png','description':'a lush green forest'},
            {'input_path':'image-2.png','description':'mountain peaks above the clouds'}]})
        corpus = imported['native_result']['data']['corpus_dir']
        search = execute('clip_search',{'operation':'rank_for_slot','corpus_dir':corpus,
                    'query_text':'sunlight through a green forest','k':2,'tag_weight':0})
        assert search['native_result']['data'].get('ranked') or search['native_result']['data'].get('clips') or search['native_result']['data'].get('results')
        labelled=execute('video_understand',{'input_path':'image-1.png','mode':'describe','model':'clip'})
        assert labelled['native_result']['data']['frames'][0]['description_kind']=='candidate_label'
        subprocess.run(['ffmpeg','-n','-hide_banner','-loglevel','error','-f','lavfi','-i',
            'testsrc2=size=640x360:rate=12','-t','12','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',str(project/'spoken-fixture.mp4')],check=True)
        transcript = {'segments':[{'start':0,'end':4,'text':'为什么需要真实素材？'},
            {'start':4,'end':8,'text':'关键是保留地点和来源。'}, {'start':8,'end':12,'text':'最后再加入合适的表达。'}]}
        (project/'fixture-transcript.json').write_text(json.dumps(transcript,ensure_ascii=False),encoding='utf-8')
        imported_video=execute('corpus_importer',{'files':[{'input_path':'spoken-fixture.mp4',
            'description':'synthetic color bars for decoder acceptance, not real footage'}],'thumbs_per_video':2})
        assert any(f['kind']=='video' and f.get('playable') for f in imported_video['outputs'])
        execute('clip_search',{'operation':'rank_for_slot','corpus_dir':imported_video['native_result']['data']['corpus_dir'],
            'query_text':'a colorful video test pattern','k':1,'tag_weight':0})
        classified=execute('video_understand',{'input_path':'spoken-fixture.mp4','mode':'classify','model':'clip','max_frames':2})
        assert classified['native_result']['data']['frame_count']==2
        assert all(f['score_kind']=='cosine_similarity_not_probability' for f in classified['native_result']['data']['frames'])
        measured=execute('video_understand',{'input_path':'spoken-fixture.mp4','mode':'quality','max_frames':2})
        assert measured['native_result']['data']['model']=='metrics'
        execute('highlight_selector',{'input_path':'spoken-fixture.mp4','transcript_path':'fixture-transcript.json',
            'min_seconds':4,'max_seconds':8,'count':3})
        design={'version':'1.0','characters':[{'id':'guide','required_actions':['greet']} ]}
        rig=SvgRigBuilder().execute({'character_design':design}).data['rig_plan']
        poses=PoseLibraryBuilder().execute({'rig_plan':rig}).data['pose_library']
        timeline=ActionTimelineCompiler().execute({'scene_plan':{'scenes':[{'id':'scene1','start_seconds':0,'end_seconds':2,'hero_moment':True}]},'character_ids':['guide']}).data['action_timeline']
        animation=execute('character_rig_renderer',{'action_timeline':timeline,'rig_plan':rig,'pose_library':poses,
            'render_video':True,'duration_seconds':2,'fps':12},allow_code=True)
        frames=[f for f in animation['outputs'] if f['path'].endswith('.png')]
        assert len({f['sha256'] for f in frames})>=3, 'Character animation is static'
        execute('piper_tts',{'text':'为什么需要真实素材？关键是保留地点和来源。最后再加入合适的表达。'})
        world={'seed':20261001,'terrain':{'size':50,'resolution':32,'height_scale':3},'scatter':[],
               'regions':[],'assets':[],'camera':{'path':[{'time':0,'position':[15,-30,14],'target':[0,0,3]},
                                                     {'time':1,'position':[8,-20,12],'target':[0,0,3]}]}}
        blender=execute('blender_world',{'operation':'render_animation','world_spec':world,'width':320,'height':240,
            'fps':2,'duration_seconds':1,'samples':1,'render_engine':'CYCLES','cpu_render':True})
        assert any(f['kind']=='video' and f.get('playable') for f in blender['outputs']), 'Blender did not export an actual video'
        assert any(f['path'].endswith('.blend') for f in blender['outputs']), 'Blender did not export an editable project'
        assert all(hashlib.sha256(Path(path).read_bytes()).hexdigest()==digest for path,digest in before.items())
        (directory/'source-verification.json').write_text(json.dumps({'sha256_before':before,'all_sources_unchanged':True},indent=2),encoding='utf-8')
        (directory/'catalog.json').write_text(json.dumps(tool_catalog(),ensure_ascii=False,indent=2),encoding='utf-8')
        (directory/'pipelines.json').write_text(json.dumps(pipeline_catalog(),ensure_ascii=False,indent=2),encoding='utf-8')
        print('LOCAL_ACCEPTANCE_COMPLETE',directory,flush=True)
    finally: jobs.shutdown()


if __name__=='__main__': main()
