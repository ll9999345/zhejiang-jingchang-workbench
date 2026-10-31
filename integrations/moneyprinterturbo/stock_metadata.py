"""Small public metadata bridge; never infer footage tags from a search query.

This module deliberately uses only the standard library so both isolated MPT
and the host workbench can use the same bounded, explicit field contract.
Metadata supports retrieval; it is not visual or location verification.
"""
from __future__ import annotations

import re
from urllib.parse import unquote, urlsplit

HOSTS = {
    'pexels': {'pexels.com', 'www.pexels.com'},
    'pixabay_video': {'pixabay.com', 'www.pixabay.com'},
    'coverr': {'coverr.co', 'www.coverr.co'},
}
ORIGINS = frozenset({'provider_tags', 'source_page_slug'})


def public_text(value) -> str:
    if not isinstance(value, str):
        return ''
    # Tags are plain text, not a place to retain signed links or auth snippets.
    value = re.sub(r'https?://\S+', '', value[:4000], flags=re.I)
    value = re.sub(r'[\x00-\x1f\x7f]', ' ', value)
    if re.search(r'\b(?:api[_-]?key|access[_-]?token|authorization|password)\s*[:=]', value, re.I):
        return ''
    return ' '.join(value.split())[:1000]


def page_metadata(provider: str, page) -> dict:
    if not isinstance(page, str):
        return {}
    try:
        url = urlsplit(page)
        if url.scheme != 'https' or url.hostname not in HOSTS.get(provider, set()) or url.username or url.password:
            return {}
    except ValueError:
        return {}
    parts = unquote(url.path).strip('/').split('/')
    prefix = 'video' if provider == 'pexels' else 'videos'
    if len(parts) != 2 or parts[0] != prefix:
        return {}
    if any(char in parts[1] for char in '?&#='):
        return {}
    slug = re.sub(r'-?\d+$', '', parts[1])
    text = public_text(slug.replace('-', ' ').replace('_', ' '))
    if not text or text.lower() in {'id', 'video', 'videos', 'clip', 'stock'}:
        return {}
    return {'source_tags': text, 'origin': 'source_page_slug'}


def normalized_metadata(value) -> dict:
    if not isinstance(value, dict) or not isinstance(value.get('origin'), str) or value['origin'] not in ORIGINS:
        return {}
    tags = public_text(value.get('source_tags'))
    return {'source_tags': tags, 'origin': value['origin']} if tags else {}


def index_response_metadata(provider: str, payload: dict, index: dict) -> None:
    """Bind fields to BOTH the provider asset ID and selected rendition URL.

    One search can contain several files per asset. An ID alone or response
    order must not transfer another asset's tags to the selected result.
    Conflicting duplicate rows intentionally contribute no metadata.
    """
    key = 'videos' if provider == 'pexels' else 'hits'
    rows = payload.get(key)
    if not isinstance(rows, list):
        return
    for item in rows[:1000]:
        if not isinstance(item, dict) or not isinstance(item.get('id'), (str, int)) or isinstance(item.get('id'), bool):
            continue
        asset_id = str(item['id'])
        if len(asset_id) > 160:
            continue
        if provider == 'pexels':
            metadata = page_metadata(provider, item.get('url'))
            renditions = item.get('video_files')
            links = [r.get('link') for r in renditions[:100] if isinstance(r, dict)] if isinstance(renditions, list) else []
        elif provider == 'pixabay_video':
            tags = public_text(item.get('tags'))
            metadata = {'source_tags': tags, 'origin': 'provider_tags'} if tags else page_metadata(provider, item.get('pageURL'))
            renditions = item.get('videos')
            links = [r.get('url') for r in list(renditions.values())[:100] if isinstance(r, dict)] if isinstance(renditions, dict) else []
        elif provider == 'coverr':
            metadata = page_metadata(provider, item.get('canonical_url') or item.get('url'))
            urls = item.get('urls')
            links = [urls.get('mp4_download')] if isinstance(urls, dict) else []
        else:
            continue
        for link in links:
            if not isinstance(link, str) or len(link) > 8000:
                continue
            identity = (asset_id, link)
            if identity not in index:
                index[identity] = metadata
            elif index[identity] != metadata:
                index[identity] = {}  # Ambiguous response: do not guess.
