// Presentation of already validated archive records only. No submit, resume,
// provider lookup, credential input or network action lives in this renderer.
export function classificationHistoryView(archive,esc){
 const rows=(archive.manifest?.auxiliaryReceipts||[]).filter(r=>r.source==='asset-classification-tasks');
 if(!rows.length)return '';
 const labels={completed:'已完成',failed:'未完成',cancelled:'发送前已停止',uncertain:'原提交结果待核对'};
 const cards=rows.map(({record:c})=>{
  const asset=archive.manifest.assets.find(a=>a.id===c.assetId),a=c.authorization,result=c.result;
  const categories=result?Object.entries(result.categories).map(([dimension,tags])=>`<p>${esc(result.flat.find(r=>r.dimension===dimension)?.label||dimension)}：${esc(tags.join('、'))}</p>`).join(''):'';
  const file=archive.manifest.files.find(f=>f.kind==='asset'&&f.sourceAssetId===c.assetId);
  const href=file?`/api/task-history-archives/${encodeURIComponent(archive.id)}/files/${encodeURIComponent(file.id)}?projectId=${encodeURIComponent(archive.projectId)}`:'';
  return `<details data-classification-history-id="${esc(c.id)}"><summary>${esc(asset?.name||c.assetId)} · ${esc(labels[c.status]||c.status)} · ${esc(c.model)}</summary><div class="classification-history-item"><p>原请求编号：${esc(c.requestId)}</p><p>原服务：${esc(c.platform.origin)} · 模型：${esc(c.model)}</p><p>原图片 SHA-256：${esc(c.media.sha256)}</p><p>授权记录：仅这一张图片 / 最多 ${esc(String(a.requestLimit))} 次 · 预算 ${esc(String(a.budget))} ${esc(a.currency)}（实际扣费另行核对）</p><p>原时间：${esc(c.createdAt)} · 最后记录：${esc(c.updatedAt)}</p>${result?`<p><strong>${esc(result.summary)}</strong></p>${categories}<p>关键词：${esc(result.tags.join('、'))}</p>`:`<p>${esc(c.error?.message||'没有可用分类结果')}</p>`}${c.status==='uncertain'?'<p class="notice">这是归档时未确认的结果；只读查看不会重新发送，也不能据此判断上游是否已扣费。</p>':''}${href?`<p><a class="download-link" href="${esc(href)}" download="${esc(asset?.name||file.name)}">下载原分类图片</a></p>`:''}<details><summary>原收据 JSON（只读）</summary><pre>${esc(JSON.stringify(c,null,2))}</pre></details></div></details>`;
 }).join('');
 return `<details data-classification-history><summary>图片分类原请求（${rows.length}）</summary><p class="muted small">保留原服务、模型、图片与状态；仅查看和下载，不会恢复发送。密钥、凭据来源同意和重新发送权限不迁移。</p>${cards}</details>`;
}

export function classificationBatchHistoryView(archive,esc){
 const rows=(archive.manifest?.auxiliaryReceipts||[]).filter(r=>r.source==='classification-batches');if(!rows.length)return '';
 const labels={unsent:'原批次未发送',completed:'已完成',failed:'未完成',cancelled:'发送前已停止',uncertain:'结果与费用待核对',interrupted:'已中断',stopped:'已停止'};
 return `<details data-classification-batch-history><summary>批量分类原清单（${rows.length}）</summary><p>仅保留原范围、预算、逐图编号和状态；只读档案不会发送、继续或恢复批次。</p>${rows.map(({record:r})=>`<details><summary>${esc(r.manifest.id)} · ${esc(labels[r.status])}</summary><p>${esc(r.manifest.platform.origin)} · ${esc(r.manifest.model)} · 总预算 ${r.manifest.authorization.budget} ${esc(r.manifest.authorization.currency)} / 最多 ${r.manifest.authorization.requestLimit} 次</p><ol>${r.manifest.items.map(i=>`<li>${esc(i.name)} · ${esc(labels[r.items.find(s=>s.requestId===i.requestId)?.status])}<p>${esc(i.requestId)}</p></li>`).join('')}</ol><pre>${esc(JSON.stringify(r,null,2))}</pre></details>`).join('')}</details>`;
}

export function apimartMaterialHistoryView(archive,esc){
 const rows=(archive.manifest?.auxiliaryReceipts||[]).filter(r=>r.source==='apimart-materials');if(!rows.length)return '';
 const labels={unsubmitted:'未提交',Processing:'审核中',Active:'原查询返回可用',Failed:'未完成/未通过',uncertain:'结果待核对'};
 return `<details data-apimart-material-history><summary>APIMart素材原注册与查询（${rows.length}）</summary><p>仅查看原服务、任务编号、素材URI和每次授权；不会注册、查询上游或恢复发送。</p>${rows.map(({record:r})=>`<details><summary>${esc(r.name)} · ${esc(labels[r.status]||r.status)}</summary><p>${esc(r.endpoint)} · 项目 ${esc(r.cloudProject)} · ${esc(r.assetType)}</p><p>原注册编号 ${esc(r.id)}<br>原平台任务 ${esc(r.upstreamId||'未取得')}<br>${esc(r.assetUri||'无可用URI')}</p><p>原注册最多1次 · 预算 ${r.authorization.budget} ${esc(r.authorization.currency)}；原查询 ${r.queryCount} 次。</p><pre>${esc(JSON.stringify(r,null,2))}</pre></details>`).join('')}</details>`;
}
