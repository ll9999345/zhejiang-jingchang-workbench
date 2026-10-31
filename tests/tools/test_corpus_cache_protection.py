"""Add-only cache/corpus behavior. All files live in isolated test directories."""
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from tools.video.clip_cache import ClipCache


def blob(path,content=b'x'*2048):
    path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(content);return path


def test_full_cache_does_not_attempt_deletion(tmp_path,monkeypatch):
    cache=ClipCache(tmp_path/'cache',max_total_bytes=4096)
    source=blob(tmp_path/'one.mp4');assert cache.ingest('one',source)
    second=blob(tmp_path/'two.mp4');assert cache.ingest('two',second)
    attempts=[]
    def refused(path,*args,**kwargs):attempts.append(str(path));raise PermissionError('test forbids deletion')
    monkeypatch.setattr(Path,'unlink',refused)
    third=blob(tmp_path/'three.mp4')
    cache.ingest('three',third)
    assert attempts==[]
    assert set(cache._read_manifest())=={'one','two'}


def test_cache_hit_keeps_existing_destination_without_attempting_delete(tmp_path,monkeypatch):
    import tools.video.clip_cache as module
    cache=ClipCache(tmp_path/'cache');source=blob(tmp_path/'source.mp4');assert cache.ingest('one',source)
    dest=blob(tmp_path/'dest.mp4',b'kept original');before=dest.read_bytes();attempts=[]
    def refused(path,*args,**kwargs):attempts.append(str(path));raise PermissionError('test forbids deletion')
    monkeypatch.setattr(Path,'unlink',refused)
    original=module._link_or_copy
    monkeypatch.setattr(module,'_link_or_copy',lambda src,dst:False if dst.exists() else original(src,dst))
    assert cache.try_link('one',dest) is False
    assert dest.read_bytes()==before and attempts==[]


def test_cache_bytes_are_independent_from_source_and_other_project(tmp_path):
    cache=ClipCache(tmp_path/'cache');source=blob(tmp_path/'source.mp4')
    assert cache.ingest('one',source)
    dest=tmp_path/'other.mp4';assert cache.try_link('one',dest)
    entry=cache._read_manifest()['one'];cached=cache.cache_dir/entry.file_name
    assert source.stat().st_ino!=cached.stat().st_ino!=dest.stat().st_ino
    before=cached.read_bytes();source.write_bytes(b'edited source');dest.write_bytes(b'edited second project')
    assert cached.read_bytes()==before


def test_same_id_refresh_keeps_old_cache_version_and_original_manifest(tmp_path):
    cache=ClipCache(tmp_path/'cache');source=blob(tmp_path/'source.mp4')
    assert cache.ingest('one',source)
    old=cache.cache_dir/cache._read_manifest()['one'].file_name;old_bytes=old.read_bytes()
    old_manifest=cache.manifest_path.read_bytes();other=blob(tmp_path/'other.mp4',b'y'*2048)
    assert cache.ingest('one',other)
    current=cache.cache_dir/cache._read_manifest()['one'].file_name
    assert current!=old and old.read_bytes()==old_bytes and current.read_bytes()==other.read_bytes()
    assert cache.manifest_path.read_bytes().startswith(old_manifest)
    assert len(cache.manifest_path.read_text().splitlines())>=2


def test_corrupt_cache_payload_is_not_reused_or_removed(tmp_path):
    cache=ClipCache(tmp_path/'cache');source=blob(tmp_path/'source.mp4');assert cache.ingest('one',source)
    path=cache.cache_dir/cache._read_manifest()['one'].file_name
    path.write_bytes(b'broken cache'*200);before=path.read_bytes()
    dest=tmp_path/'other.mp4'
    assert not cache.try_link('one',dest) and not dest.exists()
    assert path.read_bytes()==before and 'one' in cache._read_manifest()


def test_untrusted_manifest_path_never_copies_external_file(tmp_path):
    cache=ClipCache(tmp_path/'cache');outside=blob(tmp_path/'outside.mp4')
    cache.manifest_path.write_text(json.dumps({'clip_id':'one','file_name':'../outside.mp4','size_bytes':2048})+'\n')
    assert not cache.try_link('one',tmp_path/'dest.mp4')
    assert not (tmp_path/'dest.mp4').exists() and outside.read_bytes()==b'x'*2048


