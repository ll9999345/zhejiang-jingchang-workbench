"""Relationship-preserving adapter for the 0.2 OpenMontage reference author.

This module only translates authoring documents. It does not copy projects,
start Providers, generate media, or manufacture speech alignment. The separate
reference migration module owns project copying; runtime checks remain explicit.
"""
from __future__ import annotations

import html
import math
import re
import xml.etree.ElementTree as ET
from pathlib import Path

from web_api.hypit_bridge import HypitBridgeOptions, _render_svml
from web_api.hypit_runtime import HypitRuntimeError


ALIASES = {
    'media', 'pipeline', 'whisperx', 'time', 'performance', 'sound', 'caption',
    'caption-fine', 'fonts', 'space', 'program', 'film', 'render', 'recipes',
}
IDENTIFIER = re.compile(r'^[a-z][a-z0-9_-]{0,63}$')


def _tag(alias: str, name: str) -> str:
    return f'{{urn:bridge:{alias}}}{name}'


def _parse(text: str) -> ET.Element:
    if len(text.encode('utf-8')) > 512_000 or re.search(r'<!DOCTYPE|<!ENTITY', text, re.I):
        raise HypitRuntimeError('桥接作者文件超限或含外部声明')
    if not text.startswith('<?svml using="@hypit/markup@1"?>'):
        raise HypitRuntimeError('桥接作者版本未知，不能直接转换')
    declarations = ' '.join(f'xmlns:{name}="urn:bridge:{name}"' for name in sorted(ALIASES))
    quoted = re.sub(r'(\s[\w:-]+\s*=\s*)(\{[\w.-]+\})', r'\1"\2"', text)
    try:
        return ET.fromstring(quoted.replace('<svml>', f'<svml {declarations}>', 1))
    except ET.ParseError as exc:
        raise HypitRuntimeError('桥接作者包含未适配的语法，未删减内容') from exc


def _structure(node: ET.Element):
    return (node.tag, sorted(node.attrib.items()), (node.text or '').strip(),
            (node.tail or '').strip(), tuple(_structure(child) for child in node))


