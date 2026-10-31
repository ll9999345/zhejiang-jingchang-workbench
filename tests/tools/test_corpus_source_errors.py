"""Source failure handling only; synthetic vectors, no ML inference/network."""
import hashlib
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import numpy as np
import requests

from lib.corpus import Corpus, ClipRecord, EMBED_DIM
from tools.video.corpus_builder import CorpusBuilder
from tools.video.stock_sources.base import SourceSearchResults, source_failure


def test_failed_search_preserves_existing_corpus_and_stops_auth_retries(tmp_path, monkeypatch):
    import tools.video.stock_sources as sources
    corpus = Corpus(tmp_path / 'corpus'); corpus.ensure_dirs()
    media = corpus.clips_dir / 'kept.mp4'; media.write_bytes(b'preserved local fixture')
    item = ClipRecord(clip_id='test_1', source='test', source_id='1', source_url='', local_path='clips/kept.mp4')
    vector = np.zeros(EMBED_DIM, dtype=np.float32)
    corpus.add(item, vector, vector); corpus.save()
    original = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in [media, corpus.index_path, corpus.embed_path, corpus.tag_embed_path]}
    response = requests.Response(); response.status_code = 401
    search = Mock(side_effect=requests.HTTPError('synthetic-private-url-token', response=response))
    source = SimpleNamespace(name='test', search=search, is_available=lambda: True)
    monkeypatch.setattr(sources, 'available_sources', lambda: [source])
    monkeypatch.setattr(sources, 'source_summary', lambda: {})
    result = CorpusBuilder().execute({'corpus_dir': str(corpus.corpus_dir),
        'queries': [{'query': 'forest'}, {'query': 'clouds'}]})
    assert not result.success and result.data['total_corpus_size'] == 1
    assert search.call_count == 1 and result.data['errors'][0]['status_code'] == 401
    assert all(hashlib.sha256(p.read_bytes()).hexdigest() == digest for p, digest in original.items())
    assert 'synthetic-private-url-token' not in str(result.data)


def test_partial_candidates_still_enter_corpus_with_safe_warning(tmp_path, monkeypatch):
    import tools.video.stock_sources as sources
    response = requests.Response(); response.status_code = 500
    failure = source_failure(requests.HTTPError('synthetic-private-body', response=response))
    candidate = SimpleNamespace(clip_id='test_1')
    source = SimpleNamespace(name='test', is_available=lambda: True,
        search=lambda *_: SourceSearchResults([candidate], [failure]))
    monkeypatch.setattr(sources, 'available_sources', lambda: [source])
    monkeypatch.setattr(sources, 'source_summary', lambda: {})
    def process(self, *, cand, corp, **kwargs):
        record = ClipRecord(clip_id=cand.clip_id, source='test', source_id='1', source_url='', local_path='')
        vector = np.zeros(EMBED_DIM, dtype=np.float32)
        corp.add(record, vector, vector)
        return record
    monkeypatch.setattr(CorpusBuilder, '_process_candidate', process)
    result = CorpusBuilder().execute({'corpus_dir': str(tmp_path / 'corpus'), 'queries': [{'query': 'forest'}]})
    assert result.success and result.data['total_corpus_size'] == 1
    assert result.data['clips_added'] == 1 and result.data['errors'][0]['status_code'] == 500
    assert 'synthetic-private-body' not in str(result.data)


def test_processing_auth_failure_does_not_retain_signed_url_or_repeat(tmp_path, monkeypatch):
    import tools.video.stock_sources as sources
    response = requests.Response(); response.status_code = 401
    candidate = SimpleNamespace(clip_id='test_1')
    search = Mock(return_value=[candidate, SimpleNamespace(clip_id='test_2')])
    source = SimpleNamespace(name='test', is_available=lambda: True, search=search)
    monkeypatch.setattr(sources, 'available_sources', lambda: [source])
    monkeypatch.setattr(sources, 'source_summary', lambda: {})
    process = Mock(side_effect=requests.HTTPError('https://example.test/?api_key=synthetic-private-key', response=response))
    monkeypatch.setattr(CorpusBuilder, '_process_candidate', process)
    result = CorpusBuilder().execute({'corpus_dir': str(tmp_path / 'corpus'),
        'queries': [{'query': 'forest'}, {'query': 'clouds'}]})
    assert not result.success and process.call_count == 1 and search.call_count == 1
    assert result.data['errors'][0]['status_code'] == 401
    assert 'synthetic-private-key' not in str(result.data) and 'synthetic-private-key' not in result.error


def test_processing_failure_does_not_describe_existing_corpus_as_empty(tmp_path, monkeypatch):
    import tools.video.stock_sources as sources
    corpus = Corpus(tmp_path / 'corpus'); corpus.ensure_dirs()
    item = ClipRecord(clip_id='kept', source='test', source_id='kept', source_url='', local_path='')
    vector = np.zeros(EMBED_DIM, dtype=np.float32)
    corpus.add(item, vector, vector); corpus.save()
    original = corpus.index_path.read_bytes()
    source = SimpleNamespace(name='test', is_available=lambda: True,
                             search=lambda *_: [SimpleNamespace(clip_id='new')])
    monkeypatch.setattr(sources, 'available_sources', lambda: [source])
    monkeypatch.setattr(sources, 'source_summary', lambda: {})
    monkeypatch.setattr(CorpusBuilder, '_process_candidate', Mock(side_effect=AttributeError('local fixture mismatch')))
    result = CorpusBuilder().execute({'corpus_dir': str(corpus.corpus_dir), 'queries': [{'query': 'forest'}]})
    assert not result.success and result.data['total_corpus_size'] == 1
    assert 'existing corpus preserved' in result.error and 'index is empty' not in result.error
    assert corpus.index_path.read_bytes() == original
