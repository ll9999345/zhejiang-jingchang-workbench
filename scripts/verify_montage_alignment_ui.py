#!/usr/bin/env python3
"""Real Chrome: recognize, correct text, align, animate, download and reload.

Only labelled local acceptance media is used. No paid or external requests,
system changes, deletion or replacement of pre-existing assets are allowed.
"""
from datetime import datetime
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import time
from urllib.parse import urlsplit
import uuid

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = 'http://127.0.0.1:4750'
TEXT = '这是一条工作台本机功能验收音频，原有素材和成片保持不变。'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--existing-project', help='Reuse only this script’s labelled acceptance project; all older outputs stay')
    parser.add_argument('--resume-review', type=Path, help='Read back a completed real transcription; do not run the same ASR again')
    parser.add_argument('--resume-jobs', type=Path, help='Reuse already completed real UI jobs; verify their current receipts instead of rerunning them')
    args = parser.parse_args()
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:6]
    output = ROOT / 'artifacts/montage-completion-20261001' / ('alignment-ui-' + stamp)
    output.mkdir(parents=True, exist_ok=False)
    source = ROOT / 'artifacts/montage-completion-20261001/alignment-20261001-185646/projects/acceptance/caption-fixture.mp4'
    originals = {str(source): sha(source)}
    project = ROOT / 'projects' / (args.existing_project or 'acceptance-alignment-' + stamp)
    if args.existing_project:
        assert project.name == args.existing_project and project.name.startswith('acceptance-alignment-')
        assert json.loads((project/'project.json').read_text())['source'] == 'local_acceptance_fixture'
        assert sha(project/'assets/video/caption-fixture.mp4') == sha(source)
    else:
        assets = project / 'assets/video'; assets.mkdir(parents=True, exist_ok=False)
        shutil.copyfile(source, assets/'caption-fixture.mp4')
        (project/'project.json').write_text(json.dumps({'project_id': project.name,
            'title': '本机中文字幕验收（测试夹具）', 'project_kind': 'acceptance', 'stage': 'edit',
            'source': 'local_acceptance_fixture', 'pipeline_type': 'cinematic',
            'prompt': '现有 Piper 验收录音与静态树林测试背景；不是新制作的宣传片。'}, ensure_ascii=False), encoding='utf-8')
    report = {'project_id': project.name, 'paid_calls': 0, 'page_errors': [], 'external_requests': [],
              'unexpected_mutations': [], 'jobs': [], 'views': [], 'source_sha256': originals}
    def save():
        (output/'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless=True)
        context = browser.new_context(reduced_motion='reduce', viewport={'width':1440, 'height':1000})
        def guard(route):
            request = route.request
            if urlsplit(request.url).netloc != urlsplit(BASE).netloc:
                report['external_requests'].append(request.url); route.abort(); return
            if request.method not in {'GET', 'HEAD'}:
                path = urlsplit(request.url).path
                body = request.post_data_json
                permitted = body.get('project_id') == project.name
                if path == '/model-api/media/transcribe':
                    permitted = permitted and body.get('media_path') == 'assets/video/caption-fixture.mp4' and body.get('model_size') == 'small'
                elif path in {'/model-api/montage/tools/preflight', '/model-api/montage/tools/execute'}:
                    permitted = permitted and body.get('tool') in {'transcript_aligner', 'remotion_caption_burn'}
                    permitted = permitted and not any(body.get(key) for key in ('allow_network','allow_paid','allow_capture','allow_code'))
                else:
                    permitted = False
                if not permitted:
                    report['unexpected_mutations'].append({'path':path,'method':request.method}); route.abort(); return
            route.continue_()
        context.route('**/*', guard)
        page = context.new_page()
        page.on('pageerror', lambda error: report['page_errors'].append(str(error)))
        page.on('dialog', lambda dialog: dialog.accept() if 'faster-whisper small' in dialog.message else dialog.dismiss())
        try:
            page.goto(BASE+f'/model?project={project.name}&workspace=edit#mediaSubtitleCard', wait_until='networkidle', timeout=45000)
            page.locator('#mediaSubtitleCard').wait_for(state='visible')
            page.locator('#mediaSubtitleCard details.narration-import').evaluate('node => node.open = true')
            page.locator('[data-picker-target="mediaTranscriptPath"]').select_option('assets/video/caption-fixture.mp4')
            page.locator('#mediaTranscriptModel').select_option('small')
            page.locator('#mediaTranscriptAlignment').select_option('whisperx_zh')
            if args.resume_review:
                old = json.loads(args.resume_review.read_text())
                result = old['transcription']
                assert old['project_id'] == project.name and result['status'] == 'completed'
                assert sha(project/result['files']['json']['path']) == result['files']['json']['sha256']
                page.locator('#mediaTranscriptReview').wait_for(state='visible')
                report['transcription_reused_from'] = str(args.resume_review)
            else:
                with page.expect_response(lambda r: r.url.endswith('/media/transcribe') and r.request.post_data_json.get('execute'), timeout=180000) as response:
                    page.locator('#mediaTranscribe').click()
                result = response.value.json()
            report['transcription'] = result; save()
            assert result['status'] == 'completed', result
            assert result['transcriber']['model'] == 'small' and result['alignment']['engine'] == 'whisperx_forced_ctc'
            assert page.locator('#mediaTranscriptReview').is_visible()
            assert len(result['segments']) == 1, 'This short fixture should keep one editable segment'
            review_text = page.locator('#mediaTranscriptText').input_value()
            assert review_text in {result['segments'][0]['text'], TEXT}, 'Read back saved recognition or the retained local correction'
            report['review_restored_from_disk'] = bool(args.resume_review)
            for width, height in ((1440,1000),(390,844)):
                page.set_viewport_size({'width':width,'height':height})
                page.locator('#mediaTranscriptReview').scroll_into_view_if_needed()
                page.screenshot(path=str(output/f'transcript-review-{width}.png'))
                dimensions = page.evaluate('({viewport: innerWidth, body: document.documentElement.scrollWidth})')
                assert dimensions['body'] <= dimensions['viewport'], dimensions
                report['views'].append({'stage':'text_review',**dimensions})
            page.set_viewport_size({'width':1440,'height':1000})
            page.locator('#mediaTranscriptText').fill(TEXT)
            page.locator('#mediaTranscriptCorrect').click()
            host = page.locator('#montageTools'); studio = host.locator('.montage-studio')
            studio.locator('[data-native-parameter="segments"]').wait_for(state='visible')
            segments = json.loads(studio.locator('[data-native-parameter="segments"]').input_value())
            assert segments[0]['text'] == TEXT
            assert studio.locator('[data-native-parameter="input_path"]').input_value() == 'assets/video/caption-fixture.mp4'
            def run_job():
                with page.expect_response(lambda r:r.url.endswith('/tools/preflight')) as response:
                    studio.get_by_role('button', name='检查条件', exact=True).click()
                assert response.value.json()['can_execute'], response.value.json()
                studio.get_by_label('确认本次参数，写入新的产物并保留原件').check()
                with page.expect_response(lambda r:r.url.endswith('/tools/execute')) as response:
                    studio.locator('.montage-native-pane[aria-label="原生工具"] .button-row .primary').click()
                row = response.value.json(); assert row.get('job_id'), row
                deadline = time.monotonic()+300
                while row['status'] in {'queued','running','cancelling'} and time.monotonic()<deadline:
                    time.sleep(.4)
                    row = page.request.get(BASE+f'/model-api/montage/jobs/{row["job_id"]}?project_id={project.name}').json()
                report['jobs'].append(row); save()
                assert row['status'] == 'completed', row
                studio.get_by_role('button',name='刷新制作记录').click()
                return row
            saved_jobs = json.loads(args.resume_jobs.read_text()) if args.resume_jobs else {}
            assert not saved_jobs or saved_jobs['project_id'] == project.name
            def completed_job(tool):
                previous = next((row for row in saved_jobs.get('jobs',[]) if row['tool'] == tool and row['status'] == 'completed'), None)
                if not previous: return None
                with page.expect_response(lambda r:r.url.endswith('/tools/preflight')) as checked:
                    studio.get_by_role('button',name='检查条件',exact=True).click()
                assert checked.value.json()['can_execute'], checked.value.json()
                row = page.request.get(BASE+f'/model-api/montage/jobs/{previous["job_id"]}?project_id={project.name}').json()
                assert row['status'] == 'completed' and row['outputs'] == previous['outputs']
                report['jobs'].append(row)
                report.setdefault('jobs_reused_from', {})[tool] = str(args.resume_jobs)
                studio.get_by_role('button',name='刷新制作记录').click()
                return row
            alignment = completed_job('transcript_aligner') or run_job()
            assert alignment['native_result']['data']['alignment']['aligned_character_count'] == 26
            job_card = studio.locator(f'.montage-job[data-montage-job="{alignment["job_id"]}"]')
            job_card.get_by_role('button',name='用此字幕导出逐字高亮',exact=True).click()
            caption_input = studio.locator('[data-native-parameter="transcript_path"]')
            page.wait_for_function('() => document.querySelector("[data-native-parameter=transcript_path]")?.value.includes("aligned-")')
            assert caption_input.input_value() == alignment['native_result']['data']['subtitles']['json']
            assert studio.locator('[data-native-parameter="input_path"]').input_value() == 'assets/video/caption-fixture.mp4'
            caption = completed_job('remotion_caption_burn') or run_job()
            assert caption['native_result']['data']['method'] == 'remotion'
            assert caption['native_result']['data']['word_timing_source'] == 'provided_word_timestamps'
            card_selector = f'.montage-job[data-montage-job="{caption["job_id"]}"]'
            video = studio.locator(card_selector+' video')
            video.wait_for(state='visible')
            assert video.count() == 1, 'Copied source video must not appear as a second output'
            page.wait_for_function('(sel) => document.querySelector(sel)?.readyState >= 1',arg=card_selector+' video', timeout=20000)
            assert video.evaluate('node => node.play().then(() => !node.paused)')
            video.evaluate('node => node.pause()')
            downloadable = next(f for f in caption['outputs'] if f['path'] == caption['native_result']['data']['output'])
            url = BASE+'/model-api/montage/files/'+project.name+'/'+downloadable['path']
            download = page.request.get(url)
            assert download.status == 200 and hashlib.sha256(download.body()).hexdigest() == downloadable['sha256']
            report.update(browser_playback=True, exact_download_sha256=downloadable['sha256'])
            page.screenshot(path=str(output/'animated-caption-result.png'))
            page.reload(wait_until='networkidle')
            page.locator('#workspaceToolSelect').select_option('mediaMontageCard')
            host.locator('[aria-label="制作方式"]').select_option('tool')
            host.get_by_role('button',name='刷新制作记录').click()
            host.locator(card_selector+' video').wait_for(state='visible')
            report['reload_preserves_result'] = True
            assert not report['page_errors'] and not report['external_requests'] and not report['unexpected_mutations'], report
            assert all(sha(Path(path)) == digest for path,digest in originals.items())
            report['originals_unchanged'] = True
            report['completed'] = True; save()
            print('REAL_CHROME_ALIGNMENT_FLOW_PASSED',output,flush=True)
        finally:
            if not report.get('completed'):
                try:
                    report['failure_view'] = page.locator('#mediaNarrationStatus').inner_text()
                    page.screenshot(path=str(output/'failure.png'))
                except Exception:
                    pass
            save(); browser.close()


if __name__ == '__main__':
    main()