def bridge_model(text: str, recipe: str) -> dict:
    """Accept the whole known bridge graph, never just cherry-pick its nodes.

    Derive its explicit source/segment relationships from the author, then
    compare every node/property with the old exporter's complete topology.
    Unknown tracks, effects, selectors and customized relationships fail closed.
    """
    root = _parse(text)
    story = root.find('script')
    canvas = root.find(_tag('space', 'Canvas'))
    clock = root.find(_tag('program', 'Clock'))
    if root.tag != 'svml' or root.attrib or story is None or canvas is None or clock is None:
        raise HypitRuntimeError('不是完整的旧版参考片桥接结构')
    shots = []
    for node in story:
        if not IDENTIFIER.fullmatch(node.tag) or node.attrib or len(node) or (node.tail or '').strip():
            raise HypitRuntimeError('脚本包含额外层级或属性，需单独迁移')
        shots.append({'id': node.tag, 'text': node.text or ''})
    if not shots or len(shots) > 200 or len({s['id'] for s in shots}) != len(shots):
        raise HypitRuntimeError('脚本段落为空、超限或编号重复')
    try:
        width, height, fps = int(canvas.get('width')), int(canvas.get('height')), int(clock.get('frame-rate'))
        if not (64 <= width <= 4096 and 64 <= height <= 4096 and 1 <= fps <= 120):
            raise ValueError('bounds')
    except (TypeError, ValueError) as exc:
        raise HypitRuntimeError('桥接画幅或帧率无效') from exc

    sources = [dict(node.attrib) for node in root.findall(_tag('media', 'Video'))]
    if not sources or any(set(row) != {'id', 'src'} or not IDENTIFIER.fullmatch(row['id']) for row in sources):
        raise HypitRuntimeError('此桥接缺少明确视频来源或来源声明无效')
    if len({s['id'] for s in sources}) != len(sources):
        raise HypitRuntimeError('媒体编号重复')
    source_ids = {s['id'] for s in sources}
    by_shot, languages = {}, set()
    for node in root.findall(_tag('whisperx', 'SemanticTake')):
        segment, media = node.get('segment', ''), node.get('media', '')
        match = re.fullmatch(r'\{story\.segment\.([a-z][a-z0-9_-]*)\}', segment)
        source_match = re.fullmatch(r'\{([a-z][a-z0-9_-]*)-media\.media\}', media)
        if not match or not source_match or source_match[1] not in source_ids or match[1] in by_shot:
            raise HypitRuntimeError('语音段落与原素材对应关系不完整或重复')
        by_shot[match[1]] = source_match[1]
        if node.get('language'):
            languages.add(node.get('language'))
    if set(by_shot) != {s['id'] for s in shots} or len(set(by_shot.values())) != len(sources):
        raise HypitRuntimeError('有段落缺少素材或素材缺少明确段落，不猜测分配')
    if len(languages) > 1 or any(not re.fullmatch('[a-z]{2,3}', lang) for lang in languages):
        raise HypitRuntimeError('多语言桥接需单独迁移')
    language = next(iter(languages), 'zh')
    options = HypitBridgeOptions(resolution=240, fps=fps, language=language)
    canonical = _parse(_render_svml(Path('.'), Path('.'), shots, {},
        [{'id': s['id'], 'package_path': s['src']} for s in sources], by_shot, options, []))
    # Preserve the original Script text byte-for-byte after XML decoding. It
    # already contains escaped Script markers; do not escape those a second time.
    expected_story = canonical.find('script')
    for actual, expected in zip(story, expected_story):
        expected.text = actual.text
    canonical.find(_tag('space', 'Canvas')).set('width', str(width))
    canonical.find(_tag('space', 'Canvas')).set('height', str(height))
    if _structure(root) != _structure(canonical):
        raise HypitRuntimeError('检测到自定义轨道、参数或结构；未简化成默认桥接')
    if not recipe.startswith('<?svml using="@hypit/svs@1"?>') or re.search(r'<!DOCTYPE|<!ENTITY', recipe, re.I):
        raise HypitRuntimeError('旧桥接样式入口无效')
    # 0.3 explicitly separates placement from reusable treatment. Move only
    # the two known placement properties; keep all caption/film styling intact.
    blocks = re.findall(r'(?<![\w.-])media\.reference\s*\{([^{}]*)\}', recipe)
    if len(blocks) != 1:
        raise HypitRuntimeError('媒体样式声明缺失或重复')
    properties = re.findall(r'([\w-]+)\s*:\s*([^;{}]+)\s*;', blocks[0])
    remainder = re.sub(r'[\w-]+\s*:\s*[^;{}]+\s*;', '', blocks[0]).strip()
    values = dict(properties)
    if remainder or len(properties) != 2 or set(values) != {'stack-order', 'fit'}:
        raise HypitRuntimeError('媒体样式含未适配效果，不能丢弃')
    try:
        z = float(values['stack-order'])
        if not math.isfinite(z):
            raise ValueError('finite')
    except ValueError as exc:
        raise HypitRuntimeError('媒体层级参数无效') from exc
    fit = values['fit'].strip()
    if fit not in {'cover', 'contain', 'fit-width', 'fit-height', 'native', 'scale-down', 'stretch'}:
        raise HypitRuntimeError('媒体适配方式未知')
    ids = [node.get('id') for node in root.iter() if node.get('id')]
    if len(ids) != len(set(ids)):
        raise HypitRuntimeError('作者节点编号重复')
    generated = {'bridge-caption-face', 'bridge-story-time', 'bridge-caption-timing'}
    if set(ids) & generated:
        raise HypitRuntimeError('迁移辅助编号与原节点冲突')
    return {'width': width, 'height': height, 'fps': fps, 'language': language,
            'shots': shots, 'sources': sources, 'by_shot': by_shot,
            'z': values['stack-order'].strip(), 'fit': fit,
            'recipe': recipe, 'source_ids': ids}


