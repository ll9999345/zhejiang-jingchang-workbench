from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from backlot.model_adapter import create_app as create_model_app
from tools.base_tool import ToolResult, ToolStatus
from web_api.app import create_app as create_task_app
from web_api.media_pipeline import create_media_app


async def request(app: FastAPI, method: str, path: str, **kwargs: Any) -> httpx.Response:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.request(method, path, **kwargs)


class FakeTranscriber:
    name = "fake_transcriber"
    provider = "fake-whisper"
    dependencies = ["test:faster-whisper"]
    install_instructions = "test provider"
    capabilities = ["transcribe", "word_timestamps"]

    def __init__(self, *, available: bool = True) -> None:
        self.available = available
        self.calls: list[dict[str, Any]] = []

    def get_status(self) -> ToolStatus:
        return ToolStatus.AVAILABLE if self.available else ToolStatus.UNAVAILABLE

    def get_info(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "provider": self.provider,
            "status": self.get_status().value,
            "dependencies": self.dependencies,
            "install_instructions": self.install_instructions,
            "capabilities": self.capabilities,
        }

    def execute(self, inputs: dict[str, Any]) -> ToolResult:
        self.calls.append(dict(inputs))
        if not self.available:
            return ToolResult(success=False, error="faster-whisper is not installed")
        output_dir = Path(inputs["output_dir"])
        output_dir.mkdir(parents=True, exist_ok=True)
        provider_json = output_dir / "source_transcript.json"
        provider_json.write_text(json.dumps({"provider": "fake"}), encoding="utf-8")
        return ToolResult(
            success=True,
            data={
                "segments": [
                    {
                        "id": 1,
                        "start": 0.0,
                        "end": 1.25,
                        "text": "湖光从晨雾里展开。",
                        "words": [
                            {"word": "湖光", "start": 0.0, "end": 0.45},
                            {"word": "从晨雾里展开。", "start": 0.45, "end": 1.25},
                        ],
                    },
                    {"id": 2, "start": 1.25, "end": 2.8, "text": "山色沿着湖岸慢慢醒来。"},
                ],
                "language": "zh",
                "duration_seconds": 2.8,
                "model_size": "tiny",
            },
            artifacts=[str(provider_json)],
        )


def make_project(root: Path, name: str = "nanbeihu-demo") -> Path:
    project = root / name
    (project / "assets" / "video").mkdir(parents=True)
    (project / "assets" / "video" / "source.wav").write_bytes(b"test-media")
    return project


@pytest.mark.asyncio
async def test_transcription_dry_run_then_confirmed_execute_writes_truthful_artifacts(tmp_path: Path) -> None:
    transcriber = FakeTranscriber()
    app = create_media_app(project_root=tmp_path, transcriber=transcriber)
    project = make_project(tmp_path)
    body = {"project_id": project.name, "media_path": "assets/video/source.wav", "model_size": "tiny"}

    preview = await request(app, "POST", "/api/media/transcribe", json=body)
    assert preview.status_code == 200
    preview_payload = preview.json()
    assert preview_payload["status"] == "dry_run"
    assert preview_payload["transcriber"]["status"] == "available"
    assert preview_payload["would_execute"] is True
    assert transcriber.calls == []
    assert not (project / "transcripts").exists()

    missing_confirmation = await request(
        app,
        "POST",
        "/api/media/transcribe",
        json={**body, "dry_run": False, "execute": True},
    )
    assert missing_confirmation.status_code == 400
    assert transcriber.calls == []

    rendered = await request(
        app,
        "POST",
        "/api/media/transcribe",
        json={**body, "dry_run": False, "execute": True, "confirm": True},
    )
    assert rendered.status_code == 200
    payload = rendered.json()
    assert payload["status"] == "completed"
    assert payload["segment_count"] == 2
    assert payload["duration_seconds"] == 2.8
    assert len(transcriber.calls) == 1

    transcript = project / payload['files']['json']['path']
    srt = project / payload['files']['srt']['path']
    vtt = project / payload['files']['vtt']['path']
    provider_json = project / payload['files']['provider_json']['path']
    manifest = project / "artifacts" / "transcript_manifest.json"
    assert transcript.is_file() and srt.is_file() and vtt.is_file() and provider_json.is_file() and manifest.is_file()
    assert "湖光" in transcript.read_text(encoding="utf-8")
    assert "湖光" in srt.read_text(encoding="utf-8")
    assert "WEBVTT" in vtt.read_text(encoding="utf-8")
    manifest_payload = json.loads(manifest.read_text(encoding="utf-8"))
    assert manifest_payload["stage"] == "transcription"
    assert manifest_payload["source_media"]["sha256"] == hashlib.sha256((project / "assets/video/source.wav").read_bytes()).hexdigest()
    assert manifest_payload["outputs"]["srt"]["sha256"] == hashlib.sha256(srt.read_bytes()).hexdigest()
    events = [json.loads(line) for line in (project / "events.jsonl").read_text(encoding="utf-8").splitlines()]
    assert any(event.get("event") == "transcription" and event.get("status") == "completed" for event in events)


