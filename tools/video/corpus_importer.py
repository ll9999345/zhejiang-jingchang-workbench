"""Index creator-owned local footage with the native CLIP corpus format."""
from __future__ import annotations

import hashlib
import shutil
import time
from pathlib import Path

from tools.base_tool import BaseTool, ToolResult, ToolRuntime, ToolStatus, ResourceProfile


class CorpusImporter(BaseTool):
    name = 'corpus_importer'
    capability = 'clip_retrieval'
    provider = 'openmontage'
    runtime = ToolRuntime.LOCAL
    dependencies = ['cmd:ffmpeg', 'cmd:ffprobe', 'python:numpy', 'python:cv2']
    resource_profile = ResourceProfile(cpu_cores=2, ram_mb=1800, disk_mb=1000)
    best_for = ['Indexing already downloaded or uploaded project footage without network access']
    input_schema = {'type': 'object', 'required': ['files'], 'properties': {
        'files': {'type': 'array', 'minItems': 1, 'maxItems': 50, 'items': {
            'type': 'object', 'required': ['input_path'], 'additionalProperties': False,
            'properties': {'input_path': {'type': 'string'}, 'description': {'type': 'string'},
                           'creator': {'type': 'string'}, 'license': {'type': 'string'}}}},
        'output_dir': {'type': 'string'},
        'thumbs_per_video': {'type': 'integer', 'default': 3, 'minimum': 1, 'maximum': 8}}}
    output_schema = {'type': 'object', 'properties': {'corpus_dir': {'type': 'string'}, 'records': {'type': 'array'}}}

    def get_status(self):
        from lib.clip_embedder import local_runtime_ready
        return ToolStatus.AVAILABLE if local_runtime_ready() and shutil.which('ffmpeg') else ToolStatus.UNAVAILABLE

    def execute(self, inputs):
        from PIL import Image
        from lib.clip_embedder import embed_images, embed_texts, pool_frames
        from lib.corpus import Corpus, ClipRecord
        from tools.video.corpus_builder import _extract_video_thumbs
        started = time.time()
        directory = Path(inputs['output_dir'])
        if directory.exists() and (not directory.is_dir() or any(directory.iterdir())):
            return ToolResult(success=False, error='Use a fresh destination; an existing corpus will not be overwritten')
        source_files = [Path(f['input_path']) for f in inputs['files']]
        if sum(p.stat().st_size for p in source_files) > 2_000_000_000:
            return ToolResult(success=False, error='Import exceeds the per-run 2 GB copy limit')
        corpus = Corpus(directory)
        corpus.ensure_dirs()
        evidence = []
        for item, source in zip(inputs['files'], source_files):
            suffix = source.suffix.lower()
            kind = 'image' if suffix in {'.png', '.jpg', '.jpeg', '.webp'} else 'video' if suffix in {'.mp4', '.mov', '.webm', '.mkv', '.m4v'} else None
            if kind is None or not source.is_file():
                return ToolResult(success=False, error='Import only supported local images and videos', data={'imported': evidence})
            with source.open('rb') as stream:
                digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            clip_id = 'local_' + digest[:24]
            if any(r.clip_id == clip_id for r in corpus.records): continue
            destination = corpus.clips_dir / (clip_id + suffix)
            shutil.copyfile(source, destination)
            thumbs = corpus.thumbs_dir / clip_id
            thumbs.mkdir()
            if kind == 'video':
                frames, probe = _extract_video_thumbs(destination, thumbs, inputs.get('thumbs_per_video', 3))
                if not frames:
                    return ToolResult(success=False, error='Video cannot be decoded', data={'imported': evidence})
            else:
                with Image.open(destination) as im:
                    probe = {'width': im.width, 'height': im.height}
                    im.convert('RGB').save(thumbs / 'frame_00.jpg')
                frames = [thumbs / 'frame_00.jpg']
            vector = pool_frames(embed_images(frames))
            text = item.get('description') or source.stem
            record = ClipRecord(clip_id=clip_id, source='local', source_id=digest,
                source_url='', local_path=destination.relative_to(directory).as_posix(), kind=kind,
                thumb_dir=thumbs.relative_to(directory).as_posix(), query=text, source_tags=text,
                creator=item.get('creator', ''), license=item.get('license', 'User-supplied; rights not verified'),
                duration=float(probe.get('duration', 0)), width=int(probe.get('width', 0)),
                height=int(probe.get('height', 0)), motion_score=float(probe.get('motion_score', 0)), added_at=time.time())
            corpus.add(record, vector, embed_texts([text])[0])
            corpus.save()  # Partial progress remains usable if a later input fails.
            with source.open('rb') as stream:
                after = hashlib.file_digest(stream, 'sha256').hexdigest()
            evidence.append({'clip_id': clip_id, 'source_path': str(source), 'sha256_before': digest,
                             'sha256_after': after, 'source_unchanged': digest == after})
            if digest != after:
                return ToolResult(success=False, error='Source changed during import', data={'imported': evidence})
        return ToolResult(success=True, data={'corpus_dir': str(directory), 'records': evidence,
            'query_note': 'CLIP primarily supports English descriptions; review Chinese retrieval results.'},
            artifacts=[str(corpus.index_path), str(corpus.embed_path), str(corpus.tag_embed_path)],
            duration_seconds=round(time.time() - started, 2))
