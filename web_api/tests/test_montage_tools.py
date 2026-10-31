from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from tools.base_tool import ToolResult
import web_api.montage_composition as composition
import web_api.montage_clips as clips


def project(tmp_path: Path) -> tuple[Path, Path]:
    root = tmp_path / "projects"
    directory = root / "demo"
    (directory / "assets").mkdir(parents=True)
    (directory / "assets/source.mp4").write_bytes(b"original video")
    return root, directory


def video_probe(duration: float = 3) -> dict:
    return {"duration_seconds": duration, "video": {"width": 320, "height": 240, "codec": "h264"}, "audio": {"codec": "aac"}}


def composition_payload(**overrides) -> dict:
    return {"project_id": "demo", "scenes": [{"type": "text_card", "duration_seconds": 1, "props": {"text": "浙江"}}],
            "width": 320, "height": 240, **overrides}


def clips_payload(**overrides) -> dict:
    return {"project_id": "demo", "input_path": "assets/source.mp4",
            "segments": [{"id": "first", "start_seconds": 0, "end_seconds": 1}], **overrides}


def ready_runtime() -> dict:
    return {"status": "available", "reasons": [], "automatic_download": False}


@pytest.mark.parametrize("changes", [
    {"scene_code": "import os"}, {"output_name": "../../outside.mp4"}, {"output_name": "/private/tmp/out.mp4"},
    {"width": 321}, {"fps": 25},
    {"scenes": [{"type": "text_card", "props": {"text": "x", "backgroundVideo": "https://example.test/video"}}]},
    {"scenes": [{"type": "unknown", "props": {"text": "x"}}]},
    {"scenes": [{"type": "pie_chart", "props": {"chartData": [{"label": "a", "value": 0}]}}]},
    {"scenes": [{"type": "progress_bar", "props": {"progress": float("nan")}}]},
    {"scenes": [{"type": "video", "props": {"source": "assets/source.mp4", "browserVideoDecode": True}}]},
])
def test_composition_closed_contract(changes: dict) -> None:
    with pytest.raises(ValidationError):
        composition.MontageCompositionRequest.model_validate(composition_payload(**changes))


@pytest.mark.parametrize("changes", [
    {"input_path": "/private/tmp/source.mp4"}, {"input_path": "../other/video.mp4"}, {"codec": "shell"},
    {"segments": [{"start_seconds": 2, "end_seconds": 1}]},
    {"segments": [{"start_seconds": float("nan"), "end_seconds": 1}]},
])
def test_clips_closed_contract(changes: dict) -> None:
    with pytest.raises(ValidationError):
        clips.MontageClipsRequest.model_validate(clips_payload(**changes))


def test_preflight_never_writes_and_confirmation_never_invents_approval(tmp_path: Path, monkeypatch) -> None:
    root, directory = project(tmp_path)
    monkeypatch.setattr(composition, "composition_runtime", ready_runtime)
    monkeypatch.setattr(clips, "clip_runtime", ready_runtime)
    monkeypatch.setattr(clips, "_probe_media", lambda _path: video_probe())
    before = sorted(str(p.relative_to(directory)) for p in directory.rglob("*"))
    assert composition.preflight_composition(composition_payload(), project_root=root)["can_execute"]
    assert clips.preflight_clips(clips_payload(), project_root=root)["can_execute"]
    assert composition.execute_composition(composition_payload(execute=True, dry_run=False), project_root=root)["status"] == "confirmation_required"
    assert clips.execute_clips(clips_payload(execute=True, dry_run=False), project_root=root)["status"] == "confirmation_required"
    assert sorted(str(p.relative_to(directory)) for p in directory.rglob("*")) == before


def test_missing_browser_reports_unavailable_without_running_renderer(tmp_path: Path, monkeypatch) -> None:
    root, directory = project(tmp_path)
    monkeypatch.setattr(composition, "composition_runtime", lambda: {"status": "unavailable", "reasons": ["no existing browser"]})
    result = composition.execute_composition(composition_payload(execute=True, confirm=True, dry_run=False), project_root=root)
    assert result["status"] == "unavailable"
    assert not (directory / "renders").exists()


