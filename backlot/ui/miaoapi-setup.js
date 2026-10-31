(() => {
  'use strict';
  const base = '/model-api/montage/director/miaoapi';
  const form = document.querySelector('#setup'), state = document.querySelector('#state');
  let data;
  const show = (message, error = false) => { state.textContent = message; state.classList.toggle('error', error); };
  const prices = () => {
    const p = data?.models?.find(m => m.id === form.elements.model.value)?.pricing;
    document.querySelector('#pricing').textContent = p ? `页面单价：输入 $${p.displayed_input_per_million} / 输出 $${p.displayed_output_per_million} 每百万令牌。工作台加倍预留，每次调用前确认。` : '价格尚未读取。';
  };
  async function load() {
    const r = await fetch(base + '/status', {cache:'no-store'});
    if (!r.ok) throw Error('无法读取连接状态');
    data = await r.json();
    if (data.model) form.elements.model.value = data.model;
    if (data.protocol) form.elements.protocol.value = data.protocol;
    show(data.configured ? `专用认证已配置 · ${data.model}。这只代表本机能读取密钥；实际调用是否成功，以任务结果为准。` : data.error || '请配置喵喵专用密钥');
    prices();
  }
  form.elements.model.addEventListener('change', prices);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const button = form.querySelector('button'), key = form.elements.key;
    if (key.value && !form.elements.saveToKeychain.checked) { show('请先确认保存到本机钥匙串', true); return; }
    const body = {model:form.elements.model.value, protocol:form.elements.protocol.value,
      apiKey:key.value, saveToKeychain:form.elements.saveToKeychain.checked};
    button.disabled = true;
    try {
      const r = await fetch(base + '/config', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const result = await r.json();
      if (!r.ok) throw Error(typeof result.detail === 'string' ? result.detail : '保存失败');
      await load();
      show(data.configured ? '本机连接设置已保存，没有发起模型调用。可在助理设置中选择喵喵；执行前仍需确认单次发送范围和费用。已有镜场平台设置保持原样。' : '模型设置已保存，但尚未配置密钥，助理还不能调用喵喵。没有发起模型调用。');
    } catch (error) { show(error.message, true); }
    finally { body.apiKey = ''; key.value = ''; form.elements.saveToKeychain.checked = false; button.disabled = false; }
  });
  load().catch(error => show(error.message, true));
})();
