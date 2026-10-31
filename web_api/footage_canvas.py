"""Immutable, verified real-footage cuts for the local canvas bridge.

Each rendered version has its own copy-on-edit canvas project. The original
storyboard, accepted MP4 and existing native canvas edits are never replaced.
"""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
import re

CUT_ID = re.compile(r'^footage-[a-f0-9]{24}$')


def checksum(file):
    digest = hashlib.sha256()
    with file.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def subtitle_cues(file, duration):
    """Read the verified SRT, retaining plain text, overlaps and millisecond timing."""
    if file.stat().st_size > 256 * 1024:
        raise ValueError('初剪字幕过大，请拆分后带入画布')
    try:
        text = file.read_text(encoding='utf-8-sig').replace('\r\n', '\n').replace('\r', '\n').strip()
    except UnicodeDecodeError:
        raise ValueError('初剪字幕不是 UTF-8 SRT，原文件保留') from None
    cues, previous, clipped = [], -1, 0
    def seconds(value):
        match = re.fullmatch(r'(\d{2,}):([0-5]\d):([0-5]\d)[,.](\d{3})', value)
        if not match:
            raise ValueError('初剪字幕时间格式无效，原字幕保留')
        hour, minute, second, ms = map(int, match.groups())
        return hour * 3600 + minute * 60 + second + ms / 1000
    for block in re.split(r'\n\s*\n', text) if text else []:
        lines = block.split('\n')
        if lines[0].strip().isdigit():
            lines.pop(0)
        match = re.fullmatch(r'(\S+)\s+-->\s+(\S+)', lines.pop(0).strip() if lines else '')
        if not match:
            raise ValueError('初剪字幕缺少时间与正文，原字幕保留')
        start, end = map(seconds, match.groups())
        content = '\n'.join(lines)
        if start < previous or end - start < .000999 or not content.strip() or len(content) > 4000:
            raise ValueError('初剪字幕顺序、时长或文字无效，原字幕保留')
        previous = start
        if len(cues) >= 2000:
            raise ValueError('一次带入最多2000段字幕，请拆分作品')
        if end > duration:
            clipped += 1
        if start < duration:
            cues.append({'start': start, 'end': min(end, duration), 'text': content})
    return cues, clipped


def cut_file(project, relative):
    if not isinstance(relative, str) or not relative:
        raise ValueError('初剪媒体路径无效')
    path = Path(relative)
    if path.is_absolute() or '..' in path.parts:
        raise ValueError('初剪媒体路径无效')
    file = project / path
    if file.is_symlink() or not file.is_file() or not file.resolve().is_relative_to(project.resolve()):
        raise ValueError('初剪媒体已移动或越出作品目录，请重新导出当前选片')
    return file


def write_canvas_cut(project, output_dir, project_id, job_id, version, topic, result, options):
    # Only called after the renderer and local FFprobe have accepted the MP4.
    paths = list(dict.fromkeys([s['source_path'] for s in result['segments']] +
                 [p for p in (result['output_path'], options.get('audio_path'), options.get('bgm_path'),
                               result.get('subtitle_path')) if p]))
    files = [{'path': p, 'sha256': checksum(cut_file(project, p)),
              'size': cut_file(project, p).stat().st_size} for p in paths]
    hashes = {r['path']: r['sha256'] for r in files}
    if result.get('sha256') and result['sha256'] != hashes[result['output_path']]:
        raise ValueError('导出的初剪视频已变化，原文件保留，未建立画布交接记录')
    if any(s.get('source_sha256') and s['source_sha256'] != hashes[s['source_path']] for s in result['segments']):
        raise ValueError('剪辑后素材发生变化，原文件保留，未建立画布交接记录')
    payload = {'version': 1, 'project_id': project_id, 'job_id': job_id, 'cut_version': version,
               'topic': topic, 'output_path': result['output_path'], 'segments': result['segments'],
               'options': options, 'files': files, 'subtitle_path': result.get('subtitle_path'),
               'audio_path': options.get('audio_path'), 'bgm_path': options.get('bgm_path')}
    target = output_dir / 'canvas-cut.json'
    with target.open('x', encoding='utf-8') as stream:
        json.dump(payload, stream, ensure_ascii=False, indent=2, allow_nan=False)
    return target.relative_to(project).as_posix()