def test_symlinks_cannot_read_other_projects_or_redirect_output(tmp_path: Path, monkeypatch) -> None:
    root, directory = project(tmp_path)
    other = root / "other"
    other.mkdir()
    (other / "video.mp4").write_bytes(b"private")
    (directory / "assets/linked.mp4").symlink_to(other / "video.mp4")
    monkeypatch.setattr(composition, "composition_runtime", ready_runtime)
    monkeypatch.setattr(clips, "clip_runtime", ready_runtime)
    monkeypatch.setattr(clips, "_probe_media", lambda _path: video_probe())
    assert clips.preflight_clips(clips_payload(input_path="assets/linked.mp4"), project_root=root)["status"] == "invalid_request"
    assert composition.preflight_composition(composition_payload(scenes=[{"type": "video", "props": {"source": "assets/linked.mp4"}}]), project_root=root)["status"] == "invalid_request"
    (directory / "renders").symlink_to(other, target_is_directory=True)
    assert clips.preflight_clips(clips_payload(), project_root=root)["status"] == "invalid_request"
    assert composition.preflight_composition(composition_payload(), project_root=root)["status"] == "invalid_request"
    (root / "alias").symlink_to(other, target_is_directory=True)
    assert composition.preflight_composition(composition_payload(project_id="alias"), project_root=root)["status"] == "invalid_request"
    assert not list(other.glob("montage*"))


def test_batches_use_native_trimmer_preserve_inputs_and_never_overwrite(tmp_path: Path, monkeypatch) -> None:
    root, directory = project(tmp_path)
    monkeypatch.setattr(clips, "clip_runtime", ready_runtime)
    monkeypatch.setattr(clips, "_probe_media", lambda _path: video_probe(1 if "renders" in _path.parts else 3))
    monkeypatch.setattr(clips, "notify_project_changed", lambda _id: None)
    calls = []

    class FakeTrimmer:
        def execute(self, inputs):
            calls.append(inputs)
            Path(inputs["output_path"]).write_bytes(b"derived")
            return ToolResult(success=True)

    monkeypatch.setattr(clips, "VideoTrimmer", FakeTrimmer)
    payload = clips_payload(execute=True, dry_run=False, confirm=True)
    first = clips.execute_clips(payload, project_root=root)
    second = clips.execute_clips(payload, project_root=root)
    assert first["status"] == second["status"] == "completed"
    assert first["clips"][0]["path"] != second["clips"][0]["path"]
    assert first["manifest"]["path"] != second["manifest"]["path"]
    assert (directory / "assets/source.mp4").read_bytes() == b"original video"
    assert all(call["operation"] == "cut" for call in calls)


def test_batch_failure_keeps_successful_clips_and_truthful_receipt(tmp_path: Path, monkeypatch) -> None:
    root, directory = project(tmp_path)
    monkeypatch.setattr(clips, "clip_runtime", ready_runtime)
    monkeypatch.setattr(clips, "_probe_media", lambda _path: video_probe(1 if "renders" in _path.parts else 3))

    class PartialTrimmer:
        calls = 0

        def execute(self, inputs):
            self.calls += 1
            if self.calls == 2:
                return ToolResult(success=False, error="second clip failed")
            Path(inputs["output_path"]).write_bytes(b"first clip")
            return ToolResult(success=True)

    monkeypatch.setattr(clips, "VideoTrimmer", PartialTrimmer)
    payload = clips_payload(execute=True, dry_run=False, confirm=True, segments=[
        {"id": "a", "start_seconds": 0, "end_seconds": 1},
        {"id": "b", "start_seconds": 1, "end_seconds": 2},
    ])
    result = clips.execute_clips(payload, project_root=root)
    assert result["status"] == "failed" and result["completed_clip_count"] == 1
    assert (directory / result["clips"][0]["path"]).is_file()
    assert (directory / result["manifest"]["path"]).is_file()
    assert result["writes_occurred"] and len(result["written_files"]) == 1


def test_native_scene_contract_and_render_result_are_verified(tmp_path: Path, monkeypatch) -> None:
    root, directory = project(tmp_path)
    monkeypatch.setattr(composition, "composition_runtime", ready_runtime)
    monkeypatch.setattr(composition, "_probe_media", lambda _path: video_probe(1))
    monkeypatch.setattr(composition, "notify_project_changed", lambda _id: None)
    calls = []

    class FakeComposer:
        def __init__(self, _model, _run):
            pass

        def execute(self, inputs):
            calls.append(inputs)
            Path(inputs["output_path"]).write_bytes(b"native remotion output")
            return ToolResult(success=True)

    monkeypatch.setattr(composition, "LocalVideoCompose", FakeComposer)
    result = composition.execute_composition(composition_payload(execute=True, dry_run=False, confirm=True), project_root=root)
    assert result["status"] == "completed"
    assert calls[0]["operation"] == "remotion_render"
    assert calls[0]["edit_decisions"]["cuts"][0]["text"] == "浙江"
    assert calls[0]["edit_decisions"]["cuts"][0]["out_seconds"] == 1
    assert result["output"]["probe"]["video"]["width"] == 320
    assert (directory / result["manifest"]["path"]).is_file()


