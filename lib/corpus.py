"""Local clip corpus: project-scoped index of candidate video/image assets.

The corpus is the heart of the documentary-montage pipeline. Instead of
hitting stock APIs every time the agent changes its mind, we download
once into a project-local corpus and query it offline.

Directory layout
----------------
    <corpus_dir>/
      clips/                # downloaded assets, named <clip_id>.<ext>
      thumbnails/
        <clip_id>/
          frame_00.jpg      # 5 evenly-spaced frames per video (or the
          frame_01.jpg      # image itself as frame_00 for still assets)
          ...
      .corpus-generations/<id>/
        index.jsonl         # immutable rows for one complete version
        embeddings.npy      # aligned (N, 512) visual vectors
        tag_embeddings.npy  # aligned (N, 512) text vectors
      .corpus-commits/       # atomically published, append-only commits
      index.jsonl / *.npy    # retained legacy format, never overwritten

The JSONL + .npy split is intentional: the index is human-readable
(git-diffable, debuggable) while the embeddings are a contiguous array
for fast vector math. Row N in the JSONL aligns with row N in both .npy
files.

The Corpus class owns add/load/save + all retrieval math. It's pure
infrastructure — no judgment calls, no creative decisions. The agent
picks WHAT to search for and WHICH results to accept; this class only
implements the operations the agent names.
"""
from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable, Optional

import numpy as np


EMBED_DIM = 512


@dataclass
class ClipRecord:
    """One row in the corpus index.

    Fields mirror everything we want to query or attribute. Missing
    fields default to None/empty so adapters can populate only what
    they know.
    """
    clip_id: str                       # unique within corpus: "<source>_<source_id>"
    source: str                        # "pexels", "archive_org", "nasa", ...
    source_id: str
    source_url: str
    local_path: str                    # relative to corpus_dir
    kind: str = "video"                # "video" or "image"
    thumb_dir: str = ""                # relative to corpus_dir
    query: str = ""                    # the search query that surfaced this clip
    creator: str = ""
    license: str = ""
    duration: float = 0.0              # seconds (0 for images)
    width: int = 0
    height: int = 0
    motion_score: float = 0.0          # residual optical flow magnitude
    dominant_colors: list[list[int]] = field(default_factory=list)
    source_tags: str = ""              # raw tags/description from the API
    shot_type: str = ""                # wide/medium/close (optional, may be empty)
    time_of_day: str = ""              # day/golden/night (optional)
    added_at: float = 0.0              # unix timestamp


