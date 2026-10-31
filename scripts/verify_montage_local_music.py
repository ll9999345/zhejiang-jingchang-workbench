#!/usr/bin/env python3
"""Actual free web BGM, three native presets, mixing and offline BLIP.

Writes only fresh test outputs in the explicitly selected local project.
Blocks other browser mutations and all external requests; keeps earlier media.
"""
from datetime import datetime
import hashlib
import json
from pathlib import Path
import time
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = 'http://127.0.0.1:4750'
PROJECT = 'draft-20260914-141923-cc721bf9b9'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    out = ROOT / 'artifacts/montage-completion-20261001' / ('local-music-ui-' + stamp)
    out.mkdir(parents=True, exist_ok=False)
    project = ROOT / 'projects' / PROJECT
    originals = [project / 'assets/frames/shot-1.png'] + [p for p in (project / 'assets/music').rglob('*') if p.is_file()]
    checksums = {str(p): digest(p) for p in originals}
    report = {'project_id': PROJECT, 'jobs': [], 'page_errors': [], 'external_requests': [],
              'unexpected_mutations': [], 'confirmations': [], 'paid_calls': 0, 'external_inference_calls': 0}
    def save():
        (out / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless=True)
        context = browser.new_context(reduced_motion='reduce', viewport={'width': 1440, 'height': 1000})
        def guard(route):
            request = route.request
            path = urlsplit(request.url).path
            if urlsplit(request.url).netloc != urlsplit(BASE).netloc:
                report['external_requests'].append(request.url); route.abort(); return
            if request.method not in {'GET', 'HEAD'}:
                body = request.post_data_json
                allowed = bool(body and body.get('project_id') == PROJECT)
                if path in {'/model-api/media/music/estimate', '/model-api/media/music/render'}:
                    allowed &= body.get('preferred_provider') == 'local' and body.get('duration_seconds') == 6
                elif path in {'/model-api/montage/tools/preflight', '/model-api/montage/tools/execute'}:
                    allowed &= body.get('tool') in {'local_music', 'audio_mixer', 'video_understand', 'upscale', 'face_restore'}
                    allowed &= not any(body.get(k) for k in ('allow_paid', 'allow_network', 'allow_capture', 'allow_code'))
                    if path.endswith('/execute'):
                        allowed &= body.get('tool') in {'local_music', 'audio_mixer', 'video_understand'}
                        if body.get('tool') == 'video_understand': allowed &= body.get('inputs', {}).get('model') == 'blip'
                elif path == '/model-api/media/audio/mix':
                    allowed &= body.get('dry_run') is True and body.get('execute') is False
                else: allowed = False
                if not allowed:
                    report['unexpected_mutations'].append({'path': path, 'method': request.method}); route.abort(); return
            route.continue_()
        context.route('**/*', guard)
        page = context.new_page()
        page.on('pageerror', lambda error: report['page_errors'].append(str(error)))
        def confirm(dialog):
            report['confirmations'].append(dialog.message)
            assert '免费' in dialog.message and 'ElevenLabs 费用' not in dialog.message
            dialog.accept()
        page.on('dialog', confirm)
        try:
            page.goto(BASE + f'/model?project={PROJECT}&workspace=edit#mediaMusicCard', wait_until='networkidle', timeout=45000)
            page.locator('#mediaMusicCard').wait_for(state='visible')
            page.locator('#mediaMusicCard details.operation-details').evaluate('node=>node.open=true')
            assert page.locator('#mediaMusicProvider').input_value() == 'local'
            page.locator('#mediaMusicDuration').fill('6')
            page.locator('#mediaMusicLocalStyle').select_option('cinematic')
            page.locator('#mediaMusicLocalTempo').fill('80')
            page.locator('#mediaMusicOutput').fill('acceptance-free-' + stamp + '.mp3')
            with page.expect_response(lambda r: r.url.endswith('/music/estimate')) as response:
                page.locator('#mediaMusicEstimate').click()
            plan = response.value.json()
            assert plan['would_generate'] and plan['estimated_cost_usd'] == 0 and plan['provider']['provider'] == 'local_synthesis', plan
            report['free_preflight'] = plan
            with page.expect_response(lambda r: r.url.endswith('/music/render'), timeout=90000) as response:
                page.locator('#mediaMusicExecute').click()
            music = response.value.json()
            assert music['status'] == 'completed' and music['paid_calls'] == 0, music
            assert music['data']['style'] == 'cinematic' and music['data']['tempo_bpm'] == 80
            report['main_bgm'] = music
            music_path = music['music']['path']
            audio = page.locator('#mediaPreview audio').first
            audio.wait_for(state='visible')
            audio.evaluate('node=>node.play().then(()=>node.pause())')
            report['generated_mp3_played'] = True
            page.wait_for_function('(path)=>document.querySelector("#mediaAudioSecondary")?.value===path', arg=music_path)
            assert music_path in page.locator('#mediaAudioTracks').input_value()
            report['bgm_automatically_added_to_mix'] = True
            with page.expect_response(lambda r: r.url.endswith('/audio/mix')) as response:
                page.locator('#mediaAudioMixEstimate').click()
            report['main_mix_preflight'] = response.value.json()
            assert response.value.status == 200 and report['main_mix_preflight']['status'] == 'dry_run', report['main_mix_preflight']
            page.screenshot(path=str(out / 'free-bgm-handoff.png'))
            page.goto(BASE + f'/model?project={PROJECT}&workspace=tools#mediaMontageCard', wait_until='networkidle', timeout=45000)
            host = page.locator('#montageTools'); host.wait_for(state='visible')
            host.locator('[aria-label="制作方式"]').select_option('tool')
            studio = host.locator('.montage-studio')
            picker = studio.locator('[aria-label="选择 OpenMontage 原生工具"]')
            def native(tool, values):
                picker.select_option(tool)
                studio.locator('details').filter(has_text='高级参数与输出文件名').evaluate('node=>node.open=true')
                for key, value in values.items():
                    control = studio.locator(f'[data-native-parameter="{key}"]')
                    if isinstance(value, bool): control.set_checked(value)
                    elif isinstance(value, (dict, list)): control.fill(json.dumps(value, ensure_ascii=False))
                    elif control.evaluate('node=>node.tagName') == 'SELECT': control.select_option(str(value))
                    else: control.fill(str(value))
                with page.expect_response(lambda r: r.url.endswith('/tools/preflight')) as response:
                    studio.get_by_role('button', name='检查条件', exact=True).click()
                plan = response.value.json()
                assert plan['can_execute'] and plan['would_write'] is False, plan
                studio.get_by_label('确认本次参数，写入新的产物并保留原件').check()
                with page.expect_response(lambda r: r.url.endswith('/tools/execute')) as response:
                    studio.get_by_role('button', name='运行所选工具', exact=True).click()
                row = response.value.json()
                assert row.get('job_id'), row
                deadline = time.monotonic() + 200
                while row['status'] in {'queued', 'running', 'cancelling'} and time.monotonic() < deadline:
                    time.sleep(.35)
                    row = page.request.get(BASE + f'/model-api/montage/jobs/{row["job_id"]}?project_id={PROJECT}').json()
                report['jobs'].append(row); save()
                assert row['status'] == 'completed', row
                studio.get_by_role('button', name='刷新制作记录').click()
                card = studio.locator(f'.montage-job[data-montage-job="{row["job_id"]}"]')
                card.wait_for(state='visible')
                return row, card
            for style in ('guofeng_ambient', 'cinematic', 'documentary'):
                row, card = native('local_music', {'duration_seconds': 6, 'style': style, 'tempo_bpm': 72})
                audio = card.locator('audio').first
                audio.wait_for(state='visible')
                audio.evaluate('node=>node.play().then(()=>node.pause())')
                assert row['native_result']['data']['rms'] > 0
            speech = page.request.get(BASE + f'/model-api/montage/jobs/20261001T055033-58147e7ac587?project_id={PROJECT}').json()
            voice = next(r['path'] for r in speech['outputs'] if r['kind'] == 'audio')
            row, card = native('audio_mixer', {'operation': 'full_mix', 'tracks': [
                {'path': voice, 'role': 'speech', 'volume': 1, 'start_seconds': 0},
                {'path': music_path, 'role': 'music', 'volume': .3, 'start_seconds': 0}], 'target_duration': 6})
            audio = card.locator('audio').first
            audio.evaluate('node=>node.play().then(()=>node.pause())')
            report['mixed_audio_played'] = True
            row, card = native('video_understand', {'input_path': 'assets/frames/shot-1.png', 'mode': 'qa',
                'model': 'blip', 'max_frames': 1, 'query': 'What is in this image?'})
            frames = row['native_result']['data']['frames']
            assert frames[0]['answer'] and row['native_result']['data']['limitations']
            assert frames[0]['answer'] in card.inner_text()
            report['actual_blip_answer_visible'] = True
            for width, height in [(1440, 1000), (390, 844)]:
                page.set_viewport_size({'width': width, 'height': height})
                card.scroll_into_view_if_needed()
                assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
                page.screenshot(path=str(out / f'actual-results-{width}.png'))
            # The served capability badge must reflect the usable local choice.
            catalog = page.request.get(BASE + '/model-api/montage/tools').json()
            health = page.request.get(BASE + '/model-api/media/music/health').json()
            capabilities = page.request.get(BASE + '/model-api/media/capabilities').json()['capabilities']
            assert catalog['tool_count'] == 127
            assert health['provider']['provider'] == 'local_synthesis' and health['provider']['status'] == 'available'
            assert capabilities['music_generation']['status'] == 'available'
            report['live_catalog'] = catalog
            report['music_health'] = health
            for result in [music] + report['jobs']:
                items = [result['music']] if result is music else result['outputs']
                for item in items:
                    assert (project / item['path']).is_file()
                    if item.get('sha256'): assert digest(project / item['path']) == item['sha256']
            report['original_tracks_and_image_unchanged'] = all(digest(Path(path)) == h for path, h in checksums.items())
            report['original_sha256'] = checksums
            assert report['original_tracks_and_image_unchanged']
            assert not report['page_errors'] and not report['external_requests'] and not report['unexpected_mutations'], report
            report['status'] = 'passed'
        finally:
            save(); browser.close()
    print(json.dumps({'status': report['status'], 'receipt': str(out), 'native_jobs': len(report['jobs']),
        'bgm_auto_mix': report['bgm_automatically_added_to_mix'], 'paid_calls': 0}, ensure_ascii=False), flush=True)


if __name__ == '__main__': main()