def test_composition_failure_keeps_intermediates_and_records_actual_writes(tmp_path: Path, monkeypatch) -> None:
    root, directory = project(tmp_path)
    monkeypatch.setattr(composition, "composition_runtime", ready_runtime)

    class BrokenComposer:
        def __init__(self, _model, run):
            self.run = run

        def execute(self, _inputs):
            (self.run / "frame-0.png").write_bytes(b"partial frame")
            return ToolResult(success=False, error="token=secret-value render failed")

    monkeypatch.setattr(composition, "LocalVideoCompose", BrokenComposer)
    result = composition.execute_composition(composition_payload(execute=True, dry_run=False, confirm=True), project_root=root)
    assert result["status"] == "failed" and result["run_id"]
    assert result["writes_occurred"] and result["output_verified"] is False
    assert "would_write" not in result and "secret-value" not in result["error"]
    assert len(result["written_files"]) == 1
    assert (directory / result["written_files"][0]["path"]).read_bytes() == b"partial frame"
    receipt = directory / result["manifest"]["path"]
    assert receipt.is_file() and "secret-value" not in receipt.read_text()


def test_unavailable_scene_type_is_rejected_during_preflight(tmp_path: Path, monkeypatch) -> None:
    root, directory = project(tmp_path)
    monkeypatch.setattr(composition, "composition_runtime", lambda: {
        "status": "available", "unavailable_scene_types": {"video": "video decoder incompatible"}})
    result = composition.preflight_composition(composition_payload(scenes=[{"type": "video", "props": {"source": "assets/source.mp4"}}]), project_root=root)
    assert result["status"] == "unavailable" and not result["can_execute"]
    assert result["error"] == "video decoder incompatible"
    assert not (directory / "renders").exists()


def test_local_cli_pins_browser_dimensions_frames_and_fonts_without_npx(tmp_path: Path, monkeypatch) -> None:
    root, directory = project(tmp_path)
    run = directory / "run"
    run.mkdir()
    browser = tmp_path / "browser"
    browser.write_bytes(b"existing browser")
    monkeypatch.setattr(composition, "installed_browser", lambda: browser)
    monkeypatch.setattr(composition.shutil, "which", lambda name: "/existing/node" if name == "node" else None)
    calls = []
    def record_command(_self, cmd, **kwargs):
        calls.append(cmd)
        if len(cmd) > 2 and cmd[2] == "render":
            frames = Path(cmd[5])
            frames.mkdir()
            for index in range(30):
                (frames / f"frame-{index:02d}.png").write_bytes(b"frame")
    monkeypatch.setattr(composition.VideoCompose, "run_command", record_command)
    tool = composition.LocalVideoCompose(composition.MontageCompositionRequest.model_validate(composition_payload()), run)
    tool.run_command(["npx", "remotion", "render", "entry.tsx", "Explainer", "out.mp4"])
    command = calls[0]
    assert command[0] == "/existing/node" and "npx" not in command
    assert f"--browser-executable={browser}" in command
    assert "--width=1920" in command and "--height=1080" in command
    assert "--frames=0-29" in command
    assert "--sequence" in command and "--muted" in command
    assert calls[1][0] == "ffmpeg"
    assert "scale=320:240:force_original_aspect_ratio=decrease" in calls[1][calls[1].index("-vf") + 1]
    config = (run / "remotion.config.cjs").read_text()
    assert "overrideWebpackConfig" in config and "google-fonts/SpaceGrotesk" in config
    assert "https://" not in config


def test_normalized_progress_is_converted_to_native_percentage(tmp_path: Path) -> None:
    _, directory = project(tmp_path)
    model = composition.MontageCompositionRequest.model_validate(composition_payload(scenes=[
        {"type": "progress_bar", "props": {"progress": 0.75}},
    ]))
    props, _ = composition._native_props(directory, model)
    assert props["cuts"][0]["progress"] == 75


def test_event_log_symlink_is_rejected_before_any_tool_write(tmp_path: Path, monkeypatch) -> None:
    root, directory = project(tmp_path)
    outside = tmp_path / "other-project-events.jsonl"
    outside.write_text("unchanged", encoding="utf-8")
    (directory / "events.jsonl").symlink_to(outside)
    monkeypatch.setattr(composition, "composition_runtime", ready_runtime)
    monkeypatch.setattr(clips, "clip_runtime", ready_runtime)
    monkeypatch.setattr(clips, "_probe_media", lambda _path: video_probe())
    for result in [composition.preflight_composition(composition_payload(), project_root=root),
                   clips.preflight_clips(clips_payload(), project_root=root)]:
        assert result["status"] == "invalid_request" and not result["can_execute"]
    assert outside.read_text() == "unchanged" and not (directory / "renders").exists()


