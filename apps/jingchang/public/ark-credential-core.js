export const ARK_API_BASE = 'https://ark.cn-beijing.volces.com/api/v3';

// A saved local credential must never follow a user-supplied proxy or endpoint.
export function isLocalArkTarget(studio) {
  if (studio?.mode !== 'video' || studio.config?.protocol !== 'ark') return false;
  try {
    const url = new URL(studio.config.baseUrl);
    return url.origin === new URL(ARK_API_BASE).origin &&
      url.pathname.replace(/\/+$/, '') === '/api/v3' &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
