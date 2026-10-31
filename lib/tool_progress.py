"""Optional task-local telemetry; observers cannot change a tool's outcome."""
from contextlib import contextmanager
from contextvars import ContextVar

_observer = ContextVar('native_tool_progress', default=None)


@contextmanager
def tool_progress_context(callback):
    token = _observer.set(callback)
    try:
        yield
    finally:
        _observer.reset(token)


def report_tool_progress(phase, **values):
    callback = _observer.get()
    if callback is not None:
        try:
            callback({'phase': phase, **values})
        except Exception:
            pass
