import test from 'node:test';
import assert from 'node:assert/strict';
import { polylinesTouch } from '../public/canvas-cut.js';

test('切线与交叉的连线相交', () => {
  assert.equal(polylinesTouch([{ x: 50, y: 0 }, { x: 50, y: 100 }], [{ x: 0, y: 50 }, { x: 100, y: 50 }]), true);
});

test('切线与附近但未触及的连线保持分离', () => {
  assert.equal(polylinesTouch([{ x: 0, y: 0 }, { x: 100, y: 0 }], [{ x: 0, y: 18 }, { x: 100, y: 18 }], 9), false);
});

test('容差可捕捉指针靠近连线时的切割', () => {
  assert.equal(polylinesTouch([{ x: 0, y: 7 }, { x: 100, y: 7 }], [{ x: 0, y: 0 }, { x: 100, y: 0 }], 9), true);
});

test('空白或单点轨迹不会切断连线', () => {
  const edge = [{ x: 0, y: 0 }, { x: 100, y: 100 }];
  assert.equal(polylinesTouch([], edge), false);
  assert.equal(polylinesTouch([{ x: 0, y: 50 }], edge), false);
});
