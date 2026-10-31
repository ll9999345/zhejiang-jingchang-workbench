"""Mixkit (by Envato) stock video source adapter.

Scrapes the Mixkit website (``mixkit.co``) for free stock video clips.
Mixkit offers curated, high-quality footage (HD and 4K) under a free
licence with no attribution required. The library is smaller than
Pixabay/Pexels but has higher average quality due to Envato's curation.

No API available — this adapter scrapes Mixkit search pages.

What Mixkit is good for
-----------------------
- High-quality curated B-roll (nature, business, technology, lifestyle)
- Clean, modern footage with consistent quality
- No-attribution-needed clips for quick gap-fills
- Nature and landscape establishing shots
"""
from __future__ import annotations

import logging
import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import quote, urljoin

from .base import Candidate, SearchFilters

_log = logging.getLogger(__name__)

_SEARCH_URL = "https://mixkit.co/free-stock-video/"
_LICENSE = "Mixkit License (free for commercial and personal use, no attribution required)"


class MixkitSource:
    """Mixkit video adapter. Satisfies `StockSource`."""

    name = "mixkit"
    display_name = "Mixkit"
    provider = "envato"
    priority = 19
    install_instructions = (
        "Mixkit works without an API key. Scrapes the Mixkit website. "
        "Requires beautifulsoup4: pip install beautifulsoup4"
    )
    supports = {"video": True, "image": False}

    def is_available(self) -> bool:
        try:
            import bs4  # noqa: F401
            return True
        except ImportError:
            return False

    def search(self, query: str, filters: SearchFilters) -> list[Candidate]:
        import requests
        from bs4 import BeautifulSoup

        kind = (filters.kind or "video").lower()
        if kind == "image":
            return []

        # Mixkit documents search pages as /discover/<term>/.  Do not fall
        # back to the category landing page: it returns popular, unrelated
        # clips for unknown terms.
        search_url = f"https://mixkit.co/free-stock-video/discover/{quote(query.strip())}/"

        try:
            r = requests.get(
                search_url,
                timeout=30,
                headers={"User-Agent": "OpenMontage/1.0"},
            )
            r.raise_for_status()
        except Exception as e:
            # Contract: an empty list means "nothing matched", so a
            # transport failure has to propagate. See `base.StockSource`.
            _log.warning("Mixkit search failed: %s", e)
            raise

        soup = BeautifulSoup(r.text, "html.parser")
        out: list[Candidate] = []

        # Mixkit lists video cards with preview videos and download links
        # Current Mixkit pages use `.item-grid-card` directly (the older
        # `.item-grid__item` wrapper is absent on discover/category pages).
        cards = soup.select(
            ".item-grid-card, .item-grid__item, .video-item, article, [class*='VideoCard']"
        )
        for card in cards[:filters.per_page]:
            link_el = card.select_one("a.item-grid-video-player__overlay-link[href], a[href]")
            if not link_el:
                continue

            href = link_el.get("href", "")
            if not href:
                continue
            if not href.startswith("http"):
                href = f"https://mixkit.co{href}"

            # Skip non-video links
            if "/free-stock-video/" not in href and "/video/" not in href:
                continue

            title = ""
            title_el = card.select_one(
                "h3, h2, .title, [class*='title'], "
                ".item-grid-video-player__overlay-video-title"
            )
            if title_el:
                title = title_el.get_text(strip=True)
            if not title:
                title = link_el.get_text(strip=True)

            description = ""
            img_el = card.select_one("img")
            if img_el:
                description = img_el.get("alt", "") or ""
            searchable = f"{title} {description}".strip()
            if not _query_matches(query, searchable):
                _log.info("Mixkit rejected unrelated result %r for %r", title, query)
                continue

            # Thumbnail
            thumb = ""
            if img_el:
                thumb = img_el.get("src", "") or img_el.get("data-src", "") or ""

            # Video preview
            video_el = card.select_one("video source[src], video[src]")
            preview_url = ""
            if video_el:
                preview_url = video_el.get("src", "") or ""

            # Extract ID from URL
            clip_id = href.rstrip("/").rsplit("/", 1)[-1] if href else ""

            out.append(
                Candidate(
                    source=self.name,
                    source_id=f"mixkit_{clip_id}",
                    source_url=href,
                    download_url=href,  # Resolved in download()
                    kind="video",
                    width=0,
                    height=0,
                    duration=0.0,
                    creator="Mixkit",
                    license=_LICENSE,
                    source_tags=searchable,
                    thumbnail_url=thumb,
                    extra={
                        "detail_url": href,
                        "preview_url": preview_url,
                    },
                )
            )

        return out

    def download(self, candidate: Candidate, out_path: Path) -> Path:
        """Download by resolving the detail page for the actual download URL."""
        import requests
        from bs4 import BeautifulSoup

        out_path = Path(out_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)

        detail_url = candidate.extra.get("detail_url", candidate.download_url)

        # Direct media URL
        if any(detail_url.lower().endswith(ext) for ext in (".mp4", ".mov", ".webm")):
            return self._stream_download(detail_url, out_path)

        try:
            r = requests.get(
                detail_url, timeout=30,
                headers={"User-Agent": "OpenMontage/1.0"},
            )
            r.raise_for_status()
            soup = BeautifulSoup(r.text, "html.parser")

            download_url = None

            # The public detail page exposes the downloadable MP4 as
            # VideoObject.contentUrl in JSON-LD. Prefer this documented
            # representation, then use visible video/source attributes.
            for script in soup.select('script[type="application/ld+json"]'):
                try:
                    payload = json.loads(script.string or script.get_text())
                except (TypeError, ValueError):
                    continue
                for obj in _jsonld_objects(payload):
                    url = obj.get("contentUrl") or obj.get("url")
                    if obj.get("@type") == "VideoObject" and _is_video_url(url):
                        download_url = urljoin(detail_url, url)
                        break
                if download_url:
                    break

            # Look for download button/link
            for a in soup.select("a[href]"):
                if download_url:
                    break
                href = a.get("href", "")
                text = (a.get_text(strip=True) or "").lower()
                classes = " ".join(a.get("class", []))
                if "download" in text or "download" in classes:
                    if href and _is_video_url(href):
                        download_url = urljoin(detail_url, href)
                    elif href and "/download/" in href:
                        # A download endpoint is acceptable only when it is
                        # the page's own public link; never synthesize one.
                        download_url = urljoin(detail_url, href)

            # Look for video source tags
            if not download_url:
                for source in soup.select("video source[src]"):
                    src = source.get("src", "")
                    if src and _is_video_url(src):
                        download_url = urljoin(detail_url, src)
                        break

            # Look for data attributes with video URLs
            if not download_url:
                for el in soup.select("[data-video-url], [data-download-url], [data-src]"):
                    url = el.get("data-video-url") or el.get("data-download-url") or el.get("data-src") or ""
                    if url and _is_video_url(url):
                        download_url = urljoin(detail_url, url)
                        break

            if not download_url:
                raise ValueError(f"Could not find download URL on Mixkit page: {detail_url}")

            return self._stream_download(download_url, out_path)

        except Exception as e:
            raise RuntimeError(f"Mixkit download failed for {detail_url}: {e}") from e

    def _stream_download(self, url: str, out_path: Path) -> Path:
        import requests

        with requests.get(
            url, stream=True, timeout=120,
            headers={"User-Agent": "OpenMontage/1.0"},
        ) as r:
            r.raise_for_status()
            with open(out_path, "wb") as f:
                for chunk in r.iter_content(chunk_size=1 << 16):
                    if chunk:
                        f.write(chunk)
        return out_path


def _is_video_url(url: Any) -> bool:
    if not isinstance(url, str) or not url.strip():
        return False
    return bool(re.search(r"\.(?:mp4|mov|webm)(?:[?#].*)?$", url, re.I))


def _jsonld_objects(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, dict):
        items = payload.get("@graph")
        if isinstance(items, list):
            return [x for x in items if isinstance(x, dict)]
        return [payload]
    if isinstance(payload, list):
        return [x for x in payload if isinstance(x, dict)]
    return []


def _query_matches(query: str, text: str) -> bool:
    """Require evidence from the result itself, including CJK queries."""
    q = query.casefold().strip()
    haystack = text.casefold()
    if not q:
        return True
    if q in haystack:
        return True
    cjk = "".join(re.findall(r"[\u3400-\u9fff]", q))
    if cjk:
        # Two-character chunks avoid accepting a generic page for a named
        # place (e.g. 南北湖晨雾) merely because it returned some videos.
        return any(chunk in haystack for chunk in (cjk[i:i + 2] for i in range(len(cjk) - 1)))
    terms = [t for t in re.findall(r"[a-z0-9]+", q) if len(t) > 2]
    return bool(terms) and any(term in haystack for term in terms)
