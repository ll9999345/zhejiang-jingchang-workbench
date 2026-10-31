"""External-model and explicitly installed CLI integration regressions."""
from types import SimpleNamespace
from unittest.mock import Mock

from tools.audio.piper_tts import PiperTTS
from tools.video.hyperframes_compose import HyperFramesCompose


def test_piper_external_default_and_reported_model(monkeypatch, tmp_path):
    model = tmp_path / "中文模型.onnx"
    model.touch()
    output = tmp_path / "voice.wav"
    monkeypatch.setenv("PIPER_MODEL", str(model))

    def synthesize(cmd, **kwargs):
        assert cmd[cmd.index("--model") + 1] == str(model)
        output.write_bytes(b"generated")
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr("tools.audio.piper_tts.subprocess.run", synthesize)
    result = PiperTTS()._generate({"text": "测试", "output_path": str(output)})
    assert result.success
    assert result.model == result.data["model"] == str(model)


def test_piper_explicit_model_id_overrides_default(monkeypatch, tmp_path):
    monkeypatch.setenv("PIPER_MODEL", "/disconnected/default.onnx")
    model = tmp_path / "english.onnx"
    model.touch()
    output = tmp_path / "voice.wav"
    output.touch()
    run = Mock(return_value=SimpleNamespace(returncode=0))
    monkeypatch.setattr("tools.audio.piper_tts.subprocess.run", run)
    result = PiperTTS()._generate({"text": "test", "model_id": str(model), "output_path": str(output)})
    assert result.success
    assert run.call_args.args[0][2] == str(model)


def test_piper_disconnected_drive_fails_before_execution(monkeypatch):
    monkeypatch.setenv("PIPER_MODEL", "/disconnected/model.onnx")
    run = Mock()
    monkeypatch.setattr("tools.audio.piper_tts.subprocess.run", run)
    result = PiperTTS()._generate({"text": "测试"})
    assert not result.success
    assert "connect the model drive" in result.error
    run.assert_not_called()


def test_piper_named_model_resolves_on_external_drive(monkeypatch, tmp_path):
    monkeypatch.setenv("PIPER_MODEL_DIR", str(tmp_path))
    model = tmp_path / "en_US-lessac-medium.onnx"
    model.touch()
    output = tmp_path / "voice.wav"
    output.touch()
    run = Mock(return_value=SimpleNamespace(returncode=0))
    monkeypatch.setattr("tools.audio.piper_tts.subprocess.run", run)
    result = PiperTTS()._generate({"text": "test", "model_id": "en_US-lessac-medium", "output_path": str(output)})
    assert result.success
    assert result.model == str(model)
    assert run.call_args.args[0][2] == str(model)


def test_hyperframes_uses_configured_cli_without_npm(monkeypatch):
    monkeypatch.setenv("HYPERFRAMES_CLI", "/local tools/hyperframes")
    monkeypatch.setattr(HyperFramesCompose, "_npm_resolve_cache", None)
    run = Mock(return_value=SimpleNamespace(returncode=0, stdout="0.8.33\n"))
    monkeypatch.setattr("tools.video.hyperframes_compose.subprocess.run", run)
    assert HyperFramesCompose._resolve_npm_package() == {"version": "0.8.33"}
    assert run.call_args.args[0] == ["/local tools/hyperframes", "--version"]


def test_hyperframes_missing_configured_cli_does_not_install(monkeypatch):
    monkeypatch.setenv("HYPERFRAMES_CLI", "/missing/hyperframes")
    monkeypatch.setattr(HyperFramesCompose, "_npm_resolve_cache", None)
    run = Mock(side_effect=FileNotFoundError)
    monkeypatch.setattr("tools.video.hyperframes_compose.subprocess.run", run)
    assert "error" in HyperFramesCompose._resolve_npm_package()
    assert run.call_count == 1


def test_hyperframes_render_uses_configured_cli(monkeypatch, tmp_path):
    monkeypatch.setenv("HYPERFRAMES_CLI", "/local tools/hyperframes")
    run = Mock(return_value=SimpleNamespace(returncode=0, stdout="", stderr=""))
    monkeypatch.setattr("tools.video.hyperframes_compose.subprocess.run", run)
    HyperFramesCompose()._run_hf(["render", "--quality", "draft"], cwd=tmp_path, timeout=30, check=False)
    assert run.call_args.args[0] == ["/local tools/hyperframes", "render", "--quality", "draft"]
    assert run.call_args.kwargs["cwd"] == str(tmp_path)
