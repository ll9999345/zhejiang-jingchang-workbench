"""Coherent immutable corpus versions; synthetic vectors and no providers."""
import hashlib
import json
from pathlib import Path

import numpy as np
import pytest

from lib.corpus import Corpus,ClipRecord,EMBED_DIM


def item(identity):
    return ClipRecord(clip_id=identity,source='fixture',source_id=identity,source_url='',local_path=identity+'.mp4')


def add(corpus,identity,value=1):
    vector=np.zeros(EMBED_DIM,dtype=np.float32);vector[0]=value
    corpus.add(item(identity),vector,vector)


def test_failure_writing_second_matrix_keeps_previous_complete_snapshot(tmp_path,monkeypatch):
    corpus=Corpus(tmp_path/'corpus');add(corpus,'old');corpus.save();before=corpus.index_path.read_bytes()
    add(corpus,'new',2)
    original=np.save;calls=[]
    def save(*args,**kwargs):
        calls.append(1)
        if len(calls)==2:raise OSError('synthetic disk interruption')
        return original(*args,**kwargs)
    monkeypatch.setattr(np,'save',save)
    with pytest.raises(OSError):corpus.save()
    restored=Corpus(corpus.corpus_dir);restored.load()
    assert [r.clip_id for r in restored.records]==['old']
    assert restored.index_path.read_bytes()==before
    assert restored.clip_embeddings.shape==restored.tag_embeddings.shape==(1,EMBED_DIM)


def test_stale_writer_does_not_replace_a_newer_commit(tmp_path):
    corpus=Corpus(tmp_path/'corpus');add(corpus,'old');corpus.save()
    first=Corpus(corpus.corpus_dir);first.load();second=Corpus(corpus.corpus_dir);second.load()
    add(first,'first',2);first.save();add(second,'second',3)
    with pytest.raises(RuntimeError,match='changed|stale|conflict'):second.save()
    current=Corpus(corpus.corpus_dir);current.load()
    assert [r.clip_id for r in current.records]==['old','first']


def current(root):
    corpus=Corpus(root);corpus.load();return corpus


def test_committed_versions_remain_immutable_and_paths_follow_loaded_snapshot(tmp_path):
    corpus=Corpus(tmp_path/'corpus');add(corpus,'old');corpus.save()
    paths=[corpus.index_path,corpus.embed_path,corpus.tag_embed_path]
    original={path:path.read_bytes() for path in paths}
    add(corpus,'new',2);corpus.save()
    assert all(path.read_bytes()==data for path,data in original.items())
    assert corpus.index_path not in paths
    assert Corpus(corpus.corpus_dir).index_path==corpus.index_path
    assert len(list((corpus.corpus_dir/'.corpus-commits').glob('*.json')))==2


def test_legacy_migration_preserves_original_three_files(tmp_path):
    from dataclasses import asdict
    root=tmp_path/'legacy';root.mkdir();record=item('old')
    (root/'index.jsonl').write_text(json.dumps(asdict(record))+'\n')
    np.save(root/'embeddings.npy',np.zeros((1,EMBED_DIM),dtype=np.float32))
    np.save(root/'tag_embeddings.npy',np.zeros((1,EMBED_DIM),dtype=np.float32))
    before={path:path.read_bytes() for path in root.iterdir()}
    corpus=current(root);assert corpus.persistence_info['format']=='legacy'
    add(corpus,'new',2);corpus.save()
    assert all(path.read_bytes()==data for path,data in before.items())
    assert [r.clip_id for r in current(root).records]==['old','new']


def test_legacy_mismatch_does_not_silently_truncate_index(tmp_path):
    from dataclasses import asdict
    root=tmp_path/'legacy';root.mkdir()
    (root/'index.jsonl').write_text(json.dumps(asdict(item('old')))+'\n'+json.dumps(asdict(item('new')))+'\n')
    np.save(root/'embeddings.npy',np.zeros((1,EMBED_DIM),dtype=np.float32))
    np.save(root/'tag_embeddings.npy',np.zeros((1,EMBED_DIM),dtype=np.float32))
    before={path:path.read_bytes() for path in root.iterdir()}
    with pytest.raises(ValueError,match='complete corpus'):current(root)
    assert all(path.read_bytes()==data for path,data in before.items())


@pytest.mark.parametrize('target',['index','visual','commit'])
def test_corrupt_latest_version_falls_back_with_explicit_warning(tmp_path,target):
    corpus=Corpus(tmp_path/'corpus');add(corpus,'old');corpus.save();add(corpus,'new',2);corpus.save()
    path=(corpus.index_path if target=='index' else corpus.embed_path if target=='visual' else
          sorted((corpus.corpus_dir/'.corpus-commits').glob('*.json'))[-1])
    # These are synthetic test files; keep an independent original before damage.
    original=tmp_path/'original-damaged-fixture';original.write_bytes(path.read_bytes())
    path.write_bytes(b'synthetic corrupt fixture');damaged=path.read_bytes()
    restored=current(corpus.corpus_dir)
    assert [r.clip_id for r in restored.records]==['old']
    assert restored.persistence_info['recovered'] and restored.persistence_info['warnings']
    assert path.read_bytes()==damaged


