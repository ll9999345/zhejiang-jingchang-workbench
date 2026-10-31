"""Download preservation using real local media; no provider/network calls."""
import hashlib
import json
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
import requests

from tools.video.direct_clip_search import DirectClipSearch
from tools.video.stock_sources.base import Candidate


@pytest.fixture(scope='module')
def local_video(tmp_path_factory):
    path=tmp_path_factory.mktemp('stock-real-media')/'blue.mp4'
    subprocess.run(['ffmpeg','-v','error','-n','-f','lavfi','-i','color=c=blue:s=160x90:r=12:d=1',
                    '-c:v','libx264','-pix_fmt','yuv420p',str(path)],check=True,timeout=20)
    return path


@pytest.fixture
def setup_source(tmp_path,monkeypatch):
    import tools.video.stock_sources as registry
    item=Candidate(source='fixture',source_id='one',source_url='https://example.test/one',
        download_url='https://example.test/one.mp4',kind='video',duration=1)
    source=SimpleNamespace(name='fixture',is_available=lambda:True,search=Mock(return_value=[item]),download=Mock())
    monkeypatch.setattr(registry,'all_sources',lambda:[source])
    args={'output_dir':str(tmp_path),'queries':[{'query':'blue'}],'sources':['fixture'],
          'extract_thumbnails':False,'clips_per_query':1}
    return source,item,args


def legacy_file(tmp_path,payload):
    path=tmp_path/'clips/fixture_one.mp4';path.parent.mkdir(exist_ok=True);path.write_bytes(payload)
    return path


def test_refresh_failure_never_overwrites_existing_accepted_file(tmp_path,setup_source,local_video):
    source,item,args=setup_source; old=legacy_file(tmp_path,local_video.read_bytes()); before=old.read_bytes()
    def fail(candidate,out): out.write_bytes(b'partial'*500);raise requests.ConnectionError('synthetic interruption')
    source.download.side_effect=fail
    result=DirectClipSearch().execute(dict(args,skip_existing=False))
    assert result.data['clips']==[]
    assert old.read_bytes()==before
    assert any(p.read_bytes()==b'partial'*500 for p in (tmp_path/'clips').rglob('*.mp4') if p!=old)


def test_interrupted_large_download_is_not_reused_as_completed_cache(tmp_path,setup_source):
    source,item,args=setup_source
    def fail(candidate,out): out.write_bytes(b'incomplete'*500);raise requests.ConnectionError('synthetic interruption')
    source.download.side_effect=fail
    first=DirectClipSearch().execute(args);second=DirectClipSearch().execute(args)
    assert first.data['clips']==[] and second.data['clips']==[]
    assert source.download.call_count==2
    assert len([p for p in (tmp_path/'clips').rglob('*.mp4') if p.read_bytes()==b'incomplete'*500])==2


def test_tiny_failed_file_is_retained_not_deleted(tmp_path,setup_source):
    source,item,args=setup_source
    source.download.side_effect=lambda candidate,out:out.write_bytes(b'tiny fixture')
    result=DirectClipSearch().execute(args)
    assert result.data['clips']==[]
    assert any(p.read_bytes()==b'tiny fixture' for p in (tmp_path/'clips').rglob('*') if p.is_file())


def test_html_error_body_is_not_accepted_as_video(tmp_path,setup_source):
    source,item,args=setup_source
    source.download.side_effect=lambda candidate,out:out.write_bytes(b'<html>Access denied</html>'*200)
    result=DirectClipSearch().execute(args)
    assert result.data['clips']==[]
    assert result.data['errors']


def test_decodable_legacy_cache_is_reused_without_download(tmp_path,setup_source,local_video):
    source,item,args=setup_source; old=legacy_file(tmp_path,local_video.read_bytes()); before=old.read_bytes()
    result=DirectClipSearch().execute(args)
    assert result.success,result.error
    assert Path(result.data['clips'][0]['path'])==old
    assert result.data['clips'][0]['skipped_existing'] and source.download.call_count==0
    assert old.read_bytes()==before


def test_corrupt_legacy_cache_is_kept_and_replaced_by_fresh_verified_path(tmp_path,setup_source,local_video):
    source,item,args=setup_source; old=legacy_file(tmp_path,b'broken legacy'*500); before=old.read_bytes()
    source.download.side_effect=lambda candidate,out:shutil.copyfile(local_video,out)
    result=DirectClipSearch().execute(args)
    assert result.success,result.error
    assert not result.data['clips'][0]['skipped_existing']
    fresh=Path(result.data['clips'][0]['path']);assert fresh!=old
    assert fresh.read_bytes()==local_video.read_bytes() and old.read_bytes()==before


