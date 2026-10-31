import test from 'node:test';
import assert from 'node:assert/strict';
import {canvasFrameQueue} from '../public/canvas-frame.js';

function fixture() {
  let serial = 0;
  const pending = new Map(), applied = [];
  const queue = canvasFrameQueue(value => applied.push(value), {
    request: callback => { pending.set(++serial, callback); return serial; },
    cancel: id => pending.delete(id),
  });
  return {queue, pending, applied};
}

test('a pointer burst paints the last position only once per display frame', () => {
  const f = fixture();
  for (let x = 0; x < 100; x++) f.queue.push({x, y: x * 2});
  assert.equal(f.pending.size, 1);
  [...f.pending.values()][0]();
  assert.deepEqual(f.applied, [{x: 99, y: 198}]);
  assert.equal(f.pending.size, 0);
});

test('pointer release flushes the final coordinates before saving and cannot paint twice', () => {
  const f = fixture();
  f.queue.push({x: 120, y: 60});
  const late = [...f.pending.values()][0];
  f.queue.flush();
  assert.deepEqual(f.applied, [{x: 120, y: 60}]);
  assert.equal(f.pending.size, 0);
  late();
  assert.equal(f.applied.length, 1);
  f.queue.push({x: 180, y: 90});
  f.queue.flush();
  assert.equal(f.applied.at(-1).x, 180);
});

test('a discarded drag leaves no scheduled update for a different project', () => {
  const f = fixture();
  f.queue.push({project: 'old'});
  f.queue.clear();
  assert.equal(f.pending.size, 0);
  f.queue.flush();
  assert.deepEqual(f.applied, []);
});
