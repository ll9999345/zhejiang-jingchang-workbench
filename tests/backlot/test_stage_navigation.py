"""Targeted regressions for Backlot stage navigation.

The library and board are deliberately small browser modules rather than a
bundled SPA.  These checks keep their navigation contract explicit without
starting an external model, browser, or production task:

* a project id is URL-encoded at the library boundary;
* a stage is a query deep-link on the same project board, not a path segment;
* deep-links are accepted only when the board state declares the stage;
* activity rows and the rail expose keyboard/focus semantics as well as click
  handlers.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backlot import server as server_mod
from backlot import state as state_mod


REPO_ROOT = Path(__file__).resolve().parents[2]
UI_DIR = REPO_ROOT / "backlot" / "ui"


def _source(name: str) -> str:
    return (UI_DIR / name).read_text(encoding="utf-8")


def test_library_stage_links_keep_project_id_and_stage_in_one_url_contract():
    source = _source("library.js")

    assert "function stageURL(projectId, stageName = null)" in source
    assert "encodeURIComponent(projectId)" in source
    assert "params.set(\"stage\", stageName)" in source
    assert "function stageLinkAction(event, projectId, stageName)" in source
    assert "function activeStageLink(project)" in source
    assert "resume_stage || project.active_stage" in source
    assert "miniRail(p.project_id, p.stage_states)" in source
    # A mini-rail status dot is an accessible link, not only a decorative dot.
    assert 'role: "link"' in source
    assert 'tabindex: "0"' in source
    assert "stageLinkAction(event, projectId, s.name)" in source


def test_board_uses_query_deep_link_and_declared_stage_guard():
    source = _source("board.js")

    assert 'const STAGE_PARAM = "stage"' in source
    assert "function stageURL(stageName)" in source
    assert 'url.searchParams.set(STAGE_PARAM, stageName)' in source
    assert "function focusStage(stageName" in source
    assert "state.stages.some((stage) => stage.name === name)" in source
    assert '"data-stage": st.name' in source
    assert 'role: "button"' in source
    assert '"aria-current": selectedStage === st.name ? "step" : null' in source
    assert "function activityStage(ev, s)" in source
    assert 'class: `act-row${stage ? " act-link" : ""}`' in source
    # A row with no reliable stage mapping remains non-clickable rather than
    # guessing from a scene id and sending the creator to the wrong stage.
    assert "return null;" in source[source.index("function activityStage"):source.index("function renderActivity")]


def test_replay_updates_controls_without_rebuilding_on_every_heartbeat():
    source = _source("board.js")

    assert "function updateReplayControls()" in source
    assert '"data-replay-range": "true"' in source
    assert '"data-replay-toggle": "true"' in source
    assert '"data-replay-point": "true"' in source
    assert "lastRenderedPoint" in source
    assert "const shouldRender = pointIndex !== replay.lastRenderedPoint || !replay.playing;" in source
    # A replay heartbeat must update its transport controls in place when no
    # checkpoint boundary was crossed; a full render is reserved for visible
    # state changes and the terminal frame.
    tick = source[source.index("function tickReplay"):source.index("// ---------------------------------------------------------------------------\n// page assembly")]
    assert "updateReplayControls();" in tick
    assert "if (shouldRender)" in tick


def test_stage_navigation_styles_include_visible_focus_states():
    source = _source("board.css")

    assert ".lib-stage-link" in source
    assert ".mini-rail i[role=\"link\"]:focus-visible" in source
    assert ".act-link:focus-visible" in source
    assert ".stage:focus-visible" in source


@pytest.fixture
def projects_root(tmp_path, monkeypatch):
    root = tmp_path / "projects"
    root.mkdir()
    monkeypatch.setattr(state_mod, "PROJECTS_DIR", root)
    monkeypatch.setattr(server_mod, "PROJECTS_DIR", root)
    monkeypatch.setattr(server_mod, "_summary_cache", {})
    monkeypatch.setattr(server_mod, "_PROJECTS_ROOT_STR", str(root.resolve()))
    monkeypatch.setattr(server_mod, "THUMB_CACHE_DIR", tmp_path / "thumbs")
    return root


@pytest.fixture
def client(projects_root, monkeypatch):
    async def no_watch():
        return None

    monkeypatch.setattr(server_mod, "_watch_projects", no_watch)
    with TestClient(server_mod.create_app()) as test_client:
        yield test_client


def _make_project(root: Path, project_id: str = "stage-demo") -> None:
    project = root / project_id
    (project / "artifacts").mkdir(parents=True)
    (project / "assets" / "images").mkdir(parents=True)
    (project / "assets" / "video").mkdir(parents=True)
    (project / "renders").mkdir(parents=True)
    (project / "project.json").write_text(
        json.dumps({
            "project_id": project_id,
            "title": "Stage navigation fixture",
            "pipeline_type": "cinematic",
        }),
        encoding="utf-8",
    )
    (project / "checkpoint_script.json").write_text(
        json.dumps({
            "version": "1.0",
            "project_id": project_id,
            "pipeline_type": "cinematic",
            "stage": "script",
            "status": "awaiting_human",
            "timestamp": "2026-07-02T00:01:00Z",
            "artifacts": {},
        }),
        encoding="utf-8",
    )


def test_stage_query_stays_on_the_existing_board_route(client, projects_root):
    _make_project(projects_root)

    response = client.get("/p/stage-demo?stage=script")

    assert response.status_code == 200
    assert "/ui/board.js?v=" in response.text
    # The stage is a query parameter consumed by board.js; the server route
    # remains the same project board rather than treating ``script`` as a new
    # project path.
    state = client.get("/api/project/stage-demo/state")
    assert state.status_code == 200
    assert state.json()["project_id"] == "stage-demo"


def test_stage_query_does_not_cross_project_boundaries(client, projects_root):
    _make_project(projects_root, "first-project")
    _make_project(projects_root, "second-project")

    first = client.get("/api/project/first-project/state")
    second = client.get("/api/project/second-project/state")

    assert first.status_code == second.status_code == 200
    assert first.json()["project_id"] == "first-project"
    assert second.json()["project_id"] == "second-project"
    # A stage query cannot change the project id selected by the board URL.
    deep_link = client.get("/p/first-project?stage=script")
    assert deep_link.status_code == 200
    assert "PROJECT NOT FOUND" not in deep_link.text
