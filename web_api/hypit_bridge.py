"""Export an OpenMontage project as an isolated Hypit Author Package.

This bridge writes only a new package directory.  It does not import Hypit's
runtime, mutate an OpenMontage project, or claim that an external model or
speech alignment has run.  Local media is either referenced explicitly or
copied into the new package with a hash and source record.
"""
from __future__ import annotations

from hashlib import file_digest
import html
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import shutil
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from web_api.footage_pipeline import (
    AUDIO_EXTS,
    IMAGE_EXTS,
    VIDEO_EXTS,
    local_path,
    probe,
    read_json,
)


_ID_RE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
_PACKAGE_RE = re.compile(r"^[a-z][a-z0-9._-]{0,80}$")
_MEDIA_EXTS = VIDEO_EXTS | IMAGE_EXTS | AUDIO_EXTS
_DEFAULT_OPTIONS = {
    "aspect_ratio": "9:16",
    "resolution": 720,
    "fps": 30,
    "transition": "cut",
    "narration": "none",
    "variants": 1,
    "language": "zh",
}


class HypitBridgeOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")

    package_id: str = Field(default="openmontage-reference", pattern=r"^[a-z][a-z0-9._-]{0,80}$")
    # A copied package is self-contained and is accepted by Hypit's workspace
    # asset-root checks.  Reference mode remains available explicitly for an
    # author who has configured an external allowed asset root.
    asset_mode: Literal["reference", "copy"] = "copy"
    language: str = Field(default="zh", pattern=r"^[a-z]{2,3}$")
    aspect_ratio: Literal["16:9", "9:16", "1:1"] = "9:16"
    resolution: int = Field(default=720, ge=240, le=2160)
    fps: int = Field(default=30, ge=1, le=120)
    variant_count: int = Field(default=1, ge=1, le=8)


