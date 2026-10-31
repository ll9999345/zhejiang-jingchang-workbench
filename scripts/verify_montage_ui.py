#!/usr/bin/env python3
"""Check the served workbench. Optional --local-tts writes one fresh test WAV.

No external request, cloud model, paid request or old-file replacement is allowed.
The default run only reads project data and performs no-write preflights.
"""
import argparse
import hashlib
import json
from pathlib import Path
import time
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
TEXT = '这是一条工作台本机功能验收音频，原有素材和成片保持不变。'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base', default='http://127.0.0.1:4750')
    parser.add_argument('--project', default='draft-20260914-141923-cc721bf9b9')
    parser.add_argument('--local-tts', action='store_true')
    parser.add_argument('--existing-tts-job', help='Play an already completed test job, without creating another audio file')
    args = parser.parse_args()
    base = args.base.rstrip('/')
    assert urlsplit(base).hostname in {'127.0.0.1','localhost'}, 'Only verify a local workbench'
    project = ROOT/'projects'/args.project
    source = project/'assets/frames/shot-1.png'
    original = hashlib.sha256(source.read_bytes()).hexdigest() if source.is_file() else None
    out = ROOT/'artifacts/montage-completion-20261001'/('ui-'+str(time.time_ns()))
    out.mkdir(parents=True,exist_ok=False)
    report = {'project_id':args.project,'views':[],'page_errors':[],'external_requests':[],
              'unexpected_mutations':[],'preflights':[],'local_test_job':None}
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless=True)
        context = browser.new_context(reduced_motion='reduce')
        def guard(route):
            req = route.request
            if urlsplit(req.url).netloc != urlsplit(base).netloc:
                report['external_requests'].append(req.url);route.abort();return
            if req.method not in {'GET','HEAD'}:
                path = urlsplit(req.url).path
                allowed = path in {'/model-api/montage/tools/preflight','/model-api/montage/director/preflight','/model-api/montage/composition/preflight'}
                if args.local_tts and path=='/model-api/montage/tools/execute':
                    body=req.post_data_json
                    allowed=body.get('project_id')==args.project and body.get('tool')=='piper_tts' and body.get('inputs',{}).get('text')==TEXT and not any(body.get(k) for k in ('allow_network','allow_paid','allow_capture','allow_code'))
                if not allowed:
                    report['unexpected_mutations'].append({'path':path,'method':req.method});route.abort();return
            route.continue_()
        context.route('**/*',guard)
        page=context.new_page()
        page.on('pageerror',lambda error: report['page_errors'].append(str(error)))
        page.goto(base+f'/model?project={args.project}&workspace=tools#mediaMontageCard',wait_until='networkidle',timeout=45000)
        host=page.locator('#montageTools')
        host.wait_for(state='visible')
        assert page.locator('#workspaceToolSelect').input_value()=='mediaMontageCard'
        assert page.locator('#mediaProjectId').input_value()==args.project
        mode=host.locator('[aria-label="制作方式"]')
        studio=host.locator('.montage-studio')
        mode.select_option('tool')
        picker=studio.locator('[aria-label="选择 OpenMontage 原生工具"]')
        picker.locator('option').first.wait_for(state='attached')
        tools=page.request.get(base+'/model-api/montage/tools').json()['tools']
        assert picker.locator('option').count()==len(tools) and len(tools)>=126
        for tool in tools:
            picker.select_option(tool['name'])
            if tool['status']=='unavailable' or tool['entry']=='/footage':
                assert studio.get_by_role('button',name='运行所选工具',exact=True).is_disabled(),tool['name']
        report['native_tool_forms_checked']=len(tools)
        unavailable=next(t['name'] for t in tools if t['status']=='unavailable')
        picker.select_option(unavailable)
        mode.select_option('composition')
        host.locator('.montage-scene-row textarea').fill('本机条件检查，不制作新视频')
        with page.expect_response(lambda r:r.url.endswith('/composition/preflight')) as response:
            host.get_by_role('button',name='检查制作条件',exact=True).click()
        assert response.value.status==200,response.value.text()
        mode.select_option('tool')
        assert picker.input_value()==unavailable
        assert studio.get_by_role('button',name='运行所选工具',exact=True).is_disabled()
        report['unavailable_tool_stays_disabled_after_other_preflight']=True
        for width,height in [(1440,1000),(900,1000),(390,844)]:
            page.set_viewport_size({'width':width,'height':height})
            for view in ['composition','clips','tool','director']:
                mode.select_option(view)
                if view=='tool':picker.select_option('highlight_selector')
                if view=='director':
                    assert studio.locator('[aria-label="制作管线"] option').count()==12
                page.locator('#mediaMontageCard').scroll_into_view_if_needed()
                page.screenshot(path=str(out/f'{view}-{width}.png'))
                dimensions=page.evaluate('({viewport:innerWidth,body:document.documentElement.scrollWidth})')
                assert dimensions['body']<=dimensions['viewport'],(view,dimensions)
                report['views'].append({'mode':view,'width':width,**dimensions})
        page.set_viewport_size({'width':1440,'height':1000})
        mode.select_option('tool');picker.select_option('frame_sampler')
        assets=page.request.get(base+f'/model-api/footage/context/{args.project}').json()['assets']
        videos=[a['path'] for a in assets if a['kind']=='video']
        assert videos,'A real video is needed for the no-write preflight'
        studio.locator('[data-native-parameter="input_path"]').fill(videos[0])
        assert studio.locator('#montage-asset-input_path option').count()==len(assets)
        with page.expect_response(lambda r: r.url.endswith('/tools/preflight')) as response:
            studio.get_by_role('button',name='检查条件',exact=True).click()
        plan=response.value.json()
        assert response.value.status==200 and plan['can_execute'] and plan['would_write'] is False,plan
        report['preflights'].append({'tool':'frame_sampler','status':plan['status'],'would_write':False})
        picker.select_option('video_understand')
        studio.locator('[data-native-parameter="input_path"]').fill(videos[0])
        for visual_mode in ('quality','classify','qa'):
            studio.locator('[data-native-parameter="mode"]').select_option(visual_mode)
            if visual_mode=='qa':
                studio.locator('details').filter(has_text='高级参数与输出文件名').evaluate('node=>node.open=true')
                studio.locator('[data-native-parameter="query"]').fill('Which city is this?')
            with page.expect_response(lambda r:r.url.endswith('/tools/preflight')) as response:
                studio.get_by_role('button',name='检查条件',exact=True).click()
            plan=response.value.json()
            assert response.value.status==200 and plan['would_write'] is False,plan
            assert plan['can_execute'] is (visual_mode!='qa'),plan
            if visual_mode=='qa':assert any('CLIP' in reason for reason in plan['requirements'])
            report['preflights'].append({'tool':'video_understand','mode':visual_mode,
                'status':plan['status'],'can_execute':plan['can_execute'],'would_write':False})
        mode.select_option('director')
        studio.locator('[aria-label="制作管线"]').select_option('documentary-montage')
        studio.get_by_label('创作需求与素材说明').fill('只检查当前导演条件，不发起制作或上传。')
        studio.get_by_label('模型名',exact=True).fill('not-installed-ui-check')
        studio.locator('[aria-label="导演模型服务"]').select_option('ollama')
        with page.expect_response(lambda r:r.url.endswith('/director/preflight')) as response:
            studio.get_by_role('button',name='检查导演条件').click()
        plan=response.value.json()
        assert response.value.status==200 and not plan['can_execute'] and plan['would_write'] is False,plan
        assert plan['requirements']
        report['preflights'].append({'director':'ollama','status':plan['status'],'requirements':plan['requirements'],'would_write':False})
        # The real recommendation handoff changes inputs only, never crops.
        mode.select_option('clips')
        host.locator('.montage-clips input').fill(videos[0])
        host.get_by_role('button',name='先自动推荐段落').click()
        assert mode.input_value()=='tool'
        assert picker.input_value()=='highlight_selector'
        assert studio.locator('[data-native-parameter="input_path"]').input_value()==videos[0]
        report['highlight_handoff_checked']=True
        if args.local_tts or args.existing_tts_job:
            picker.select_option('piper_tts')
            if args.local_tts:
                studio.locator('[data-native-parameter="text"]').fill(TEXT)
                studio.get_by_label('确认本次参数，写入新的产物并保留原件').check()
                with page.expect_response(lambda r:r.url.endswith('/tools/execute')) as response:
                    studio.get_by_role('button',name='运行所选工具',exact=True).click()
                row=response.value.json();assert row.get('job_id'),row
            else:
                import re
                assert re.fullmatch(r'\d{8}T\d{6}-[0-9a-f]{12}',args.existing_tts_job)
                row=page.request.get(base+f'/model-api/montage/jobs/{args.existing_tts_job}?project_id={args.project}').json()
            end=time.monotonic()+45
            while row['status'] in {'queued','running','cancelling'} and time.monotonic()<end:
                time.sleep(.25)
                row=page.request.get(base+f"/model-api/montage/jobs/{row['job_id']}?project_id={args.project}").json()
            assert row['status']=='completed',row
            studio.get_by_role('button',name='刷新制作记录').click()
            selector=f'.montage-job[data-montage-job="{row["job_id"]}"] audio'
            audio=studio.locator(selector)
            audio.wait_for(state='visible')
            page.wait_for_function('(sel)=>document.querySelector(sel)?.readyState>=1',arg=selector,timeout=15000)
            assert audio.evaluate('node=>node.duration')>1
            assert audio.evaluate('node=>node.play().then(()=>!node.paused)') is True
            audio.evaluate('node=>{node.dataset.acceptancePlayback="stable";node.pause();}')
            with page.expect_response(lambda r:'/model-api/montage/jobs?' in r.url) as response:
                studio.get_by_role('button',name='刷新制作记录').click()
            page.wait_for_function('(sel)=>document.querySelector(sel)?.dataset.acceptancePlayback==="stable"',arg=selector)
            report['local_test_job']={'job_id':row['job_id'],'tool':'piper_tts','status':'completed','outputs':row['outputs'],'browser_audio_played':True,'refresh_preserves_player':True,'new_job_submitted':args.local_tts}
            page.screenshot(path=str(out/'actual-local-audio.png'))
        browser.close()
    assert not report['page_errors'] and not report['external_requests'] and not report['unexpected_mutations'],report
    report['original_source_unchanged']=original is None or hashlib.sha256(source.read_bytes()).hexdigest()==original
    assert report['original_source_unchanged']
    report['paid_calls']=report['external_model_calls']=0
    (out/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'status':'passed','directory':str(out),'forms':len(tools),'views':len(report['views']),
        'local_test_job':report['local_test_job']['job_id'] if report['local_test_job'] else None},ensure_ascii=False),flush=True)


if __name__=='__main__':main()
