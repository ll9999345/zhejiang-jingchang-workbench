"""Tests for the Backlot server-only macOS Keychain bridge."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from backlot import model_adapter


def test_keychain_bridge_loads_secret_without_printing_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(model_adapter.sys, "platform", "darwin")
    monkeypatch.delenv("DOUBAO_SPEECH_API_KEY", raising=False)
    calls: list[list[str]] = []

    def fake_run(command: list[str], **kwargs: object) -> SimpleNamespace:
        calls.append(command)
        assert kwargs["capture_output"] is True
        assert kwargs["text"] is True
        return SimpleNamespace(stdout="keychain-value-for-test\n")

    monkeypatch.setattr(model_adapter.subprocess, "run", fake_run)

    assert model_adapter._load_macos_keychain_secret(
        service="DOUBAO_SPEECH_API_KEY",
        environment_name="DOUBAO_SPEECH_API_KEY",
    ) is True
    assert calls == [[
        "/usr/bin/security",
        "find-generic-password",
        "-s",
        "DOUBAO_SPEECH_API_KEY",
        "-w",
    ]]
    assert model_adapter.os.environ["DOUBAO_SPEECH_API_KEY"] == "keychain-value-for-test"


def test_keychain_bridge_prefers_existing_environment_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(model_adapter.sys, "platform", "darwin")
    monkeypatch.setenv("DOUBAO_SPEECH_API_KEY", "environment-value")

    def fail_run(*args: object, **kwargs: object) -> None:
        raise AssertionError("Keychain should not be queried when env is configured")

    monkeypatch.setattr(model_adapter.subprocess, "run", fail_run)
    assert model_adapter._load_macos_keychain_secret(
        service="DOUBAO_SPEECH_API_KEY",
        environment_name="DOUBAO_SPEECH_API_KEY",
    ) is True


def test_adapter_initializes_both_server_provider_keychain_bridges(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    calls: list[tuple[str, str]] = []

    def fake_loader(*, service: str, environment_name: str) -> bool:
        calls.append((service, environment_name))
        return False

    monkeypatch.setattr(model_adapter, "_load_macos_keychain_secret", fake_loader)

    task_application = model_adapter.task_app
    board_application = model_adapter.backlot_app
    model_adapter.create_app(
        task_application=task_application,
        board_application=board_application,
        project_root=tmp_path / "projects",
    )

    assert calls[:2] == [
        ("ARK_API_KEY", "ARK_API_KEY"),
        ("DOUBAO_SPEECH_API_KEY", "DOUBAO_SPEECH_API_KEY"),
    ]


def test_media_authorization_lazily_bootstraps_local_gate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A late local-mode flag must still make the same-origin media gate usable."""

    monkeypatch.setenv("WEB_API_LOCAL_MODE", "1")
    monkeypatch.delenv("WEB_API_PAID_AUTH_TOKEN", raising=False)

    token = model_adapter._media_authorization(None)

    assert token
    assert model_adapter.os.environ["WEB_API_PAID_AUTH_TOKEN"] == token