@pytest.fixture(scope='module')
def actual_media(tmp_path_factory):
    import subprocess
    base=tmp_path_factory.mktemp('corpus-real-media');result={}
    for name,color in [('old','blue'),('new','red')]:
        path=base/(name+'.mp4')
        subprocess.run(['ffmpeg','-v','error','-n','-f','lavfi','-i',f'color=c={color}:s=160x90:r=12:d=1',
                        '-c:v','libx264','-pix_fmt','yuv420p',str(path)],check=True,timeout=20)
        result[name]=path
    return result


@pytest.fixture
def corpus_case(tmp_path,monkeypatch,actual_media):
    import shutil,numpy as np
    import tools.video.stock_sources as sources
    import tools.video.clip_cache as cache_module
    import lib.clip_embedder as embedder
    from lib.corpus import Corpus,ClipRecord,EMBED_DIM
    from tools.video.stock_sources.base import Candidate
    corpus=Corpus(tmp_path/'corpus');corpus.ensure_dirs()
    old=corpus.clips_dir/'fixture_one.mp4';shutil.copyfile(actual_media['old'],old)
    vector=np.zeros(EMBED_DIM,dtype=np.float32)
    corpus.add(ClipRecord(clip_id='fixture_one',source='fixture',source_id='one',source_url='',
        local_path='clips/fixture_one.mp4',width=160,height=90,duration=1),vector,vector);corpus.save()
    cache=ClipCache(tmp_path/'shared-cache')
    item=Candidate(source='fixture',source_id='one',source_url='https://example.test/one',
        download_url='https://example.test/one.mp4',kind='video',duration=1)
    source=SimpleNamespace(name='fixture',is_available=lambda:True,search=Mock(return_value=[item]),
        download=Mock(side_effect=lambda candidate,out:shutil.copyfile(actual_media['new'],out)))
    monkeypatch.setattr(sources,'available_sources',lambda:[source]);monkeypatch.setattr(sources,'source_summary',lambda:{})
    monkeypatch.setattr(cache_module,'get_default_cache',lambda:cache)
    monkeypatch.setattr(embedder,'embed_images',lambda paths:np.zeros((len(paths),EMBED_DIM),dtype=np.float32))
    monkeypatch.setattr(embedder,'embed_texts',lambda texts:np.zeros((len(texts),EMBED_DIM),dtype=np.float32))
    args={'corpus_dir':str(corpus.corpus_dir),'queries':[{'query':'forest'}],'skip_existing':False,'thumbs_per_video':1}
    return corpus,old,cache,source,args


def test_corpus_refresh_failure_preserves_old_media_index_and_vectors(corpus_case):
    import requests
    from tools.video.corpus_builder import CorpusBuilder
    corpus,old,cache,source,args=corpus_case
    before={path:hashlib.sha256(path.read_bytes()).hexdigest() for path in [old,corpus.index_path,corpus.embed_path,corpus.tag_embed_path]}
    def fail(candidate,out):out.write_bytes(b'interrupted fixture'*200);raise requests.ConnectionError('synthetic interruption')
    source.download.side_effect=fail
    result=CorpusBuilder().execute(args)
    assert not result.success
    assert all(hashlib.sha256(path.read_bytes()).hexdigest()==digest for path,digest in before.items())