def render_bridge(model: dict) -> str:
    """0.3 counterpart: original ordered windows, audio, picture and captions."""
    q = lambda value: html.escape(str(value), quote=True)
    lines = ['<?svml using="@hypit/markup@1"?>', '<svml>', '  <import from="@hypit/script@1"/>']
    for alias, package in [('media','media'), ('mediaop','media-operations'), ('whisperx','whisperx'),
            ('semantic','narrative-temporal'), ('narrative-caption','narrative-caption'),
            ('time','timeline-author'), ('visual','visual-track'), ('audio','audio-track'),
            ('caption-fine','caption-fine'), ('fonts','fontsource'), ('space','spatial'),
            ('film','film'), ('html','html-video')]:
        lines.append(f'  <import as="{alias}" from="@hypit/{package}@1"/>')
    lines += ['  <import as="recipes" source="./reference.svs"/>', '  <script id="story">']
    for shot in model['shots']:
        # No second Script-marker escape: these strings come from the old
        # author, not from new user prose.
        lines.append(f'    <{shot["id"]}>{html.escape(shot["text"], quote=False)}</{shot["id"]}>')
    lines += ['  </script>', f'  <space:Canvas id="canvas" width="{model["width"]}" height="{model["height"]}"/>',
              f'  <time:Clock id="clock" frame-rate="{model["fps"]}"/>',
              '  <space:Frame id="full" within={canvas.bounds} left="0%" top="0%" right="100%" bottom="100%"/>',
              '  <fonts:Face id="bridge-caption-face" package="@fontsource-variable/inter" weight="700" style="normal"/>',
              '  <media:FontStack id="caption-font" primary={bridge-caption-face}/>']
    for source in model['sources']:
        sid = source['id']
        lines += [f'  <media:Video id="{sid}" src="{q(source["src"])}"/>',
                  f'  <mediaop:Normalize id="{sid}-media" source={{{sid}}} video="primary-moving" audio="default" span-authority="video" clock={{clock}}/>']
    ordered = []
    for shot in model['shots']:
        sid = model['by_shot'][shot['id']]
        ordered.append(sid)
        speech = f' media={{{sid}-media.media}} language="{model["language"]}"' if shot['text'].strip() else ''
        lines.append(f'  <whisperx:Alignment id="{sid}-semantic" narrative={{story}} segment={{story.segment.{shot["id"]}}} domain={{{sid}-media.domain}}{speech}/>')
    lines.append(f'  <time:Timeline id="program" clock={{clock}} end="{ordered[-1]}-semantic.end">')
    for i, sid in enumerate(ordered):
        start = 'start' if i == 0 else ordered[i-1]+'-semantic.end'
        lines.append(f'    <time:Window id="{sid}-semantic" from="{start}" for={{{sid}-media.extent}}/>')
    lines += ['  </time:Timeline>', '  <semantic:Projection id="bridge-story-time" narrative={story} timeline={program.timeline}>']
    for sid in ordered:
        lines.append(f'    <semantic:Map alignment={{{sid}-semantic.alignment}} domain={{{sid}-media.domain}} window={{program.{sid}-semantic}}/>')
    lines += ['  </semantic:Projection>', '  <visual:Track id="picture" timeline={program.timeline}>']
    for sid in ordered:
        lines.append(f'    <visual:Clip id="{sid}-source" media={{{sid}-media.media}} during={{program.{sid}-semantic}} frame={{full}} z="{q(model["z"])}" fit="{model["fit"]}"/>')
    lines += ['  </visual:Track>', '  <audio:Track id="soundtrack" timeline={program.timeline}>']
    for sid in ordered:
        lines.append(f'    <audio:Clip id="{sid}-source" source={{{sid}-media.media}} during={{program.{sid}-semantic}}/>')
    lines += ['  </audio:Track>',
              '  <caption-fine:Style id="caption-style" recipe={recipes.caption.primary} font={caption-font}/>',
              '  <narrative-caption:Timing id="bridge-caption-timing" document={story.caption} binding={story.caption-binding} projection={bridge-story-time}/>',
              '  <caption-fine:Caption id="captions" document={story.caption} timing={bridge-caption-timing} timeline={program.timeline} within={canvas.bounds}>',
              '    <caption-fine:Use style={caption-style}/>', '  </caption-fine:Caption>',
              '  <film:Film id="main" canvas={canvas.canvas} timeline={program.timeline} appearance={recipes.film.reference}>',
              '    <film:Track source={picture.visual}/>', '    <film:Track source={soundtrack.audio}/>',
              '    <film:Track source={captions.visual}/>', '  </film:Film>',
              '  <html:Video id="final" composition={main.composition} timeline={program.timeline}/>', '</svml>', '']
    return '\n'.join(lines)
