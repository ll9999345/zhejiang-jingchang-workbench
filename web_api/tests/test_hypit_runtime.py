from __future__ import annotations

import json
import io
from pathlib import Path
import threading
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
import web_api.hypit_runtime as hypit_runtime

from web_api.hypit_runtime import (
    HYPIT_COMMIT,
    HYPIT_LICENSE,
    HYPIT_VERSION,
    CommandResult,
    HypitRuntime,
    HypitRuntimeError,
    create_hypit_router,
)


def checkout(tmp_path: Path) -> Path:
    root = tmp_path / "hypit-checkout"
    (root / "bin").mkdir(parents=True)
    (root / "bin" / "hypit.mjs").write_text("#!/usr/bin/env node\n", encoding="utf-8")
    (root / "examples" / "minimal").mkdir(parents=True)
    (root / "examples" / "minimal" / "README.md").write_text("Hypit example\n", encoding="utf-8")
    (root / "examples" / "minimal" / "reference.svml").write_text(
        '<?svml using="@hypit/markup@1"?>\n', encoding="utf-8"
    )
    (root / "examples" / "minimal" / "reference.svrun").write_text(
        '<?svml using="@hypit/run-markup@1"?>\n<svrun version="1"/>\n', encoding="utf-8"
    )
    (root / "examples" / "minimal" / "hypit.runtime.json").write_text(
        json.dumps({"format": "hypit.runtime-local@1", "endpoints": {}}), encoding="utf-8"
    )
    (root / "examples" / "minimal" / ".hypit").mkdir()
    (root / "examples" / "minimal" / ".hypit" / "runtime").write_text(
        "hypit.runtime.json\n", encoding="utf-8"
    )
    (root / "examples" / "template-only").mkdir(parents=True)
    (root / "examples" / "template-only" / "README.md").write_text(
        "No executable Source\n", encoding="utf-8"
    )
    return root


def project(tmp_path: Path, *, external: bool = False) -> Path:
    directory = tmp_path / "projects" / "demo"
    directory.mkdir(parents=True)
    (directory / "main.svml").write_text("<?svml using=\"@hypit/source@1\"?>\n", encoding="utf-8")
    (directory / "build.svrun").write_text(
        '<?svml using="@hypit/run-markup@1"?>\n<svrun version="1"/>\n',
        encoding="utf-8",
    )
    endpoint = (
        {"remote.images": {"use": "@hypit/provider-hypihub", "config": {"apiKey": {"store": "env", "key": "HYPIT_TEST_KEY"}}}}
        if external
        else {"media.local": {"use": "@hypit/provider-media-local"}}
    )
    (directory / "hypit.runtime.json").write_text(
        json.dumps({"format": "hypit.runtime-local@1", "endpoints": endpoint}),
        encoding="utf-8",
    )
    return directory


def service(tmp_path: Path, runner=None, *, external: bool = False) -> tuple[HypitRuntime, Path]:
    root = tmp_path / "projects"
    root.mkdir(exist_ok=True)
    selected = project(tmp_path, external=external)
    return HypitRuntime(root, hypit_root=checkout(tmp_path), runner=runner), selected


def test_build_cancelled_before_preflight_explicitly_confirms_no_submission(tmp_path):
    def forbidden_runner(*args, **kwargs):
        raise AssertionError('preflight cancellation must not execute a CLI command')
    runtime, selected = service(tmp_path, runner=forbidden_runner)
    cancelled = threading.Event()
    cancelled.set()
    try:
        result = runtime._operation('build', selected, {'run': 'build.svrun'}, cancelled)
        assert result['status'] == 'cancelled'
        assert result['build_submitted'] is False
        assert result['command_succeeded'] is False
    finally:
        runtime.close(wait=True)


def wait_for(service: HypitRuntime, project: Path, job_id: str, timeout: float = 2) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = service.get(project, job_id)
        if state["status"] in {
            "completed", "build_completed", "failed", "cancelled", "needs_attention",
            "awaiting_authorization", "authorization_required", "interrupted",
            "dry_run", "plan_required", "preflight_failed",
        }:
            return state
        time.sleep(0.01)
    return service.get(project, job_id)


