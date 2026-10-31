import json
import pytest
from tools.analysis.highlight_selector import read_transcript, suggest_segments


def test_suggestions_follow_real_boundaries_and_do_not_overlap(tmp_path):
    transcript=tmp_path/'source.srt'
    transcript.write_text('1\n00:00:00,000 --> 00:00:06,000\n为什么水乡值得慢下来？\n\n2\n00:00:06,000 --> 00:00:13,000\n关键是人与风景的关系。\n\n3\n00:00:13,000 --> 00:00:26,000\n接下来走进真实的街巷。\n',encoding='utf-8')
    rows=read_transcript(transcript)
    result=suggest_segments(rows,26,min_seconds=6,max_seconds=14,count=3)
    assert result
    assert all(r['start_seconds'] in {0,6,13} and r['end_seconds'] in {6,13,26} for r in result)
    assert all(a['end_seconds']<=b['start_seconds'] for a,b in zip(result,result[1:]))
    assert all(6<=r['end_seconds']-r['start_seconds']<=14 for r in result)


def test_invalid_transcript_never_generates_fake_candidates(tmp_path):
    p=tmp_path/'transcript.json'
    p.write_text(json.dumps([{'start':0,'end':10,'text':'first'},{'start':5,'end':15,'text':'second'}]))
    with pytest.raises(ValueError,match='重叠'): read_transcript(p)
    with pytest.raises(ValueError,match='超出'): suggest_segments([{'start':0,'end':11,'text':'sentence'}],5)
