"""Actual independent downloads + FFmpeg decoding, only synthetic local media."""
from pathlib import Path
from types import SimpleNamespace
import shutil
import subprocess
import threading

import pytest

import tools.video.direct_clip_search as direct
from tools.video.stock_sources.base import Candidate, SourceAPIError


@pytest.fixture(scope='module')
def media(tmp_path_factory):
    p=tmp_path_factory.mktemp('parallel-download')/'blue.mp4'
    subprocess.run(['ffmpeg','-v','error','-n','-f','lavfi','-i','color=c=blue:s=160x90:r=12:d=2',
                    '-c:v','libx264','-pix_fmt','yuv420p',str(p)],check=True,timeout=20)
    return p


def setup(monkeypatch,tmp_path,media,*,count=5,duration=2,download=None):
    import tools.video.stock_sources as registry
    calls=[]
    def search(query,filters):
        return [Candidate(source='fixture',source_id=str(i),kind='video',duration=duration,
                source_url=f'https://example.test/{i}',download_url=f'https://example.test/{i}.mp4') for i in range(count)]
    def copy(candidate,out):
        calls.append(candidate.source_id)
        if download: return download(candidate,out)
        shutil.copyfile(media,out);return out
    src=SimpleNamespace(name='fixture',is_available=lambda:True,search=search,download=copy)
    monkeypatch.setattr(registry,'all_sources',lambda:[src])
    args={'output_dir':str(tmp_path),'sources':['fixture'],'queries':[{'query':'blue'}],
          'clips_per_query':4,'download_concurrency':2,'extract_thumbnails':False}
    return src,args,calls


@pytest.mark.parametrize('unique,expected_ids,expected_downloads',[(False,['0','0'],1),(True,['0','1'],2)])
def test_cross_query_uniqueness_is_explicit_and_legacy_cache_reuse_survives(monkeypatch,tmp_path,media,unique,expected_ids,expected_downloads):
    src,args,calls=setup(monkeypatch,tmp_path,media,count=2)
    args.update(queries=[{'query':'blue'},{'query':'red'}],clips_per_query=1,unique_across_queries=unique)
    result=direct.DirectClipSearch().execute(args)
    assert result.success,result.error
    assert [row['source_id'] for row in result.data['clips']]==expected_ids
    assert len(calls)==expected_downloads and result.data['distinct_clip_ids']==expected_downloads
    assert result.data['queries_without_clips']==0
    assert len({row['path'] for row in result.data['clips']})==expected_downloads


def test_unique_mode_reports_shortage_instead_of_repeating_only_candidate(monkeypatch,tmp_path,media):
    src,args,calls=setup(monkeypatch,tmp_path,media,count=1)
    args.update(queries=[{'query':'one'},{'query':'two'}],clips_per_query=1,unique_across_queries=True)
    result=direct.DirectClipSearch().execute(args)
    assert result.success and result.data['total_clips']==result.data['distinct_clip_ids']==1
    assert result.data['queries_without_clips']==1 and len(calls)==1
    assert [row['clips_ready'] for row in result.data['coverage']]==[1,0]


def test_real_parallel_downloads_keep_priority_order_and_do_not_schedule_third(monkeypatch,tmp_path,media):
    both=threading.Barrier(2);second_done=threading.Event()
    def download(candidate,out):
        both.wait(timeout=5)
        if candidate.source_id=='0': assert second_done.wait(5)
        else: second_done.set()
        shutil.copyfile(media,out);return out
    src,args,calls=setup(monkeypatch,tmp_path,media,download=download)
    args['clips_per_query']=2
    events=[]
    with direct.stock_progress_context(lambda e:events.append((threading.get_ident(),e))):
        result=direct.DirectClipSearch().execute(args)
    assert result.success,result.error
    assert [row['source_id'] for row in result.data['clips']]==['0','1']
    assert set(calls)=={'0','1'} and len(calls)==2
    ready=[row for ident,row in events if row['phase']=='clip_ready']
    assert len(ready)==2 and [row['clips_ready'] for row in ready]==[1,2]
    assert all(ident==threading.get_ident() for ident,_ in events)
    assert len({Path(c['path']).parent for c in result.data['clips']})==2
    assert len(list(tmp_path.rglob('complete.json')))==2


def test_stop_uses_decoded_duration_instead_of_provider_claim(monkeypatch,tmp_path,media):
    src,args,calls=setup(monkeypatch,tmp_path,media,duration=999)
    args['queries']=[{'query':'blue','required_duration_seconds':5,'max_clip_duration_seconds':2.5}]
    result=direct.DirectClipSearch().execute(args)
    assert result.success,result.error
    assert len(calls)==3 and len(result.data['clips'])==3
    coverage=result.data['coverage'][0]
    assert coverage['verified_usable_seconds']==6
    assert coverage['target_met'] and coverage['missing_seconds']==0
    assert coverage['required_seconds']==5


