"""Project-scoped stock metadata from the pinned MoneyPrinterTurbo search.

The original provider adapter still performs downloads. Other sources retain
their existing implementation; there is no silent provider/engine fallback.
"""
from __future__ import annotations
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess
import time
import uuid
from urllib.parse import urlsplit

from integrations.moneyprinterturbo.catalog import ROOT, PYTHON
from integrations.moneyprinterturbo.stock_metadata import normalized_metadata, page_metadata
from integrations.moneyprinterturbo.stock_errors import read_failure
from tools.video.stock_sources.base import Candidate

UPSTREAM_PROVIDERS = frozenset(('pexels', 'pixabay_video', 'coverr'))
UPSTREAM_FUNCTIONS = {'pexels':'search_videos_pexels', 'pixabay_video':'search_videos_pixabay',
                      'coverr':'search_videos_coverr'}


def _source_page(value):
    """Public attribution URL only; never persist query credentials/fragments."""
    if not isinstance(value, str):
        return ''
    try:
        url = urlsplit(value)
        if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password:
            return ''
        return url._replace(query='', fragment='').geturl()
    except ValueError:
        return ''

class MoneyPrinterStockSource:
    def __init__(self, source, output_dir, *, deadline, runner=subprocess.run):
        if source.name not in UPSTREAM_PROVIDERS:
            raise ValueError('MoneyPrinterTurbo 不支持该素材来源')
        self.source = source
        self.name = source.name
        self.output_dir = Path(output_dir).resolve()
        self.deadline = deadline
        self.runner = runner

    def is_available(self):
        return self.source.is_available() and PYTHON.is_file()

    def search(self, query, filters):
        if not PYTHON.is_file():
            raise ValueError('MoneyPrinterTurbo 运行环境未安装；未切换其他搜索引擎')
        if filters.kind != 'video':
            raise ValueError('MoneyPrinterTurbo 库存视频搜索只接受视频')
        remaining = self.deadline - time.time()
        if remaining <= 0:
            raise TimeoutError('素材搜索时限已到')
        # Fresh directory: neither a result nor an accepted asset is overwritten.
        output = self.output_dir / 'upstream-search' / uuid.uuid4().hex
        output.mkdir(parents=True, exist_ok=False)
        aspect = {'landscape':'16:9', 'portrait':'9:16', 'square':'1:1'}.get(filters.orientation, '16:9')
        request = {'operation':'stock_search', 'provider':self.name, 'text':query,
                   'minimum_duration':filters.min_duration or 0, 'aspect_ratio':aspect}
        payload = {'project':str(self.output_dir), 'output':str(output), 'request':request}
        process = self.runner([str(PYTHON), str(ROOT / 'integrations/moneyprinterturbo/bridge.py')],
                              input=json.dumps(payload), text=True, stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, timeout=remaining, cwd=str(ROOT))
        result_path = output / 'result.json'
        if process.returncode or not result_path.is_file() or result_path.stat().st_size > 2_000_000:
            raise ValueError('MoneyPrinterTurbo 素材搜索未返回有效结果')
        result = json.loads(result_path.read_text())
        failure = read_failure(result, self.name)
        if failure is not None:
            raise failure
        if not isinstance(result, dict) or result.get('status') != 'completed':
            raise ValueError('MoneyPrinterTurbo 素材搜索未完成；请检查该来源配置与连接')
        if result.get('engine') != 'moneyprinterturbo' or result.get('upstream_function') != UPSTREAM_FUNCTIONS[self.name] or not isinstance(result.get('items'), list):
            raise ValueError('MoneyPrinterTurbo 素材搜索来源回执无效')
        rows = []
        seen = set()
        for item in result.get('items', [])[:100]:
            if not isinstance(item, dict):
                continue
            address = str(item.get('url') or '')
            try:
                url = urlsplit(address)
            except ValueError:
                continue
            if url.scheme != 'https' or not url.hostname or url.username or url.password:
                continue
            if address in seen:
                continue
            info = item.get('source_info') or {}
            if not isinstance(info, dict):
                continue
            rendition = info.get('rendition') or {}
            creator = info.get('creator') or {}
            label = creator.get('name', '') if isinstance(creator, dict) else str(creator)
            identity = str(info.get('asset_id') or hashlib.sha256(address.encode()).hexdigest()[:24])
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,160}', identity):
                identity = hashlib.sha256(address.encode()).hexdigest()[:24]
            try:
                duration = float(item.get('duration') or 0)
                width, height = int(rendition.get('width') or 0), int(rendition.get('height') or 0)
            except (ValueError, TypeError, AttributeError, OverflowError):
                continue
            if not math.isfinite(duration) or duration <= 0 or width < 0 or height < 0:
                continue
            if filters.min_duration is not None and duration < filters.min_duration or filters.max_duration is not None and duration > filters.max_duration or filters.min_width is not None and width < filters.min_width:
                continue
            seen.add(address)
            metadata = normalized_metadata(item.get('source_metadata'))
            if not metadata:
                metadata = page_metadata(self.name, info.get('source_page'))
            extra = {'search_engine':'moneyprinterturbo', 'upstream_function':UPSTREAM_FUNCTIONS[self.name]}
            if metadata:
                extra['metadata_origin'] = metadata['origin']
            rows.append(Candidate(source=self.name, source_id=identity,
                source_url=_source_page(info.get('source_page')), download_url=address, kind='video',
                duration=duration, width=width, height=height, creator=label,
                source_tags=metadata.get('source_tags', ''),
                license={'pexels':'Pexels License', 'pixabay_video':'Pixabay Content License',
                         'coverr':'Coverr License'}[self.name],
                extra=extra))
        return rows

    def download(self, candidate, destination):
        return self.source.download(candidate, destination)