@pytest.mark.asyncio
async def test_rerun_retains_legacy_files_previous_run_and_manifest(tmp_path):
    fake = FakeTranscriber()
    app = create_media_app(project_root=tmp_path, transcriber=fake)
    project = make_project(tmp_path)
    (project / 'transcripts').mkdir()
    old_subtitle = project / 'transcripts/source.srt'
    old_subtitle.write_text('accepted original subtitle', encoding='utf-8')
    (project / 'artifacts').mkdir()
    old_manifest = b'{"accepted_before_upgrade":true}'
    (project / 'artifacts/transcript_manifest.json').write_bytes(old_manifest)
    body = {'project_id':project.name, 'media_path':'assets/video/source.wav',
            'dry_run':False, 'execute':True, 'confirm':True}
    first = (await request(app, 'POST', '/api/media/transcribe', json=body)).json()
    hashes = {r['path']:hashlib.sha256((project/r['path']).read_bytes()).hexdigest() for r in first['files'].values()}
    immutable = (project / first['run_manifest']['path']).read_bytes()
    second = (await request(app, 'POST', '/api/media/transcribe', json=body)).json()
    assert first['status'] == second['status'] == 'completed'
    assert first['files']['json']['path'] != second['files']['json']['path']
    assert all(hashlib.sha256((project/name).read_bytes()).hexdigest() == digest for name,digest in hashes.items())
    assert (project / first['run_manifest']['path']).read_bytes() == immutable
    assert old_subtitle.read_text() == 'accepted original subtitle'
    assert any(p.read_bytes() == old_manifest for p in (project/'artifacts').glob('transcript_manifest_preserved_*.json'))


@pytest.mark.asyncio
async def test_requested_diarization_is_blocked_before_recognition_or_writing(tmp_path):
    fake = FakeTranscriber()
    app = create_media_app(project_root=tmp_path, transcriber=fake)
    project = make_project(tmp_path)
    body = {'project_id':project.name, 'media_path':'assets/video/source.wav', 'diarize':True}
    plan = (await request(app, 'POST', '/api/media/transcribe', json=body)).json()
    assert not plan['would_execute'] and '说话人' in plan['error']
    result = (await request(app, 'POST', '/api/media/transcribe', json={**body,'dry_run':False,'execute':True,'confirm':True})).json()
    assert result['status'] == 'unavailable' and not fake.calls
    assert not (project/'transcripts').exists()


@pytest.mark.asyncio
async def test_chinese_alignment_budget_is_time_bounded_before_model_runs(tmp_path, monkeypatch):
    fake = FakeTranscriber()
    app = create_media_app(project_root=tmp_path, transcriber=fake)
    project = make_project(tmp_path)
    monkeypatch.setattr('web_api.media_pipeline._probe_media', lambda path: {'duration_seconds':121,'audio':{'codec':'pcm_s16le'}})
    monkeypatch.setattr('tools.analysis.transcript_aligner.alignment_ready', lambda:True)
    body = {'project_id':project.name, 'media_path':'assets/video/source.wav', 'alignment':'whisperx_zh'}
    plan = (await request(app, 'POST', '/api/media/transcribe', json=body)).json()
    assert not plan['would_execute'] and '120' in plan['error']
    body['language'] = 'en'
    plan = (await request(app, 'POST', '/api/media/transcribe', json=body)).json()
    assert not plan['would_execute'] and 'zh' in plan['error'] and not fake.calls


@pytest.mark.asyncio
async def test_unavailable_transcriber_is_explicit_and_writes_nothing(tmp_path: Path) -> None:
    transcriber = FakeTranscriber(available=False)
    app = create_media_app(project_root=tmp_path, transcriber=transcriber)
    project = make_project(tmp_path)
    body = {
        "project_id": project.name,
        "media_path": "assets/video/source.wav",
        "dry_run": False,
        "execute": True,
        "confirm": True,
    }
    response = await request(app, "POST", "/api/media/transcribe", json=body)
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "unavailable"
    assert "faster-whisper" in payload["error"]
    assert transcriber.calls == []
    assert not (project / "transcripts").exists()
    assert not (project / "artifacts" / "transcript_manifest.json").exists()