def test_verified_download_reuses_receipt_but_not_changed_payload(tmp_path,setup_source,local_video):
    source,item,args=setup_source
    source.download.side_effect=lambda candidate,out:shutil.copyfile(local_video,out)
    first=DirectClipSearch().execute(args);second=DirectClipSearch().execute(args)
    assert first.data['clips'] and second.data['clips']
    assert not first.data['clips'][0]['skipped_existing'] and second.data['clips'][0]['skipped_existing']
    assert source.download.call_count==1
    old=Path(first.data['clips'][0]['path']);old.write_bytes(b'corrupted after commit'*300); before=old.read_bytes()
    third=DirectClipSearch().execute(args)
    assert not third.data['clips'][0]['skipped_existing'] and source.download.call_count==2
    assert Path(third.data['clips'][0]['path'])!=old and old.read_bytes()==before
    receipts=list((tmp_path/'clips').rglob('complete.json'))
    assert len(receipts)==2
    for path in receipts:
        value=json.loads(path.read_text());assert value['clip_id']==item.clip_id
        assert 'http' not in path.read_text()


def test_untrusted_clip_id_cannot_escape_download_root(tmp_path,setup_source,local_video):
    source,item,args=setup_source;item.source_id='../../escaped'
    source.download.side_effect=lambda candidate,out:shutil.copyfile(local_video,out)
    result=DirectClipSearch().execute(args)
    assert result.data['clips']
    path=Path(result.data['clips'][0]['path'])
    assert path.resolve().is_relative_to((tmp_path/'clips').resolve())
    assert not (tmp_path/'escaped.mp4').exists()


def test_small_valid_image_is_accepted_below_old_size_threshold(tmp_path,setup_source):
    from PIL import Image
    source,item,args=setup_source; item.kind='image';item.download_url='https://example.test/one.png'
    image=tmp_path/'blue.png';Image.new('RGB',(32,32),'blue').save(image)
    assert image.stat().st_size<1024
    source.download.side_effect=lambda candidate,out:shutil.copyfile(image,out)
    result=DirectClipSearch().execute(args)
    assert result.data['clips'] and Path(result.data['clips'][0]['path']).read_bytes()==image.read_bytes()


def test_successful_refresh_uses_fresh_path_and_preserves_previous_version(tmp_path,setup_source,local_video):
    source,item,args=setup_source;old=legacy_file(tmp_path,local_video.read_bytes()); before=old.read_bytes()
    source.download.side_effect=lambda candidate,out:shutil.copyfile(local_video,out)
    first=DirectClipSearch().execute(dict(args,skip_existing=False))
    first_path=Path(first.data['clips'][0]['path'])
    second=DirectClipSearch().execute(dict(args,skip_existing=False))
    second_path=Path(second.data['clips'][0]['path'])
    reused=DirectClipSearch().execute(args)
    assert len({old,first_path,second_path})==3
    assert all(path.read_bytes()==before for path in [old,first_path,second_path])
    assert Path(reused.data['clips'][0]['path'])==second_path
    assert source.download.call_count==2


def test_validation_deadline_does_not_commit_or_reuse_attempt(tmp_path,setup_source,local_video,monkeypatch):
    from tools.video import stock_downloads
    source,item,args=setup_source
    source.download.side_effect=lambda candidate,out:shutil.copyfile(local_video,out)
    with monkeypatch.context() as patch:
        patch.setattr(stock_downloads,'validate_media',Mock(side_effect=stock_downloads.DownloadDeadlineExceeded('fixture deadline')))
        first=DirectClipSearch().execute(args)
    assert not first.success and first.data['phase']=='validation' and not first.data['clips']
    assert not list((tmp_path/'clips').rglob('complete.json'))
    second=DirectClipSearch().execute(args)
    assert second.data['clips'] and source.download.call_count==2
    assert len(list((tmp_path/'clips').rglob('*.mp4')))==2


def test_cache_hash_deadline_is_propagated_not_silently_ignored(tmp_path,setup_source,local_video,monkeypatch):
    from tools.video import stock_downloads
    source,item,args=setup_source;source.download.side_effect=lambda candidate,out:shutil.copyfile(local_video,out)
    first=DirectClipSearch().execute(args);assert first.data['clips']
    monkeypatch.setattr(stock_downloads,'_sha256',Mock(side_effect=stock_downloads.DownloadDeadlineExceeded('fixture deadline')))
    second=DirectClipSearch().execute(args)
    assert not second.success and second.data['phase']=='validation'
    assert source.download.call_count==1


