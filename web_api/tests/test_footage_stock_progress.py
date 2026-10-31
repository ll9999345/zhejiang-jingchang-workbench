"""Real task/API progress during actual local acquisition; no external services."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import threading
import time

from fastapi import FastAPI
from fastapi.testclient import TestClient

from web_api.footage_api import create_footage_router
from web_api.footage_pipeline import FootageJobs
from tools.video.stock_sources.base import Candidate


def test_actual_collection_progress_visible_before_task_returns(tmp_path, monkeypatch):
    import tools.video.stock_sources as registry
    project = tmp_path / 'demo'; project.mkdir()
    media = tmp_path / 'original.mp4'
    subprocess.run(['ffmpeg','-v','error','-n','-f','lavfi','-i','color=c=blue:s=160x90:r=12:d=2',
                    '-c:v','libx264','-pix_fmt','yuv420p',str(media)],check=True,timeout=20)
    before = hashlib.sha256(media.read_bytes()).hexdigest()
    source_barrier = threading.Barrier(2)
    searches = []
    class Source:
        def __init__(self, name): self.name = name
        def is_available(self): return True
        def search(self, query, filters):
            searches.append((self.name, query))
            if len(searches) <= 2: source_barrier.wait(timeout=5)
            return [Candidate(source=self.name, source_id='one', source_tags=query,
                source_url=f'https://example.test/{self.name}/one',
                download_url=f'https://example.test/{self.name}/one.mp4',
                kind='video', duration=2, width=160, height=90)]
        def download(self, candidate, out): shutil.copyfile(media, out); return out
    sources = [Source('wikimedia'), Source('archive_org')]
    monkeypatch.setattr(registry, 'all_sources', lambda: sources)
    monkeypatch.setattr(registry, 'source_catalog', lambda: [{'name':s.name,'status':'available'} for s in sources])
    manager = FootageJobs(tmp_path)
    original_update = manager.update
    ready, release = threading.Event(), threading.Event()
    observations = []
    def update(project_id, job_id, **values):
        result = original_update(project_id, job_id, **values)
        observations.append({'status': result['status'], 'progress':result['progress'],
                             'message':result['message'], 'stock_progress':result.get('stock_progress')})
        if values.get('stock_progress', {}).get('phase') == 'clip_ready' and not ready.is_set():
            ready.set(); assert release.wait(15), 'test must release owned task'
        return result
    monkeypatch.setattr(manager, 'update', update)
    app = FastAPI(); app.include_router(create_footage_router(tmp_path,jobs=manager))
    try:
        with TestClient(app) as client:
            submitted = client.post('/model-api/footage/jobs', json={
                'project_id':'demo', 'topic':'三清山', 'script':'云雾升起。', 'action':'collect',
                'sources':['wikimedia','archive_org'], 'confirm_network':True,
                'options':{'narration':'none','bgm_mode':'none'},
                'shots':[{'id':'one','text':'云雾','query':'Mount Sanqing clouds','duration_seconds':1,'selection_mode':'auto'},
                         {'id':'two','text':'云雾','query':'Mount Sanqing clouds','duration_seconds':1,'selection_mode':'auto'}]})
            assert submitted.status_code == 202, submitted.text
            job = submitted.json()['job_id']
            assert ready.wait(10)
            current = client.get(f'/model-api/footage/jobs/{job}',params={'project_id':'demo'})
            assert current.status_code == 200
            during = current.json()
            assert during['status'] == 'running'
            assert during['stock_progress']['phase'] == 'clip_ready'
            assert during['stock_progress']['clips_ready'] == 1
            assert '已校验 1 个候选' in during['message'] and during['progress'] < 100
            release.set()
            deadline = time.monotonic()+20
            while time.monotonic() < deadline:
                final = client.get(f'/model-api/footage/jobs/{job}',params={'project_id':'demo'}).json()
                if final['status'] != 'running': break
                time.sleep(.03)
            assert final['status'] == 'awaiting_review', final['message']
            assert len({s['source_path'] for s in final['shots']}) == 2
            assert hashlib.sha256(media.read_bytes()).hexdigest() == before
            phases = {row['stock_progress']['phase'] for row in observations if row.get('stock_progress')}
            assert {'search_started','search_completed','download_started','clip_ready'} <= phases
            progress = [row['progress'] for row in observations]
            assert progress == sorted(progress)
            assert len(searches) == 2
            (tmp_path/'actual-progress-receipt.json').write_text(json.dumps({
                'status':'passed','api_status_during':during['status'], 'during':during['stock_progress'],
                'during_message':during['message'],'final_status':final['status'],'phases':sorted(phases),
                'actual_parallel_sources':2,'search_calls':len(searches),'selected_paths':[s['source_path'] for s in final['shots']],
                'original_media_unchanged':True,'real_media_decode':True,'source_http_simulated':True,
                'actual_provider_calls':0,'paid_calls':0,'observations':observations},ensure_ascii=False,indent=2))
    finally:
        release.set(); manager.executor.shutdown(wait=True)