def plan_payload(*, external: bool = False, **overrides) -> dict:
    provider = {
        "request": "render-request",
        "capability": "@hypit/render@1#video",
        "status": "resolved",
        "endpoint": "remote.images" if external else "media.local",
        "use": "@hypit/provider-hypihub" if external else "@hypit/provider-media-local",
        "pricing": {"kind": "page", "url": "https://example.invalid/pricing"}
        if external else {"kind": "local"},
    }
    payload = {
        "format": "hypit.cli-plan@1",
        "ok": True,
        "run": "build.svrun",
        "targetCount": 1,
        "targets": ["final.video"],
        "steps": 1,
        "requestCount": 1,
        "requestIssueCount": 0,
        "providerRequestCount": 1 if external else 0,
        "localRequestCount": 0 if external else 1,
        "unresolvedRequestCount": 0,
        "unsupportedRequestCount": 0,
        "choiceCount": 0,
        "providers": [provider],
        "needs": [{"request": "render-request", "step": "render", "port": "video",
                    "capability": "@hypit/render@1#video", "pending": []}],
        "preflight": {
            "ok": True,
            "capabilityCount": 1,
            "diagnosticCount": 0,
            "diagnostics": [],
            "capabilities": ["@hypit/render@1#video"],
        },
    }
    payload.update(overrides)
    return payload


def build_payload(*, work_outcome: str = "complete", result_state: str = "complete",
                  attention=None, failure=None) -> dict:
    build = {
        "id": "bld_20260923T000000000Z_TEST",
        "work": {"state": "done", "outcome": work_outcome},
        "result": {"state": result_state, "outputCount": 1},
    }
    if attention is not None:
        build["attention"] = attention
    if failure is not None:
        build["failure"] = failure
    return {"format": "hypit.cli-build@1", "build": build}


def test_metadata_catalog_and_examples_preserve_upstream_identity(tmp_path: Path):
    runtime, selected = service(tmp_path)
    status = runtime.status(selected)
    assert status["checkout"]["version"] == HYPIT_VERSION
    assert status["checkout"]["commit"] == HYPIT_COMMIT
    assert status["checkout"]["license"] == HYPIT_LICENSE
    catalog = runtime.catalog(selected)
    assert {entry["name"] for entry in catalog["operations"]} >= {"check", "plan", "studio", "build", "builds", "history", "inspect", "get", "cancel"}
    examples = runtime.examples(selected)
    assert examples["available"] is True
    assert examples["examples"][0]["id"] == "minimal"
    minimal = next(item for item in examples["examples"] if item["id"] == "minimal")
    template = next(item for item in examples["examples"] if item["id"] == "template-only")
    assert minimal["executable"] is True
    assert minimal["runtime_selection_marker"] is True
    assert template["executable"] is False
    assert template["sources"] == []


def test_official_example_import_copies_source_profile_and_selected_marker(tmp_path: Path):
    runtime, selected = service(tmp_path)
    job = runtime.submit("example_import", selected, example_id="minimal")
    result = wait_for(runtime, selected, job["job_id"])
    assert result["status"] == "completed"
    imported = tmp_path / "projects" / result["hypit_project_id"]
    assert (imported / "reference.svml").is_file()
    assert (imported / "reference.svrun").is_file()
    assert (imported / "hypit.runtime.json").is_file()
    assert (imported / ".hypit" / "runtime").read_text(encoding="utf-8") == "hypit.runtime.json\n"
    assert result["runtime_selection_marker_copied"] is True
    assert not (imported / ".hypit" / "execution").exists()


def test_official_example_without_source_is_listed_but_cannot_be_imported(tmp_path: Path):
    runtime, selected = service(tmp_path)
    with pytest.raises(HypitRuntimeError, match="没有可执行"):
        runtime.import_example(selected, "template-only", threading.Event())


def test_project_scope_rejects_traversal_absolute_and_symlink_escape(tmp_path: Path):
    runtime, selected = service(tmp_path)
    with pytest.raises(HypitRuntimeError):
        runtime.project("../outside")
    with pytest.raises(HypitRuntimeError):
        runtime.command_for("validate", selected, source="../main.svml")
    outside = tmp_path / "outside.svml"
    outside.write_text("outside", encoding="utf-8")
    link = selected / "link.svml"
    try:
        link.symlink_to(outside)
    except OSError:
        pytest.skip("symlinks are unavailable on this filesystem")
    with pytest.raises(HypitRuntimeError):
        runtime.command_for("validate", selected, source="link.svml")


