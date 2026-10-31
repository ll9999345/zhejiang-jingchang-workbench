"""Host-side public metadata contract, no real stock account or requests."""
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from integrations.moneyprinterturbo.stock_metadata import (
    index_response_metadata, normalized_metadata, page_metadata, public_text,
)


def test_tags_bind_asset_id_and_specific_rendition_and_conflicts_are_empty():
    row = {'id': 101, 'pageURL': 'https://pixabay.com/videos/101/', 'tags': 'forest, trees',
           'videos': {'large': {'url': 'https://example.test/one.mp4'}, 'small': {'url': 'https://example.test/small.mp4'}}}
    index = {}
    index_response_metadata('pixabay_video', {'hits': [row]}, index)
    assert index[('101', 'https://example.test/one.mp4')]['source_tags'] == 'forest, trees'
    assert index[('101', 'https://example.test/small.mp4')]['source_tags'] == 'forest, trees'
    assert ('102', 'https://example.test/one.mp4') not in index
    assert ('101', 'https://example.test/other.mp4') not in index
    other = deepcopy(row); other['tags'] = 'cloud, mist'
    index_response_metadata('pixabay_video', {'hits': [other, row]}, index)
    assert index[('101', 'https://example.test/one.mp4')] == {}


@pytest.mark.parametrize('page', [
    'https://evil.test/video/forest-101/', 'https://pexels.com.evil.test/video/forest-101/',
    'https://user:password@www.pexels.com/video/forest-101/', 'http://www.pexels.com/video/forest-101/',
    'https://www.pexels.com/video/101/', 'https://www.pexels.com/video/forest%3Ftoken%3Dvalue-101/',
    'https://www.pexels.com/photo/forest-101/', 'https://[bad', None,
])
def test_unrelated_or_missing_page_metadata_is_not_guessed(page):
    assert page_metadata('pexels', page) == {}


def test_public_slug_ignores_url_queries_and_retains_unicode_words():
    assert page_metadata('pexels', 'https://www.pexels.com/video/forest-mist-101/?token=excluded#excluded') == {
        'source_tags': 'forest mist', 'origin': 'source_page_slug'}
    assert page_metadata('pixabay_video', 'https://pixabay.com/videos/森林-雾气-101/')['source_tags'] == '森林 雾气'


@pytest.mark.parametrize('value', [None, [], {'origin': []}, {'origin': 'invented', 'source_tags': 'forest'},
                                    {'origin': 'provider_tags', 'source_tags': {'token': 'not-public'}}])
def test_untyped_or_unknown_metadata_is_ignored(value):
    assert normalized_metadata(value) == {}


def test_text_is_bounded_and_does_not_copy_auth_snippets_or_urls():
    assert public_text('forest\x00  mist\n clouds') == 'forest mist clouds'
    assert public_text('forest https://example.test/?token=excluded') == 'forest'
    assert public_text('api_key=excluded') == ''
    assert len(public_text('tree ' * 1000)) <= 1000


def test_native_pexels_uses_current_video_endpoint_and_preserves_photo_endpoint(monkeypatch):
    from tools.video.stock_sources.pexels import PexelsSource
    from tools.video.stock_sources.base import SearchFilters
    monkeypatch.setenv('PEXELS_API_KEY', 'synthetic-offline-key')
    response = SimpleNamespace(raise_for_status=lambda: None, json=lambda: {'videos': [], 'photos': []})
    get = Mock(return_value=response)
    monkeypatch.setattr('requests.get', get)
    source = PexelsSource()
    source.search('trees', SearchFilters(kind='video'))
    assert get.call_args.args[0] == 'https://api.pexels.com/v1/videos/search'
    source.search('trees', SearchFilters(kind='image'))
    assert get.call_args.args[0] == 'https://api.pexels.com/v1/search'
