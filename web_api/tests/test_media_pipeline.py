from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from PIL import Image

from tools.base_tool import ToolResult, ToolStatus
from web_api.media_pipeline import create_media_app


async def request(app: FastAPI, method: str, path: str, **kwargs: Any) -> httpx.Response:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.request(method, path, **kwargs)


class FakeImageSelector:
    def __init__(self, available: bool = False) -> None:
        self.available = available
        self.calls: list[dict[str, Any]] = []

    def get_status(self) -> ToolStatus:
        return ToolStatus.AVAILABLE if self.available else ToolStatus.UNAVAILABLE

    def _providers(self) -> list[Any]:
        return []

    def execute(self, inputs: dict[str, Any]) -> ToolResult:
        self.calls.append(dict(inputs))
        if inputs.get("operation") == "rank":
            return ToolResult(success=True, data={"rankings": []})
        return ToolResult(success=False, error="fake image provider unavailable")


def make_project(root: Path, name: str = "demo-project") -> Path:
    project = root / name
    project.mkdir()
    return project


@pytest.mark.asyncio
async def test_capabilities_report_local_subtitle_and_video_status(tmp_path: Path) -> None:
    app = create_media_app(project_root=tmp_path, image_selector=FakeImageSelector())
    project = make_project(tmp_path)
    response = await request(app, "GET", "/api/media/capabilities")
    assert response.status_code == 200
    payload = response.json()
    assert payload["capabilities"]["subtitle"]["status"] == "available"
    assert payload["capabilities"]["video_post"]["status"] == "available"
    assert payload["capabilities"]["image_generation"]["status"] == "unavailable"
    assert payload["capabilities"]["reference_analysis"]["status"] == "available"
    assert project.is_dir()