def test_command_builder_is_closed_and_uses_expected_upstream_commands(tmp_path: Path):
    runtime, selected = service(tmp_path)
    assert runtime.command_for("check", selected, source="main.svml")[2:4] == ["check", "main.svml"]
    assert runtime.command_for("check", selected, source="build.svrun")[2:4] == ["check", "build.svrun"]
    assert runtime.command_for("plan", selected, run="build.svrun")[2:4] == ["plan", "build.svrun"]
    studio = runtime.command_for("studio", selected, run="build.svrun")
    assert studio[2:5] == ["studio", "--run", "build.svrun"]
    build = runtime.command_for("build", selected, run="build.svrun", follow=True)
    assert build[2:4] == ["build", "build.svrun"]
    assert "--follow" in build
    assert runtime.command_for("builds", selected)[2] == "builds"
    assert runtime.command_for("history", selected, output="final.video")[2:4] == ["history", "final.video"]
    assert runtime.command_for("inspect", selected, build_id="bld_20260922T000000000Z_ABC")[2:4] == ["inspect", "bld_20260922T000000000Z_ABC"]
    assert runtime.command_for("cancel", selected, build_id="bld_20260922T000000000Z_ABC")[2:4] == ["cancel", "bld_20260922T000000000Z_ABC"]
    assert runtime.command_for("project_manifest", selected) is None
    assert runtime.command_for("validate_manifest", selected) is None
    with pytest.raises(HypitRuntimeError):
        runtime.command_for("rm -rf", selected)
    with pytest.raises(HypitRuntimeError):
        runtime.command_for("validate", selected, source="main.svml;touch-pwned")


def test_native_cli_forwards_upstream_argv_and_preserves_upstream_path_semantics(tmp_path: Path):
    runtime, selected = service(tmp_path)
    media = selected / "assets" / "scene.mp4"
    media.parent.mkdir()
    media.write_bytes(b"media")
    command = runtime.command_for("native_cli", selected, command_line="hypit media probe assets/scene.mp4 --json")
    assert command[0:2] == ["node", str(runtime.hypit_root / "bin" / "hypit.mjs")]
    assert command[2:] == ["media", "probe", "assets/scene.mp4", "--json"]
    assert runtime.command_for("native_cli", selected, command_line="help media tiles")[2:] == ["help", "media", "tiles"]
    outside_media = tmp_path / "outside-media.mp4"
    outside_media.write_bytes(b"external-media")
    external = runtime.command_for("native_cli", selected, command_line=f'media probe "{outside_media}" --workspace "{selected}" --json')
    assert external[2:] == ["media", "probe", str(outside_media), "--workspace", str(selected), "--json"]
    # Even an unfamiliar command is left to the pinned upstream CLI to accept
    # or reject; it is passed as argv, never interpreted by a system shell.
    unknown = runtime.command_for("native_cli", selected, command_line="future-command --flag 'two words'")
    assert unknown[2:] == ["future-command", "--flag", "two words"]
    no_shell = runtime.command_for("native_cli", selected, command_line="sh -c 'touch pwned'")
    assert no_shell[2:] == ["sh", "-c", "touch pwned"]
    with pytest.raises(HypitRuntimeError, match="当前选择的项目"):
        runtime.command_for("native_cli", selected, command_line="media probe assets/scene.mp4 --workspace ../other")
    with pytest.raises(HypitRuntimeError, match="不要把密钥或令牌"):
        runtime.command_for("native_cli", selected, command_line="auth login endpoint --api-key=plaintext")


def test_get_allows_a_new_parent_directory_but_rejects_escape(tmp_path: Path):
    runtime, selected = service(tmp_path)
    command = runtime.command_for(
        "get", selected, build_id="bld_20260922T000000000Z_ABC", output="final.video", to="exports/final.mp4"
    )
    assert command[2:8] == ["get", "bld_20260922T000000000Z_ABC", "--output", "final.video", "--to", "exports/final.mp4"]
    assert not (selected / "exports").exists()
    for target in ("../escape.mp4", str(tmp_path / "absolute.mp4"), ""):
        with pytest.raises(HypitRuntimeError):
            runtime.command_for("get", selected, build_id="bld_20260922T000000000Z_ABC", output="final.video", to=target)


def test_runtime_bridge_export_creates_isolated_package_without_mutating_source(tmp_path: Path):
    runtime, selected = service(tmp_path)
    (selected / "artifacts").mkdir()
    (selected / "artifacts" / "reference_blueprint.json").write_text(json.dumps({
        "target_duration": 1,
        "shots": [{"id": "shot-1", "text": "本地镜头", "duration_seconds": 1}],
    }), encoding="utf-8")
    (selected / "artifacts" / "footage_draft.json").write_text(json.dumps({"shots": []}), encoding="utf-8")
    before = (selected / "main.svml").read_bytes()
    job = runtime.submit("bridge_export", selected)
    result = wait_for(runtime, selected, job["job_id"])
    assert result["status"] == "completed"
    package = tmp_path / "projects" / result["hypit_project_id"]
    assert (package / "reference.svml").is_file()
    assert (package / "reference.svrun").is_file()
    assert (package / "bridge.manifest.json").is_file()
    assert (selected / "main.svml").read_bytes() == before