def test_mov_preflight_is_read_only_and_video_preparation_preserves_offset(tmp_path: Path, monkeypatch) -> None:
    root, directory = project(tmp_path)
    original = directory / "assets/source.mov"
    original.write_bytes(b"original mov")
    monkeypatch.setattr(composition, "composition_runtime", ready_runtime)
    monkeypatch.setattr(composition, "require_video_decoder", lambda _codec: None)
    monkeypatch.setattr(composition, "_probe_media", lambda path: {**video_probe(), "video": {"codec": "prores" if path.suffix == ".mov" else "h264"}, "duration_seconds": 3 if path.suffix == ".mov" else 1})
    payload = composition_payload(scenes=[{"type": "video", "duration_seconds": 1,
                                          "props": {"source": "assets/source.mov", "source_in_seconds": .5}}])
    before = sorted(str(p.relative_to(directory)) for p in directory.rglob("*"))
    assert composition.preflight_composition(payload, project_root=root)["can_execute"]
    assert sorted(str(p.relative_to(directory)) for p in directory.rglob("*")) == before
    model = composition.MontageCompositionRequest.model_validate(payload)
    props, _ = composition._native_props(directory, model)
    assert props["cuts"][0]["browserVideoDecode"] is True
    calls = []
    class FakeTrimmer:
        def execute(self, inputs):
            calls.append(inputs)
            Path(inputs["output_path"]).write_bytes(b"compatible h264")
            return ToolResult(success=True)
    monkeypatch.setattr(composition, "VideoTrimmer", FakeTrimmer)
    public = directory / "renders/public"
    public.mkdir(parents=True)
    records = composition.prepare_browser_video_sources(directory, props, public)
    assert calls[0]["start_seconds"] == .5 and calls[0]["end_seconds"] == 1.5
    assert props["cuts"][0]["source_in_seconds"] == 0
    assert props["cuts"][0]["source"] == str(public / "compatible-video-01.mp4")
    assert records[0]["original_preserved"] and original.read_bytes() == b"original mov"


def test_failed_video_conversion_keeps_partial_file_and_failure_receipt(tmp_path: Path, monkeypatch) -> None:
    root, directory = project(tmp_path)
    (directory / "assets/source.mov").write_bytes(b"original mov")
    monkeypatch.setattr(composition, "composition_runtime", ready_runtime)
    monkeypatch.setattr(composition, "require_video_decoder", lambda _codec: None)
    monkeypatch.setattr(composition, "_probe_media", lambda _path: {**video_probe(), "video": {"codec": "prores"}})
    class BrokenTrimmer:
        def execute(self, inputs):
            Path(inputs["output_path"]).write_bytes(b"partial conversion")
            return ToolResult(success=False, error="video conversion failed")
    monkeypatch.setattr(composition, "VideoTrimmer", BrokenTrimmer)
    result = composition.execute_composition(composition_payload(execute=True, dry_run=False, confirm=True,
        scenes=[{"type": "video", "duration_seconds": 1, "props": {"source": "assets/source.mov"}}]), project_root=root)
    assert result["status"] == "failed" and result["run_id"] and result["writes_occurred"]
    assert any(row["path"].endswith("compatible-video-01.mp4") for row in result["written_files"])
    assert (directory / result["manifest"]["path"]).is_file()
    assert (directory / "assets/source.mov").read_bytes() == b"original mov"


def test_failure_receipt_falls_back_to_run_directory_without_overwriting(tmp_path: Path, monkeypatch) -> None:
    _, directory = project(tmp_path)
    run = directory / "renders/run"
    run.mkdir(parents=True)
    def unavailable(*_args):
        raise OSError("artifacts unavailable")
    monkeypatch.setattr(composition, "write_receipt", unavailable)
    result = composition.write_failure_receipt(directory, "composition", "test-run", run, {"status": "failed"})
    assert result and result["path"] == "renders/run/failure-manifest.json"
    assert composition.write_failure_receipt(directory, "composition", "test-run", run, {"status": "other"}) is None
    assert '"failed"' in (directory / result["path"]).read_text()


def test_clips_receipt_uses_source_hash_at_execution_time(tmp_path: Path, monkeypatch) -> None:
    root, directory = project(tmp_path)
    monkeypatch.setattr(clips, "clip_runtime", ready_runtime)
    monkeypatch.setattr(clips, "_probe_media", lambda _path: video_probe(1))
    original_preflight = clips.preflight_clips
    def preflight_then_update(request, **kwargs):
        result = original_preflight(request, **kwargs)
        (directory / "assets/source.mp4").write_bytes(b"updated source before execution")
        return result
    monkeypatch.setattr(clips, "preflight_clips", preflight_then_update)
    class FakeTrimmer:
        def execute(self, inputs):
            Path(inputs["output_path"]).write_bytes(b"clip")
            return ToolResult(success=True)
    monkeypatch.setattr(clips, "VideoTrimmer", FakeTrimmer)
    result = clips.execute_clips(clips_payload(execute=True, dry_run=False, confirm=True), project_root=root)
    assert result["status"] == "completed"
    assert result["input"]["sha256"] == clips._sha256(directory / "assets/source.mp4")
