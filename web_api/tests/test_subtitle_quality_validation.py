from pathlib import Path

import pytest

from web_api.media_pipeline import _quality_subtitles, quality_check


@pytest.mark.parametrize('body,expected', [
    ('1\n00:00:00,000 --> 00:00:01,000\n你好', 'passed'),
    ('1\n00:00:02,000 --> 00:00:01,000\n你好', 'failed'),
    ('1\n00:00:00,000 --> 00:00:03,000\n你好', 'failed'),
    ('1\n00:00:00,000 --> 00:00:01,000\n', 'failed'),
    ('1\n00:75:00,000 --> 00:76:00,000\n你好', 'failed'),
    ('1\n00:00:01,000 --> 00:00:02,000\n一\n\n2\n00:00:00,000 --> 00:00:01,000\n二', 'failed'),
])
def test_subtitle_timing(tmp_path: Path, body: str, expected: str):
    subtitle = tmp_path / 'test.srt'
    subtitle.write_text(body, encoding='utf-8')
    assert _quality_subtitles(subtitle, 2)['status'] == expected


def test_valid_vtt_and_overlap_warning(tmp_path: Path):
    subtitle = tmp_path / 'test.vtt'
    subtitle.write_text('WEBVTT\n\n00:00.000 --> 00:01.500\n一\n\n00:01.000 --> 00:02.000\n二', encoding='utf-8')
    result = _quality_subtitles(subtitle, 2)
    assert result['status'] == 'passed'
    assert result['overlap_count'] == 1
    assert result['warnings']
    assert result['sync_review'] == 'not_run'


def test_bad_subtitle_fails_report(tmp_path: Path):
    project = tmp_path / 'subtitle-check'
    project.mkdir()
    (project / 'bad.srt').write_text('1\n00:00:02,000 --> 00:00:01,000\n错误', encoding='utf-8')
    result = quality_check({'project_id': project.name, 'media_paths': ['bad.srt'], 'execute': True}, project_root=tmp_path)
    assert result['status'] == 'failed'
    assert any('结束时间' in failure for failure in result['technical']['failures'])
    assert result['media'][0]['technical_status'] == 'failed'


def test_unknown_file_cannot_pass_quality(tmp_path: Path):
    project = tmp_path / 'unsupported-check'
    project.mkdir()
    (project / 'notes.txt').write_text('not a video', encoding='utf-8')
    result = quality_check({'project_id': project.name, 'media_paths': ['notes.txt'], 'execute': True}, project_root=tmp_path)
    assert result['status'] == 'failed'