def test_all_versions_corrupt_reports_failure_instead_of_empty_success(tmp_path):
    corpus=Corpus(tmp_path/'corpus');add(corpus,'old');corpus.save()
    path=corpus.embed_path;(tmp_path/'original-matrix').write_bytes(path.read_bytes());path.write_bytes(b'invalid')
    with pytest.raises(ValueError,match='complete committed'):current(corpus.corpus_dir)


def test_read_without_load_cannot_overwrite_an_existing_store(tmp_path):
    corpus=Corpus(tmp_path/'corpus');add(corpus,'old');corpus.save()
    unsafe=Corpus(corpus.corpus_dir);add(unsafe,'unloaded')
    with pytest.raises(RuntimeError,match='changed|stale'):unsafe.save()
    assert [r.clip_id for r in current(corpus.corpus_dir).records]==['old']


def test_uncommitted_complete_generation_is_never_selected(tmp_path,monkeypatch):
    import lib.corpus_store as store
    corpus=Corpus(tmp_path/'corpus');add(corpus,'old');corpus.save();add(corpus,'orphan',2)
    original=store.os.rename
    monkeypatch.setattr(store.os,'rename',lambda *args:(_ for _ in ()).throw(OSError('synthetic publish failure')))
    with pytest.raises(OSError):corpus.save()
    monkeypatch.setattr(store.os,'rename',original)
    assert [r.clip_id for r in current(corpus.corpus_dir).records]==['old']
    assert len(list((corpus.corpus_dir/'.corpus-generations').glob('*/commit.pending.json')))==1


def test_symbolic_commit_directory_is_refused_without_external_writes(tmp_path):
    root=tmp_path/'corpus';root.mkdir();outside=tmp_path/'outside';outside.mkdir()
    (root/'.corpus-commits').symlink_to(outside,target_is_directory=True)
    with pytest.raises(ValueError,match='symlink'):Corpus(root)
    assert list(outside.iterdir())==[]


def test_clip_search_surfaces_recovered_version_warning(tmp_path):
    from tools.video.clip_search import ClipSearch
    corpus=Corpus(tmp_path/'corpus');add(corpus,'old');corpus.save();add(corpus,'new',2);corpus.save()
    path=corpus.tag_embed_path;(tmp_path/'original-tags').write_bytes(path.read_bytes());path.write_bytes(b'bad')
    result=ClipSearch().execute({'corpus_dir':str(corpus.corpus_dir),'operation':'stats'})
    assert result.success,result.error
    assert result.data['rows']==1 and result.data['persistence']['recovered']
    assert '上一份完整索引' in result.data['persistence_warning']


@pytest.fixture
def process_worker(tmp_path):
    path=tmp_path/'worker.py'
    path.write_text(r'''
import os,sys,time
from pathlib import Path
import numpy as np
sys.path.insert(0,sys.argv[1])
from lib.corpus import Corpus,ClipRecord,EMBED_DIM
import lib.corpus_store as store
root=Path(sys.argv[2]);mode=sys.argv[3];name=sys.argv[4]
corpus=Corpus(root);corpus.load()
vector=np.ones(EMBED_DIM,dtype=np.float32)
corpus.add(ClipRecord(clip_id=name,source='fixture',source_id=name,source_url='',local_path=name+'.mp4'),vector,vector)
def wait_for(path):
    deadline=time.monotonic()+15
    while not path.exists():
        if time.monotonic()>deadline:raise RuntimeError('test synchronization deadline')
        time.sleep(.02)
original_save=store.np.save;calls=[]
def save(*args,**kwargs):
    calls.append(1)
    if mode=='during_matrix' and len(calls)==2:os._exit(71)
    result=original_save(*args,**kwargs)
    if mode=='pause_matrix' and len(calls)==1:
        (root/'paused').write_text('ready');wait_for(root/'release')
    return result
store.np.save=save
original_rename=store.os.rename
def rename(*args):
    if mode=='before_publish':os._exit(72)
    result=original_rename(*args)
    if mode=='after_publish':os._exit(73)
    return result
store.os.rename=rename
if mode=='race':
    (root/(name+'.ready')).write_text('ready');wait_for(root/'release')
try:corpus.save()
except store.CorpusWriteConflict:sys.exit(17)
''')
    return path


def worker_command(script,root,mode,name):
    import sys
    return [sys.executable,str(script),str(Path(__file__).resolve().parents[2]),str(root),mode,name]


@pytest.mark.parametrize('mode,exit_code,expected',[
    ('during_matrix',71,['old']),('before_publish',72,['old']),('after_publish',73,['old','new'])])
