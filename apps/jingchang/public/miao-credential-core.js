export const MIAO_API_BASE = 'https://miaoapi.xyz/v1';

// Local credentials are bound to this origin and to explicit supported modes.
// Check the raw authority as well: URL normalizes an explicit :443 to no port.
export function isLocalMiaoTarget(platform, {purpose = 'chat'} = {}) {
  if (!['chat', 'image', 'video'].includes(purpose) || platform?.protocol !== 'openai-compatible') return false;
  const baseUrl = platform.baseUrl;
  if (typeof baseUrl !== 'string' || /[\s?#]/.test(baseUrl) ||
      !/^https:\/\/miaoapi\.xyz(?:\/(?:v1\/?)?)?$/i.test(baseUrl)) return false;
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'https:' && url.hostname === 'miaoapi.xyz' &&
      !url.port && !url.username && !url.password && !url.search && !url.hash &&
      ['/', '/v1', '/v1/'].includes(url.pathname);
  } catch { return false; }
}
