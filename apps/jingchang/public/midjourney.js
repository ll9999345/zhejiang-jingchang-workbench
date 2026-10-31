import {MJ_MODES} from './midjourney-core.js';
export function midjourneyFields(c,esc,kind='config') {
  const attr=n=>kind==='config'?`data-config="${n}"`:`name="${n}"`;
  const select=(name,values,value)=>`<select ${attr(name)}>${Object.entries(values).map(([k,v])=>`<option value="${esc(k)}" ${String(value)===k?'selected':''}>${esc(v)}</option>`).join('')}</select>`;
  const field=(label,input)=>`<label>${label}${input}</label>`;
  return `<div class="form-grid midjourney-fields">${field('Midjourney 操作',select('mjMode',MJ_MODES,c.mjMode||'imagine'))}${field('速度',select('mjSpeed',{relax:'relax',fast:'fast',turbo:'turbo'},c.mjSpeed||'relax'))}${field('自定义画幅（宽:高）',`<input ${attr('mjSize')} maxlength="5" value="${esc(c.mjSize||c.ratio||'1:1')}" placeholder="例如7:5">`)}${field('版本（文生图）',`<input ${attr('mjVersion')} maxlength="24" value="${esc(c.mjVersion||'6.1')}">`)}${field('原任务编号（二次操作）',`<input ${attr('mjTaskId')} maxlength="240" value="${esc(c.mjTaskId||'')}" placeholder="task_…">`)}${field('图片序号',`<input ${attr('mjIndex')} type="number" min="1" max="4" step="1" value="${c.mjIndex??1}">`)}${field('缩放倍数（扩图）',`<input ${attr('mjZoom')} type="number" min="1.01" max="4" step="0.01" value="${c.mjZoom??2}">`)}${field('平移方向',select('mjDirection',{left:'向左',right:'向右',up:'向上',down:'向下'},c.mjDirection||'left'))}${field('重绘遮罩',select('mjMaskConvention',{'white-edit':'白色区域重绘（镜场遮罩）',alpha:'透明区域重绘（平台PNG）'},c.mjMaskConvention||'white-edit'))}${field('按钮编号（可选）',`<input ${attr('mjCustomId')} maxlength="600" value="${esc(c.mjCustomId||'')}" placeholder="自动匹配失败时，填原任务buttons的customId">`)}</div><p class="field-help">每次只提交一次操作，可能返回一张图片或四张选图。多图融合只发送图片；二次操作使用原任务编号。局部重绘先使用已放大的单图任务编号，再分两步：创建重绘入口，再为返回的编号单独确认遮罩和补参请求。版本与按钮是否支持由平台核验。</p>`;
}
export function readMidjourneyFields(form) {
  const data=form instanceof FormData?form:new FormData(form),out={};
  for(const key of ['mjMode','mjSpeed','mjVersion','mjSize','mjTaskId','mjCustomId','mjDirection','mjMaskConvention'])if(data.has(key))out[key]=String(data.get(key)).trim();
  for(const key of ['mjIndex','mjZoom'])if(data.has(key))out[key]=Number(data.get(key));
  return out;
}
