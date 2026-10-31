"""CLIP embedder: thin wrapper around openai/clip-vit-base-patch32 for
corpus indexing and text-to-visual similarity ranking.

Design notes
------------
This module intentionally does ONE thing: turn images and text into
normalised 512-d float32 vectors that can be cosine-compared.

- Single shared model instance, lazy-loaded on first call, so the 350 MB
  weights only load once per process regardless of how many places in
  the codebase embed something.
- CPU by default, GPU if available. The ViT-B/32 variant runs at
  ~150-300 ms per image on a modern CPU — fast enough for corpora of
  a few hundred candidates without needing FAISS.
- Output vectors are L2-normalised so cosine similarity reduces to a
  dot product — downstream code can `embeddings @ query_vec.T` and
  interpret it as cosine similarity directly.
- Batched at the caller's request count; no internal mini-batching.
  For corpora > a few hundred items, the caller should chunk.

This file does NOT decide what to embed or how to use the embeddings.
That intelligence lives in the corpus manager and retrieval skills.
"""
from __future__ import annotations

from pathlib import Path
import importlib.util
import json
import os
import subprocess
import sys
from typing import Iterable, Sequence, Union

import numpy as np

# Import heavy deps lazily inside methods so importing this module does
# not pull torch/transformers unless someone actually uses it.


_MODEL = None
_PROCESSOR = None
_DEVICE: str = "cpu"
_MODEL_ID = "openai/clip-vit-base-patch32"


def local_runtime() -> tuple[Path, Path]:
    root = Path(__file__).resolve().parents[1]
    return (Path(os.environ.get('OPENMONTAGE_CLIP_PYTHON', str(root / '.runtime/montage-ml/bin/python'))),
            Path(os.environ.get('OPENMONTAGE_CLIP_MODEL_PATH', str(root / '.runtime/models/clip-vit-base-patch32-20261001'))))


def local_runtime_ready() -> bool:
    python, model = local_runtime()
    return python.is_file() and all((model / f).is_file() for f in ('model.safetensors', 'config.json', 'vocab.json', 'merges.txt', 'preprocessor_config.json'))


def _needs_bridge() -> bool:
    return importlib.util.find_spec('torch') is None or importlib.util.find_spec('transformers') is None


def _bridge(operation: str, values: Sequence) -> np.ndarray:
    python, model = local_runtime()
    if not local_runtime_ready():
        raise RuntimeError('Local CLIP runtime/verified model is not installed; no implicit model download')
    env = {**os.environ, 'OPENMONTAGE_CLIP_MODEL_PATH': str(model),
           'PYTHONPATH': str(Path(__file__).resolve().parents[1]),
           'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1', 'OMP_NUM_THREADS': '2'}
    result = subprocess.run([str(python), '-m', 'lib.clip_embedder'],
        input=json.dumps({'operation': operation, 'values': list(map(str, values))}),
        text=True, capture_output=True, env=env, timeout=180)
    if result.returncode:
        raise RuntimeError('Local CLIP inference failed; no external fallback was attempted')
    array = np.asarray(json.loads(result.stdout)['embeddings'], dtype=np.float32)
    if array.shape != (len(values), 512) or not np.isfinite(array).all():
        raise RuntimeError('Invalid CLIP embeddings')
    return array


def _load() -> None:
    """Load CLIP model and processor exactly once per process."""
    global _MODEL, _PROCESSOR, _DEVICE
    if _MODEL is not None:
        return
    import torch  # type: ignore
    from transformers import CLIPModel, CLIPProcessor  # type: ignore

    _DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
    _, local = local_runtime()
    if not (local / 'model.safetensors').is_file():
        raise RuntimeError('Install the verified local CLIP safetensors model first; automatic downloads are disabled')
    _PROCESSOR = CLIPProcessor.from_pretrained(str(local), local_files_only=True)
    _MODEL = CLIPModel.from_pretrained(str(local), local_files_only=True, use_safetensors=True).to(_DEVICE)
    _MODEL.eval()