class Corpus:
    """Append-only local clip corpus with vector search.

    Usage::

        corp = Corpus(Path("projects/foo/corpus"))
        corp.load()
        corp.add(record, clip_embedding, tag_embedding)
        corp.save()
        ranked = corp.rank_by_text("a lonely figure walking home")
        neighbours = corp.knn(clip_id="pexels_12345", k=5)

    Append-only is by design — deleting rows would break the row-to-
    embedding alignment. The agent hides a clip by filtering at query
    time, not by removing it from the corpus.
    """

    def __init__(self, corpus_dir: Path):
        self.corpus_dir = Path(corpus_dir)
        from lib import corpus_store
        self._storage_dir = corpus_store.peek(self.corpus_dir)
        self._revision = None
        self.persistence_info = {}
        self.records: list[ClipRecord] = []
        self.clip_embeddings: np.ndarray = np.zeros((0, EMBED_DIM), dtype=np.float32)
        self.tag_embeddings: np.ndarray = np.zeros((0, EMBED_DIM), dtype=np.float32)
        self._id_to_row: dict[str, int] = {}

    # ------------------------------------------------------------------
    # Paths
    # ------------------------------------------------------------------

    @property
    def clips_dir(self) -> Path:
        return self.corpus_dir / "clips"

    @property
    def thumbs_dir(self) -> Path:
        return self.corpus_dir / "thumbnails"

    @property
    def index_path(self) -> Path:
        return self._storage_dir / "index.jsonl"

    @property
    def embed_path(self) -> Path:
        return self._storage_dir / "embeddings.npy"

    @property
    def tag_embed_path(self) -> Path:
        return self._storage_dir / "tag_embeddings.npy"

    def ensure_dirs(self) -> None:
        self.corpus_dir.mkdir(parents=True, exist_ok=True)
        self.clips_dir.mkdir(exist_ok=True)
        self.thumbs_dir.mkdir(exist_ok=True)

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def load(self) -> None:
        """Read one complete committed version, or a coherent legacy corpus."""
        from lib import corpus_store
        snapshot = corpus_store.load(self.corpus_dir, ClipRecord, EMBED_DIM)
        # Replace all in-memory state only after every file has validated.
        self.records = snapshot.records
        self.clip_embeddings, self.tag_embeddings = snapshot.visual, snapshot.tags
        self._id_to_row = {record.clip_id: index for index, record in enumerate(self.records)}
        self._storage_dir, self._revision = snapshot.directory, snapshot.revision
        self.persistence_info = snapshot.info

    def save(self) -> None:
        """Publish a complete immutable generation; reject stale writers."""
        from lib import corpus_store
        self.ensure_dirs()
        rows = [asdict(record) for record in self.records]
        directory, revision, info = corpus_store.publish(self.corpus_dir, rows,
            self.clip_embeddings, self.tag_embeddings, EMBED_DIM, self._revision)
        self._storage_dir, self._revision = directory, revision
        self.persistence_info = info

    # ------------------------------------------------------------------
    # Mutation
    # ------------------------------------------------------------------

    def has(self, clip_id: str) -> bool:
        return clip_id in self._id_to_row

    def add(
        self,
        record: ClipRecord,
        clip_embedding: np.ndarray,
        tag_embedding: np.ndarray,
        *,
        replace_existing: bool = False,
    ) -> None:
        """Append idempotently, or explicitly replace one fully processed row."""
        existing = self._id_to_row.get(record.clip_id)
        if existing is not None and not replace_existing:
            return
        if clip_embedding.shape != (EMBED_DIM,):
            raise ValueError(
                f"clip_embedding must be ({EMBED_DIM},), got {clip_embedding.shape}"
            )
        if tag_embedding.shape != (EMBED_DIM,):
            raise ValueError(
                f"tag_embedding must be ({EMBED_DIM},), got {tag_embedding.shape}"
            )
        if record.added_at == 0.0:
            record.added_at = time.time()

        if existing is not None:
            # Prepare both matrices before changing any current record. A bad
            # second vector must not leave metadata pointing at new media with
            # an old or only partially updated embedding pair.
            visual = self.clip_embeddings.copy()
            tags = self.tag_embeddings.copy()
            visual[existing] = clip_embedding.astype(np.float32)
            tags[existing] = tag_embedding.astype(np.float32)
            self.records[existing] = record
            self.clip_embeddings, self.tag_embeddings = visual, tags
            return

        idx = len(self.records)
        self.records.append(record)
        self._id_to_row[record.clip_id] = idx

        self.clip_embeddings = np.vstack(
            [self.clip_embeddings, clip_embedding.reshape(1, -1).astype(np.float32)]
        )
        self.tag_embeddings = np.vstack(
            [self.tag_embeddings, tag_embedding.reshape(1, -1).astype(np.float32)]
        )

    def get(self, clip_id: str) -> Optional[ClipRecord]:
        idx = self._id_to_row.get(clip_id)
        if idx is None:
            return None
        return self.records[idx]

    def __len__(self) -> int:
        return len(self.records)

    # ------------------------------------------------------------------
    # Vector math (the named retrieval operations)
    # ------------------------------------------------------------------

    def _fused_sims(self, query_vec: np.ndarray, tag_weight: float) -> np.ndarray:
        """Cosine similarity fused across visual and tag channels.

        Both embedding banks are L2-normalised, so `bank @ query` is
        cosine similarity directly. Fused score = (1 - w) * visual +
        w * tag, where w is the tag weight (default 0.3 at call sites).
        """
        if self.clip_embeddings.shape[0] == 0:
            return np.zeros(0, dtype=np.float32)
        visual = self.clip_embeddings @ query_vec.astype(np.float32)
        tag = self.tag_embeddings @ query_vec.astype(np.float32)
        return (1.0 - tag_weight) * visual + tag_weight * tag

    def rank_by_text(
        self,
        query_embedding: np.ndarray,
        k: int = 20,
        tag_weight: float = 0.3,
        motion_min: Optional[float] = None,
        kind: Optional[str] = None,
        exclude_ids: Optional[Iterable[str]] = None,
    ) -> list[tuple[ClipRecord, float]]:
        """Return the top-k records scored against an embedded text query.

        Args:
            query_embedding: (512,) L2-normalised text embedding.
            k: how many results to return.
            tag_weight: blend between visual (1-w) and tag (w) channels.
            motion_min: if set, reject records with motion_score below this.
                Use for "no dead clips" at the retrieval step.
            kind: filter to "video" or "image" only.
            exclude_ids: clip_ids to skip (already used in the current edit).
        """
        if len(self.records) == 0:
            return []

        scores = self._fused_sims(query_embedding, tag_weight)
        exclude = set(exclude_ids or [])

        ranked: list[tuple[int, float]] = []
        for i, s in enumerate(scores):
            rec = self.records[i]
            if rec.clip_id in exclude:
                continue
            if kind and rec.kind != kind:
                continue
            if motion_min is not None and rec.motion_score < motion_min:
                continue
            ranked.append((i, float(s)))

        ranked.sort(key=lambda x: x[1], reverse=True)
        top = ranked[:k]
        return [(self.records[i], s) for i, s in top]

    def knn(
        self,
        clip_id: str,
        k: int = 5,
        exclude_ids: Optional[Iterable[str]] = None,
    ) -> list[tuple[ClipRecord, float]]:
        """Pure k-nearest-neighbours against the visual channel only.

        Used as a building block for `find_similar_set` via MMR.
        """
        if clip_id not in self._id_to_row:
            return []
        seed_idx = self._id_to_row[clip_id]
        seed_vec = self.clip_embeddings[seed_idx]

        sims = self.clip_embeddings @ seed_vec
        exclude = set(exclude_ids or [])
        exclude.add(clip_id)  # never return the seed itself

        ranked: list[tuple[int, float]] = []
        for i, s in enumerate(sims):
            if self.records[i].clip_id in exclude:
                continue
            ranked.append((i, float(s)))

        ranked.sort(key=lambda x: x[1], reverse=True)
        top = ranked[:k]
        return [(self.records[i], s) for i, s in top]

    def find_similar_set(
        self,
        seed_clip_id: str,
        n: int = 5,
        diversity: float = 0.3,
        candidate_pool: int = 30,
        exclude_ids: Optional[Iterable[str]] = None,
    ) -> list[tuple[ClipRecord, float]]:
        """Collection-style retrieval: `n` clips that share the seed's
        visual register but don't duplicate each other.

        Uses Maximal Marginal Relevance:

            score(c) = (1 - lambda) * sim(c, seed)
                       - lambda * max(sim(c, already_picked))

        where `lambda = diversity`. At diversity=0 the result is pure
        k-NN; at diversity=1 it picks the most-different-from-each-other
        clips regardless of seed similarity. Default 0.3 keeps the set
        tight but avoids duplicates.
        """
        if seed_clip_id not in self._id_to_row:
            return []
        seed_idx = self._id_to_row[seed_clip_id]
        seed_vec = self.clip_embeddings[seed_idx]

        exclude = set(exclude_ids or [])
        exclude.add(seed_clip_id)

        # Narrow to the top-`candidate_pool` by raw similarity first.
        sims_to_seed = self.clip_embeddings @ seed_vec
        candidate_idxs = np.argsort(-sims_to_seed).tolist()
        pool: list[int] = []
        for i in candidate_idxs:
            if self.records[i].clip_id in exclude:
                continue
            pool.append(int(i))
            if len(pool) >= candidate_pool:
                break

        if not pool:
            return []

        picked: list[int] = []
        picked_scores: list[float] = []

        while pool and len(picked) < n:
            best_i = -1
            best_score = -1e9
            for i in pool:
                sim_seed = float(sims_to_seed[i])
                if picked:
                    # max similarity to already-picked set
                    picked_vecs = self.clip_embeddings[np.array(picked)]
                    sim_picked = float(np.max(self.clip_embeddings[i] @ picked_vecs.T))
                else:
                    sim_picked = 0.0
                mmr = (1.0 - diversity) * sim_seed - diversity * sim_picked
                if mmr > best_score:
                    best_score = mmr
                    best_i = i
            picked.append(best_i)
            picked_scores.append(best_score)
            pool.remove(best_i)

        return [(self.records[i], s) for i, s in zip(picked, picked_scores)]

    def diversify(
        self,
        candidate_ids: list[str],
        n: int,
        diversity: float = 0.5,
    ) -> list[str]:
        """Given a pre-selected candidate list, greedily pick `n` that
        are mutually dissimilar.

        Used at edit-arrangement time to make sure no two adjacent slots
        are visually redundant. Returns the ordered clip_ids to keep;
        order matches pick order.
        """
        if not candidate_ids:
            return []
        idxs = [self._id_to_row[c] for c in candidate_ids if c in self._id_to_row]
        if not idxs:
            return []

        picked: list[int] = [idxs[0]]
        remaining = idxs[1:]

        while remaining and len(picked) < n:
            best_i = -1
            best_score = -1e9
            picked_mat = self.clip_embeddings[np.array(picked)]
            # Normalize the position term to [0, 1] so it lives on the
            # same scale as cosine similarity. An absolute index grows
            # with the pool, drowning the similarity term: at the 0.5
            # default a candidate one slot later needed a similarity gap
            # > 1.0 to be preferred — impossible for non-negative
            # cosines — so diversify() degenerated to input order.
            denom = max(1, len(remaining) - 1)
            for pos, i in enumerate(remaining):
                sim_picked = float(np.max(self.clip_embeddings[i] @ picked_mat.T))
                # We want LOW similarity, so we negate.
                score = -sim_picked
                # Diversity weights how hard we penalize similarity. At
                # diversity=1 we always pick the most different; at
                # diversity=0 we just take them in input order.
                score = diversity * score + (1.0 - diversity) * (-pos / denom)
                if score > best_score:
                    best_score = score
                    best_i = i
            picked.append(best_i)
            remaining.remove(best_i)

        return [self.records[i].clip_id for i in picked]