def test_corpus_successful_refresh_keeps_original_version_and_records_new_path(corpus_case,actual_media):
    from tools.video.corpus_builder import CorpusBuilder
    from lib.corpus import Corpus
    corpus,old,cache,source,args=corpus_case
    old_bytes=old.read_bytes();old_index=corpus.index_path.read_bytes()
    assert cache.ingest('fixture_one',old)
    previous_cache=cache.cache_dir/cache._read_manifest()['fixture_one'].file_name
    result=CorpusBuilder().execute(args)
    assert result.success,result.error
    source.download.assert_called_once()
    assert result.data['clips_added']==0 and result.data['clips_refreshed']==1
    current=Corpus(corpus.corpus_dir);current.load();record=current.records[0]
    fresh=corpus.corpus_dir/record.local_path
    assert fresh!=old and fresh.read_bytes()==actual_media['new'].read_bytes() and old.read_bytes()==old_bytes
    assert previous_cache.read_bytes()==old_bytes
    assert any(p.read_bytes()==old_index for p in (corpus.corpus_dir/'.history').rglob('index.jsonl'))
    assert record.thumb_dir!='thumbnails/fixture_one'


def test_corpus_embedding_failure_retains_previous_media_and_record(corpus_case,monkeypatch):
    import lib.clip_embedder as embedder
    from tools.video.corpus_builder import CorpusBuilder
    corpus,old,cache,source,args=corpus_case;before=old.read_bytes();old_index=corpus.index_path.read_bytes()
    monkeypatch.setattr(embedder,'embed_images',Mock(side_effect=RuntimeError('synthetic local embedding failure')))
    result=CorpusBuilder().execute(args)
    assert not result.success and 'synthetic local embedding failure' in result.error
    assert old.read_bytes()==before and corpus.index_path.read_bytes()==old_index
    assert len(list(corpus.clips_dir.rglob('*.mp4')))==2


def test_interrupted_manifest_row_is_retained_and_new_complete_row_is_readable(tmp_path):
    cache=ClipCache(tmp_path/'cache');assert cache.ingest('one',blob(tmp_path/'one.mp4'))
    with cache.manifest_path.open('ab') as stream:stream.write(b'{"interrupted-row":')
    original=cache.manifest_path.read_bytes()
    assert cache.ingest('two',blob(tmp_path/'two.mp4'))
    assert cache.manifest_path.read_bytes().startswith(original)
    assert set(cache._read_manifest())=={'one','two'}


def test_capacity_includes_retained_old_versions(tmp_path):
    cache=ClipCache(tmp_path/'cache',max_total_bytes=4096)
    assert cache.ingest('one',blob(tmp_path/'one.mp4'))
    assert cache.ingest('one',blob(tmp_path/'new.mp4',b'y'*2048))
    assert not cache.ingest('two',blob(tmp_path/'two.mp4'))
    stats=cache.stats();assert stats['retained_media_bytes']==4096 and stats['entry_count']==1
    assert stats['full_skips_this_session']==1 and stats['evictions_this_session']==0


def test_posix_fallback_lock_uses_no_file_deletion(tmp_path,monkeypatch):
    import os
    if os.name!='posix':pytest.skip('POSIX fallback only')
    import tools.video.clip_cache as module
    monkeypatch.setattr(module,'_HAVE_FILELOCK',False)
    monkeypatch.setattr(Path,'unlink',lambda *a,**k:(_ for _ in ()).throw(AssertionError('no deletion')))
    cache=ClipCache(tmp_path/'cache');assert cache.ingest('one',blob(tmp_path/'one.mp4'))
    assert cache.try_link('one',tmp_path/'other.mp4')
    assert cache.lock_path.is_file() and cache.stats()['filelock_backend']=='posix_flock'


def test_corpus_build_continues_when_optional_shared_cache_is_full(corpus_case):
    from tools.video.corpus_builder import CorpusBuilder
    corpus,old,cache,source,args=corpus_case;cache.max_total_bytes=1
    result=CorpusBuilder().execute(args)
    assert result.success,result.error
    assert result.data['cache_stats']['full_skips_this_session']==1
    assert result.data['clips_added']==0 and result.data['clips_refreshed']==1
    assert old.is_file()


