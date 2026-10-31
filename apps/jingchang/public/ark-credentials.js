import {isLocalArkTarget} from './ark-credential-core.js';
import {isLocalStudioServiceTarget} from './studio-service-core.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function arkCredentialFields({studio, keyId = '', keyName = '', sourceId = '', manualLabel = '本次 API Key', placeholder = '仅在本次请求使用'}) {
  const eligible = isLocalArkTarget(studio), miao = isLocalStudioServiceTarget(studio);
  return `<div class="ark-credential-fields" data-ark-credential data-ark-eligible="${eligible}" data-miao-eligible="${miao}"><label>服务认证<select data-credential-source ${sourceId ? `id="${esc(sourceId)}"` : ''}><option value="manual">本次填写</option><option value="miao-local" ${miao ? 'selected' : 'disabled'}>使用本机已有模型服务配置</option>${studio?.mode === 'video' ? `<option value="ark-local" ${eligible ? '' : 'disabled'}>使用本机已有火山配置</option>` : ''}</select></label><label data-manual-key-label ${miao ? 'hidden' : ''}>${esc(manualLabel)}<input data-manual-key ${keyId ? `id="${esc(keyId)}"` : ''} ${keyName ? `name="${esc(keyName)}"` : ''} type="password" autocomplete="new-password" placeholder="${esc(placeholder)}" ${miao ? 'disabled' : ''}></label><p class="ark-credential-note" data-credential-note>本机配置只在服务端使用；密钥会在本次授权执行时读取。</p><p class="ark-credential-note" data-credential-status aria-live="polite"></p></div>`;
}

export function updateArkCredentialTarget(row, studio) {
  if (!row) return;
  const eligible = isLocalArkTarget(studio), select = row.querySelector('[data-credential-source]');
  row.dataset.arkEligible = String(eligible);
  const miao = isLocalStudioServiceTarget(studio);
  row.dataset.miaoEligible = String(miao);
  const miaoOption = select?.querySelector('[value="miao-local"]');
  if (miaoOption) miaoOption.disabled = !miao;
  const option = select?.querySelector('[value="ark-local"]');
  if (option) option.disabled = !eligible;
  if (!eligible && select?.value === 'ark-local') { select.value = 'manual'; select.dispatchEvent(new Event('change', {bubbles: true})); }
  if (!miao && select?.value === 'miao-local') { select.value = 'manual'; select.dispatchEvent(new Event('change', {bubbles: true})); }
  if (miao && select?.value !== 'miao-local') { select.value = 'miao-local'; select.dispatchEvent(new Event('change', {bubbles: true})); }
  const note = row.querySelector('[data-credential-note]');
  if (note) note.textContent = '本机配置只在服务端使用；密钥会在本次授权执行时读取。';
}

export function readArkCredentialFields(root, fallbackKey = '') {
  const row = root.matches?.('[data-ark-credential]') ? root : root.querySelector('[data-ark-credential]');
  if (!row) throw Error('密钥输入尚未准备好');
  if (row.querySelector('[data-credential-source]')?.value === 'miao-local') {
    if (row.dataset.miaoEligible !== 'true') throw Error('本机模型服务配置只用于已登记的 HTTPS 模型服务地址');
    return {apiKey: '', credentialSource: 'miao-local', credentialConsent: true};
  }
  if (row.querySelector('[data-credential-source]')?.value === 'ark-local') {
    if (row.dataset.arkEligible !== 'true') throw Error('本机配置只用于火山官方视频接口');
    return {apiKey: '', credentialSource: 'ark-local', credentialConsent: true};
  }
  return {apiKey: row.querySelector('[data-manual-key]').value || fallbackKey};
}

if (typeof document !== 'undefined') document.addEventListener('change', async event => {
  const select = event.target.closest?.('[data-credential-source]');
  if (!select) return;
  const row = select.closest('[data-ark-credential]'), input = row.querySelector('[data-manual-key]'), label = row.querySelector('[data-manual-key-label]'), status = row.querySelector('[data-credential-status]');
  const local = select.value === 'ark-local' && row.dataset.arkEligible === 'true' || select.value === 'miao-local' && row.dataset.miaoEligible === 'true';
  input.value = ''; input.disabled = local; label.hidden = local; status.textContent = '';
  if (!local) return;
  status.textContent = '正在检查本机配置…';
  try {
    const source = select.value;
    const response = await fetch(source === 'miao-local' ? '/api/miao-credentials/status' : '/api/ark-credentials/status'), result = await response.json();
    if (!row.isConnected || select.value !== source) return;
    if (!response.ok) throw Error();
    status.textContent = result.configured ? `已找到${result.source === 'environment' ? '服务端环境变量' : 'macOS 钥匙串'}配置；尚未验证账户权限。读取密钥会在本次授权执行时进行。` : result.status === 'missing' ? '未找到本机配置。可改为本次填写。' : '暂时无法检查本机配置。可检查钥匙串访问或改为本次填写。';
  } catch { if (row.isConnected && local) status.textContent = '暂时无法检查本机配置；没有提交生成。'; }
});
