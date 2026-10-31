"""Video/image understanding tool using vision-language models.

Analyzes images or video frames using CLIP, BLIP, BLIP-2, or LLaVA. Supports
frame description, visual question answering, quality assessment, and
scene classification. Primary use case: visual QA for automated video review.
"""

from __future__ import annotations

import subprocess
import importlib.util
import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any

from tools.base_tool import (
    BaseTool,
    Determinism,
    ExecutionMode,
    ResourceProfile,
    ToolResult,
    ToolRuntime,
    ToolStability,
    ToolStatus,
    ToolTier,
)

VIDEO_EXTENSIONS = {".mp4", ".mov", ".avi", ".webm"}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".bmp", ".tiff", ".webp"}

SCENE_CATEGORIES = [
    "indoor", "outdoor", "landscape", "cityscape", "portrait",
    "action", "close-up", "aerial", "underwater", "night",
    "studio", "nature", "urban", "abstract", "text-overlay",
]


class VideoUnderstand(BaseTool):
    name = "video_understand"
    version = "0.1.0"
    tier = ToolTier.ANALYZE
    capability = "analysis"
    provider = "transformers"
    stability = ToolStability.EXPERIMENTAL
    execution_mode = ExecutionMode.SYNC
    determinism = Determinism.DETERMINISTIC
    runtime = ToolRuntime.LOCAL

    dependencies = ["python:transformers", "python:torch"]
    install_instructions = (
        "技术质量检查使用本机 Pillow/NumPy/SciPy；CLIP 分类复用 .runtime/montage-ml 与已安装的安全权重。"
        "BLIP 使用本机轻量描述/问答权重；主要支持英语。BLIP-2/LLaVA 需另行安装较大权重；不会自动下载或切换模型。"
    )
    agent_skills = ["video-understand"]

    capabilities = [
        "image_description",
        "visual_qa",
        "quality_assessment",
        "scene_classification",
    ]

    input_schema = {
        "type": "object",
        "required": ["input_path"],
        "properties": {
            "input_path": {
                "type": "string",
                "description": "Path to image or video file",
            },
            "query": {
                "type": "string",
                "description": "Question to answer about the visual content (for VQA mode)",
            },
            "mode": {
                "type": "string",
                "enum": ["describe", "qa", "quality", "classify"],
                "default": "describe",
                "description": (
                    "describe: 描述画面（CLIP 仅返回候选类别标签）；qa: 视觉问答（CLIP 不支持）；"
                    "quality: 技术质量指标；classify: 场景分类。分类分数不是事实正确率。"
                ),
            },
            "model": {
                "type": "string",
                "enum": ["clip", "blip", "blip2", "llava"],
                "default": "clip",
                "description": "clip：检索/分类；blip：轻量画面描述/英语视觉问答；blip2、llava：需另装大模型",
            },
            "frame_indices": {
                "type": "array",
                "items": {"type": "integer", "minimum": 0},
                "description": (
                    "For video input, which frames to analyze. "
                    "If not provided, samples key frames at even intervals."
                ),
            },
            "max_frames": {
                "type": "integer",
                "minimum": 1,
                "maximum": 32,
                "default": 5,
                "description": "Maximum number of frames to analyze from video",
            },
        },
    }

    output_schema = {
        "type": "object",
        "properties": {
            "frames": {
                "type": "array",
                "description": "Per-frame analysis results",
            },
            "summary": {"type": "string"},
            "mode": {"type": "string"},
            "model": {"type": "string"},
        },
    }

    resource_profile = ResourceProfile(
        cpu_cores=2,
        ram_mb=4096,
        vram_mb=0,
        disk_mb=1000,
        network_required=False,
    )

    idempotency_key_fields = ["input_path", "mode", "model", "query"]
    side_effects = []
    fallback = None
    user_visible_verification = [
        "Compare generated descriptions against actual visual content",
        "Verify quality scores match perceived image quality",
    ]

    def get_status(self) -> ToolStatus:
        # Modes have different requirements. CPU metrics/CLIP are useful even
        # when the much larger captioning and question-answering models are absent.
        if all(importlib.util.find_spec(name) for name in ("PIL", "numpy", "scipy")):
            return ToolStatus.DEGRADED
        return ToolStatus.UNAVAILABLE

    @staticmethod
    def _caption_model_path(model_name: str) -> Path:
        root = Path(__file__).resolve().parents[2]
        variable = f"OPENMONTAGE_{model_name.upper()}_MODEL_PATH"
        return Path(os.environ.get(variable, str(root / ".runtime/models" / model_name)))

    @staticmethod
    def _blip_model_path(mode: str) -> Path:
        root = Path(__file__).resolve().parents[2]
        kind = 'caption' if mode == 'describe' else 'vqa'
        return Path(os.environ.get(f'OPENMONTAGE_BLIP_{kind.upper()}_MODEL_PATH',
            str(root / f'.runtime/models/blip-{kind}-base-20261001')))

    @staticmethod
    def _safe_weights_installed(path: Path) -> bool:
        if not (path / "config.json").is_file():
            return False
        if (path / "model.safetensors").is_file():
            return True
        index = path / "model.safetensors.index.json"
        if not index.is_file():
            return False
        try:
            names = set(json.loads(index.read_text())["weight_map"].values())
            return bool(names) and all(
                isinstance(name, str) and Path(name).name == name
                and name.endswith(".safetensors") and (path / name).is_file()
                for name in names
            )
        except (ValueError, KeyError, TypeError, OSError):
            return False

    def input_requirements(self, inputs: dict[str, Any]) -> list[str]:
        """Read-only, mode-specific requirements shared by preflight and execution."""
        mode, model = inputs.get("mode", "describe"), inputs.get("model", "clip")
        if mode == "quality":
            return [] if all(importlib.util.find_spec(n) for n in ("PIL", "numpy", "scipy")) else ["技术质量检查缺少 Pillow、NumPy 或 SciPy"]
        if model == "clip":
            if mode == "qa":
                return ["CLIP 只能比较画面与候选描述，不能进行视觉问答；请选择已安装的 BLIP / BLIP-2 / LLaVA"]
            from lib.clip_embedder import local_runtime_ready
            return [] if local_runtime_ready() else ["请先安装本机 CLIP 运行时及固定 safetensors 权重"]
        if model == 'blip':
            from tools.local_ml_runtime import runtime_ready
            if not runtime_ready('vision'):
                return ['BLIP 的项目内 Torch/Transformers 运行时未安装；不会改用 CLIP']
            path = self._blip_model_path(mode)
            files = ['config.json', 'model.safetensors', 'preprocessor_config.json', 'vocab.txt', 'tokenizer_config.json']
            return [] if all((path / f).is_file() for f in files) else ['请先安装所选 BLIP 描述/问答模型的完整本机 safetensors 权重']
        if not all(importlib.util.find_spec(n) for n in ("transformers", "torch")):
            return [f"{model} 的本机 Torch/Transformers 运行时尚未配置；不会改用 CLIP"]
        if not self._safe_weights_installed(self._caption_model_path(model)):
            return [f"{model} 的本机 safetensors 权重尚未安装；不会联网下载或改用其他模型"]
        return []

    def estimate_runtime(self, inputs: dict[str, Any]) -> float:
        """Estimate runtime in seconds based on mode and frame count."""
        max_frames = inputs.get("max_frames", 5)
        mode = inputs.get("mode", "describe")
        if mode == "quality":
            return max_frames * 0.5  # quality metrics are fast
        return max_frames * 5.0  # VLM inference per frame

    def execute(self, inputs: dict[str, Any]) -> ToolResult:
        input_path = Path(inputs["input_path"])
        mode = inputs.get("mode", "describe")
        model_name = inputs.get("model", "clip")
        query = inputs.get("query")
        frame_indices = inputs.get("frame_indices")
        max_frames = inputs.get("max_frames", 5)

        if not input_path.exists():
            return ToolResult(
                success=False,
                error=f"Input file not found: {input_path}",
            )

        suffix = input_path.suffix.lower()
        is_video = suffix in VIDEO_EXTENSIONS
        is_image = suffix in IMAGE_EXTENSIONS

        if not is_video and not is_image:
            return ToolResult(
                success=False,
                error=(
                    f"Unsupported file type: {suffix}. "
                    f"Supported: {sorted(VIDEO_EXTENSIONS | IMAGE_EXTENSIONS)}"
                ),
            )

        if mode == "qa" and not query:
            return ToolResult(
                success=False,
                error="Query is required for 'qa' mode.",
            )

        if mode not in {"describe", "qa", "quality", "classify"} or model_name not in {"clip", "blip", "blip2", "llava"}:
            return ToolResult(success=False, error="Unknown visual analysis mode or model")
        if isinstance(max_frames, bool) or not isinstance(max_frames, int) or not 1 <= max_frames <= 32:
            return ToolResult(success=False, error="max_frames must be an integer between 1 and 32")
        if frame_indices is not None and (not isinstance(frame_indices, list) or any(
            isinstance(i, bool) or not isinstance(i, int) or i < 0 for i in frame_indices
        )):
            return ToolResult(success=False, error="frame_indices must contain non-negative integers")
        requirements = self.input_requirements(inputs)
        if requirements:
            return ToolResult(success=False, error="；".join(requirements))
        if model_name == 'blip' and mode != 'quality':
            from tools import local_ml_runtime
            if local_ml_runtime.needs_bridge():
                return local_ml_runtime.execute(self.name, inputs)

        start = time.time()

        # --- Load frames ---
        try:
            frames = self._load_frames(
                input_path, is_video, frame_indices, max_frames
            )
        except Exception as e:
            return ToolResult(success=False, error=f"Failed to load frames: {e}")

        if not frames:
            return ToolResult(success=False, error="No frames could be extracted.")

        # --- Analyze each frame ---
        try:
            if mode == "quality":
                frame_results = self._analyze_quality(frames)
            elif mode == "describe":
                frame_results = self._analyze_describe(frames, model_name)
            elif mode == "qa":
                frame_results = self._analyze_qa(frames, model_name, query)
            elif mode == "classify":
                frame_results = self._analyze_classify(frames, model_name)
            else:
                return ToolResult(success=False, error=f"Unknown mode: {mode}")
        except ImportError as e:
            return ToolResult(
                success=False,
                error=f"Missing dependency for {model_name}: {e}",
            )
        except Exception as e:
            return ToolResult(success=False, error=f"Analysis failed: {e}")
        finally:
            for image in frames:
                image.close()

        elapsed = time.time() - start

        # --- Build summary ---
        summary = self._build_summary(frame_results, mode)

        return ToolResult(
            success=True,
            data={
                "frames": frame_results,
                "summary": summary,
                "mode": mode,
                "model": model_name if mode != "quality" else "metrics",
                "frame_count": len(frame_results),
                "limitations": (
                    ["CLIP 结果是候选标签的视觉相似度，不是完整画面叙述、事实验证或校准的正确率。"]
                    if model_name == "clip" and mode != "quality" else
                    ["亮度、对比度和模糊指标仅作技术参考，不代表作品审美或事实正确性。"]
                    if mode == "quality" else
                    ["BLIP 主要支持英语，描述和回答可能出错；不能据此确认具体景点、史实或人物身份。"]
                    if model_name == 'blip' else []
                ),
            },
            duration_seconds=round(elapsed, 2),
            model=model_name if mode != "quality" else None,
        )

    # ------------------------------------------------------------------
    # Frame extraction
    # ------------------------------------------------------------------

    def _load_frames(
        self,
        input_path: Path,
        is_video: bool,
        frame_indices: list[int] | None,
        max_frames: int,
    ) -> list:
        """Load PIL Image objects from an image or video file."""
        from PIL import Image

        if not is_video:
            return [Image.open(input_path).convert("RGB")]

        return self._extract_video_frames(input_path, frame_indices, max_frames)

    @staticmethod
    def _video_duration_seconds(video_path: Path) -> float | None:
        """Duration via ffprobe, or None when it cannot be determined."""
        try:
            out = subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration",
                 "-of", "default=noprint_wrappers=1:nokey=1", str(video_path)],
                capture_output=True, text=True, timeout=30,
            ).stdout.strip()
            duration = float(out)
            return duration if duration > 0 else None
        except (ValueError, OSError, subprocess.SubprocessError):
            return None

    def _extract_video_frames(
        self,
        video_path: Path,
        frame_indices: list[int] | None,
        max_frames: int,
    ) -> list:
        """Extract frames from a video file using ffmpeg.

        Without explicit frame_indices, frames are sampled by TIMESTAMP across
        the whole clip. The obvious spelling, `-vf thumbnail=N -frames:v N`,
        looks like even sampling and is not: thumbnail=N picks the most
        representative frame out of each consecutive N-frame batch, so paired
        with -frames:v N it stops after the opening seconds and never sees the
        rest. A four-second clip that is solid red for 2s then solid blue for
        2s yielded four red frames, and the caption pass then described it as
        a video in which nothing changes.
        """
        from PIL import Image

        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)

            if frame_indices:
                # Explicit indices: the select filter is exactly right here.
                frames_to_extract = frame_indices[:max_frames]
                select_expr = "+".join(
                    f"eq(n\\,{idx})" for idx in frames_to_extract
                )
                subprocess.run(
                    ["ffmpeg", "-i", str(video_path),
                     "-vf", f"select='{select_expr}'",
                     "-vsync", "vfr",
                     str(tmp / "frame_%04d.png"),
                     "-y", "-loglevel", "error"],
                    capture_output=True, text=True, timeout=60,
                )
            elif (duration := self._video_duration_seconds(video_path)) is not None:
                # Land inside each 1/N slice rather than on its edge, so a cut
                # exactly on a boundary does not sample the frame before or
                # after it depending on rounding.
                for index in range(max_frames):
                    stamp = duration * (index + 0.5) / max_frames
                    # -ss ahead of -i seeks by keyframe: fast, and accurate
                    # enough for sampling, which is not frame-exact anyway.
                    subprocess.run(
                        ["ffmpeg", "-ss", f"{stamp:.3f}", "-i", str(video_path),
                         "-frames:v", "1",
                         str(tmp / f"frame_{index:04d}.png"),
                         "-y", "-loglevel", "error"],
                        capture_output=True, text=True, timeout=60,
                    )
            else:
                # No duration — a stream, or no ffprobe on PATH. Fall back to
                # an even pass over the file rather than returning nothing.
                subprocess.run(
                    ["ffmpeg", "-i", str(video_path),
                     "-vsync", "vfr", "-frames:v", str(max_frames),
                     str(tmp / "frame_%04d.png"),
                     "-y", "-loglevel", "error"],
                    capture_output=True, text=True, timeout=60,
                )

            # Load extracted frames
            frame_files = sorted(tmp.glob("frame_*.png"))
            images = []
            for f in frame_files[:max_frames]:
                images.append(Image.open(f).convert("RGB"))

            return images

    # ------------------------------------------------------------------
    # Quality assessment (uses PIL/numpy, no VLM needed)
    # ------------------------------------------------------------------

    def _analyze_quality(self, frames: list) -> list[dict[str, Any]]:
        """Assess technical quality using simple image metrics."""
        import numpy as np

        results = []
        for i, img in enumerate(frames):
            arr = np.array(img, dtype=np.float64)
            gray = np.mean(arr, axis=2)

            # Blur detection: Laplacian variance (low = blurry)
            # Manual Laplacian approximation using numpy
            laplacian_kernel = np.array([[0, 1, 0], [1, -4, 1], [0, 1, 0]])
            from scipy.signal import convolve2d
            laplacian = convolve2d(gray, laplacian_kernel, mode="valid")
            blur_score = float(np.var(laplacian))

            # Brightness: mean pixel value (0-255 scale)
            brightness = float(np.mean(arr))

            # Contrast: standard deviation of pixel values
            contrast = float(np.std(arr))

            # Classify quality
            quality_issues = []
            if blur_score < 100:
                quality_issues.append("blurry")
            if brightness < 40:
                quality_issues.append("underexposed")
            elif brightness > 220:
                quality_issues.append("overexposed")
            if contrast < 30:
                quality_issues.append("low_contrast")

            quality_label = "good" if not quality_issues else "issues_detected"

            results.append({
                "frame_index": i,
                "blur_score": round(blur_score, 2),
                "brightness": round(brightness, 2),
                "contrast": round(contrast, 2),
                "quality": quality_label,
                "issues": quality_issues,
                "resolution": f"{img.width}x{img.height}",
            })

        return results

    # ------------------------------------------------------------------
    # VLM-based analysis modes
    # ------------------------------------------------------------------

    def _load_model(self, model_name: str, *, mode: str = 'describe'):
        """Load the requested vision-language model and processor."""
        import torch
        from transformers import (
            Blip2Processor,
            Blip2ForConditionalGeneration,
            AutoProcessor,
            LlavaForConditionalGeneration,
        )

        device = "cuda" if torch.cuda.is_available() else "cpu"
        model_path = str(self._caption_model_path(model_name))
        options = {"local_files_only": True, "use_safetensors": True,
                   "torch_dtype": torch.float16 if device == "cuda" else torch.float32}

        if model_name == 'blip':
            from transformers import BlipProcessor, BlipForConditionalGeneration, BlipForQuestionAnswering
            model_path = str(self._blip_model_path(mode))
            processor = BlipProcessor.from_pretrained(model_path, local_files_only=True)
            cls = BlipForConditionalGeneration if mode == 'describe' else BlipForQuestionAnswering
            model = cls.from_pretrained(model_path, **options).eval().to(device)
            return model, processor, device

        if model_name == "blip2":
            processor = Blip2Processor.from_pretrained(model_path, local_files_only=True)
            model = Blip2ForConditionalGeneration.from_pretrained(
                model_path, **options
            ).to(device)
            return model, processor, device

        if model_name == "llava":
            processor = AutoProcessor.from_pretrained(model_path, local_files_only=True)
            model = LlavaForConditionalGeneration.from_pretrained(
                model_path, **options
            ).to(device)
            return model, processor, device

        raise ValueError(f"Unknown model: {model_name}")

    @staticmethod
    def _clip_scores(frames: list, candidates: list[str]):
        """Use the same verified offline CLIP runtime as visual corpus retrieval."""
        from lib.clip_embedder import embed_images, embed_texts
        with tempfile.TemporaryDirectory(prefix="montage-visual-") as directory:
            paths = []
            for index, image in enumerate(frames):
                path = Path(directory) / f"frame-{index}.png"
                image.save(path)
                paths.append(path)
            image_vectors = embed_images(paths)
        return image_vectors @ embed_texts(candidates).T

    @staticmethod
    def _caption_frame(model, processor, device, image, model_name, prompt):
        import torch
        if model_name == 'blip':
            is_question = prompt.startswith('Question: ')
            if is_question:
                question = prompt[len('Question: '):]
                if question.endswith(' Answer:'): question = question[:-len(' Answer:')]
                inputs = processor(images=image, text=question, return_tensors='pt').to(device)
            else:
                inputs = processor(images=image, return_tensors='pt').to(device)
            with torch.inference_mode():
                generated = model.generate(**inputs, max_new_tokens=50, do_sample=False)
            return processor.decode(generated[0], skip_special_tokens=True).strip()
        if model_name == "llava":
            prompt = f"USER: <image>\n{prompt}\nASSISTANT:"
        inputs = processor(images=image, text=prompt, return_tensors="pt").to(device)
        with torch.no_grad():
            generated = model.generate(**inputs, max_new_tokens=80)
        if model_name == "llava":
            generated = generated[:, inputs["input_ids"].shape[1]:]
        text = processor.batch_decode(generated, skip_special_tokens=True)[0].strip()
        return text[len(prompt):].strip() if text.startswith(prompt) else text

    def _analyze_describe(
        self, frames: list, model_name: str
    ) -> list[dict[str, Any]]:
        """Captions for generative models; explicitly labelled candidates for CLIP."""
        if model_name == "clip":
            candidates = [
                "a photo of a person", "a photo of a landscape", "a photo of an object",
                "a photo of text", "a photo of an animal", "a photo of a building",
                "a photo of food", "a photo of a vehicle", "an abstract image",
                "a dark scene", "a bright scene",
            ]
            scores = self._clip_scores(frames, candidates)
            return [{"frame_index": i, "description": candidates[int(row.argmax())],
                     "description_kind": "candidate_label", "similarity": round(float(row.max()), 4),
                     "score_kind": "cosine_similarity_not_probability"}
                    for i, row in enumerate(scores)]
        model, processor, device = self._load_model(model_name)
        return [{"frame_index": i, "description": self._caption_frame(
            model, processor, device, image, model_name, "Describe the image.")}
            for i, image in enumerate(frames)]

    def _analyze_qa(
        self, frames: list, model_name: str, query: str
    ) -> list[dict[str, Any]]:
        """Answer a question about each frame."""
        if model_name == "clip":
            raise ValueError("CLIP does not support visual question answering; no yes/no guess is returned")
        model, processor, device = self._load_model(model_name, mode='qa')
        return [{"frame_index": i, "query": query, "answer": self._caption_frame(
            model, processor, device, image, model_name, f"Question: {query} Answer:")}
            for i, image in enumerate(frames)]

    def _analyze_classify(
        self, frames: list, model_name: str
    ) -> list[dict[str, Any]]:
        """Classify each frame into scene categories."""
        if model_name == "clip":
            scores = self._clip_scores(frames, [f"a {category} scene" for category in SCENE_CATEGORIES])
            results = []
            for i, row in enumerate(scores):
                ranked = sorted(zip(SCENE_CATEGORIES, row.tolist()), key=lambda x: x[1], reverse=True)
                results.append({"frame_index": i, "top_category": ranked[0][0],
                    "score_kind": "cosine_similarity_not_probability",
                    "categories": [{"label": label, "score": round(score, 4)} for label, score in ranked[:5]]})
            return results
        model, processor, device = self._load_model(model_name, mode='classify')
        prompt = "Classify this image into one of these categories: " + ", ".join(SCENE_CATEGORIES) + ". Category:"
        if model_name == 'blip':
            prompt = 'Question: Which kind of scene is in this image? Answer:'
        return [{"frame_index": i, "top_category": self._caption_frame(
            model, processor, device, image, model_name, prompt)} for i, image in enumerate(frames)]

    # ------------------------------------------------------------------
    # Summary
    # ------------------------------------------------------------------

    def _build_summary(
        self, frame_results: list[dict[str, Any]], mode: str
    ) -> str:
        """Build a human-readable summary from per-frame results."""
        n = len(frame_results)

        if mode == "describe":
            descriptions = [r.get("description", "") for r in frame_results]
            if n == 1:
                return descriptions[0]
            return f"Analyzed {n} frames. Descriptions: " + "; ".join(descriptions)

        if mode == "qa":
            answers = [r.get("answer", "") for r in frame_results]
            if n == 1:
                return answers[0]
            return f"Analyzed {n} frames. Answers: " + "; ".join(answers)

        if mode == "quality":
            issues_all = []
            for r in frame_results:
                issues_all.extend(r.get("issues", []))
            if not issues_all:
                return f"All {n} frame(s) passed quality checks."
            unique_issues = sorted(set(issues_all))
            return (
                f"Analyzed {n} frame(s). Issues found: {', '.join(unique_issues)}."
            )

        if mode == "classify":
            categories = [r.get("top_category", "unknown") for r in frame_results]
            if n == 1:
                return f"Scene classified as: {categories[0]}"
            return (
                f"Analyzed {n} frames. Scene categories: "
                + ", ".join(categories)
            )

        return f"Analyzed {n} frame(s)."