def model_info() -> dict:
    """Return metadata about the loaded model (for index provenance)."""
    return {
        "model_id": _MODEL_ID,
        "device": _DEVICE,
        "dim": 512,
        "local_weights": str(local_runtime()[1]),
        "runtime": 'isolated_cpu' if _needs_bridge() else 'in_process',
        "query_language_note": 'Original CLIP primarily supports English; verify Chinese matches or provide English descriptions.',
    }


def _as_feature_tensor(features):
    """Normalize CLIP feature return values across transformers versions.

    Transformers 4 returned the projected tensor directly. Transformers 5 may
    wrap that tensor in a model-output object whose ``pooler_output`` contains
    the same shared-space embedding. Do not project it again: the vision
    projection expects the pre-projection width, while ``pooler_output`` is
    already the final CLIP width.
    """

    pooled = getattr(features, "pooler_output", None)
    return features if pooled is None else pooled


def embed_images(image_paths: Sequence[Union[str, Path]]) -> np.ndarray:
    """Embed a list of image files into a (N, 512) float32 matrix.

    Each row is L2-normalised.
    """
    if not image_paths:
        return np.zeros((0, 512), dtype=np.float32)
    if _needs_bridge():
        return np.concatenate([_bridge('images', image_paths[i:i+16]) for i in range(0, len(image_paths), 16)])

    import torch  # type: ignore
    from PIL import Image  # type: ignore

    _load()
    assert _MODEL is not None and _PROCESSOR is not None

    images = []
    for p in image_paths:
        img = Image.open(str(p)).convert("RGB")
        images.append(img)

    inputs = _PROCESSOR(images=images, return_tensors="pt").to(_DEVICE)
    with torch.no_grad():
        features = _as_feature_tensor(_MODEL.get_image_features(**inputs))
    features = features / features.norm(dim=-1, keepdim=True).clamp_min(1e-8)
    arr = features.cpu().numpy().astype(np.float32, copy=False)
    # Close PIL handles to avoid leaking file handles on Windows
    for img in images:
        img.close()
    return arr


def embed_texts(texts: Sequence[str]) -> np.ndarray:
    """Embed a list of text strings into a (N, 512) float32 matrix.

    Each row is L2-normalised.
    """
    if not texts:
        return np.zeros((0, 512), dtype=np.float32)
    if _needs_bridge():
        return np.concatenate([_bridge('texts', texts[i:i+32]) for i in range(0, len(texts), 32)])

    import torch  # type: ignore

    _load()
    assert _MODEL is not None and _PROCESSOR is not None

    # Empty strings break the processor — substitute a placeholder so
    # the alignment with caller indices stays intact.
    safe_texts = [t if t and t.strip() else "untitled" for t in texts]

    inputs = _PROCESSOR(
        text=safe_texts,
        return_tensors="pt",
        padding=True,
        truncation=True,
        max_length=77,
    ).to(_DEVICE)
    with torch.no_grad():
        features = _as_feature_tensor(_MODEL.get_text_features(**inputs))
    features = features / features.norm(dim=-1, keepdim=True).clamp_min(1e-8)
    return features.cpu().numpy().astype(np.float32, copy=False)


def pool_frames(frame_embeddings: np.ndarray) -> np.ndarray:
    """Average a (K, 512) stack of frame embeddings into a (512,) clip vector.

    Re-normalises after the mean. This is the simplest temporal pooling
    that still respects the L2 assumption the rest of the pipeline makes.
    """
    if frame_embeddings.size == 0:
        return np.zeros(512, dtype=np.float32)
    mean = frame_embeddings.mean(axis=0)
    norm = np.linalg.norm(mean)
    if norm < 1e-8:
        return np.zeros(512, dtype=np.float32)
    return (mean / norm).astype(np.float32, copy=False)


if __name__ == '__main__':
    packet = json.loads(sys.stdin.read(1_000_000))
    values = packet.get('values', [])
    if not isinstance(values, list) or len(values) > 32 or not all(isinstance(v, str) for v in values):
        raise ValueError('Invalid embedding batch')
    if packet['operation'] == 'images':
        vectors = embed_images(values)
    elif packet['operation'] == 'texts':
        vectors = embed_texts(values)
    else:
        raise ValueError('Invalid embedding operation')
    sys.stdout.write(json.dumps({'embeddings': vectors.tolist()}, allow_nan=False))
