const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../../backlot/ui/model.js'), 'utf8');
const code = source.slice(source.indexOf('function autofillMediaPaths('), source.indexOf('function showMediaResult('));
function fixture() {
  const fields = {};
  for (const name of new Set(code.match(/\bmedia[A-Z]\w*/g))) fields[name] = {value: ''};
  fields.mediaLines = field => field.value.split('\n').filter(Boolean);
  const context = vm.createContext(fields);
  vm.runInContext(code, context);
  return {fields, apply: (data, options) => context.autofillMediaPaths(data, options)};
}
test('music output preserves narration and is added only to the music track', () => {
  const {fields, apply} = fixture();
  fields.mediaAudioPath.value = 'assets/voice.wav';
  fields.mediaAudioPrimary.value = 'assets/voice.wav';
  apply({music:{path:'assets/music.mp3'}, output:{path:'assets/music.mp3',kind:'audio'}});
  assert.equal(fields.mediaAudioPath.value, 'assets/voice.wav');
  assert.equal(fields.mediaAudioPrimary.value, 'assets/voice.wav');
  assert.equal(fields.mediaAudioSecondary.value, 'assets/music.mp3');
  assert.match(fields.mediaAudioTracks.value, /assets\/music.mp3 \| music/);
  // BGM can be generated again: this control takes a filename, not an
  // asset path. A full path made the next free preflight fail validation.
  assert.equal(fields.mediaMusicOutput.value, 'music.mp3');
});
test('ordinary audio output never populates background music', () => {
  const {fields, apply} = fixture();
  apply({output:{path:'assets/voice-clean.wav',kind:'audio'}});
  assert.equal(fields.mediaAudioPath.value, 'assets/voice-clean.wav');
  assert.equal(fields.mediaAudioSecondary.value, '');
  assert.equal(fields.mediaAudioTracks.value, '');
});
test('project refresh preserves manually selected media but new output can replace it', () => {
  const {fields, apply} = fixture();
  fields.mediaPublishVideo.value = 'renders/chosen.mp4';
  fields.mediaAudioPath.value = 'assets/chosen.wav';
  fields.mediaSubtitlePath.value = 'assets/chosen.srt';
  fields.mediaAudioSecondary.value = 'assets/chosen-music.mp3';
  fields.mediaAudioTracks.value = 'assets/chosen-music.mp3 | music | 0.1 | 0';
  const snapshot = {preferred_video_path:'renders/latest.mp4', audio:{path:'assets/latest.wav'}, music:{path:'assets/latest.mp3'}, subtitles:{srt:'assets/latest.srt'}};
  apply(snapshot, {preserveExisting:true});
  assert.equal(fields.mediaPublishVideo.value, 'renders/chosen.mp4');
  assert.equal(fields.mediaAudioPath.value, 'assets/chosen.wav');
  assert.equal(fields.mediaSubtitlePath.value, 'assets/chosen.srt');
  assert.equal(fields.mediaAudioSecondary.value, 'assets/chosen-music.mp3');
  assert.equal(fields.mediaAudioTracks.value, 'assets/chosen-music.mp3 | music | 0.1 | 0');
  apply({output:{path:'renders/new.mp4',kind:'video'}});
  assert.equal(fields.mediaPublishVideo.value, 'renders/new.mp4');
});
test('technical warnings remain visible and are not reported as quality approval', () => {
  const context = vm.createContext({});
  vm.runInContext(source.slice(source.indexOf('function mediaNarrationResultStatus('), source.indexOf('async function runMediaAction(')), context);
  const result = context.mediaNarrationResultStatus({status:'passed', technical:{warnings:['no audio stream'],failures:[]}, semantic_review:'not_run'}, '质检');
  assert.equal(result[0], 'warn');
  assert.match(result[1], /no audio stream/);
  assert.match(result[1], /不代表成片质量通过/);
});
test('stock failures and empty results show actionable messages', () => {
  const context = vm.createContext({});
  vm.runInContext(source.slice(source.indexOf('function mediaNarrationResultStatus('), source.indexOf('async function runMediaAction(')), context);
  for (const [status, tone] of [['failed', 'error'], ['no_results', 'warn'], ['completed', 'success']]) {
    const result = context.mediaNarrationResultStatus({status, resolved_sources:['nasa'], clip_count: status === 'completed' ? 1 : 0, message:'来源说明与下一步'}, '素材检索');
    assert.equal(result[0], tone);
    assert.equal(result[1], '来源说明与下一步');
  }
});
