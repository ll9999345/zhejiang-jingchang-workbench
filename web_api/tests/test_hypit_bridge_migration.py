from pathlib import Path
import re
import xml.etree.ElementTree as ET

import pytest

from web_api.hypit_bridge import HypitBridgeOptions, _render_svs, _render_svml
from web_api.hypit_bridge_migration import bridge_model, render_bridge
from web_api.hypit_runtime import HypitRuntimeError


@pytest.fixture
def author():
    options = HypitBridgeOptions(aspect_ratio='16:9', resolution=720, fps=24, language='en')
    shots = [{'id':'first', 'text':'First \\@{literal} || sentence & words'},
             {'id':'second', 'text':'Second source.'}]
    # Export new user data, so leave initial marker escaping to the exporter.
    shots[0]['text'] = 'First @{literal} || sentence & words'
    sources = [{'id':'clip-first','package_path':'./assets/first & original.mp4'},
               {'id':'clip-second','package_path':'./assets/second.mp4'}]
    text = _render_svml(Path('.'), Path('.'), shots, {}, sources,
                        {'first':'clip-first','second':'clip-second'}, options, [])
    return text, _render_svs(options)


def parsed_new(text):
    aliases = re.findall(r'<import as="([\w-]+)"', text)
    ns = ' '.join(f'xmlns:{a}="urn:new:{a}"' for a in aliases)
    quoted = re.sub(r'(\s[\w:-]+\s*=\s*)(\{[\w.-]+\})', r'\1"\2"', text)
    return ET.fromstring(quoted.replace('<svml>', f'<svml {ns}>'))


def test_three_tracks_keep_ordered_sources_sound_caption_projection_and_exact_script(author):
    text, recipe = author
    model = bridge_model(text, recipe)
    tree = parsed_new(render_bridge(model))
    tag = lambda alias, name: f'{{urn:new:{alias}}}{name}'
    assert [n.get('source') for n in tree.find(tag('film','Film'))] == [
        '{picture.visual}', '{soundtrack.audio}', '{captions.visual}']
    windows = list(tree.find(tag('time','Timeline')))
    assert [n.get('from') for n in windows] == ['start', 'clip-first-semantic.end']
    assert [n.get('for') for n in windows] == ['{clip-first-media.extent}', '{clip-second-media.extent}']
    pictures = list(tree.find(tag('visual','Track')))
    audio = list(tree.find(tag('audio','Track')))
    assert [n.get('during') for n in pictures] == [n.get('during') for n in audio]
    assert [n.get('media') for n in pictures] == [n.get('source') for n in audio]
    assert [n.get('text') for n in tree.findall('script/*')] == [None, None]
    assert [n.text for n in tree.find('script')] == [s['text'] for s in model['shots']]
    assert '\\@{literal}' in tree.find('script/first').text
    assert '\\\\@{literal}' not in tree.find('script/first').text
    assert tree.find(tag('media','Video')).get('src') == './assets/first & original.mp4'
    assert len(list(tree.find(tag('semantic','Projection')))) == 2
    assert tree.find(tag('caption-fine','Caption')).get('timing') == '{bridge-caption-timing}'
    assert model['recipe'] == recipe
    assert (model['width'],model['height'],model['fps']) == (1280,720,24)


@pytest.mark.parametrize('change', [
    lambda x:x.replace('<film:Track source={captions.track}/>', ''),
    lambda x:x.replace('<film:Track source={captions.track}/>', '<film:Track source={other.track}/>'),
    lambda x:x.replace('source={clip-first-semantic.take}', 'source={clip-second-semantic.take}'),
    lambda x:x.replace('span-authority="video"', 'span-authority="audio"'),
    lambda x:x.replace('frame={full}', 'frame={other}'),
    lambda x:x.replace('language="en"', 'language="auto"'),
    lambda x:x.replace('frame-rate="24"', 'frame-rate="0"'),
    lambda x:x.replace('<first>', '<first custom="value">'),
    lambda x:x.replace('</svml>', '<unknown id="extra"/></svml>'),
    lambda x:x.replace('<svml>', '<!DOCTYPE svml><svml>'),
])
def test_unmapped_author_relationships_never_become_simplified_success(author, change):
    with pytest.raises(HypitRuntimeError):
        bridge_model(change(author[0]), author[1])


@pytest.mark.parametrize('change', [
    lambda x:x.replace('fit: cover;', 'fit: cover; opacity: 0.5;'),
    lambda x:x.replace('fit: cover;', 'fit: invalid;'),
    lambda x:x.replace('stack-order: 10;', 'stack-order: NaN;'),
    lambda x:x.replace('fit: cover;', 'fit: cover; fit: contain;'),
    lambda x:x.replace('media.reference {', 'other.reference {'),
])
def test_unmapped_media_treatment_not_silently_lost(author, change):
    with pytest.raises(HypitRuntimeError):
        bridge_model(author[0], change(author[1]))


def test_custom_known_placement_survives_recipe_split(author):
    recipe = author[1].replace('stack-order: 10;', 'stack-order: 22;').replace('fit: cover;', 'fit: contain;')
    model = bridge_model(author[0], recipe)
    tree = parsed_new(render_bridge(model))
    for clip in tree.findall('.//{urn:new:visual}Clip'):
        assert clip.get('z') == '22' and clip.get('fit') == 'contain'
    assert model['recipe'] == recipe


def test_silent_segment_does_not_fabricate_alignment_request():
    options=HypitBridgeOptions()
    old=_render_svml(Path('.'),Path('.'),[{'id':'silent','text':''}],{},
                    [{'id':'clip','package_path':'./clip.mp4'}],{'silent':'clip'},options,[])
    tree=parsed_new(render_bridge(bridge_model(old,_render_svs(options))))
    node=tree.find('{urn:new:whisperx}Alignment')
    assert node.get('domain') == '{clip-media.domain}'
    assert 'media' not in node.attrib and 'language' not in node.attrib
