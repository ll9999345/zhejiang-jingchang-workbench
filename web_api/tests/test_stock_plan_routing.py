from tools.base_tool import ToolResult
from web_api.media_pipeline import StockSearchRequest, search_stock_media


def test_default_plan_uses_topic_sources_and_adds_nasa_for_space(tmp_path, monkeypatch):
    import tools.video.stock_sources as sources

    (tmp_path / "demo").mkdir()
    monkeypatch.setattr(
        sources,
        "source_summary",
        lambda: {"available_source_names": ["wikimedia", "archive_org", "mixkit", "pexels", "pixabay_video", "unsplash", "nasa"]},
    )
    ordinary = search_stock_media({"project_id": "demo", "queries": ["南北湖晨雾"]}, project_root=tmp_path)
    space = search_stock_media({"project_id": "demo", "queries": ["moon surface"]}, project_root=tmp_path)
    assert "nasa" not in ordinary["sources"]
    assert space["sources"][-1] == "nasa"


def test_plan_reports_unavailable_when_no_applicable_default_source(tmp_path, monkeypatch):
    import tools.video.stock_sources as sources

    (tmp_path / "demo").mkdir()
    monkeypatch.setattr(sources, "source_summary", lambda: {"available_source_names": ["nasa"]})
    result = search_stock_media({"project_id": "demo", "queries": ["古镇街巷"]}, project_root=tmp_path)
    assert result["would_execute"] is False
    assert result["sources"] == []
    assert "没有满足条件" in result["message"]


def test_query_shot_mapping_reaches_search_and_shot_results(tmp_path, monkeypatch):
    import tools.video.direct_clip_search as direct
    import tools.video.stock_sources as sources

    project = tmp_path / "demo"
    project.mkdir()
    clip = project / "assets/stock/clips/a.mp4"
    clip.parent.mkdir(parents=True)
    clip.write_bytes(b"candidate")
    monkeypatch.setattr(sources, "source_summary", lambda: {"available_source_names": ["wikimedia"]})
    captured = {}

    def fake_execute(_, inputs):
        captured.update(inputs)
        return ToolResult(success=True, data={"clips": [{"path": str(clip), "slot_id": "shot-1,shot-2"}], "resolved_sources": ["wikimedia"]})

    monkeypatch.setattr(direct.DirectClipSearch, "execute", fake_execute)
    result = search_stock_media(
        {"project_id": "demo", "queries": ["harbor"], "query_shot_ids": [["shot-1", "shot-2"]], "execute": True, "dry_run": False, "confirm": True},
        project_root=tmp_path,
    )
    assert captured["queries"][0]["slot_id"] == "shot-1,shot-2"
    assert result["clips"][0]["shot_ids"] == ["shot-1", "shot-2"]
    assert all(item["candidates_found"] and not item["missing"] for item in result["shot_results"])


def test_query_shot_ids_must_match_query_count():
    try:
        StockSearchRequest(project_id="demo", queries=["a", "b"], query_shot_ids=[["shot-1"]])
    except ValueError as exc:
        assert "one entry per query" in str(exc)
    else:
        raise AssertionError("mismatched query_shot_ids should be rejected")
