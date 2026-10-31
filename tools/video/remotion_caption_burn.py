"""Remotion caption burn tool — **runtime-specific (Remotion-only)**.

Renders animated word-by-word captions onto a talking-head video using
the Remotion CaptionOverlay component. Falls back to FFmpeg subtitle
burning if Remotion is not available.

The tool:
1. Converts word-level transcript segments to Remotion WordCaption JSON
2. Writes a props file for the TalkingHead composition
3. Renders via ``npx remotion render``
4. Returns the captioned video path

Fallback: if Remotion is unavailable, burns subtitles at the bottom of
the frame using FFmpeg's ``subtitles`` filter with bold styling.

## Runtime scope

This tool is **Remotion-specific** and deliberately has no HyperFrames
counterpart in Phase 1. Word-level caption burn parity on the HyperFrames
runtime is explicitly deferred work (see ``skills/core/hyperframes.md`` →
"What stays Remotion-only in Phase 1").

If a brief requires word-level/karaoke captions, lock
``render_runtime="remotion"`` at proposal even if the rest of the
composition would otherwise be a good fit for HyperFrames. Do NOT attempt
to bolt this tool onto a HyperFrames workspace — the TalkingHead
composition ID and ``WordCaption`` prop shape it emits are tied to the
React scene stack in ``remotion-composer/``.
"""

from __future__ import annotations

import json
import math
import re
import shutil
import time
import os
import uuid
import subprocess
from pathlib import Path
from typing import Any

from tools.base_tool import (
    BaseTool,
    Determinism,
    ExecutionMode,
    ResourceProfile,
    ToolResult,
    ToolStability,
    ToolTier,
)


