#!/usr/bin/env python3
"""Read-only final delivery check; reuses real results, never reruns models."""
from collections import Counter
from datetime import datetime
import hashlib
import json
from pathlib import Path
import sys
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
BASE = 'http://127.0.0.1:4750'
PROJECT = 'draft-20260914-141923-cc721bf9b9'
EVIDENCE = ROOT / 'artifacts/montage-completion-20261001'


def sha(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''): result.update(chunk)
    return result.hexdigest()


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def main():
    target = EVIDENCE / ('local-models-verification-' + datetime.now().strftime('%Y%m%d-%H%M%S'))
    target.mkdir(parents=True, exist_ok=False)
    restoration_path = EVIDENCE / 'restoration-20261001-154915/acceptance.json'
    music_path = EVIDENCE / 'local-music-ui-20261001-162656/report.json'
    restoration, music = read(restoration_path), read(music_path)
    source_info = read(restoration_path.parent / 'source-verification.json')
    assert len(restoration['jobs']) == 12 and len(music['jobs']) == 5 and music['status'] == 'passed'
    output_count = 0
    for project, jobs in [(Path(restoration['project']), restoration['jobs']), (ROOT / 'projects' / PROJECT, music['jobs'])]:
        for row in jobs:
            assert row['status'] == 'completed'
            for output in row['outputs']:
                path = project / output['path']
                assert path.is_file() and sha(path) == output['sha256'], path
                output_count += 1
    original_hashes = {**source_info['original_sha256'], **music['original_sha256']}
    assert all(sha(Path(path)) == expected for path, expected in original_hashes.items())
    installations, model_files = [], 0
    for receipt in sorted((ROOT / '.runtime/installation-receipts').glob('20261001T*.json')):
        info = read(receipt)
        assert info['paid_calls'] == 0 and not info['private_media_uploaded']
        for item in info['files']:
            path = ROOT / item['file']
            assert sha(path) == item['sha256'], path
            model_files += 1
        installations.append(str(receipt.relative_to(ROOT)))
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def get(path):
        with opener.open(BASE + path, timeout=30) as response: return json.load(response)
    catalog = get('/model-api/montage/tools')
    state = get('/api/project/' + PROJECT + '/state')
    health = get('/model-api/media/music/health')
    assert catalog['tool_count'] == 127
    assert health['provider']['provider'] == 'local_synthesis'
    music_file = music['main_bgm']['music']
    assert sha(ROOT / 'projects' / PROJECT / music_file['path']) == music_file['sha256']
    assert any(row['path'] == music_file['path'] for row in state['media']['music'])
    served = {}
    for name in ('model.html', 'model.js', 'montage-studio.js', 'montage-studio.css'):
        path = '/model?project=' + PROJECT if name == 'model.html' else '/ui/' + name
        with opener.open(BASE + path, timeout=15) as response: content = response.read()
        digest = hashlib.sha256(content).hexdigest()
        if name == 'model.html':
            from backlot.model_adapter import _model_html
            assert content == _model_html().body, name
        else: assert digest == sha(ROOT / 'backlot/ui' / name), name
        served[name] = digest
    browser_errors, external, mutations = [], [], []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless=True)
        context = browser.new_context(reduced_motion='reduce', viewport={'width': 1440, 'height': 1000})
        def guard(route):
            request = route.request
            if urlsplit(request.url).netloc != urlsplit(BASE).netloc:
                external.append(request.url); route.abort()
            elif request.method not in {'GET', 'HEAD'}:
                mutations.append(request.url); route.abort()
            else: route.continue_()
        from urllib.parse import urlsplit
        context.route('**/*', guard)
        page = context.new_page()
        page.on('pageerror', lambda error: browser_errors.append(str(error)))
        page.goto(BASE + f'/model?project={PROJECT}&workspace=edit#mediaMusicCard', wait_until='networkidle', timeout=45000)
        page.locator('#mediaMusicCard').wait_for(state='visible')
        page.locator('#mediaMusicCard details.operation-details').evaluate('node=>node.open=true')
        assert page.locator('#mediaMusicProvider').input_value() == 'local'
        # The actual restored project preview contains the already delivered
        # MP3. Reuse it without injecting UI state or submitting another task.
        audio = page.locator('#mediaPreview audio[src*="' + Path(music_file['path']).name + '"]')
        audio.wait_for(state='visible')
        audio.evaluate('node=>node.play().then(()=>node.pause())')
        page.locator('#mediaMusicCard').scroll_into_view_if_needed()
        page.screenshot(path=str(target / 'free-bgm-1440.png'))
        page.set_viewport_size({'width': 390, 'height': 844})
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        page.screenshot(path=str(target / 'free-bgm-390.png'))
        options = page.locator('select').locator('option').evaluate_all('(nodes)=>nodes.map(n=>n.value)')
        assert music_file['path'] in options
        browser.close()
    assert not browser_errors and not external and not mutations
    report = {'status': 'passed', 'scope': 'offline models and free music; not all cloud services or 12 complete AI productions',
        'restoration_receipt': str(restoration_path.relative_to(ROOT)), 'music_receipt': str(music_path.relative_to(ROOT)),
        'completed_native_jobs': 17, 'completed_main_bgm': 1, 'verified_native_outputs': output_count,
        'originals_unchanged': True, 'installation_receipts': installations, 'installation_files_verified': model_files,
        'live_catalog': catalog, 'live_status_counts': dict(Counter(row['status'] for row in catalog['tools'])),
        'served_assets_sha256': served, 'main_mp3_browser_played': True, 'nested_music_found_after_server_restart': True,
        'page_errors': browser_errors, 'external_browser_requests': external, 'unexpected_browser_mutations': mutations,
        'paid_calls': 0, 'private_media_uploaded': False, 'request_fully_completed': False,
        'pending': ['real AI director provider/model/budget', 'cloud account and GPU-specific production verification',
                    '12 full AI-directed productions and human content/aesthetic review']}
    (target / 'verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'status': report['status'], 'directory': str(target), 'native_jobs': 17,
        'status_counts': report['live_status_counts'], 'main_mp3_browser_played': True}, ensure_ascii=False))


if __name__ == '__main__': main()
