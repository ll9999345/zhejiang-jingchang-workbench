"""Small standard-library failure contract shared by worker and host.

Only an actual status code and a fixed category cross the process boundary.
Provider bodies, URLs, headers, exception strings and credentials do not.
"""
from __future__ import annotations

ERROR_KINDS = frozenset({'api_error', 'rate_limited', 'temporarily_unavailable',
                         'permission_denied', 'invalid_response', 'connection_failed', 'timeout'})
FUNCTIONS = {'pexels': 'search_videos_pexels', 'pixabay_video': 'search_videos_pixabay',
             'coverr': 'search_videos_coverr'}


def valid_status(value):
    return isinstance(value, int) and not isinstance(value, bool) and 100 <= value <= 599


def http_kind(status):
    return {401: 'permission_denied', 403: 'permission_denied', 429: 'rate_limited',
            503: 'temporarily_unavailable'}.get(status)


class StockSearchError(ValueError):
    def __init__(self, provider, *, status_code=None, error_kind='api_error'):
        self.provider = provider if provider in FUNCTIONS else ''
        self.status_code = status_code if valid_status(status_code) else None
        self.error_kind = http_kind(self.status_code) or (error_kind if error_kind in ERROR_KINDS else 'api_error')
        super().__init__('stock source request failed')

    def receipt(self):
        failure = {'schema_version': 1, 'error_kind': self.error_kind}
        if self.status_code is not None:
            failure['status_code'] = self.status_code
        return {'engine': 'moneyprinterturbo', 'provider': self.provider,
                'upstream_function': FUNCTIONS.get(self.provider, ''), 'failure': failure}


def transport_error(provider, error):
    if isinstance(error, StockSearchError):
        return error
    status = getattr(getattr(error, 'response', None), 'status_code', None)
    names = {cls.__name__ for cls in type(error).__mro__}
    kind = ('timeout' if names & {'Timeout', 'TimeoutError', 'ReadTimeout', 'ConnectTimeout', 'TimeoutExpired'} else
            'connection_failed' if names & {'ConnectionError', 'ConnectionResetError', 'SSLError'} else 'api_error')
    return StockSearchError(provider, status_code=status, error_kind=kind)


def read_failure(result, provider):
    """Return a typed failure only for this exact worker/provider contract."""
    if (not isinstance(result, dict) or result.get('status') != 'failed' or
            result.get('engine') != 'moneyprinterturbo' or result.get('provider') != provider or
            result.get('upstream_function') != FUNCTIONS.get(provider)):
        return None
    failure = result.get('failure')
    if not isinstance(failure, dict) or type(failure.get('schema_version')) is not int or failure['schema_version'] != 1:
        return None
    kind = failure.get('error_kind')
    if not isinstance(kind, str) or kind not in ERROR_KINDS:
        return None
    status = failure.get('status_code')
    if 'status_code' in failure and not valid_status(status):
        return None
    if http_kind(status) and kind != http_kind(status):
        return None
    return StockSearchError(provider, status_code=status, error_kind=kind)
