import { loadAsset, safeId, userError } from './workspace.mjs';
import { renderSource } from './render-inputs.mjs';
import { command } from './render.mjs';

const WIDTH = 640;
const HEIGHT = 64;
const CACHE_LIMIT = 128;

export function decodeWaveformPixels(bytes, width = WIDTH, height = HEIGHT) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== width * height * 4) throw userError('无法读取音频波形');
  const peaks = new Array(width);
  for (let x = 0; x < width; x++) {
    let extent = 0;
    for (let y = 0; y < height; y++) {
      const i = (y * width + x) * 4;
      const intensity = Math.max(bytes[i], bytes[i + 1], bytes[i + 2]);
      if (intensity > 24) extent = Math.max(extent, Math.abs(y - (height - 1) / 2));
    }
    peaks[x] = Number(Math.min(1, extent / (height / 2)).toFixed(4));
  }
  return peaks;
}

export function audioWaveformService({ data }) {
  const cache = new Map();
  const pending = new Map();
  let active = 0;
  const waiters = [];
  const acquire = () => new Promise(resolve => {
    const grant = () => {
      active++;
      resolve(() => { active--; waiters.shift()?.(); });
    };
    if (active < 2) grant(); else waiters.push(grant);
  });

  async function preview(assetId, signal) {
    if (!safeId(assetId)) throw userError('素材编号无效');
    if (cache.has(assetId)) {
      const value = cache.get(assetId);
      cache.delete(assetId);
      cache.set(assetId, value);
      return value;
    }
    if (pending.has(assetId)) return pending.get(assetId);

    const task = (async () => {
      const release = await acquire();
      try {
        signal?.throwIfAborted();
        const asset = await loadAsset(data, assetId);
        if (!asset.type?.startsWith('audio/')) throw userError('只有音频素材可以生成波形');
        const timeout = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
        const source = await renderSource(data, asset, command, timeout);
        const chunks = [];
        let size = 0;
        const expectedSize = WIDTH * HEIGHT * 4;
        await command(process.env.FFMPEG_PATH || 'ffmpeg', [
          '-hide_banner', '-loglevel', 'error', '-nostdin', '-filter_threads', '1',
          ...source.input, '-i', source.file,
          '-filter_complex', '[0:a:0]aformat=channel_layouts=mono,showwavespic=s=640x64:colors=0x7187d9:scale=sqrt:draw=scale[w]',
          '-map', '[w]', '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'
        ], timeout, { onStdout(bytes) {
          if (size < expectedSize) {
            const chunk = bytes.subarray(0, expectedSize - size);
            chunks.push(chunk);
            size += chunk.length;
          }
        } });
        const value = { assetId, width: WIDTH, peaks: decodeWaveformPixels(Buffer.concat(chunks)), duration: source.duration };
        cache.set(assetId, value);
        if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
        return value;
      } finally { release(); }
    })();
    pending.set(assetId, task);
    try { return await task; }
    finally { pending.delete(assetId); }
  }

  return { preview };
}