class BridgeNeed(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    kind: str
    status: Literal["needed", "unsupported", "missing"] = "needed"
    message: str


def _safe_id(value: Any, fallback: str, used: set[str]) -> str:
    raw = re.sub(r"[^a-zA-Z0-9_-]+", "-", str(value or "")).strip("-").lower()
    if not raw or not raw[0].isalpha():
        raw = f"{fallback}-{raw}" if raw else fallback
    raw = raw[:64]
    if not _ID_RE.fullmatch(raw):
        raw = re.sub(r"^[^a-z]+", "", raw)[:64] or fallback
    candidate = raw
    index = 2
    while candidate in used:
        suffix = f"-{index}"
        candidate = f"{raw[:64-len(suffix)]}{suffix}"
        index += 1
    used.add(candidate)
    return candidate


def _xml_text(value: Any) -> str:
    # SVML uses @{} markers and || as author syntax. A source script is data
    # here, so escape marker starts while retaining authored cue breaks.
    text = str(value or "").replace("@{", r"\@{")
    return html.escape(text, quote=False)


def _caption_text(value: Any) -> str:
    """Add cue boundaries to newly exported plain Chinese prose only.

    Hypit's lexical model counts each Han character as a word. The default
    recipe allows two rows of six words, so a whole paragraph cannot be one
    cue. Prefer punctuation and preserve every source character. Explicit
    author syntax and mixed-language text retain their existing boundaries;
    this is not a parser or a rewrite of already exported author packages.
    """
    text = str(value or "")
    han = r"[\u3400-\u4dbf\u4e00-\u9fff\U00020000-\U000323af]"
    if not re.fullmatch(rf"(?:{han}|[\s，。！？；：、,.!?;:…—“”‘’（）《》])+", text):
        return text
    words = list(re.finditer(han, text))
    if len(words) <= 12:
        return text
    cuts: list[int] = []
    start = 0
    while len(words) - start > 12:
        stop = start + 12
        # A mark belongs to the preceding character, never to a new cue.
        for end in range(stop, start, -1):
            gap = text[words[end - 1].end():words[end].start()]
            if re.search(r"[，。！？；,.!?;]", gap):
                stop = end
                break
        cuts.append(words[stop].start())
        start = stop
    positions = [0, *cuts, len(text)]
    return "||".join(text[a:b] for a, b in zip(positions, positions[1:]))


def _json_write_new(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2, allow_nan=False)
        handle.write("\n")


def _hash_file(path: Path) -> str:
    with path.open("rb") as handle:
        return file_digest(handle, "sha256").hexdigest()


def _canvas(options: HypitBridgeOptions) -> tuple[int, int]:
    # H.264/yuv420p needs both dimensions divisible by two. Plain round()
    # produces e.g. 427x240 or 720x1281 and fails at the final encoder.
    # Apply only when authoring a new package; never rewrite old canvases.
    even = lambda value: 2 * round(value / 2)
    if options.aspect_ratio == "16:9":
        return even(options.resolution * 16 / 9), even(options.resolution)
    if options.aspect_ratio == "1:1":
        return even(options.resolution), even(options.resolution)
    return even(options.resolution), even(options.resolution * 16 / 9)


def _safe_source_file(project: Path, raw: str) -> Path:
    value = str(raw or "").strip()
    if not value:
        raise ValueError("素材路径为空")
    path = local_path(project, value)
    if path.suffix.lower() not in _MEDIA_EXTS:
        raise ValueError("Hypit 桥接只接受视频、图片或音频素材")
    if not path.is_file() or path.stat().st_size <= 0:
        raise ValueError("素材文件为空或不存在")
    return path


def _relative_media_path(package_dir: Path, source: Path) -> str:
    try:
        relative = PurePosixPath(*source.relative_to(package_dir).parts).as_posix()
    except ValueError:
        relative = PurePosixPath(*Path(os.path.relpath(source, package_dir)).parts).as_posix()
    return relative if relative.startswith(".") else f"./{relative}"


def _source_records(project: Path, package_dir: Path, shots: list[dict],
                    options: HypitBridgeOptions, needs: list[BridgeNeed]) -> tuple[list[dict], dict[str, str]]:
    records: list[dict] = []
    source_by_shot: dict[str, str] = {}
    copied_names: set[str] = set()
    used_asset_ids: set[str] = set()

    def add_media(raw: str, *, role: str, shot_id: str, index: int, label: str) -> str | None:
        if not raw:
            return None
        try:
            source = _safe_source_file(project, raw)
        except ValueError as exc:
            needs.append(BridgeNeed(id=f"media-{label}", kind=f"{role}-media", status="missing",
                                    message=f"镜头 {shot_id} 的 {role} 素材不可用：{exc}"))
            return None
        source_hash = _hash_file(source)
        stem = re.sub(r"[^a-zA-Z0-9._-]+", "-", source.stem).strip("-") or f"asset-{index+1}"
        name = f"{index+1:02d}-{label}-{stem}{source.suffix.lower()}"
        while name in copied_names:
            name = f"{index+1:02d}-{label}-{stem}-{len(copied_names)+1}{source.suffix.lower()}"
        copied_names.add(name)
        destination = package_dir / "assets" / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        mode = options.asset_mode
        if mode == "copy":
            shutil.copy2(source, destination)
        else:
            destination.symlink_to(source)
        asset_id = _safe_id(f"{role}-{shot_id}-{label}", f"{role}-{index+1}", used_asset_ids)
        record = {
            "id": asset_id,
            "role": role,
            "shot_id": shot_id,
            "source_path": raw,
            "package_path": _relative_media_path(package_dir, destination),
            "mode": mode,
            "sha256": source_hash,
            "size_bytes": source.stat().st_size,
            "source_project": project.name,
            "reference_target": str(source) if mode == "reference" else None,
        }
        if source.suffix.lower() in VIDEO_EXTS:
            try:
                record["probe"] = probe(source)
            except (OSError, ValueError):
                needs.append(BridgeNeed(id=f"probe-{label}", kind="media-probe", status="needed",
                                        message=f"素材 {raw} 尚未取得可验证的媒体探测结果。"))
        records.append(record)
        return asset_id

    for index, shot in enumerate(shots):
        raw = str(shot.get("source_path") or "").strip()
        if not raw:
            needs.append(BridgeNeed(id=f"media-{index+1}", kind="source-media", status="needed",
                                    message=f"镜头 {shot.get('id') or index+1} 没有本地素材；Hypit 不会用参考片或占位结果填充。"))
        else:
            asset_id = add_media(raw, role="a_roll", shot_id=str(shot.get("id") or index + 1), index=index,
                                 label=f"shot-{index+1}")
            if asset_id:
                source_by_shot[str(shot.get("id") or f"shot-{index+1}")] = asset_id
        broll = shot.get("broll_paths") or shot.get("broll_path") or []
        if isinstance(broll, str):
            broll = [broll]
        for broll_index, broll_raw in enumerate(broll if isinstance(broll, list) else []):
            add_media(str(broll_raw or "").strip(), role="b_roll", shot_id=str(shot.get("id") or index + 1),
                      index=index, label=f"shot-{index+1}-broll-{broll_index+1}")
    return records, source_by_shot


def _load_shots(project: Path) -> tuple[list[dict], dict, dict]:
    blueprint = read_json(project / "artifacts/reference_blueprint.json")
    draft = read_json(project / "artifacts/footage_draft.json")
    script = read_json(project / "artifacts/script.json")
    shots = blueprint.get("shots") if blueprint else None
    draft_shots = draft.get("shots") if draft else None
    if shots and draft_shots:
        draft_by_id = {str(item.get("id")): item for item in draft_shots if isinstance(item, dict)}
        merged = []
        for item in shots:
            row = dict(item or {})
            draft_item = draft_by_id.get(str(row.get("id"))) or {}
            for key in ("source_path", "start_seconds", "selected_source", "candidates", "broll_path", "broll_paths"):
                if not row.get(key) and draft_item.get(key):
                    row[key] = draft_item[key]
            merged.append(row)
        shots = merged
    if not shots:
        shots = draft_shots
    if not shots:
        shots = (read_json(project / "artifacts/workflow_state.json").get("storyboard") or {}).get("shots")
    if not shots:
        shots = []
    normalized: list[dict] = []
    used: set[str] = set()
    for index, raw in enumerate(shots):
        item = dict(raw or {})
        item["id"] = _safe_id(item.get("id"), f"shot-{index+1}", used)
        item["text"] = str(item.get("text") or item.get("narration") or "")
        item["duration_seconds"] = float(item.get("duration_seconds") or 0)
        normalized.append(item)
    return normalized, blueprint, script


def _options(project: Path, supplied: HypitBridgeOptions | None) -> HypitBridgeOptions:
    if supplied is not None:
        return supplied
    settings = read_json(project / "artifacts/footage_settings.json")
    raw = {**_DEFAULT_OPTIONS, **{k: settings[k] for k in _DEFAULT_OPTIONS if k in settings}}
    return HypitBridgeOptions(
        language=str(raw.get("language") or "zh"),
        aspect_ratio=raw.get("aspect_ratio", "9:16"),
        resolution=int(raw.get("resolution") or 720),
        fps=int(raw.get("fps") or 30),
        variant_count=int(raw.get("variants") or 1),
    )


def _validate_destination(source_project: Path, package_dir: Path) -> tuple[Path, Path]:
    source = source_project.resolve()
    destination = package_dir.resolve()
    if not source.is_dir():
        raise ValueError("OpenMontage 源项目目录不存在")
    if destination == source or destination.is_relative_to(source):
        raise ValueError("Hypit 包必须写到源项目之外，避免修改源项目")
    if destination.exists() and any(destination.iterdir()):
        raise FileExistsError("目标 Hypit 包已存在且非空，不覆盖已有包")
    destination.mkdir(parents=True, exist_ok=True)
    return source, destination


def _render_svs(options: HypitBridgeOptions) -> str:
    width, height = _canvas(options)
    return f'''<?svml using="@hypit/svs@1"?>

<sheet version="1" id="reference">
  media.reference {{
    stack-order: 10;
    fit: cover;
  }}

  caption.primary {{
    stack-order: 70;
    x: 0.5;
    y: 0.86;
    width: 0.88;
    height: 0.2;
    anchor-x: center;
    anchor-y: bottom;
    align: center;
    block-align: end;
    inline-size: fixed;
    wrap: word;
    max-lines: 2;
    max-words-per-line: 6;
    size: {max(24, round(height / 22))};
    line-height: 1.08;
    fill: #FFFFFF;
    stroke-color: #000000;
    stroke-width: 2;
    shadow-color: #000000;
    shadow-opacity: 0.75;
    shadow-x: 0;
    shadow-y: 3;
    shadow-blur: 6;
    karaoke: off;
    background: #00000000;
    padding: "0";
    radius: 0;
    cue-enter: none;
    cue-exit: none;
    handoff: cut;
  }}

  film.reference {{
    background: #000000;
  }}

  canvas.reference {{
    width: {width};
    height: {height};
  }}
</sheet>
'''


def _render_svml(project: Path, package_dir: Path, shots: list[dict], blueprint: dict,
                 records: list[dict], source_by_shot: dict[str, str],
                 options: HypitBridgeOptions, needs: list[BridgeNeed]) -> str:
    width, height = _canvas(options)
    segments: list[str] = []
    for shot in shots:
        text = _xml_text(_caption_text(shot.get("text")))
        segments.append(f"    <{shot['id']}>\n      {text}\n    </{shot['id']}>")
    if not segments:
        segments.append("    <empty/>")
    imports = '''  <import from="@hypit/script@1"/>
  <import as="media" from="@hypit/media@1"/>
  <import as="pipeline" from="@hypit/media-pipeline@1"/>
  <import as="whisperx" from="@hypit/whisperx@1"/>
  <import as="time" from="@hypit/timeline-author@1"/>
  <import as="performance" from="@hypit/performance@1"/>
  <import as="sound" from="@hypit/sound@1"/>
  <import as="caption" from="@hypit/caption@1"/>
  <import as="caption-fine" from="@hypit/caption-fine@1"/>
  <import as="fonts" from="@hypit/fonts-open@1"/>
  <import as="space" from="@hypit/spatial@1"/>
  <import as="program" from="@hypit/program-space@1"/>
  <import as="film" from="@hypit/film@1"/>
  <import as="render" from="@hypit/render-hyperframes@1"/>
  <import as="recipes" source="./reference.svs"/>'''
    declarations: list[str] = []
    takes: list[str] = []
    for index, shot in enumerate(shots):
        asset_id = source_by_shot.get(shot["id"])
        if not asset_id:
            continue
        record = next(row for row in records if row["id"] == asset_id)
        source = html.escape(record["package_path"], quote=True)
        declarations.append(f'  <media:Video id="{asset_id}" src="{source}"/>')
        media_id = f"{asset_id}-media"
        declarations.append(
            f'  <pipeline:Normalize id="{media_id}" source={{{asset_id}}} '
            f'video="primary-moving" audio="default" span-authority="video" clock={{clock}}/>'
        )
        if shot.get("text", "").strip():
            takes.append(
                f'  <whisperx:SemanticTake id="{asset_id}-semantic" narrative={{story}} '
                f'segment={{story.segment.{shot["id"]}}} media={{{media_id}.media}} language="{options.language}"/>'
            )
        else:
            takes.append(
                f'  <whisperx:SemanticTake id="{asset_id}-semantic" narrative={{story}} '
                f'segment={{story.segment.{shot["id"]}}} media={{{media_id}.media}}/>'
            )
    if not takes:
        duration = float(blueprint.get("target_duration") or sum(s.get("duration_seconds", 0) for s in shots) or 1)
        if not math.isfinite(duration) or duration <= 0:
            duration = 1
        timeline = f'  <time:Timeline id="program" clock={{clock}} end="{duration:.3f}s"/>'
    else:
        # Keep source ids explicit rather than deriving them from markup text.
        timeline_takes = []
        for shot in shots:
            asset_id = source_by_shot.get(shot["id"])
            if asset_id:
                timeline_takes.append(f'    <time:Take source={{{asset_id}-semantic.take}}/>')
        timeline = '  <time:Timeline id="program" clock={clock}>\n' + "\n".join(timeline_takes) + '\n  </time:Timeline>'
    frame = '  <space:Frame id="full" within={canvas} left="0%" top="0%" right="100%" bottom="100%"/>'
    uses = '''  <performance:Style id="picture-style" frame={full} appearance={recipes.media.reference}/>
  <performance:Track id="picture" timeline={program.timeline} canvas={canvas}>
    <performance:Use style={picture-style}/>
  </performance:Track>
  <caption-fine:Style id="caption-style" recipe={recipes.caption.primary} font={caption-font}/>
  <caption-fine:Track id="captions" document={story.caption} timeline={program.timeline}>
    <caption-fine:Use style={caption-style}/>
  </caption-fine:Track>
  <sound:Style id="sound-style"/>
  <sound:Track id="soundtrack" timeline={program.timeline}>
    <sound:Use style={sound-style}/>
  </sound:Track>
  <film:Film id="main" canvas={canvas} timeline={program.timeline} appearance={recipes.film.reference}>
    <film:Track source={picture.visual}/>
    <film:Track source={soundtrack.audio}/>
    <film:Track source={captions.track}/>
  </film:Film>
  <render:Video id="final" composition={main.composition} timeline={program.timeline}/>'''
    if any(not shot.get("text", "").strip() for shot in shots):
        needs.append(BridgeNeed(id="caption-empty", kind="caption", status="needed",
                                message="无旁白镜头保留为空段；Hypit 不会伪造字幕或语音时间。"))
    return f'''<?svml using="@hypit/markup@1"?>

<svml>
{imports}

  <script id="story">
{''.join(segments)}
  </script>

  <space:Canvas id="canvas" width="{width}" height="{height}"/>
  <program:Clock id="clock" frame-rate="{options.fps}"/>
  <fonts:Stack id="caption-font" family="inter" weight="700" style="normal"/>
{frame}
{chr(10).join(declarations)}
{chr(10).join(takes)}
{timeline}
{uses}
</svml>
'''


def export_hypit_package(source_project: str | Path, package_dir: str | Path,
                         options: HypitBridgeOptions | None = None) -> dict[str, Any]:
    """Export one OpenMontage project into a new Hypit package directory."""
    source, destination = _validate_destination(Path(source_project), Path(package_dir))
    selected = _options(source, options)
    shots, blueprint, script = _load_shots(source)
    needs: list[BridgeNeed] = []
    records, source_by_shot = _source_records(source, destination, shots, selected, needs)
    settings = read_json(source / "artifacts/footage_settings.json")
    transition = str(settings.get("transition") or "cut")
    if transition not in {"cut", "fade", "crossfade"}:
        needs.append(BridgeNeed(id="transition", kind="effect", status="unsupported",
                                message=f"未知转场 {transition} 未映射；需要作者确认。"))
        transition = "cut"
    if transition != "cut":
        needs.append(BridgeNeed(id="transition-runtime", kind="effect", status="needed",
                                message=f"已记录 {transition} 转场意图；Performance 时间轴桥接不自动声称已渲染该效果。"))
    if any(str(shot.get("query") or "").strip() for shot in shots):
        needs.append(BridgeNeed(id="b-roll", kind="b-roll", status="needed",
                                message="脚本含有画面查询词但没有明确本地 B-roll 文件；不会把查询词伪装成视觉理解或生成结果。"))
    if any(shot.get("text", "").strip() for shot in shots):
        needs.append(BridgeNeed(id="speech-alignment", kind="credential", status="needed",
                                message=f"有词脚本需要 Hypit 的 WhisperX 对齐 Endpoint（language={selected.language}）；本桥接未调用外部服务。"))
    if selected.variant_count > 1:
        needs.append(BridgeNeed(id="variants-review", kind="variant", status="needed",
                                message="变体配置已生成；每个变体仍需作者提供或确认素材/效果差异，不自动伪造变体结果。"))
    svml = _render_svml(source, destination, shots, blueprint, records, source_by_shot, selected, needs)
    _json_write_new(destination / "package.json", {
        "name": selected.package_id,
        "version": "0.0.0",
        "private": True,
        "type": "module",
        "description": "OpenMontage bridge package exported for Hypit authoring",
    })
    hyperframes_config: dict[str, Any] = {
        "workers": 2,
        "quality": "standard",
        "defaultConcurrency": 1,
    }
    for chrome in (
        Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        Path("/Applications/Chromium.app/Contents/MacOS/Chromium"),
    ):
        if chrome.is_file():
            # Hypit's managed Chrome download was not reliable on this host;
            # an existing browser is an official Runtime Profile option.
            hyperframes_config["chromePath"] = str(chrome)
            break
    _json_write_new(destination / "hypit.runtime.json", {
        "format": "hypit.runtime-local@1",
        "dataRoot": ".hypit/runtimes/local",
        "credentials": {},
        "endpoints": {
            "media.local": {"use": "@hypit/provider-media-local", "config": {"defaultConcurrency": 2}},
            "hyperframes.local": {"use": "@hypit/provider-hyperframes-local", "config": hyperframes_config},
            "whisperx.local": {"use": "@hypit/provider-whisperx-local", "config": {"expectedModel": "small", "alignmentLanguages": [selected.language]}},
        },
        "bindings": {"@hypit/whisperx@1#whisperx-alignment": "whisperx.local"},
    })
    # The official CLI treats a profile file and the project's selected
    # profile as separate facts.  Select the package-local profile so Studio,
    # doctor and build work from the exported directory without a hidden
    # machine-level choice.
    (destination / ".hypit").mkdir(parents=True, exist_ok=False)
    (destination / ".hypit" / "runtime").open("x", encoding="utf-8").write("hypit.runtime.json\n")
    (destination / ".hypit" / ".gitignore").open("x", encoding="utf-8").write("*\n")
    (destination / "reference.svml").open("x", encoding="utf-8").write(svml)
    (destination / "reference.svrun").open("x", encoding="utf-8").write(
        '<?svml using="@hypit/run-markup@1"?>\n<svrun version="1">\n  <author source="./reference.svml"/>\n  <target output="final.video"/>\n</svrun>\n'
    )
    (destination / "reference.svs").open("x", encoding="utf-8").write(_render_svs(selected))
    _json_write_new(destination / "assets.manifest.json", {
        "schema_version": "1.0",
        "asset_mode": selected.asset_mode,
        "source_project": str(source),
        "assets": records,
        "notice": "引用模式不复制素材；复制模式仅复制本次明确列出的本地文件。sha256 是本次导出证据。",
    })
    _json_write_new(destination / "variants.json", {
        "schema_version": "1.0",
        "count": selected.variant_count,
        "variants": [{
            "id": "default" if index == 0 else f"variant-{index+1}",
            "run": "reference.svrun",
            "status": "authored-baseline" if index == 0 else "needs_review",
            "source_selection": "same explicit local records; no automatic creative substitution",
        } for index in range(selected.variant_count)],
    })
    manifest = {
        "schema_version": "1.0",
        "bridge": "openmontage-hypit-author@1",
        "source_project": str(source),
        "package_dir": str(destination),
        "reference_id": blueprint.get("reference_id") if blueprint else None,
        "topic": blueprint.get("topic") if blueprint else script.get("title"),
        "script_segments": [{"id": s["id"], "text": s["text"], "duration_seconds": s.get("duration_seconds", 0)} for s in shots],
        "language": selected.language,
        "canvas": {"width": _canvas(selected)[0], "height": _canvas(selected)[1], "fps": selected.fps},
        "transition_intent": transition,
        "needs": [need.model_dump() for need in needs],
        "source_unchanged": True,
    }
    _json_write_new(destination / "bridge.manifest.json", manifest)
    (destination / "NEEDS.md").open("x", encoding="utf-8").write(
        "# Hypit bridge needs\n\n" + "\n".join(f"- **{n.id}** ({n.status}): {n.message}" for n in needs)
        + ("\n" if needs else "- None recorded.\n")
    )
    return {
        "status": "created",
        "package_dir": str(destination),
        "author": str(destination / "reference.svml"),
        "run": str(destination / "reference.svrun"),
        "runtime": str(destination / "hypit.runtime.json"),
        "assets_manifest": str(destination / "assets.manifest.json"),
        "runtime_selection": str(destination / ".hypit" / "runtime"),
        "variants": str(destination / "variants.json"),
        "needs": [need.model_dump() for need in needs],
        "asset_count": len(records),
        "source_unchanged": True,
    }


def build_hypit_package(source_project: str | Path, package_dir: str | Path,
                        options: HypitBridgeOptions | None = None) -> dict[str, Any]:
    """Compatibility alias used by callers that call the bridge a builder."""
    return export_hypit_package(source_project, package_dir, options)
