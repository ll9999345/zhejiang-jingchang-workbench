import test from 'node:test';
import assert from 'node:assert/strict';
import {ambientState, frameQuality} from '../public/ambient-glass.js';

test('bounded sample distinguishes smooth playback, a slow machine and insufficient data', () => {
  assert.equal(frameQuality(Array.from({length: 121}, (_, i) => i * (1000 / 60))).static, false);
  assert.equal(frameQuality(Array.from({length: 26}, (_, i) => i * 80)).static, true);
  assert.equal(frameQuality([0]).static, true);
  assert.equal(frameQuality([0, 0, 0]).static, true);
});
test('stalls are detected even when average frame rate passes', () => {
  const samples = [0];
  for (let i = 0; i < 50; i++) samples.push(samples.at(-1) + (i % 2 ? 71 : 1));
  const result = frameQuality(samples);
  assert.ok(result.fps > 24); assert.equal(result.static, true);
});
test('user pause and old-machine auto pause remain separate from task state', () => {
  assert.deepEqual(ambientState({preference: 'paused'}), {motion: 'paused', quality: 'standard', reason: 'user', disabled: false});
  assert.deepEqual(ambientState({preference: 'auto'}), {motion: 'paused', quality: 'static', reason: 'performance', disabled: false});
  assert.deepEqual(ambientState({preference: 'running'}), {motion: 'running', quality: 'standard', reason: '', disabled: false});
});
test('system motion, transparency, forced colors and missing blur support use static surfaces', () => {
  for (const property of ['reducedMotion', 'reducedTransparency', 'forcedColors']) {
    const result = ambientState({preference: 'running', [property]: true});
    assert.equal(result.motion, 'paused'); assert.equal(result.quality, 'static'); assert.equal(result.disabled, true);
  }
  assert.equal(ambientState({supported: false}).reason, 'capability');
});
test('background pause does not erase user preference or automatic fallback', () => {
  assert.equal(ambientState({preference: 'running', hidden: true}).reason, 'background');
  assert.equal(ambientState({preference: 'running', hidden: false}).motion, 'running');
  assert.equal(ambientState({preference: 'auto', hidden: true}).quality, 'static');
  assert.equal(ambientState({preference: 'auto', hidden: false}).motion, 'paused');
});