def read_canvas_cut(project, project_id, cut_id, version):
    if not CUT_ID.fullmatch(cut_id) or isinstance(version, bool) or version not in range(1, 6):
        raise ValueError('初剪版本编号无效')
    relative = f'renders/{cut_id}/version-{version}/canvas-cut.json'
    file = cut_file(project, relative)
    if file.stat().st_size > 2 * 1024 * 1024:
        raise ValueError('初剪记录过大，请重新导出当前选片')
    raw = file.read_bytes()
    try:
        cut = json.loads(raw)
        job_file = cut_file(project, f'artifacts/footage_jobs/{cut_id}/job.json')
        job = json.loads(job_file.read_bytes())
        outputs = job['outputs']
        if not isinstance(cut, dict) or (cut.get('project_id'), cut.get('job_id'), cut.get('cut_version')) != (project_id, cut_id, version):
            raise ValueError()
        if job.get('project_id') != project_id or job.get('job_id') != cut_id:
            raise ValueError()
        output = next(o for o in outputs if o.get('canvas_cut_path') == relative)
        if output.get('status') != 'completed' or output.get('output_path') != cut['output_path']:
            raise ValueError()
        # A previously completed individual version can be used even when a
        # later variant failed/cancelled. Never turn that partial job into success.
        if not isinstance(cut['segments'], list) or not 0 < len(cut['segments']) <= 60:
            raise ValueError()
        from web_api.footage_pipeline import FootageOptions
        options = FootageOptions.model_validate(cut['options']).model_dump()
        rows = cut['files']
        if not isinstance(rows, list) or not 1 <= len(rows) <= 64:
            raise ValueError()
        recorded = {r['path']: r for r in rows}
        if len(recorded) != len(rows):
            raise ValueError()
        required = {s['source_path'] for s in cut['segments']} | {cut['output_path']}
        required |= {p for p in (cut.get('audio_path'), cut.get('bgm_path'), cut.get('subtitle_path')) if p}
        if required != set(recorded):
            raise ValueError()
        for path, record in recorded.items():
            source = cut_file(project, path)
            if source.stat().st_size != record['size'] or checksum(source) != record['sha256']:
                raise ValueError('初剪所用媒体已变化，保留原文件，请重新导出当前选片')
        if output.get('sha256') and output['sha256'] != recorded[cut['output_path']]['sha256']:
            raise ValueError()
    except (KeyError, TypeError, StopIteration, json.JSONDecodeError):
        raise ValueError('初剪记录无法核对，请重新导出当前选片') from None
    scenes, assets, cursor, keys = [], [], 0.0, set()
    for segment in cut['segments']:
        key, duration, start = str(segment.get('id', '')), segment.get('duration_seconds'), segment.get('start_seconds', 0)
        if not key or key in keys or any(isinstance(n, bool) or not isinstance(n, (int, float)) or not math.isfinite(n) for n in (duration, start)) or not 0 < duration <= 600 or not 0 <= start <= 86400:
            raise ValueError('初剪镜头编号或时长无效')
        keys.add(key)
        text = str(segment.get('text') or '')
        scene = {'id': key, 'title': '素材镜头 ' + key, 'description': text,
                 'narration': text, 'start_seconds': cursor, 'end_seconds': cursor + duration,
                 'source_start': start, 'source_end': segment.get('out_seconds'),
                 'repeat_to_fill': segment.get('repeat_to_fill') is True,
                 'source_path': segment['source_path']}
        scenes.append(scene)
        assets.append({'scene_id': key, 'path': segment['source_path'],
                       'sha256': recorded[segment['source_path']]['sha256']})
        cursor += duration
    if cursor > 600:
        raise ValueError('初剪超过 10 分钟，请拆分后带入画布')
    warnings = ['画布建立独立剪辑版本；再次带入保留其中的用户编辑。']
    captions = None
    if cut.get('subtitle_path'):
        captions, clipped = subtitle_cues(cut_file(project, cut['subtitle_path']), cursor)
        for scene in scenes:
            start, end = scene['start_seconds'], scene['end_seconds']
            scene['subtitle_cues'] = [{'start': round(max(c['start'], start) - start, 6),
                                       'end': round(min(c['end'], end) - start, 6), 'text': c['text']}
                                      for c in captions if min(c['end'], end) - max(c['start'], start) >= .001]
            if len(scene['subtitle_cues']) > 500:
                raise ValueError('单镜超过500段字幕，请先拆分该镜头')
        if clipped:
            warnings.append(f'{clipped} 段字幕超过成片末尾，画布仅保留成片时间内的部分；原 SRT 不变。')
        warnings.append('逐句字幕保留时间与文字；跨镜字幕随镜头拆分，显示时间按导出帧率对齐。字体、换行仍以画布预览为准。')
    if options['ken_burns'] and any(Path(s['source_path']).suffix.lower() in {'.png', '.jpg', '.jpeg', '.webp'} for s in scenes):
        warnings.append('静态图以原图带入，初剪的推拉效果保留在原 MP4。')
    # Old immutable receipts did not implement sidechain ducking. Do not infer
    # that they did just because the new request model defaults to enabling it.
    options['duck_bgm'] = cut['options'].get('duck_bgm', False)
    media_paths = [p for p in recorded if p != cut['output_path'] and p != cut.get('subtitle_path')]
    return {
        'project': {'title': str(cut.get('topic') or project_id) + f' · 素材初剪 {version}'},
        'script': {'title': '初剪旁白', 'sections': [{'text': s['narration']} for s in scenes]},
        'scenes': {'scenes': scenes, 'metadata': {'aspect_ratio': options['aspect_ratio']}},
        'asset_manifest': {'assets': assets}, 'image_manifest': {},
        'footage_cut': {'id': cut_id, 'version': version, 'options': options,
                        'audio_path': cut.get('audio_path'), 'bgm_path': cut.get('bgm_path'),
                        'duration': cursor, 'media_paths': media_paths, 'warnings': warnings,
                        'fingerprints': {p: recorded[p]['sha256'] for p in media_paths}},
    }, hashlib.sha256(raw).hexdigest()