@pytest.mark.asyncio
async def test_stock_search_dry_run_and_execute_persist_project_assets(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Stock search is a real, confirmed project write rather than a UI stub."""

    project = make_project(tmp_path, "stock-demo")
    app = create_media_app(project_root=tmp_path)

    preview = await request(
        app,
        "POST",
        "/api/media/stock/search",
        json={"project_id": project.name, "queries": ["南北湖晨雾"]},
    )
    assert preview.status_code == 200
    assert preview.json()["status"] == "dry_run"
    assert preview.json()["requires_confirmation"] is True
    assert not (project / "artifacts" / "stock_search_manifest.json").exists()

    class FakeDirectClipSearch:
        def execute(self, inputs: dict[str, Any]) -> ToolResult:
            clips_dir = Path(inputs["output_dir"]) / "clips"
            thumbs_dir = Path(inputs["output_dir"]) / "thumbnails"
            clips_dir.mkdir(parents=True, exist_ok=True)
            thumbs_dir.mkdir(parents=True, exist_ok=True)
            clip = clips_dir / "archive_org_demo.mp4"
            thumbnail = thumbs_dir / "archive_org_demo.jpg"
            clip.write_bytes(b"fake-stock-video")
            thumbnail.write_bytes(b"fake-thumbnail")
            return ToolResult(
                success=True,
                data={
                    "resolved_sources": ["archive_org"],
                    "clips_downloaded": 1,
                    "clips_reused": 0,
                    "clips": [{
                        "clip_id": "archive_org_demo",
                        "source": "archive_org",
                        "kind": "video",
                        "path": str(clip),
                        "thumbnail": str(thumbnail),
                        "license": "Public Domain",
                    }],
                    "errors": [],
                },
            )

    import tools.video.direct_clip_search as direct_clip_search
    monkeypatch.setattr(direct_clip_search, "DirectClipSearch", FakeDirectClipSearch)
    completed = await request(
        app,
        "POST",
        "/api/media/stock/search",
        json={
            "project_id": project.name,
            "queries": ["南北湖晨雾"],
            "sources": ["archive_org"],
            "dry_run": False,
            "execute": True,
            "confirm": True,
        },
    )
    assert completed.status_code == 200
    payload = completed.json()
    assert payload["status"] == "completed"
    assert payload["clip_count"] == 1
    assert payload["clips"][0]["path"] == "assets/stock/clips/archive_org_demo.mp4"
    assert payload["clips"][0]["thumbnail"] == "assets/stock/thumbnails/archive_org_demo.jpg"
    assert (project / "artifacts" / "stock_search_manifest.json").is_file()
    assert (project / "checkpoint_assets.json").is_file()
    manifest = json.loads((project / "artifacts" / "stock_search_manifest.json").read_text(encoding="utf-8"))
    assert manifest["clips"][0]["license"] == "Public Domain"


@pytest.mark.asyncio
async def test_stock_search_requires_confirmation_before_network_write(tmp_path: Path) -> None:
    app = create_media_app(project_root=tmp_path)
    project = make_project(tmp_path, "stock-confirmation-demo")
    response = await request(
        app,
        "POST",
        "/api/media/stock/search",
        json={"project_id": project.name, "queries": ["南北湖"], "dry_run": False, "execute": True},
    )
    assert response.status_code == 400
    assert "confirm=true" in response.json()["detail"]


@pytest.mark.asyncio
async def test_subtitle_dry_run_then_execute_writes_manifest(tmp_path: Path) -> None:
    app = create_media_app(project_root=tmp_path)
    project = make_project(tmp_path)
    body = {
        "project_id": project.name,
        "segments": [
            {"id": "s1", "text": "湖光在晨雾里展开。", "start_seconds": 0, "end_seconds": 2},
            {"id": "s2", "text": "山色沿着湖岸慢慢醒来。", "start_seconds": 2, "end_seconds": 4},
        ],
    }
    preview = await request(app, "POST", "/api/media/subtitles/render", json=body)
    assert preview.status_code == 200
    assert preview.json()["status"] == "dry_run"
    assert not list(project.rglob("subtitles.*"))

    rendered = await request(app, "POST", "/api/media/subtitles/render", json={**body, "dry_run": False, "execute": True})
    assert rendered.status_code == 200
    payload = rendered.json()
    assert payload["status"] == "completed"
    srt = project / "subtitles" / "subtitles.srt"
    vtt = project / "subtitles" / "subtitles.vtt"
    manifest = project / "artifacts" / "subtitle_manifest.json"
    assert srt.is_file() and vtt.is_file() and manifest.is_file()
    assert "湖光" in srt.read_text(encoding="utf-8")
    manifest_payload = json.loads(manifest.read_text(encoding="utf-8"))
    assert manifest_payload["formats"]["srt"]["sha256"] == hashlib.sha256(srt.read_bytes()).hexdigest()


@pytest.mark.asyncio
async def test_media_paths_cannot_escape_project(tmp_path: Path) -> None:
    app = create_media_app(project_root=tmp_path)
    project = make_project(tmp_path)
    response = await request(
        app,
        "POST",
        "/api/media/compose",
        json={"project_id": project.name, "clips": ["../outside.mp4"], "dry_run": False, "execute": True},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "invalid_request"


@pytest.mark.asyncio
async def test_image_render_unavailable_does_not_write_files(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WEB_API_PAID_AUTH_TOKEN", "test-token")
    selector = FakeImageSelector(available=False)
    app = create_media_app(project_root=tmp_path, image_selector=selector)
    project = make_project(tmp_path)
    response = await request(
        app,
        "POST",
        "/api/media/images/render",
        headers={"X-Generation-Authorization": "test-token"},
        json={
            "project_id": project.name,
            "shots": [{"id": "shot-01", "prompt": "南北湖云雾与群山"}],
            "dry_run": False,
            "execute": True,
            "confirm": True,
        },
    )
    assert response.status_code == 200
    assert response.json()["status"] == "unavailable"
    assert not list((project / "assets").rglob("*")) if (project / "assets").exists() else True


@pytest.mark.asyncio
@pytest.mark.skipif(shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None, reason="ffmpeg and ffprobe required")
async def test_compose_local_clips_and_quality_report(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    renders = project / "renders"
    renders.mkdir()
    for index, color in enumerate(("red", "blue"), start=1):
        output = renders / f"clip-{index}.mp4"
        subprocess.run(
            ["ffmpeg", "-y", "-f", "lavfi", "-i", f"color=c={color}:s=160x90:r=12", "-t", "1", "-pix_fmt", "yuv420p", str(output)],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    app = create_media_app(project_root=tmp_path)
    response = await request(
        app,
        "POST",
        "/api/media/compose",
        json={
            "project_id": project.name,
            "clips": ["renders/clip-1.mp4", "renders/clip-2.mp4"],
            "transition": "cut",
            "dry_run": False,
            "execute": True,
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "completed"
    output = project / "renders" / "openmontage-compose.mp4"
    assert output.is_file()
    assert payload["output"]["sha256"] == hashlib.sha256(output.read_bytes()).hexdigest()

    quality = await request(
        app,
        "POST",
        "/api/media/quality",
        json={"project_id": project.name, "media_paths": ["renders/openmontage-compose.mp4"], "execute": True},
    )
    assert quality.status_code == 200
    quality_payload = quality.json()
    assert quality_payload["status"] == "passed"
    quality_row = quality_payload["media"][0]
    assert quality_row["visual_frames"]["valid_count"] >= 1
    assert quality_row["black_frame_check"]["status"] == "passed"
    assert quality_row["audio_check"]["status"] == "not_present"
    assert any("no audio stream" in warning for warning in quality_payload["technical"]["warnings"])
    assert (project / "artifacts" / "media_quality_report.json").is_file()


@pytest.mark.asyncio
@pytest.mark.skipif(shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None, reason="ffmpeg and ffprobe required")
async def test_trim_media_is_previewable_and_persists_verified_segment(tmp_path: Path) -> None:
    project = make_project(tmp_path, "trim-demo")
    source = project / "assets" / "source.mp4"
    source.parent.mkdir(parents=True)
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=12", "-t", "2", "-pix_fmt", "yuv420p", str(source)],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    app = create_media_app(project_root=tmp_path)
    body = {
        "project_id": project.name,
        "input_path": "assets/source.mp4",
        "start_seconds": 0.4,
        "end_seconds": 1.2,
        "output_name": "hero-segment.mp4",
    }
    preview = await request(app, "POST", "/api/media/trim", json=body)
    assert preview.status_code == 200
    assert preview.json()["status"] == "dry_run"
    assert preview.json()["output"]["path"] == "assets/trimmed/hero-segment.mp4"
    assert not (project / "assets" / "trimmed" / "hero-segment.mp4").exists()

    completed = await request(
        app,
        "POST",
        "/api/media/trim",
        json={**body, "dry_run": False, "execute": True},
    )
    assert completed.status_code == 200
    payload = completed.json()
    assert payload["status"] == "completed"
    output = project / "assets" / "trimmed" / "hero-segment.mp4"
    assert output.is_file() and output.stat().st_size > 0
    assert payload["output"]["sha256"] == hashlib.sha256(output.read_bytes()).hexdigest()
    assert 0.6 <= float(payload["output"]["probe"]["duration_seconds"]) <= 1.0
    assert (project / "artifacts" / "trim_manifest.json").is_file()
    assert (project / "checkpoint_edit.json").is_file()


@pytest.mark.asyncio
@pytest.mark.skipif(shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None, reason="ffmpeg and ffprobe required")
async def test_video_postprocess_preview_and_real_local_operations(tmp_path: Path) -> None:
    """Video finishing tools are real local artifacts, not status-only UI."""

    project = make_project(tmp_path, "video-post-demo")
    source = project / "assets" / "source.mp4"
    source.parent.mkdir(parents=True)
    subprocess.run(
        [
            "ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=12",
            "-t", "2", "-pix_fmt", "yuv420p", str(source),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    app = create_media_app(project_root=tmp_path)

    preview = await request(
        app,
        "POST",
        "/api/media/video/postprocess",
        json={
            "project_id": project.name,
            "operation": "auto_reframe",
            "input_path": "assets/source.mp4",
            "target_aspect": "portrait",
            "target_width": 90,
            "target_height": 160,
            "output_name": "portrait.mp4",
        },
    )
    assert preview.status_code == 200
    preview_payload = preview.json()
    assert preview_payload["status"] == "dry_run"
    assert preview_payload["output"]["path"] == "renders/processed/portrait.mp4"
    assert preview_payload["would_write"] is False
    assert not (project / "renders" / "processed" / "portrait.mp4").exists()

    reframed = await request(
        app,
        "POST",
        "/api/media/video/postprocess",
        json={
            "project_id": project.name,
            "operation": "auto_reframe",
            "input_path": "assets/source.mp4",
            "target_aspect": "portrait",
            "target_width": 90,
            "target_height": 160,
            "output_name": "portrait.mp4",
            "dry_run": False,
            "execute": True,
        },
    )
    assert reframed.status_code == 200
    reframed_payload = reframed.json()
    assert reframed_payload["status"] == "completed"
    portrait = project / "renders" / "processed" / "portrait.mp4"
    assert portrait.is_file() and portrait.stat().st_size > 0
    assert reframed_payload["output"]["sha256"] == hashlib.sha256(portrait.read_bytes()).hexdigest()
    assert reframed_payload["output"]["probe"]["video"]["width"] == 90
    assert reframed_payload["output"]["probe"]["video"]["height"] == 160
    assert (project / "artifacts" / "auto_reframe_manifest.json").is_file()
    assert (project / "checkpoint_edit.json").is_file()

    marked = await request(
        app,
        "POST",
        "/api/media/video/postprocess",
        json={
            "project_id": project.name,
            "operation": "silence_cut",
            "mode": "mark",
            "input_path": "assets/source.mp4",
            "output_name": "silence-report.json",
            "dry_run": False,
            "execute": True,
        },
    )
    assert marked.status_code == 200
    marked_payload = marked.json()
    assert marked_payload["status"] == "completed"
    silence_report = project / "analysis" / "silence" / "silence-report.json"
    assert silence_report.is_file()
    report = json.loads(silence_report.read_text(encoding="utf-8"))
    assert report["silences"] == []
    assert (project / "artifacts" / "silence_cut_manifest.json").is_file()

    scenes = await request(
        app,
        "POST",
        "/api/media/video/postprocess",
        json={
            "project_id": project.name,
            "operation": "scene_detect",
            "input_path": "assets/source.mp4",
            "output_name": "scenes.json",
            "dry_run": False,
            "execute": True,
        },
    )
    assert scenes.status_code == 200
    scenes_payload = scenes.json()
    assert scenes_payload["status"] == "completed"
    scene_report = project / "analysis" / "video" / "scenes.json"
    assert scene_report.is_file()
    assert isinstance(json.loads(scene_report.read_text(encoding="utf-8"))["scenes"], list)
    assert (project / "artifacts" / "scene_detect_manifest.json").is_file()
    assert (project / "checkpoint_research.json").is_file()

    graded = await request(
        app,
        "POST",
        "/api/media/video/postprocess",
        json={
            "project_id": project.name,
            "operation": "color_grade",
            "input_path": "assets/source.mp4",
            "profile": "cinematic_warm",
            "intensity": 0,
            "output_name": "neutral.mp4",
            "dry_run": False,
            "execute": True,
        },
    )
    assert graded.status_code == 200
    graded_payload = graded.json()
    assert graded_payload["status"] == "completed"
    assert (project / "renders" / "processed" / "neutral.mp4").is_file()
    assert (project / "artifacts" / "color_grade_manifest.json").is_file()


@pytest.mark.asyncio
async def test_video_postprocess_rejects_mismatched_report_and_video_outputs(tmp_path: Path) -> None:
    project = make_project(tmp_path, "video-post-validation")
    source = project / "assets" / "source.mp4"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"not-a-real-video")
    app = create_media_app(project_root=tmp_path)

    response = await request(
        app,
        "POST",
        "/api/media/video/postprocess",
        json={
            "project_id": project.name,
            "operation": "scene_detect",
            "input_path": "assets/source.mp4",
            "output_name": "scenes.mp4",
        },
    )
    assert response.status_code == 200
    assert response.json()["status"] == "invalid_request"


@pytest.mark.asyncio
@pytest.mark.skipif(shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None, reason="ffmpeg and ffprobe required")
async def test_audio_mix_extract_and_enhance_are_real_project_artifacts(tmp_path: Path) -> None:
    project = make_project(tmp_path, "audio-demo")
    narration = project / "assets" / "audio" / "narration.wav"
    music = project / "assets" / "music" / "bgm.wav"
    narration.parent.mkdir(parents=True)
    music.parent.mkdir(parents=True)
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000", "-t", "1.2", str(narration)],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=16000", "-t", "1.2", str(music)],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    app = create_media_app(project_root=tmp_path)
    preview = await request(
        app,
        "POST",
        "/api/media/audio/mix",
        json={
            "project_id": project.name,
            "operation": "full_mix",
            "tracks": [
                {"path": "assets/audio/narration.wav", "role": "speech"},
                {"path": "assets/music/bgm.wav", "role": "music", "volume": 0.3},
            ],
        },
    )
    assert preview.status_code == 200
    assert preview.json()["status"] == "dry_run"
    assert preview.json()["output"]["path"] == "assets/audio/processed/openmontage-mix.wav"

    mixed = await request(
        app,
        "POST",
        "/api/media/audio/mix",
        json={
            "project_id": project.name,
            "operation": "full_mix",
            "tracks": [
                {"path": "assets/audio/narration.wav", "role": "speech"},
                {"path": "assets/music/bgm.wav", "role": "music", "volume": 0.3},
            ],
            "output_name": "narration-bgm.wav",
            "dry_run": False,
            "execute": True,
        },
    )
    assert mixed.status_code == 200
    mixed_payload = mixed.json()
    assert mixed_payload["status"] == "completed"
    mixed_path = project / "assets" / "audio" / "processed" / "narration-bgm.wav"
    assert mixed_path.is_file() and mixed_payload["output"]["sha256"] == hashlib.sha256(mixed_path.read_bytes()).hexdigest()
    assert (project / "artifacts" / "audio_mix_manifest.json").is_file()

    enhanced = await request(
        app,
        "POST",
        "/api/media/audio/enhance",
        json={
            "project_id": project.name,
            "input_path": "assets/audio/narration.wav",
            "preset": "clean_speech",
            "output_name": "narration-clean.wav",
            "dry_run": False,
            "execute": True,
        },
    )
    assert enhanced.status_code == 200
    enhanced_payload = enhanced.json()
    assert enhanced_payload["status"] == "completed"
    assert (project / "assets" / "audio" / "processed" / "narration-clean.wav").is_file()
    assert (project / "artifacts" / "audio_enhance_manifest.json").is_file()

    extracted_video = project / "renders" / "source.mp4"
    extracted_video.parent.mkdir(parents=True)
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=black:s=160x90:r=12", "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=16000", "-t", "1", "-shortest", str(extracted_video)],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    extracted = await request(
        app,
        "POST",
        "/api/media/audio/mix",
        json={
            "project_id": project.name,
            "operation": "extract",
            "input_path": "renders/source.mp4",
            "output_name": "source-extracted.wav",
            "dry_run": False,
            "execute": True,
        },
    )
    assert extracted.status_code == 200
    assert extracted.json()["status"] == "completed"
    assert (project / "assets" / "audio" / "processed" / "source-extracted.wav").is_file()


@pytest.mark.asyncio
async def test_publish_export_requires_confirmation_and_writes_local_bundle(tmp_path: Path) -> None:
    project = make_project(tmp_path, "publish-demo")
    video = project / "renders" / "final.mp4"
    video.parent.mkdir(parents=True)
    video.write_bytes(b"fake-video")
    subtitles = project / "subtitles" / "final.srt"
    subtitles.parent.mkdir(parents=True)
    subtitles.write_text("1\n00:00:00,000 --> 00:00:01,000\n湖光展开\n", encoding="utf-8")
    app = create_media_app(project_root=tmp_path)
    body = {
        "project_id": project.name,
        "video_path": "renders/final.mp4",
        "title": "南北湖：一阵风去旅行",
        "description": "电影级风景短视频",
        "tags": ["南北湖", "浙江文旅"],
        "subtitles_path": "subtitles/final.srt",
    }

    preview = await request(app, "POST", "/api/media/publish", json=body)
    assert preview.status_code == 200
    assert preview.json()["status"] == "dry_run"
    assert preview.json()["would_write"] is True
    assert not (project / "exports").exists()

    missing_confirmation = await request(
        app,
        "POST",
        "/api/media/publish",
        json={**body, "dry_run": False, "execute": True},
    )
    assert missing_confirmation.status_code == 200
    assert missing_confirmation.json()["status"] == "confirmation_required"

    exported = await request(
        app,
        "POST",
        "/api/media/publish",
        json={**body, "dry_run": False, "execute": True, "confirm": True},
    )
    assert exported.status_code == 200
    payload = exported.json()
    assert payload["status"] == "completed"
    assert payload["upload"]["performed"] is False
    assert (project / "exports" / "video" / "output.mp4").is_file()
    assert (project / "exports" / "video" / "subtitles.srt").is_file()
    log = project / "artifacts" / "publish_log.json"
    assert log.is_file()
    log_payload = json.loads(log.read_text(encoding="utf-8"))
    assert log_payload["entries"][0]["export_path"] == "exports"
    assert (project / "checkpoint_publish.json").is_file()


@pytest.mark.asyncio
@pytest.mark.skipif(shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None, reason="ffmpeg and ffprobe required")
async def test_reference_review_extracts_keyframes_and_research_artifacts(tmp_path: Path) -> None:
    project = make_project(tmp_path, "reference-demo")
    source = project / "assets" / "reference.mp4"
    source.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=8", "-t", "1", "-pix_fmt", "yuv420p", str(source)],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    app = create_media_app(project_root=tmp_path)
    body = {"project_id": project.name, "source": "assets/reference.mp4", "max_keyframes": 3}

    preview = await request(app, "POST", "/api/media/reference/review", json=body)
    assert preview.status_code == 200
    assert preview.json()["status"] == "dry_run"
    assert preview.json()["would_execute"] is True
    assert not (project / "artifacts" / "source_media_review.json").exists()

    completed = await request(
        app,
        "POST",
        "/api/media/reference/review",
        json={**body, "dry_run": False, "execute": True, "confirm": True},
    )
    assert completed.status_code == 200
    payload = completed.json()
    assert payload["status"] == "completed"
    assert payload["source"]["project_path"] == "assets/reference.mp4"
    assert payload["keyframes"]
    assert all((project / item["path"]).is_file() for item in payload["keyframes"])
    review = project / "artifacts" / "source_media_review.json"
    brief = project / "artifacts" / "video_analysis_brief.json"
    assert review.is_file() and brief.is_file() and (project / "checkpoint_research.json").is_file()
    review_payload = json.loads(review.read_text(encoding="utf-8"))
    assert review_payload["analysis_depth"] == "standard"
    assert review_payload["artifacts"]["scenes"]
    assert str(source) not in review.read_text(encoding="utf-8")


@pytest.mark.asyncio
async def test_reference_review_rejects_urls_without_network_opt_in(tmp_path: Path) -> None:
    app = create_media_app(project_root=tmp_path)
    project = make_project(tmp_path, "url-reference-demo")
    response = await request(
        app,
        "POST",
        "/api/media/reference/review",
        json={"project_id": project.name, "source": "https://example.com/reference.mp4"},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "invalid_request"
    assert "URL" in response.json()["error"]


@pytest.mark.asyncio
@pytest.mark.skipif(shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None, reason="ffmpeg and ffprobe required")
async def test_still_images_are_animated_composed_and_manifested(tmp_path: Path) -> None:
    project = make_project(tmp_path, "stills-demo")
    images = project / "assets" / "storyboard"
    images.mkdir(parents=True)
    Image.new("RGB", (160, 90), (220, 120, 50)).save(images / "shot-01.png")
    Image.new("RGB", (160, 90), (40, 120, 190)).save(images / "shot-02.png")
    app = create_media_app(project_root=tmp_path)
    body = {
        "project_id": project.name,
        "images": ["assets/storyboard/shot-01.png", "assets/storyboard/shot-02.png"],
        "default_duration_seconds": 1,
        "transition": "cut",
        "width": 320,
        "height": 180,
        "fps": 12,
        "output_name": "stills-final.mp4",
    }

    preview = await request(app, "POST", "/api/media/stills/compose", json=body)
    assert preview.status_code == 200
    assert preview.json()["status"] == "dry_run"
    assert preview.json()["image_count"] == 2
    assert not (project / "renders" / "stills-final.mp4").exists()

    completed = await request(
        app,
        "POST",
        "/api/media/stills/compose",
        json={**body, "dry_run": False, "execute": True},
    )
    assert completed.status_code == 200
    payload = completed.json()
    assert payload["status"] == "completed"
    assert len(payload["still_clips"]) == 2
    output = project / "renders" / "stills-final.mp4"
    assert output.is_file() and output.stat().st_size > 0
    assert payload["output"]["path"] == "renders/stills-final.mp4"
    assert (project / "artifacts" / "still_composition_manifest.json").is_file()
    manifest = json.loads((project / "artifacts" / "still_composition_manifest.json").read_text(encoding="utf-8"))
    assert manifest["stage"] == "still_image_motion"
    assert manifest["images"][0]["clip_path"].startswith("renders/still_clips/")
    assert (project / "checkpoint_compose.json").is_file()