def test_native_cli_runs_exact_upstream_command_and_requires_paid_scope_for_build(tmp_path: Path):
    calls = []
    def fake_runner(argv, *, cwd, env, cancel_event):
        calls.append((list(argv), cwd))
        return CommandResult(tuple(argv), 0, '{"ok":true}')

    runtime, selected = service(tmp_path, runner=fake_runner)
    media = selected / "assets" / "scene.mp4"
    media.parent.mkdir()
    media.write_bytes(b"media")
    job = runtime.submit("native_cli", "demo", command_line="media probe assets/scene.mp4 --json")
    result = wait_for(runtime, selected, job["job_id"])
    assert result["status"] == "completed"
    assert calls[0][0][2:] == ["media", "probe", "assets/scene.mp4", "--json"]
    assert calls[0][1] == selected

    with pytest.raises(HypitRuntimeError, match="人民币预算"):
        runtime.submit("native_cli", "demo", command_line="build build.svrun --follow")


def test_local_job_runs_without_node_modules_and_persists_safe_result(tmp_path: Path):
    calls = []

    def fake_runner(argv, *, cwd, env, cancel_event):
        calls.append((list(argv), cwd, dict(env)))
        return CommandResult(tuple(argv), 0, '{"outputs": []}\n', "")

    runtime, selected = service(tmp_path, runner=fake_runner)
    job = runtime.submit("validate", selected, source="main.svml")
    result = wait_for(runtime, selected, job["job_id"])
    assert result["status"] == "completed"
    assert result["command_succeeded"] is True
    assert result["delivery_verified"] is False
    assert calls[0][0][0:2] == ["node", str(runtime.hypit_root / "bin" / "hypit.mjs")]
    assert calls[0][1] == selected
    assert calls[0][0][2:4] == ["check", "main.svml"]
    persisted = json.loads((selected / "artifacts" / "hypit_jobs" / job["job_id"] / "job.json").read_text("utf-8"))
    assert persisted["status"] == "completed"


def test_local_build_uses_only_same_run_plan_and_does_not_require_paid_approval(tmp_path: Path):
    calls = []

    def fake_runner(argv, *, cwd, env, cancel_event):
        calls.append(list(argv))
        output = plan_payload() if argv[2] == "plan" else build_payload()
        return CommandResult(tuple(argv), 0, json.dumps(output))

    runtime, selected = service(tmp_path, runner=fake_runner)
    # An unrelated remote Endpoint is allowed to be unconfigured when this
    # exact Run's official plan is entirely local.
    (selected / "hypit.runtime.json").write_text(json.dumps({
        "format": "hypit.runtime-local@1",
        "endpoints": {
            "media.local": {"use": "@hypit/provider-media-local"},
            "unrelated.remote": {
                "use": "@hypit/provider-hypihub",
                "config": {"apiKey": {"store": "env", "key": "UNRELATED_HYPIT_KEY"}},
            },
        },
    }), encoding="utf-8")
    job = runtime.submit("build", selected, run="build.svrun", paid_approval={})
    result = wait_for(runtime, selected, job["job_id"])
    assert result["status"] == "build_completed"
    assert [call[2] for call in calls] == ["plan", "build"]
    assert result["cost_classification"] == "local"


def test_external_build_empty_or_missing_authorization_never_submits_build(tmp_path: Path, monkeypatch):
    monkeypatch.delenv("HYPIT_TEST_KEY", raising=False)
    calls = []

    def fake_runner(argv, *, cwd, env, cancel_event):
        calls.append(list(argv))
        return CommandResult(tuple(argv), 0, json.dumps(plan_payload(external=True)))

    runtime, selected = service(tmp_path, runner=fake_runner, external=True)
    for approval in ({}, None, {"confirmed": False}):
        job = runtime.submit("build", selected, run="build.svrun", paid_approval=approval)
        result = wait_for(runtime, selected, job["job_id"])
        assert result["status"] == "authorization_required"
        assert result["command_succeeded"] is False
    assert all(call[2] == "plan" for call in calls)


