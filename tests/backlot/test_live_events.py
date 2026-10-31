"""Exercise real SSE generators without an infinite buffered HTTP response."""
import asyncio
import json
from starlette.requests import Request
from backlot import server as server_mod
from tests.backlot.test_server import projects_root, _make_project


def event_request():
    async def receive():
        return {'type': 'http.request', 'body': b'', 'more_body': False}
    return Request({'type': 'http', 'method': 'GET', 'path': '/', 'headers': []}, receive)


def read_event(raw):
    if isinstance(raw, bytes): raw = raw.decode()
    return json.loads(raw.removeprefix('data: ').strip())


def test_project_feed_survives_changes_and_uses_latest_burst_revision(projects_root, monkeypatch):
    _make_project(projects_root)
    local = server_mod.ChangeHub()
    monkeypatch.setattr(server_mod, 'hub', local)
    async def scenario():
        app = server_mod.create_app()
        route = next(r for r in app.routes if r.path == '/api/project/{project_id}/events')
        response = await route.endpoint('film', event_request())
        stream = response.body_iterator
        try:
            assert read_event(await anext(stream))['type'] == 'hello'
            for _ in range(3): local.publish('film')
            assert read_event(await anext(stream)) == {'type':'change','project_id':'film','revision':3}
            local.publish('film')
            assert read_event(await anext(stream))['revision'] == 4
        finally:
            await stream.aclose()
        assert not local._subscribers
    asyncio.run(scenario())


def test_library_feed_reports_latest_event_after_coalescing_projects(projects_root, monkeypatch):
    local = server_mod.ChangeHub()
    monkeypatch.setattr(server_mod, 'hub', local)
    async def scenario():
        route = next(r for r in server_mod.create_app().routes if r.path == '/api/library/events')
        stream = (await route.endpoint(event_request())).body_iterator
        try:
            assert read_event(await anext(stream))['type'] == 'hello'
            local.publish('film')
            local.publish('other')
            local.publish('other')
            assert read_event(await anext(stream)) == {'type':'change','project_id':'other','revision':2}
        finally:
            await stream.aclose()
        assert not local._subscribers
    asyncio.run(scenario())


def test_project_feed_keeps_filtering_other_projects_and_heartbeat_cleanup(projects_root, monkeypatch):
    _make_project(projects_root)
    local = server_mod.ChangeHub()
    monkeypatch.setattr(server_mod, 'hub', local)
    monkeypatch.setattr(server_mod, 'SSE_HEARTBEAT_SECONDS', .01)
    async def scenario():
        route = next(r for r in server_mod.create_app().routes if r.path == '/api/project/{project_id}/events')
        stream = (await route.endpoint('film', event_request())).body_iterator
        try:
            await anext(stream)
            local.publish('other')
            assert read_event(await asyncio.wait_for(anext(stream), .5))['type'] == 'heartbeat'
        finally:
            await stream.aclose()
        assert not local._subscribers
    asyncio.run(scenario())


def test_workbench_starts_and_stops_its_mounted_app_lifespans(tmp_path, monkeypatch):
    from contextlib import asynccontextmanager
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from backlot import model_adapter
    from web_api.app import create_app as create_task_app
    from tests.backlot.test_model_adapter import FakeTool
    calls = []
    @asynccontextmanager
    async def task_life(app):
        calls.append('task-start')
        try: yield
        finally: calls.append('task-stop')
    @asynccontextmanager
    async def board_life(app):
        calls.append('board-start')
        try: yield
        finally: calls.append('board-stop')
    monkeypatch.setattr(model_adapter, '_load_macos_keychain_secret', lambda **kwargs: False)
    task = create_task_app(FakeTool(), tmp_path/'tasks.sqlite3')
    task.router.lifespan_context = task_life
    app = model_adapter.create_app(task_application=task,
        board_application=FastAPI(lifespan=board_life), project_root=tmp_path/'projects')
    with TestClient(app):
        assert calls == ['task-start', 'board-start']
    assert calls == ['task-start','board-start','board-stop','task-stop']