class RemotionCaptionBurn(BaseTool):
    name = "remotion_caption_burn"
    version = "0.1.0"
    tier = ToolTier.CORE
    capability = "subtitle"
    provider = "remotion"
    stability = ToolStability.EXPERIMENTAL
    execution_mode = ExecutionMode.SYNC
    determinism = Determinism.DETERMINISTIC

    dependencies = ["cmd:ffmpeg", "cmd:ffprobe"]
    install_instructions = (
        "Remotion (optional, preferred): npm install in remotion-composer/\n"
        "FFmpeg (required for fallback): https://ffmpeg.org/download.html"
    )
    agent_skills = ["remotion-best-practices", "ffmpeg"]

    capabilities = [
        "burn_remotion_captions",
        "burn_ffmpeg_captions_fallback",
    ]

    input_schema = {
        "type": "object",
        "required": ["input_path", "output_path"],
        "properties": {
            "input_path": {
                "type": "string",
                "description": "Path to the input video (enhanced talking-head footage).",
            },
            "output_path": {
                "type": "string",
                "description": "Path for the output video with captions burned in.",
            },
            "segments": {
                "type": "array",
                "description": (
                    "Word-level transcript segments from transcriber tool. "
                    "Each segment has 'words' array with {word, start, end}."
                ),
            },
            "srt_path": {
                "type": "string",
                "description": (
                    "Path to an SRT file. Used as an alternative to segments. "
                    "If both provided, segments take priority."
                ),
            },
            'transcript_path': {'type': 'string', 'description': 'Aligned JSON from transcript_aligner or transcriber; preserves actual character timing'},
            "words_per_page": {
                "type": "integer",
                "default": 4,
                "description": "Words shown at once in the caption overlay.",
            },
            "font_size": {
                "type": "integer",
                "default": 52,
                "description": "Font size for captions.",
            },
            "highlight_color": {
                "type": "string",
                "default": "#22D3EE",
                "description": "Highlight color for the active word (hex).",
            },
            "corrections": {
                "type": "object",
                "description": (
                    "Dictionary of word corrections for common misrecognitions. "
                    "Keys are the wrong word (case-insensitive), values are the "
                    "correct replacement. Example: {\"cloud\": \"Claude\"}."
                ),
            },
            "overlays": {
                "type": "array",
                "description": (
                    "Array of overlay objects to render on top of the video. "
                    "Each overlay has: type (text_card, stat_card, callout, "
                    "comparison, bar_chart, line_chart, pie_chart, kpi_grid, "
                    "hero_title, section_title, stat_reveal), in_seconds, "
                    "out_seconds, position (lower_third, upper_third, "
                    "left_panel, right_panel, full_overlay), and component-"
                    "specific props (text, stat, chartData, etc.). "
                    "See asset_manifest overlays from the asset-director."
                ),
            },
            "force_ffmpeg": {
                "type": "boolean",
                "default": False,
                "description": "Force FFmpeg fallback even if Remotion is available.",
            },
        },
    }

    resource_profile = ResourceProfile(cpu_cores=4, ram_mb=2048, vram_mb=0, disk_mb=500)
    idempotency_key_fields = ["input_path", "segments", "srt_path"]
    side_effects = ["writes captioned video to output_path"]
    user_visible_verification = [
        "Play the output video and verify captions appear at the bottom of the frame",
        "Check that the active word is highlighted in the specified color",
        "Verify face is not occluded by caption text",
    ]

    # ------------------------------------------------------------------ #
    #  Remotion detection
    # ------------------------------------------------------------------ #

    def _find_remotion_root(self) -> Path | None:
        """Find the remotion-composer directory relative to the repo."""
        candidates = [
            Path.cwd() / "remotion-composer",
            Path(__file__).resolve().parent.parent.parent / "remotion-composer",
        ]
        for p in candidates:
            if (
                p.is_dir()
                and (p / "package.json").exists()
                and (p / "node_modules").is_dir()
            ):
                return p
        return None

    def _remotion_available(self) -> bool:
        return (
            shutil.which("npx") is not None
            and self._find_remotion_root() is not None
        )

    # ------------------------------------------------------------------ #
    #  Word caption conversion
    # ------------------------------------------------------------------ #

    def _segments_to_word_captions(
        self, segments: list[dict], corrections: dict[str, str] | None = None
    ) -> list[dict]:
        """Convert transcriber segments to [{word, startMs, endMs}, ...]."""
        captions: list[dict] = []
        corr = {k.lower(): v for k, v in (corrections or {}).items()}

        for seg in segments:
            words = seg.get("words", [])
            if words:
                for w in words:
                    raw = w["word"].strip()
                    fixed = corr.get(raw.lower().strip(".,!?;:"), raw)
                    # Preserve trailing punctuation from original
                    trailing = ""
                    if raw and raw[-1] in ".,!?;:":
                        trailing = raw[-1]
                    if fixed != raw and not fixed.endswith(trailing):
                        fixed = fixed + trailing
                    captions.append({
                        "word": fixed,
                        "startMs": int(w["start"] * 1000),
                        "endMs": int(w["end"] * 1000),
                    })
            elif "text" in seg:
                text_words = seg["text"].strip().split()
                dur = seg["end"] - seg["start"]
                per_word = dur / max(len(text_words), 1)
                for i, tw in enumerate(text_words):
                    fixed = corr.get(tw.lower().strip(".,!?;:"), tw)
                    captions.append({
                        "word": fixed,
                        "startMs": int((seg["start"] + i * per_word) * 1000),
                        "endMs": int((seg["start"] + (i + 1) * per_word) * 1000),
                    })
        return captions

    def _srt_to_word_captions(
        self, srt_path: str, corrections: dict[str, str] | None = None
    ) -> list[dict]:
        """Parse SRT file into word captions."""
        content = Path(srt_path).read_text(encoding="utf-8")
        blocks = re.split(r"\n\n+", content.strip())
        corr = {k.lower(): v for k, v in (corrections or {}).items()}
        captions: list[dict] = []

        for block in blocks:
            lines = block.strip().split("\n")
            if len(lines) < 3:
                continue
            m = re.match(
                r"(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*"
                r"(\d{2}):(\d{2}):(\d{2}),(\d{3})",
                lines[1],
            )
            if not m:
                continue
            start_ms = (
                int(m.group(1)) * 3600000
                + int(m.group(2)) * 60000
                + int(m.group(3)) * 1000
                + int(m.group(4))
            )
            end_ms = (
                int(m.group(5)) * 3600000
                + int(m.group(6)) * 60000
                + int(m.group(7)) * 1000
                + int(m.group(8))
            )
            text = " ".join(lines[2:]).strip()
            words = text.split()
            per_word = (end_ms - start_ms) / max(len(words), 1)
            for i, w in enumerate(words):
                fixed = corr.get(w.lower().strip(".,!?;:"), w)
                captions.append({
                    "word": fixed,
                    "startMs": int(start_ms + i * per_word),
                    "endMs": int(start_ms + (i + 1) * per_word),
                })
        return captions

    # ------------------------------------------------------------------ #
    #  Remotion render
    # ------------------------------------------------------------------ #

    def _render_remotion(
        self,
        input_path: str,
        output_path: str,
        captions: list[dict],
        words_per_page: int,
        font_size: int,
        highlight_color: str,
        overlays: list[dict] | None = None,
    ) -> ToolResult:
        root = self._find_remotion_root()
        if root is None:
            return ToolResult(success=False, error="Remotion root not found")

        # Get video duration in frames
        dur_cmd = [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "csv=p=0",
            input_path,
        ]
        dur_result = self.run_command(dur_cmd)
        dur_out = dur_result.stdout
        duration_s = float(dur_out.strip().split("\n")[0])
        total_frames = math.ceil(duration_s * 30)

        # Detect video dimensions
        dim_cmd = [
            "ffprobe", "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "csv=p=0:s=x",
            input_path,
        ]
        dim_result = self.run_command(dim_cmd)
        dim_parts = dim_result.stdout.strip().split("x")
        width = int(dim_parts[0])
        height = int(dim_parts[1])

        from tools.video._caption_runtime import prepare_workspace
        props_dir = Path(output_path).parent
        try:
            workspace, runtime, runtime_record = prepare_workspace(
                root, props_dir, width, height, total_frames)
        except ValueError as exc:
            return ToolResult(success=False, error=str(exc))

        # Preserve source and editable components in this render's own workspace.
        pub_dir = workspace / "public" / "talking-head"
        pub_dir.mkdir(parents=True, exist_ok=True)
        video_filename = 'caption-source-' + uuid.uuid4().hex + Path(input_path).suffix.lower()
        dest_video = pub_dir / video_filename
        shutil.copy2(input_path, dest_video)

        # Build props JSON
        props = {
            "videoSrc": f"talking-head/{video_filename}",
            "captions": captions,
            "overlays": overlays or [],
            "wordsPerPage": words_per_page,
            "fontSize": font_size,
            "highlightColor": highlight_color,
            'captionWordSeparator': '' if any(re.search(r'[\u3400-\u9fff]', c['word']) for c in captions) else ' ',
            'captionFontFamily': '"PingFang SC", "Noto Sans CJK SC", system-ui, sans-serif',
        }
        props_dir.mkdir(parents=True, exist_ok=True)
        props_file = props_dir / f"caption-burn-{uuid.uuid4().hex}.json"
        with props_file.open('x', encoding='utf-8') as stream:
            json.dump(props, stream, ensure_ascii=False, indent=2)

        node = shutil.which('node')
        if not node:
            return ToolResult(success=False, error='Node 未安装，没有下载替代运行时')
        render_cmd = [
            node, str(runtime / 'node_modules/@remotion/cli/remotion-cli.js'), 'render',
            str(workspace / 'src/caption-entry.tsx'), 'TalkingHead',
            f"--config={workspace / 'remotion.config.cjs'}",
            f"--props={props_file.resolve()}",
            f"--width={width}", f"--height={height}", "--fps=30",
            f"--frames=0-{total_frames - 1}",
            "--codec=h264", "--crf=18",
            '--concurrency=2',
            f"--output={str(Path(output_path).resolve())}",
        ]
        browser = os.environ.get('REMOTION_BROWSER_EXECUTABLE', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
        if Path(browser).is_file():
            render_cmd += ['--browser-executable=' + browser]
        try:
            self.run_command(render_cmd, cwd=str(workspace))
        except subprocess.CalledProcessError as exc:
            detail = (exc.stderr or exc.stdout or 'Render process failed').strip()
            return ToolResult(success=False, error='Remotion render failed: ' + detail[-1800:], artifacts=[str(props_file)])

        if not Path(output_path).exists():
            return ToolResult(success=False, error="Remotion render produced no output")

        return ToolResult(
            success=True,
            data={
                "method": "remotion",
                "output": output_path,
                "duration_seconds": round(duration_s, 2),
                "total_frames": total_frames,
                "caption_count": len(captions),
                "overlay_count": len(overlays or []),
                "words_per_page": words_per_page,
                'runtime': runtime_record,
            },
            artifacts=[output_path, str(props_file), str(workspace / 'runtime.json'), str(workspace / 'src/caption-entry.tsx')],
        )

    # ------------------------------------------------------------------ #
    #  FFmpeg fallback
    # ------------------------------------------------------------------ #

    def _render_ffmpeg(
        self,
        input_path: str,
        output_path: str,
        captions: list[dict],
    ) -> ToolResult:
        """Fall back to FFmpeg subtitle burning at bottom of frame."""
        # Generate temporary SRT from word captions
        tmp_srt = Path(output_path).parent / f"captions-{uuid.uuid4().hex}.srt"
        tmp_srt.parent.mkdir(parents=True, exist_ok=True)

        srt_lines = []
        idx = 1
        # Group into pages of ~4 words
        page_size = 4
        for i in range(0, len(captions), page_size):
            page = captions[i : i + page_size]
            text = " ".join(c["word"] for c in page)
            start = page[0]["startMs"]
            end = page[-1]["endMs"]
            srt_lines.append(str(idx))
            srt_lines.append(
                f"{self._ms_to_srt(start)} --> {self._ms_to_srt(end)}"
            )
            srt_lines.append(text)
            srt_lines.append("")
            idx += 1

        tmp_srt.write_text("\n".join(srt_lines), encoding="utf-8")

        # Escape path for FFmpeg subtitles filter (Windows colon issue)
        srt_escaped = str(tmp_srt).replace("\\", "/").replace(":", "\\:")

        cmd = [
            "ffmpeg", "-n",
            "-i", input_path,
            "-vf", (
                f"subtitles='{srt_escaped}'"
                ":force_style='FontName=Segoe UI,FontSize=24,Bold=1,"
                "PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,"
                "Outline=3,Shadow=2,Alignment=2,MarginV=100'"
            ),
            "-c:v", "libx264", "-preset", "fast", "-crf", "18",
            "-pix_fmt", "yuv420p",
            "-c:a", "copy",
            output_path,
        ]
        self.run_command(cmd)

        # Retain the subtitle source beside the render for inspection.

        if not Path(output_path).exists():
            return ToolResult(success=False, error="FFmpeg subtitle burn produced no output")

        return ToolResult(
            success=True,
            data={
                "method": "ffmpeg_fallback",
                "output": output_path,
                "caption_count": len(captions),
                "note": "Used FFmpeg fallback. Install Remotion for animated captions.",
            },
            artifacts=[output_path, str(tmp_srt)],
        )

    @staticmethod
    def _ms_to_srt(ms: int) -> str:
        h = ms // 3600000
        m = (ms % 3600000) // 60000
        s = (ms % 60000) // 1000
        rem = ms % 1000
        return f"{h:02d}:{m:02d}:{s:02d},{rem:03d}"

    # ------------------------------------------------------------------ #
    #  Main execute
    # ------------------------------------------------------------------ #

    def execute(self, inputs: dict[str, Any]) -> ToolResult:
        input_path = inputs["input_path"]
        output_path = inputs["output_path"]
        corrections = inputs.get("corrections")
        force_ffmpeg = inputs.get("force_ffmpeg", False)
        words_per_page = inputs.get("words_per_page", 4)
        font_size = inputs.get("font_size", 52)
        highlight_color = inputs.get("highlight_color", "#22D3EE")

        if not Path(input_path).exists():
            return ToolResult(success=False, error=f"Input video not found: {input_path}")
        if Path(output_path).exists() or Path(input_path).resolve() == Path(output_path).resolve():
            return ToolResult(success=False, error='输出文件已存在；请选择新文件名，原成果保留')

        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        start = time.time()

        # Build word captions from segments or SRT
        segments = inputs.get("segments")
        srt_path = inputs.get("srt_path")
        transcript_path = inputs.get('transcript_path')
        if transcript_path:
            source = Path(transcript_path)
            if not source.is_file() or source.suffix.lower() != '.json' or source.stat().st_size > 5_000_000:
                return ToolResult(success=False, error='请提供已存在的字幕 JSON（最多 5 MB）')
            try:
                payload = json.loads(source.read_text(encoding='utf-8'))
                segments = payload['segments']
            except (ValueError, KeyError, TypeError):
                return ToolResult(success=False, error='字幕 JSON 没有有效 segments；没有编造词级时间')

        if not segments and not srt_path:
            return ToolResult(
                success=False,
                error="请提供已对齐的字幕 JSON、分段词级记录，或普通 SRT 字幕。",
            )
        try:
            if segments:
                captions = self._segments_to_word_captions(segments, corrections)
            else:
                captions = self._srt_to_word_captions(srt_path, corrections)
        except (ValueError, TypeError, KeyError, AttributeError, OverflowError, OSError):
            return ToolResult(success=False, error='字幕格式或词级时间无效；没有生成假完成视频')

        if not captions:
            return ToolResult(success=False, error="No caption words extracted.")

        overlays = inputs.get("overlays")
        timed = bool(segments) and all(s.get('words') and all(
            isinstance(w.get('start'), (int, float)) and isinstance(w.get('end'), (int, float))
            for w in s['words']) for s in segments)
        if not isinstance(words_per_page, int) or not isinstance(font_size, int) or not 1 <= words_per_page <= 30 or not 8 <= font_size <= 200:
            return ToolResult(success=False, error='每屏字幕须为 1–30 字/词，字号须为 8–200')
        if any(not math.isfinite(c['startMs']) or not math.isfinite(c['endMs']) or c['startMs'] < 0 or c['endMs'] <= c['startMs'] for c in captions):
            return ToolResult(success=False, error='字幕有无效词级时间；没有生成假完成视频')

        # Choose render method
        if not force_ffmpeg and self._remotion_available():
            result = self._render_remotion(
                input_path, output_path, captions,
                words_per_page, font_size, highlight_color,
                overlays=overlays,
            )
        else:
            result = self._render_ffmpeg(input_path, output_path, captions)

        result.duration_seconds = round(time.time() - start, 2)
        result.data['word_timing_source'] = 'provided_word_timestamps' if timed else 'estimated_from_sentence_times'
        if not timed:
            result.data['limitations'] = ['当前为句内均分的估计时间，不能当作真实词级对齐；请先用中文精细字幕对齐。']
        return result