def test_external_build_with_exact_endpoint_credential_and_approval_submits_build(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("HYPIT_TEST_KEY", "test-key")
    calls = []

    def fake_runner(argv, *, cwd, env, cancel_event):
        calls.append((list(argv), dict(env)))
        output = plan_payload(external=True) if argv[2] == "plan" else build_payload()
        return CommandResult(tuple(argv), 0, json.dumps(output))

    runtime, selected = service(tmp_path, runner=fake_runner, external=True)
    approval = {"service": "test provider", "budget_cny": 10, "pricing_reviewed": True, "confirmed": True}
    job = runtime.submit("build", selected, run="build.svrun", paid_approval=approval)
    result = wait_for(runtime, selected, job["job_id"])
    assert result["status"] == "build_completed"
    assert [argv[2] for argv, _env in calls] == ["plan", "build"]
    assert calls[-1][1]["HYPIT_TEST_KEY"] == "test-key"


def test_abnormal_official_plan_fails_closed_without_build(tmp_path: Path):
    calls = []

    def fake_runner(argv, *, cwd, env, cancel_event):
        calls.append(list(argv))
        malformed = plan_payload(providers=[], localRequestCount=1)
        return CommandResult(tuple(argv), 0, json.dumps(malformed))

    runtime, selected = service(tmp_path, runner=fake_runner)
    job = runtime.submit("build", selected, run="build.svrun")
    result = wait_for(runtime, selected, job["job_id"])
    assert result["status"] == "plan_required"
    assert result["command_succeeded"] is False
    assert [argv[2] for argv in calls] == ["plan"]


def test_failed_plan_exposes_short_actionable_diagnostic_not_full_json(tmp_path: Path):
    def fake_runner(argv, *, cwd, env, cancel_event):
        failed = plan_payload(ok=False)
        failed["preflight"] = {
            "ok": False,
            "diagnostics": [{"code": "MANAGED_PROGRAM_DOWN", "message": "whisperx.local is not answering on localhost"}],
        }
        return CommandResult(tuple(argv), 1, json.dumps(failed))

    runtime, selected = service(tmp_path, runner=fake_runner)
    job = runtime.submit("plan", selected, run="build.svrun")
    result = wait_for(runtime, selected, job["job_id"])
    assert result["status"] == "failed"
    assert "whisperx.local is not answering" in result["message"]
    assert "providers" not in result["message"]
    assert len(result["message"]) < 300
    assert result["parsed"]["preflight"]["diagnostics"][0]["code"] == "MANAGED_PROGRAM_DOWN"


def test_failed_build_uses_official_failure_instead_of_progress_stderr(tmp_path: Path):
    def fake_runner(argv, *, cwd, env, cancel_event):
        if argv[2] == "plan":
            return CommandResult(tuple(argv), 0, json.dumps(plan_payload()))
        failed = build_payload(work_outcome="failed", result_state="failed", failure="Error: listen EPERM: operation not permitted 127.0.0.1")
        return CommandResult(tuple(argv), 1, json.dumps(failed), "Working 1/3 steps complete")

    runtime, selected = service(tmp_path, runner=fake_runner)
    job = runtime.submit("build", selected, run="build.svrun")
    result = wait_for(runtime, selected, job["job_id"])
    assert result["status"] == "failed"
    assert "EPERM" in result["message"]
    assert "Working" not in result["message"]


@pytest.mark.parametrize(
    ("build_result", "expected"),
    [
        (build_payload(), "build_completed"),
        (build_payload(work_outcome="cancelled", result_state="cancelled"), "cancelled"),
        (build_payload(work_outcome="failed", result_state="failed", failure="renderer failed"), "failed"),
        (build_payload(work_outcome="complete", result_state="open"), "needs_attention"),
        (build_payload(attention={"message": "finish Result"}), "needs_attention"),
    ],
)
def test_build_zero_exit_is_classified_from_official_build_view(tmp_path: Path, build_result: dict, expected: str):
    calls = []

    def fake_runner(argv, *, cwd, env, cancel_event):
        calls.append(list(argv))
        output = plan_payload() if argv[2] == "plan" else build_result
        return CommandResult(tuple(argv), 0, json.dumps(output))

    runtime, selected = service(tmp_path, runner=fake_runner)
    job = runtime.submit("build", selected, run="build.svrun", follow=True)
    result = wait_for(runtime, selected, job["job_id"])
    assert result["status"] == expected
    assert result["parsed"]["build"]["result"]["state"] == build_result["build"]["result"]["state"]
    assert [argv[2] for argv in calls] == ["plan", "build"]


def test_external_model_without_env_credential_stays_pending_and_does_not_run(tmp_path: Path, monkeypatch):
    monkeypatch.delenv("HYPIT_TEST_KEY", raising=False)
    calls = []

    def fake_runner(argv, *, cwd, env, cancel_event):
        calls.append(list(argv))
        return CommandResult(tuple(argv), 0, json.dumps(plan_payload(external=True)))

    runtime, selected = service(tmp_path, runner=fake_runner, external=True)
    state = runtime.status(selected)
    assert state["authorization"]["state"] == "awaiting_authorization"
    approval = {"service": "test provider", "budget_cny": 10, "pricing_reviewed": True, "confirmed": True}
    job = runtime.submit("render", selected, run="build.svrun", paid_approval=approval)
    result = wait_for(runtime, selected, job["job_id"])
    assert result["status"] == "authorization_required"
    assert result["command_succeeded"] is False
    assert calls and calls[0][2] == "plan"
    assert all(call[2] != "build" for call in calls)
    doctor_job = runtime.doctor(selected)
    doctor = wait_for(runtime, selected, doctor_job["job_id"])
    assert doctor["status"] == "completed"
    assert len(calls) == 2


def test_external_env_credential_is_passed_only_to_child_and_never_persisted(tmp_path: Path, monkeypatch):
    secret = "do-not-print-this-token"
    monkeypatch.setenv("HYPIT_TEST_KEY", secret)
    seen = {}

    def fake_runner(argv, *, cwd, env, cancel_event):
        seen.update(env)
        output = json.dumps(plan_payload(external=True)) if argv[2] == "plan" else json.dumps(build_payload())
        return CommandResult(tuple(argv), 0, output, f"warning {secret}\n")

    runtime, selected = service(tmp_path, runner=fake_runner, external=True)
    approval = {"service": "test provider", "budget_cny": 10, "pricing_reviewed": True, "confirmed": True}
    job = runtime.submit("render", selected, run="build.svrun", paid_approval=approval)
    result = wait_for(runtime, selected, job["job_id"])
    assert result["status"] == "build_completed"
    assert seen["HYPIT_TEST_KEY"] == secret
    assert secret not in json.dumps(result, ensure_ascii=False)
    assert secret not in (selected / "artifacts" / "hypit_jobs" / job["job_id"] / "job.json").read_text("utf-8")


def test_cancel_requests_are_observable_and_terminate_job(tmp_path: Path):
    started = threading.Event()

    def fake_runner(argv, *, cwd, env, cancel_event):
        started.set()
        while not cancel_event.is_set():
            time.sleep(0.01)
        return CommandResult(tuple(argv), -15, cancelled=True)

    runtime, selected = service(tmp_path, runner=fake_runner)
    job = runtime.submit("validate", selected, source="main.svml")
    assert started.wait(1)
    pending = runtime.cancel(selected, job["job_id"])
    assert pending["cancel_requested"] is True
    result = wait_for(runtime, selected, job["job_id"])
    assert result["status"] == "cancelled"
    assert runtime.list(selected)[0]["job_id"] == job["job_id"]


def test_get_rechecks_job_file_before_marking_a_race_as_interrupted(tmp_path: Path, monkeypatch):
    runtime, selected = service(tmp_path)
    job_id = "hypit-" + "a" * 24
    job_path = selected / "artifacts" / "hypit_jobs" / job_id / "job.json"
    job_path.parent.mkdir(parents=True)
    job_path.write_text(json.dumps({"job_id": job_id, "status": "running"}), encoding="utf-8")
    original = hypit_runtime._read_json
    reads = 0

    def racing_read(path: Path):
        nonlocal reads
        reads += 1
        if path == job_path and reads == 2:
            path.write_text(json.dumps({
                "job_id": job_id, "status": "build_completed", "command_succeeded": True,
            }), encoding="utf-8")
        return original(path)

    monkeypatch.setattr(hypit_runtime, "_read_json", racing_read)
    result = runtime.get(selected, job_id)
    assert result["status"] == "build_completed"
    assert reads >= 2
    assert json.loads(job_path.read_text(encoding="utf-8"))["status"] == "build_completed"


def test_manifest_validation_and_studio_description_are_separate_from_render(tmp_path: Path):
    runtime, selected = service(tmp_path)
    manifest = runtime.validate_project_manifest(selected)
    assert manifest["valid"] is True
    description = runtime.studio_start_description(selected, "build.svrun", port=5180)
    assert description["command"][2:5] == ["studio", "--run", "build.svrun"]
    assert "does not export an MP4" in runtime.studio_status(selected)["description"]


def test_native_cli_studio_is_visible_to_session_status_and_can_be_stopped(tmp_path: Path, monkeypatch):
    started = threading.Event()
    process_args = {}

    class FakeProcess:
        def __init__(self, argv, **kwargs):
            process_args.update(argv=list(argv), **kwargs)
            self.stdout = io.StringIO("")
            self.returncode = None
            started.set()

        def poll(self):
            return self.returncode

        def terminate(self):
            self.returncode = -15

        def wait(self, timeout=None):
            return self.returncode

        def kill(self):
            self.returncode = -9

    monkeypatch.setattr("web_api.hypit_runtime.subprocess.Popen", FakeProcess)
    runtime, selected = service(tmp_path)
    job = runtime.submit("native_cli", "demo", command_line="studio --run build.svrun")
    assert started.wait(1)
    assert process_args["shell"] is False
    assert process_args["cwd"] == str(selected)
    assert runtime.studio_status(selected)["running"] is True
    assert runtime.studio_status(selected)["active_jobs"] == [job["job_id"]]

    runtime.cancel(selected, job["job_id"])
    result = wait_for(runtime, selected, job["job_id"])
    assert result["status"] == "cancelled"
    assert result["operation"] == "studio"


def test_router_exposes_status_manifest_jobs_and_studio_without_raw_shell(tmp_path: Path):
    calls = []

    def fake_runner(argv, *, cwd, env, cancel_event):
        calls.append(list(argv))
        return CommandResult(tuple(argv), 0, '{"ok":true}')

    runtime, selected = service(tmp_path, runner=fake_runner)
    app = FastAPI()
    app.include_router(create_hypit_router(tmp_path / "projects", service=runtime))
    client = TestClient(app)
    assert client.get("/model-api/hypit/status", params={"project_id": "demo"}).status_code == 200
    assert client.get("/model-api/hypit/projects/demo/manifest").json()["valid"] is True
    response = client.post("/model-api/hypit/projects/demo/compile", params={"run": "build.svrun"})
    assert response.status_code == 202
    result = wait_for(runtime, selected, response.json()["job_id"])
    assert result["status"] == "completed"
    studio = client.get("/model-api/hypit/studio/status", params={"project_id": "demo"})
    assert studio.status_code == 200

    direct = client.post("/model-api/hypit/action", json={
        "action": "native_cli",
        "project_id": "demo",
        "project_path": "demo",
        "options": {"command_line": "result edit bld_20260922T000000000Z_ABC --title 'A native result title'"},
    })
    assert direct.status_code == 202
    direct_result = wait_for(runtime, selected, direct.json()["job_id"])
    assert direct_result["status"] == "completed"
    assert calls[-1][2:] == ["result", "edit", "bld_20260922T000000000Z_ABC", "--title", "A native result title"]


def test_workbench_initializes_native_project_with_upstream_runtime_init_without_copying_source(tmp_path: Path):
    runtime, selected = service(tmp_path)
    media = selected / "assets" / "imports" / "scene.png"
    media.parent.mkdir(parents=True)
    media.write_bytes(b"local-scene-frame")
    (selected / "artifacts").mkdir()
    (selected / "artifacts" / "footage_draft.json").write_text(json.dumps({
        "shots": [{"id": "scene-1", "text": "湖面晨光", "duration_seconds": 2.0,
                   "source_path": "assets/imports/scene.png"}],
    }), encoding="utf-8")
    calls = []
    def fake_runner(argv, *, cwd, env, cancel_event):
        calls.append(list(argv))
        (cwd / "hypit.runtime.json").write_text(json.dumps({"format": "hypit.runtime-local@1", "endpoints": {}}), encoding="utf-8")
        (cwd / ".hypit").mkdir(exist_ok=True)
        (cwd / ".hypit" / "runtime").write_text("local\n", encoding="utf-8")
        return CommandResult(tuple(argv), 0, '{"runtime":"initialized"}')
    runtime.runner = fake_runner
    app = FastAPI()
    app.include_router(create_hypit_router(tmp_path / "projects", service=runtime))
    client = TestClient(app)

    created = client.post("/model-api/hypit/action", json={
        "action": "project_init", "project_id": "demo", "options": {},
    })
    assert created.status_code == 202
    result = created.json()
    package_id = result["project_id"]
    package = (tmp_path / "projects" / package_id)
    assert result["project_path"] == package_id
    assert package.is_dir()
    assert (package / "hypit.runtime.json").is_file()
    assert not (package / "reference.svml").exists()
    assert not (package / "assets").exists()
    assert calls[0][2:4] == ["runtime", "init"]
    assert "--workspace" in calls[0]
    assert result["command_succeeded"] is True
    assert media.read_bytes() == b"local-scene-frame"

    catalog = client.get("/model-api/hypit/catalog", params={"project_id": "demo"}).json()
    assert {row["project_id"] for row in catalog["projects"]} == {package_id, "demo"}
    selected_result = client.post("/model-api/hypit/action", json={
        "action": "project_select", "project_id": "demo", "project_path": package_id,
        "options": {},
    })
    assert selected_result.status_code == 202
    assert selected_result.json()["project_id"] == package_id
    assert selected_result.json()["project_path"] == package_id
    assert (selected / "artifacts" / "footage_draft.json").is_file()


def test_workbench_action_dry_run_is_terminal_and_studio_session_is_managed(tmp_path: Path, monkeypatch):
    calls = []

    def fake_runner(argv, *, cwd, env, cancel_event):
        calls.append(list(argv))
        return CommandResult(tuple(argv), 0)

    runtime, selected = service(tmp_path, runner=fake_runner, external=True)
    app = FastAPI()
    app.include_router(create_hypit_router(tmp_path / "projects", service=runtime))
    client = TestClient(app)
    response = client.post("/model-api/hypit/action", json={
        "action": "build", "project_id": "demo", "project_path": "demo",
        "options": {"run": "build.svrun", "dry_run": True},
    })
    assert response.status_code == 202
    result = response.json()
    assert result["status"] == "dry_run"
    assert result["would_execute"] is True
    assert result["would_generate"] is True
    assert result["command_succeeded"] is False
    assert "没有启动 Hypit CLI" in result["message"]
    assert calls == []
    assert runtime.get(selected, result["job_id"])["status"] == "dry_run"

    processes = []

    class FakeStudioProcess:
        def __init__(self):
            self.stdout = io.StringIO("  Local: http://127.0.0.1:5179/\n")
            self.returncode = None

        def poll(self):
            return self.returncode

        def terminate(self):
            self.returncode = -15

        def wait(self, timeout=None):
            return self.returncode

        def kill(self):
            self.returncode = -9

    def fake_popen(*args, **kwargs):
        process = FakeStudioProcess()
        processes.append(process)
        return process

    monkeypatch.setattr("web_api.hypit_runtime.subprocess.Popen", fake_popen)
    studio = client.post("/model-api/hypit/action", json={
        "action": "studio", "project_id": "demo", "project_path": "demo",
        "options": {"run": "build.svrun"},
    })
    assert studio.status_code == 202
    studio_job_id = studio.json()["job_id"]
    deadline = time.monotonic() + 2
    studio_state = runtime.get(selected, studio_job_id)
    while time.monotonic() < deadline and not studio_state.get("studio_url"):
        time.sleep(0.01)
        studio_state = runtime.get(selected, studio_job_id)
    assert studio_state["studio_url"] == "http://127.0.0.1:5179/"
    assert studio_state["studio_state"] == "running"
    assert processes
    runtime.cancel(selected, studio_job_id)
    stopped = wait_for(runtime, selected, studio_job_id)
    assert stopped["status"] == "cancelled"
    assert stopped["studio_state"] == "stopped"
    assert stopped["studio_url"] == "http://127.0.0.1:5179/"
    assert calls == []

    studio_start = client.post("/model-api/hypit/studio/start", json={
        "project_id": "demo", "operation": "studio_start", "run": "build.svrun",
    })
    assert studio_start.status_code == 202
    second_id = studio_start.json()["job_id"]
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline and runtime.get(selected, second_id).get("studio_state") != "running":
        time.sleep(0.01)
    runtime.cancel(selected, second_id)
    assert wait_for(runtime, selected, second_id)["studio_state"] == "stopped"
    assert calls == []


def test_workbench_calls_plan_directly_and_rejects_unsafe_project_paths(tmp_path: Path):
    calls = []

    def fake_runner(argv, *, cwd, env, cancel_event):
        calls.append(list(argv))
        return CommandResult(tuple(argv), 0, '{"plan":true}')

    runtime, _selected = service(tmp_path, runner=fake_runner)
    app = FastAPI()
    app.include_router(create_hypit_router(tmp_path / "projects", service=runtime))
    client = TestClient(app)
    planned = client.post("/model-api/hypit/action", json={
        "action": "plan", "project_id": "demo", "project_path": "demo",
        "options": {"run": "build.svrun"},
    })
    assert planned.status_code == 202
    assert planned.json()["operation"] == "plan"
    result = wait_for(runtime, tmp_path / "projects" / "demo", planned.json()["job_id"])
    assert result["status"] == "completed"
    assert calls[0][2:4] == ["plan", "build.svrun"]

    escape = client.post("/model-api/hypit/action", json={
        "action": "project_select", "project_id": "demo", "project_path": "../outside",
        "options": {},
    })
    assert escape.status_code == 422


def test_missing_source_is_rejected_before_a_job_is_created(tmp_path: Path):
    runtime, selected = service(tmp_path)
    with pytest.raises(HypitRuntimeError):
        runtime.submit("validate", selected, source="missing.svml")