def test_symlink_cache_directory_is_refused_without_writing_outside(tmp_path,setup_source):
    source,item,args=setup_source
    outside=tmp_path/'outside';outside.mkdir(); clips=tmp_path/'clips';clips.mkdir()
    (clips/'.verified-stock').symlink_to(outside,target_is_directory=True)
    result=DirectClipSearch().execute(args)
    assert not result.success and source.download.call_count==0
    assert list(outside.iterdir())==[] and (clips/'.verified-stock').is_symlink()


def test_parallel_allocations_are_independent_and_all_versions_remain(tmp_path,local_video):
    from concurrent.futures import ThreadPoolExecutor
    from tools.video.stock_downloads import StockDownloadStore
    import time
    tmp_path.mkdir(exist_ok=True);store=StockDownloadStore(tmp_path)
    def acquire(_):
        path=store.allocate('fixture_one','.mp4');shutil.copyfile(local_video,path)
        store.complete(path,'fixture_one','video',time.time()+20)
        return path
    with ThreadPoolExecutor(max_workers=3) as pool: paths=list(pool.map(acquire,range(3)))
    assert len(set(paths))==3
    assert all(path.read_bytes()==local_video.read_bytes() for path in paths)
    assert len(list(tmp_path.rglob('complete.json')))==3


def test_playlists_are_not_followed_by_the_local_decoder(tmp_path,setup_source):
    source,item,args=setup_source
    source.download.side_effect=lambda candidate,out:out.write_text('#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:1,\nhttps://example.test/private.ts\n#EXT-X-ENDLIST\n')
    result=DirectClipSearch().execute(args)
    assert not result.data['clips'] and result.data['errors'][0]['phase']=='validation'
    assert not list((tmp_path/'clips').rglob('complete.json'))


@pytest.mark.asyncio
@pytest.mark.parametrize('invalid', [False, True])
async def test_actual_workbench_route_keeps_verified_nested_path_playable(tmp_path,setup_source,local_video,monkeypatch,invalid):
    import httpx
    from web_api.media_pipeline import create_media_app
    import backlot.server as server
    import tools.video.stock_sources as registry
    source,item,args=setup_source
    project=tmp_path/'demo';project.mkdir()
    source.download.side_effect=(lambda candidate,out:out.write_bytes(b'<html>denied</html>'*200)) if invalid else (lambda candidate,out:shutil.copyfile(local_video,out))
    monkeypatch.setattr(registry,'source_summary',lambda:{'available_source_names':['fixture']})
    monkeypatch.setattr(server,'PROJECTS_DIR',tmp_path)
    app=create_media_app(project_root=tmp_path);app.mount('/backlot',server.create_app())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
        request={'project_id':'demo','queries':['blue'],'sources':['fixture'],
                 'execute':True,'dry_run':False,'confirm':True,'extract_thumbnails':False,'clips_per_query':1}
        first=await client.post('/api/media/stock/search',json=request);assert first.status_code==200
        result=first.json()
        if invalid:
            assert result['status']=='failed' and '未通过本机校验' in result['message']
            assert not result['clips']
        else:
            assert result['status']=='completed'
            row=result['clips'][0];assert not Path(row['path']).is_absolute()
            assert (project/row['path']).read_bytes()==local_video.read_bytes()
            playback=await client.get('/backlot/media/demo/'+row['path'],headers={'Range':'bytes=0-63'})
            assert playback.status_code==206 and playback.content==local_video.read_bytes()[:64]
            second=(await client.post('/api/media/stock/search',json=request)).json()
            assert second['clips_reused']==1 and second['clips'][0]['path']==row['path']
            assert source.download.call_count==1
        (tmp_path/'api-receipt.json').write_text(json.dumps({'status':'passed',
            'route_status':first.status_code,'business_status':result['status'],'message':result['message'],
            'valid_media':not invalid,'actual_provider_calls':0,'source_http_simulated':True,
            'playback_range_status':None if invalid else playback.status_code},ensure_ascii=False,indent=2))


def test_download_and_reuse_report_measured_dimensions_and_duration(tmp_path,setup_source,local_video):
    source,item,args=setup_source; item.width=1920;item.height=1080;item.duration=99
    source.download.side_effect=lambda candidate,out:shutil.copyfile(local_video,out)
    for _ in range(2):
        result=DirectClipSearch().execute(args); row=result.data['clips'][0]
        assert (row['width'],row['height'])==(160,90)
        assert row['duration']==pytest.approx(1,abs=.02)
    assert source.download.call_count==1