def test_actual_process_exit_never_exposes_mixed_index_and_vectors(tmp_path,process_worker,mode,exit_code,expected):
    import subprocess
    corpus=Corpus(tmp_path/'corpus');add(corpus,'old');corpus.save();old=corpus.index_path;before=old.read_bytes()
    result=subprocess.run(worker_command(process_worker,corpus.corpus_dir,mode,'new'),capture_output=True,timeout=20)
    assert result.returncode==exit_code,result.stderr.decode(errors='replace')
    restored=current(corpus.corpus_dir)
    assert [r.clip_id for r in restored.records]==expected
    assert restored.clip_embeddings.shape==restored.tag_embeddings.shape==(len(expected),EMBED_DIM)
    assert old.read_bytes()==before


def wait_marker(process,path):
    import time
    deadline=time.monotonic()+15
    while not path.exists():
        assert process.poll() is None,'writer exited before synchronization'
        assert time.monotonic()<deadline,'writer synchronization timed out'
        time.sleep(.02)


def test_actual_reader_during_staging_reads_only_previous_complete_version(tmp_path,process_worker):
    import subprocess
    corpus=Corpus(tmp_path/'corpus');add(corpus,'old');corpus.save()
    child=subprocess.Popen(worker_command(process_worker,corpus.corpus_dir,'pause_matrix','new'),stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    wait_marker(child,corpus.corpus_dir/'paused')
    for _ in range(12):
        restored=current(corpus.corpus_dir)
        assert [r.clip_id for r in restored.records]==['old']
        assert restored.clip_embeddings.shape==restored.tag_embeddings.shape==(1,EMBED_DIM)
    (corpus.corpus_dir/'release').write_text('go')
    _,errors=child.communicate(timeout=20);assert child.returncode==0,errors.decode(errors='replace')
    assert len(current(corpus.corpus_dir))==2


def test_actual_concurrent_writers_publish_one_and_reject_stale_other(tmp_path,process_worker):
    import subprocess
    corpus=Corpus(tmp_path/'corpus');add(corpus,'old');corpus.save()
    children=[subprocess.Popen(worker_command(process_worker,corpus.corpus_dir,'race',name),stdout=subprocess.PIPE,stderr=subprocess.PIPE) for name in ['first','second']]
    for child,name in zip(children,['first','second']):wait_marker(child,corpus.corpus_dir/(name+'.ready'))
    (corpus.corpus_dir/'release').write_text('go')
    for child in children:child.communicate(timeout=20)
    assert sorted(child.returncode for child in children)==[0,17]
    restored=current(corpus.corpus_dir)
    assert len(restored)==2 and restored.records[0].clip_id=='old'
    assert restored.records[1].clip_id in {'first','second'}
    assert len(list((corpus.corpus_dir/'.corpus-commits').glob('*.json')))==2


def test_local_importer_refuses_existing_generation_before_touching_media(tmp_path):
    from tools.video.corpus_importer import CorpusImporter
    corpus=Corpus(tmp_path/'corpus');add(corpus,'old');corpus.save()
    before={path:path.read_bytes() for path in corpus.corpus_dir.rglob('*') if path.is_file()}
    result=CorpusImporter().execute({'output_dir':str(corpus.corpus_dir),'files':[]})
    assert not result.success and 'fresh destination' in result.error
    assert all(path.read_bytes()==data for path,data in before.items())


def test_blank_legacy_lines_do_not_misalign_identifier_lookup(tmp_path):
    from dataclasses import asdict
    root=tmp_path/'legacy';root.mkdir()
    (root/'index.jsonl').write_text('\n'+json.dumps(asdict(item('old')))+'\n\n'+json.dumps(asdict(item('new')))+'\n')
    matrix=np.zeros((2,EMBED_DIM),dtype=np.float32);matrix[1,0]=7
    np.save(root/'embeddings.npy',matrix);np.save(root/'tag_embeddings.npy',matrix)
    corpus=current(root)
    assert corpus.get('new').clip_id=='new'
    assert corpus.clip_embeddings[corpus._id_to_row['new'],0]==7


def test_load_binds_revision_to_observed_commit_list_not_later_writer(tmp_path,monkeypatch):
    import lib.corpus_store as store
    writer=Corpus(tmp_path/'corpus');add(writer,'old');writer.save()
    reader=Corpus(writer.corpus_dir)
    original=store._commits;trigger={'active':True}
    def observed(root):
        entries=original(root)
        if trigger['active']:
            trigger['active']=False
            # Commit after this reader has enumerated the old snapshot, but
            # before it captures a revision. These must never be mixed.
            add(writer,'newer',2);writer.save()
        return entries
    monkeypatch.setattr(store,'_commits',observed)
    reader.load();assert [row.clip_id for row in reader.records]==['old']
    add(reader,'stale-reader',3)
    with pytest.raises(RuntimeError,match='changed|stale'):reader.save()
    assert [row.clip_id for row in current(writer.corpus_dir).records]==['old','newer']