@pytest.mark.asyncio
async def test_silent_video_is_explained_before_recognizer_runs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A no-audio render must not leak PyAV's opaque tuple-index error."""

    transcriber = FakeTranscriber()
    app = create_media_app(project_root=tmp_path, transcriber=transcriber)
    project = make_project(tmp_path)
    silent_video = project / "assets" / "video" / "silent.mp4"
    silent_video.write_bytes(b"video-without-audio")
    monkeypatch.setattr(
        "web_api.media_pipeline._probe_media",
        lambda _path: {
            "duration_seconds": 2.0,
            "format": "mov,mp4,m4a,3gp,3g2,mj2",
            "size_bytes": 19,
            "stream_count": 1,
            "video": {"codec": "h264", "width": 496, "height": 864, "fps": "24/1"},
        },
    )
    body = {
        "project_id": project.name,
        "media_path": "assets/video/silent.mp4",
        "dry_run": False,
        "execute": True,
        "confirm": True,
    }
    response = await request(app, "POST", "/api/media/transcribe", json=body)
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "unavailable"
    assert "没有音频" in payload["error"] or "audio" in payload["error"].lower()
    assert payload["media"]["audio_stream_available"] is False
    assert transcriber.calls == []
    assert not (project / "transcripts").exists()


def _board_stub() -> FastAPI:
    app = FastAPI()

    @app.get("/")
    async def root() -> dict[str, bool]:
        return {"board": True}

    return app


class _FakeVideoTool:
    name = "fake_seedance"

    def get_status(self) -> str:
        return "available"


@pytest.mark.asyncio
async def test_model_adapter_exposes_transcription_alias_and_capability(tmp_path: Path) -> None:
    transcriber = FakeTranscriber()
    task_app = create_task_app(tool=_FakeVideoTool(), db_path=tmp_path / "tasks.sqlite3")
    project_root = tmp_path / "projects"
    project = make_project(project_root)
    app = create_model_app(
        task_application=task_app,
        board_application=_board_stub(),
        project_root=project_root,
        transcriber=transcriber,
    )

    capabilities = await request(app, "GET", "/model-api/media/capabilities")
    assert capabilities.status_code == 200
    assert capabilities.json()["capabilities"]["transcription"]["status"] == "available"

    response = await request(
        app,
        "POST",
        "/model-api/media/transcribe",
        json={"project_id": project.name, "media_path": "assets/video/source.wav"},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "dry_run"
    assert transcriber.calls == []


@pytest.mark.asyncio
async def test_model_adapter_exposes_local_publish_alias(tmp_path: Path) -> None:
    task_app = create_task_app(tool=_FakeVideoTool(), db_path=tmp_path / "tasks.sqlite3")
    project_root = tmp_path / "projects"
    project = project_root / "publish-demo"
    (project / "renders").mkdir(parents=True)
    (project / "renders" / "final.mp4").write_bytes(b"fake-video")
    app = create_model_app(
        task_application=task_app,
        board_application=_board_stub(),
        project_root=project_root,
    )

    response = await request(
        app,
        "POST",
        "/model-api/media/publish",
        json={
            "project_id": project.name,
            "video_path": "renders/final.mp4",
            "title": "南北湖：一阵风去旅行",
        },
    )
    assert response.status_code == 200
    assert response.json()["status"] == "dry_run"
    assert response.json()["upload"]["performed"] is False


@pytest.mark.asyncio
async def test_model_adapter_exposes_reference_review_alias(tmp_path: Path) -> None:
    task_app = create_task_app(tool=_FakeVideoTool(), db_path=tmp_path / "tasks.sqlite3")
    project_root = tmp_path / "projects"
    project = make_project(project_root, "reference-alias")
    source = project / "assets" / "reference.mp4"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(b"not-a-real-video")
    app = create_model_app(
        task_application=task_app,
        board_application=_board_stub(),
        project_root=project_root,
    )

    response = await request(
        app,
        "POST",
        "/model-api/media/reference/review",
        json={"project_id": project.name, "source": "assets/reference.mp4"},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "dry_run"
    assert response.json()["source"]["project_path"] == "assets/reference.mp4"


def test_model_page_contains_transcription_entry() -> None:
    page = Path(__file__).parents[2] / "backlot" / "ui" / "model.html"
    html = page.read_text(encoding="utf-8")
    assert 'id="mediaTranscriptPath"' in html
    assert 'id="mediaReferencePath"' in html
    assert 'id="mediaReferenceReview"' in html
    assert "自动转录并生成字幕" in html