def test_duration_target_keeps_minimum_diversity_and_reuse_does_not_download_again(monkeypatch,tmp_path,media):
    src,args,calls=setup(monkeypatch,tmp_path,media)
    args['queries']=[{'query':'blue','required_duration_seconds':1,'minimum_clips':2,'max_clip_duration_seconds':1}]
    first=direct.DirectClipSearch().execute(args);second=direct.DirectClipSearch().execute(args)
    assert first.success and second.success
    assert len(calls)==2
    assert first.data['coverage'][0]['clips_ready']==2
    assert second.data['coverage'][0]['verified_usable_seconds']==2
    assert second.data['clips_reused']==2
    assert [c['path'] for c in first.data['clips']]==[c['path'] for c in second.data['clips']]


def test_inflight_success_survives_sibling_timeout_and_is_in_partial_result(monkeypatch,tmp_path,media):
    both=threading.Barrier(2)
    def download(candidate,out):
        both.wait(timeout=5)
        if candidate.source_id=='0': raise direct._DeadlineExceeded('synthetic deadline')
        shutil.copyfile(media,out);return out
    src,args,calls=setup(monkeypatch,tmp_path,media,download=download)
    result=direct.DirectClipSearch().execute(args)
    assert not result.success and result.data['timed_out']
    assert result.data['phase']=='download'
    assert [c['source_id'] for c in result.data['clips']]==['1']
    assert len(calls)==2 and len(list(tmp_path.rglob('complete.json')))==1


def test_rate_limit_stops_new_batches_and_later_queries_not_inflight_success(monkeypatch,tmp_path,media):
    both=threading.Barrier(2)
    def download(candidate,out):
        both.wait(timeout=5)
        if candidate.source_id=='0': raise SourceAPIError('rate_limited')
        shutil.copyfile(media,out);return out
    src,args,calls=setup(monkeypatch,tmp_path,media,download=download)
    args['queries']=[{'query':'first'},{'query':'second'}]
    result=direct.DirectClipSearch().execute(args)
    assert result.success,result.error
    assert len(calls)==2
    assert [c['source_id'] for c in result.data['clips']]==['1']
    assert any(e.get('error_kind')=='rate_limited' for e in result.data['errors'])


def test_failed_bytes_preserved_and_replacement_fills_remaining_quota(monkeypatch,tmp_path,media):
    def download(candidate,out):
        if candidate.source_id=='0':out.write_bytes(b'failed partial fixture');return out
        shutil.copyfile(media,out);return out
    src,args,calls=setup(monkeypatch,tmp_path,media,download=download)
    args['clips_per_query']=2
    result=direct.DirectClipSearch().execute(args)
    assert result.success,result.error
    assert [c['source_id'] for c in result.data['clips']]==['1','2']
    assert len(calls)==3
    assert len(list(tmp_path.rglob('complete.json')))==2
    assert any(p.read_bytes()==b'failed partial fixture' for p in tmp_path.rglob('*.mp4'))


def test_duplicate_candidate_not_downloaded_or_retried_twice(monkeypatch,tmp_path,media):
    src,args,calls=setup(monkeypatch,tmp_path,media)
    original=src.search
    src.search=lambda q,f: [original(q,f)[0],original(q,f)[0],original(q,f)[1]]
    args['clips_per_query']=2
    result=direct.DirectClipSearch().execute(args)
    assert result.success and len(calls)==2 and result.data['candidates_filtered']==1


def test_hard_quota_caps_parallel_launch_even_with_zero_metadata_duration(monkeypatch,tmp_path,media):
    src,args,calls=setup(monkeypatch,tmp_path,media,duration=0)
    args.update(clips_per_query=1,download_concurrency=4)
    result=direct.DirectClipSearch().execute(args)
    assert result.success and calls==['0']


@pytest.mark.parametrize('extra',[{'required_duration_seconds':float('nan')},{'required_duration_seconds':True},
    {'required_duration_seconds':-1},{'minimum_clips':5},{'minimum_clips':True},{'max_clip_duration_seconds':0}])
def test_invalid_coverage_requirements_rejected_before_download(monkeypatch,tmp_path,media,extra):
    src,args,calls=setup(monkeypatch,tmp_path,media)
    args['queries']=[dict(query='blue',**extra)]
    result=direct.DirectClipSearch().execute(args)
    assert not result.success and not calls and not list(tmp_path.iterdir())
