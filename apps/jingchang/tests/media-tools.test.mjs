import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { storeAsset, readJson } from '../lib/workspace.mjs';
import { cropImage, extractVideoFrames } from '../lib/media-tools.mjs';

const execute = promisify(execFile);
const PNG_MAGIC = Buffer.from('89504e470d0a1a0a', 'hex');
// Synthetic-only fixtures and processing outputs are deliberately retained.
async function fixtures() {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'jingchang-media-test-'));
  const video = path.join(data, 'synthetic.mp4');
  const image = path.join(data, 'synthetic.png');
  await execute('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10:duration=1', '-c:v', 'mpeg4', '-threads', '1', video]);
  await execute('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=1', '-frames:v', '1', '-threads', '1', '-update', '1', image]);
  const videoBytes = await fs.readFile(video), imageBytes = await fs.readFile(image);
  const videoAsset = await storeAsset(data, videoBytes, { name: '合成视频.mp4', type: 'video/mp4' });
  const imageAsset = await storeAsset(data, imageBytes, { name: '合成图片.png', type: 'image/png' });
  return { data, videoAsset, imageAsset, videoBytes, imageBytes };
}

test('local media tools use real FFmpeg outputs and preserve sources and intermediate files', async t => {
  const { data, videoAsset, imageAsset, videoBytes, imageBytes } = await fixtures();
  await t.test('extract requested video frames with actual duration and PNG dimensions', async () => {
    const times = [0, 0.5, 0.99];
    const result = await extractVideoFrames({ data, assetId: videoAsset.id, times });
    assert.equal(result.duration, 1);
    assert.equal(result.assets.length, 3);
    for (const [index, asset] of result.assets.entries()) {
      const bytes = await fs.readFile(path.join(data, 'assets', asset.id));
      assert.deepEqual(bytes.subarray(0, 8), PNG_MAGIC);
      assert.equal(bytes.readUInt32BE(16), 160);
      assert.equal(bytes.readUInt32BE(20), 120);
      assert.equal(asset.frameTime, times[index]);
      assert.equal(asset.sourceAssetId, videoAsset.id);
      assert.deepEqual(await readJson(path.join(data, 'assets', `${asset.id}.json`)), asset);
    }
  });
  await t.test('crop respects odd source-pixel coordinates and exact dimensions', async () => {
    const asset = await cropImage({ data, assetId: imageAsset.id, x: 3, y: 5, width: 71, height: 43 });
    const bytes = await fs.readFile(path.join(data, 'assets', asset.id));
    assert.deepEqual(bytes.subarray(0, 8), PNG_MAGIC);
    assert.equal(bytes.readUInt32BE(16), 71);
    assert.equal(bytes.readUInt32BE(20), 43);
    assert.deepEqual(asset.crop, { x: 3, y: 5, width: 71, height: 43 });
    const raw = await execute('ffmpeg', ['-v', 'error', '-i', path.join(data, 'assets', asset.id), '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer' });
    const original = await execute('ffmpeg', ['-v', 'error', '-i', path.join(data, 'assets', imageAsset.id), '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer' });
    assert.deepEqual(raw.stdout.subarray(0, 71 * 3), original.stdout.subarray((5 * 160 + 3) * 3, (5 * 160 + 74) * 3));
  });
  await t.test('invalid identifiers, non-local sources, malformed media and bounds are rejected', async () => {
    for (const assetId of ['../synthetic.mp4', '/tmp/example', 'http://localhost/movie.mp4', '', null, 'missing']) {
      await assert.rejects(extractVideoFrames({ data, assetId, times: [0] }), /素材/);
    }
    for (const times of [[], Array(13).fill(0), [-1], [NaN], [Infinity], ['0'], [1], [2]]) {
      await assert.rejects(extractVideoFrames({ data, assetId: videoAsset.id, times }), /时间/);
    }
    for (const rectangle of [{ x: -1, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 0, height: 1 }, { x: 0.5, y: 0, width: 1, height: 1 }, { x: 159, y: 0, width: 2, height: 1 }, { x: 0, y: 0, width: 160, height: 121 }]) {
      await assert.rejects(cropImage({ data, assetId: imageAsset.id, ...rectangle }), /裁剪/);
    }
    await assert.rejects(cropImage({ data, assetId: videoAsset.id, x: 0, y: 0, width: 1, height: 1 }), /图片/);
    const fake = await storeAsset(data, Buffer.from('#EXTM3U\n#EXTINF:1\nhttps://example.invalid/video.ts\n'), { name: 'fake.mp4', type: 'video/mp4' });
    await assert.rejects(extractVideoFrames({ data, assetId: fake.id, times: [0] }), /媒体处理失败/);
    await fs.symlink(path.join(data, 'synthetic.mp4'), path.join(data, 'assets', 'linked'));
    await fs.writeFile(path.join(data, 'assets', 'linked.json'), JSON.stringify({ ...videoAsset, id: 'linked' }));
    await assert.rejects(extractVideoFrames({ data, assetId: 'linked', times: [0] }), /普通媒体文件/);
  });
  assert.deepEqual(await fs.readFile(path.join(data, 'assets', videoAsset.id)), videoBytes);
  assert.deepEqual(await fs.readFile(path.join(data, 'assets', imageAsset.id)), imageBytes);
  const directories = await fs.readdir(path.join(data, 'media-tools'));
  assert.equal(directories.length, 2);
  const counts = await Promise.all(directories.map(async directory => (await fs.readdir(path.join(data, 'media-tools', directory))).length));
  assert.equal(counts.reduce((sum, value) => sum + value, 0), 4);
});