def test_corpus_rejects_bad_shared_media_and_downloads_to_another_fresh_path(corpus_case):
    from tools.video.corpus_builder import CorpusBuilder
    from tools.video.stock_sources.base import Candidate
    corpus,old,cache,source,args=corpus_case
    source.search.return_value=[Candidate(source='fixture',source_id='two',source_url='https://example.test/two',
        download_url='https://example.test/two.mp4',kind='video',duration=1)]
    invalid=blob(corpus.corpus_dir/'synthetic-bad.mp4',b'<html>not media</html>'*100)
    assert cache.ingest('fixture_two',invalid)
    old_cache=cache.cache_dir/cache._read_manifest()['fixture_two'].file_name
    result=CorpusBuilder().execute(dict(args,skip_existing=True))
    assert result.success,result.error
    source.download.assert_called_once()
    assert old_cache.read_bytes()==invalid.read_bytes()
    assert result.data['cache_hits']==0 and result.data['cache_misses']==1
    assert len(list(corpus.clips_dir.rglob('asset.mp4')))==2


def test_failed_cache_copy_is_kept_and_not_given_to_downloader(corpus_case):
    from tools.video.corpus_builder import CorpusBuilder
    from tools.video.stock_sources.base import Candidate
    corpus,old,cache,source,args=corpus_case;partial=[]
    source.search.return_value=[Candidate(source='fixture',source_id='two',source_url='https://example.test/two',
        download_url='https://example.test/two.mp4',kind='video',duration=1)]
    def failed_cache(identity,destination):
        destination.write_bytes(b'partial cache copy');partial.append(destination);return False
    cache.try_link=failed_cache
    result=CorpusBuilder().execute(dict(args,skip_existing=True))
    assert result.success,result.error
    assert partial[0].read_bytes()==b'partial cache copy'
    assert source.download.call_args.args[1]!=partial[0]


def test_corpus_small_image_and_shared_copy_are_accepted(corpus_case,tmp_path):
    from PIL import Image
    import shutil
    from tools.video.corpus_builder import CorpusBuilder
    from tools.video.stock_sources.base import Candidate
    corpus,old,cache,source,args=corpus_case
    image=tmp_path/'tiny.png';Image.new('RGB',(32,32),'blue').save(image)
    assert image.stat().st_size<1024
    source.search.return_value=[Candidate(source='fixture',source_id='image',source_url='https://example.test/image',
        download_url='https://example.test/image.png',kind='image')]
    source.download.side_effect=lambda candidate,out:shutil.copyfile(image,out)
    result=CorpusBuilder().execute(dict(args,skip_existing=True))
    assert result.success,result.error
    assert cache._read_manifest()['fixture_image'].size_bytes==image.stat().st_size


def test_corpus_explicit_replace_rejects_invalid_vectors_before_changing_old_row(tmp_path):
    import numpy as np
    from lib.corpus import Corpus,ClipRecord,EMBED_DIM
    corpus=Corpus(tmp_path/'corpus');vector=np.zeros(EMBED_DIM,dtype=np.float32)
    old=ClipRecord(clip_id='one',source='fixture',source_id='one',source_url='',local_path='old.mp4')
    corpus.add(old,vector,vector)
    new=ClipRecord(clip_id='one',source='fixture',source_id='one',source_url='',local_path='new.mp4')
    with pytest.raises(ValueError):corpus.add(new,vector,np.zeros(2,dtype=np.float32),replace_existing=True)
    assert corpus.get('one') is old and corpus.clip_embeddings.shape==(1,EMBED_DIM)
    # Normal callers retain the original idempotent add behavior.
    corpus.add(new,vector,vector);assert corpus.get('one') is old


def test_successful_refresh_is_partial_success_when_another_candidate_fails(corpus_case):
    from tools.video.corpus_builder import CorpusBuilder
    from tools.video.stock_sources.base import Candidate
    corpus,old,cache,source,args=corpus_case
    original=source.search.return_value[0]
    source.search.return_value=[original,Candidate(source='fixture',source_id='broken',source_url='https://example.test/broken',
        download_url='https://example.test/broken.mp4',kind='video')]
    good=source.download.side_effect
    def download(candidate,out):
        if candidate.source_id=='broken':raise OSError('synthetic local failure')
        return good(candidate,out)
    source.download.side_effect=download
    result=CorpusBuilder().execute(args)
    assert result.success,result.error
    assert result.data['clips_added']==0 and result.data['clips_refreshed']==1 and result.data['clips_failed']==1
