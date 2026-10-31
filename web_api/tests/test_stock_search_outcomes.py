import json
from pathlib import Path

import pytest

from tools.base_tool import ToolResult
from web_api.media_pipeline import search_stock_media


@pytest.mark.parametrize("errors,expected", [([], "no_results"), ([{"source": "coverr", "phase": "search", "error": "401 Unauthorized"}], "failed")])
def test_empty_results_are_distinguished_from_provider_failure(tmp_path, monkeypatch, errors, expected):
    import tools.video.direct_clip_search as direct
    import tools.video.stock_sources as sources
    project = tmp_path / "demo"
    project.mkdir()
    monkeypatch.setattr(sources, "source_summary", lambda: {"available_source_names": ["nasa"]})
    monkeypatch.setattr(direct.DirectClipSearch, "execute", lambda *_: ToolResult(success=True, data={"clips": [], "errors": errors, "resolved_sources": ["nasa"]}))
    result = search_stock_media({"project_id": "demo", "queries": ["南北湖晨雾"], "sources": ["nasa"], "execute": True, "dry_run": False, "confirm": True}, project_root=tmp_path)
    assert result["status"] == expected
    assert result["message"]
    assert "认证未通过" in result["message"] if errors else "没有找到" in result["message"]
    manifest = json.loads((project / "artifacts/stock_search_manifest.json").read_text())
    assert manifest["status"] == expected


def test_timeout_keeps_already_downloaded_media(tmp_path, monkeypatch):
    import tools.video.direct_clip_search as direct
    import tools.video.stock_sources as sources
    project = tmp_path / "demo"
    clip = project / "assets/stock/clips/test.mp4"
    clip.parent.mkdir(parents=True)
    clip.write_bytes(b"preserved media")
    monkeypatch.setattr(sources, "source_summary", lambda: {"available_source_names": ["nasa"]})
    monkeypatch.setattr(direct.DirectClipSearch, "execute", lambda *_: ToolResult(success=False, error="timeout", data={"clips": [{"path": str(clip), "source": "nasa"}], "resolved_sources": ["nasa"]}))
    result = search_stock_media({"project_id": "demo", "queries": ["moon"], "sources": ["nasa"], "execute": True, "dry_run": False, "confirm": True}, project_root=tmp_path)
    assert result["status"] == "completed"
    assert result["partial"] is True
    assert result["clip_count"] == 1
    assert "超时" in result["message"]
    assert clip.read_bytes() == b"preserved media"
