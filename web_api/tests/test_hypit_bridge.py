from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

import web_api.hypit_bridge as bridge
from web_api.footage_pipeline import write_json


@pytest.fixture
def source_project(tmp_path: Path) -> Path:
    project = tmp_path / "openmontage-source"
    media = project / "assets" / "imports"
    media.mkdir(parents=True)
    (media / "main.mp4").write_bytes(b"main-local-media")
    (media / "broll.jpg").write_bytes(b"b-roll-local-media")
    write_json(project / "artifacts/reference_blueprint.json", {
        "reference_id": "reference-local",
        "topic": "本地桥接样例",
        "target_duration": 3.0,
        "shots": [
            {"id": "shot-1", "text": "第一段 @{脚本}||第二句", "duration_seconds": 1.5,
             "source_path": "", "query": ""},
            {"id": "shot-2", "text": "第二段", "duration_seconds": 1.5,
             "source_path": "", "query": ""},
        ],
    })
    write_json(project / "artifacts/footage_draft.json", {
        "shots": [
            {"id": "shot-1", "source_path": "assets/imports/main.mp4",
             "broll_paths": ["assets/imports/broll.jpg"]},
            {"id": "shot-2", "source_path": "assets/imports/main.mp4"},
        ]
    })
    write_json(project / "artifacts/script.json", {"title": "本地桥接", "sections": []})
    write_json(project / "artifacts/footage_settings.json", {
        "aspect_ratio": "9:16", "resolution": 720, "fps": 30,
        "transition": "cut", "language": "zh", "variants": 2,
    })
    return project


def _fake_probe(path: Path) -> dict:
    return {"duration": 1.5, "width": 720, "height": 1280, "has_audio": False, "has_video": True}


def test_long_chinese_caption_preserves_prose_and_prefers_sentence_boundaries():
    text = '欢迎来到浙江。让我们一起看见山水，听见城市的故事。'
    assert bridge._caption_text(text) == '欢迎来到浙江。||让我们一起看见山水，||听见城市的故事。'
    assert bridge._caption_text(text).replace('||', '') == text
    # Also limit unpunctuated prose, without deleting characters.
    assert bridge._caption_text('山' * 25).split('||') == ['山' * 12, '山' * 12, '山']


@pytest.mark.parametrize('text', ['短句。', '欢迎||已经手工分段的文字。',
                                   '第一段 @{标记}第二段', 'Hello, 浙江。', '', None])
def test_caption_auto_break_does_not_reinterpret_authored_or_mixed_text(text):
    assert bridge._caption_text(text) == (text or '')


@pytest.mark.parametrize('ratio', ['16:9','9:16','1:1'])
@pytest.mark.parametrize('resolution', [240,241,360,480,720,721,1080,2160])
def test_new_canvas_is_compatible_with_h264_chroma_dimensions(ratio, resolution):
    width,height = bridge._canvas(bridge.HypitBridgeOptions(aspect_ratio=ratio,resolution=resolution))
    assert width % 2 == height % 2 == 0
    ideal = {'16:9':(resolution*16/9,resolution),
             '9:16':(resolution,resolution*16/9),
             '1:1':(resolution,resolution)}[ratio]
    assert abs(width-ideal[0]) <= 1 and abs(height-ideal[1]) <= 1


def test_copy_export_writes_isolated_author_package_and_provenance(
    source_project: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(bridge, "probe", _fake_probe)
    before = hashlib.sha256((source_project / "artifacts/reference_blueprint.json").read_bytes()).hexdigest()
    package = tmp_path / "hypit-author-package"
    result = bridge.export_hypit_package(
        source_project, package, bridge.HypitBridgeOptions(asset_mode="copy", variant_count=2)
    )

    assert result["status"] == "created"
    for name in ("package.json", "hypit.runtime.json", "reference.svml", "reference.svrun",
                 "reference.svs", "assets.manifest.json", "variants.json", "bridge.manifest.json", "NEEDS.md"):
        assert (package / name).is_file(), name
    assert (package / ".hypit/runtime").read_text() == "hypit.runtime.json\n"
    assert json.loads((package / "package.json").read_text())["name"] == "openmontage-reference"
    manifest = json.loads((package / "assets.manifest.json").read_text())
    assert {asset["role"] for asset in manifest["assets"]} == {"a_roll", "b_roll"}
    assert all(asset["mode"] == "copy" for asset in manifest["assets"])
    assert all(asset["sha256"] for asset in manifest["assets"])
    assert (package / "assets" / "01-shot-1-main.mp4").read_bytes() == b"main-local-media"
    svml = (package / "reference.svml").read_text()
    assert r"\@{" in svml
    assert "||" in svml
    assert 'language="zh"' in svml
    assert json.loads((package / "variants.json").read_text())["count"] == 2
    assert hashlib.sha256((source_project / "artifacts/reference_blueprint.json").read_bytes()).hexdigest() == before


def test_reference_export_uses_symlink_and_records_external_source(
    source_project: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(bridge, "probe", _fake_probe)
    package = tmp_path / "hypit-reference-package"
    bridge.export_hypit_package(
        source_project, package, bridge.HypitBridgeOptions(asset_mode="reference")
    )
    asset = package / "assets" / "01-shot-1-main.mp4"
    assert asset.is_symlink()
    manifest = json.loads((package / "assets.manifest.json").read_text())
    main = next(item for item in manifest["assets"] if item["role"] == "a_roll")
    assert main["mode"] == "reference"
    assert main["reference_target"].endswith("assets/imports/main.mp4")
    assert main["source_project"] == source_project.name


def test_export_refuses_overwrite_and_source_nested_destination(source_project: Path, tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="源项目之外"):
        bridge.export_hypit_package(source_project, source_project / "hypit-package")
    existing = tmp_path / "existing-package"
    existing.mkdir()
    (existing / "keep.txt").write_text("keep")
    with pytest.raises(FileExistsError, match="非空"):
        bridge.export_hypit_package(source_project, existing)


def test_missing_media_is_explicit_and_never_becomes_fake_asset(tmp_path: Path) -> None:
    project = tmp_path / "missing-source"
    (project / "artifacts").mkdir(parents=True)
    write_json(project / "artifacts/reference_blueprint.json", {
        "shots": [{"id": "shot-1", "text": "有脚本", "duration_seconds": 1,
                   "source_path": "assets/does-not-exist.mp4"}]
    })
    write_json(project / "artifacts/footage_draft.json", {"shots": []})
    write_json(project / "artifacts/script.json", {})
    package = tmp_path / "missing-package"
    result = bridge.export_hypit_package(project, package)
    assert result["asset_count"] == 0
    assert any(need["status"] == "missing" for need in result["needs"])
    assert not list((package / "assets").glob("*"))
    assert "不会用参考片或占位结果" not in (package / "NEEDS.md").read_text()
    assert "media-shot-1" in (package / "NEEDS.md").read_text()


def test_outside_media_path_is_rejected_without_package_write(source_project: Path, tmp_path: Path) -> None:
    outside = tmp_path / "outside.mp4"
    outside.write_bytes(b"outside")
    write_json(source_project / "artifacts/footage_draft.json", {
        "shots": [{"id": "shot-1", "source_path": str(outside)}]
    })
    package = tmp_path / "outside-package"
    result = bridge.build_hypit_package(source_project, package)
    assert result["asset_count"] == 0
    assert any(need["status"] == "missing" for need in result["needs"])
    assert not list((package / "assets").glob("*"))
