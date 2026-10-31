export function legacyNativeInputAuditMarkup(audit,esc){
 if(audit?.format!=='jingchang.legacy-native-input-audit@1'||audit.blocksResume!==true&&audit.state!=='reviewed')return'';
 const slots=value=>Array.isArray(value)&&value.every(n=>Number.isSafeInteger(n)&&n>=0&&n<64)?value.map(n=>n+1).join('、'):'无法确认';
 const rows=(audit.entries||[]).filter(row=>row.state!=='compatible').map(row=>`<li>第 ${esc(String(row.stepIndex+1))} 步：${esc(row.reason)}${row.authorizedIndices?`<br>旧确认序号：${esc(slots(row.authorizedIndices))}；${row.state==='reviewed'?'已确认所需序号':'快照所需序号'}：${esc(slots(row.reconstructedIndices))}`:''}</li>`).join('');
 return`<section class="native-input-review" role="status"><strong>${audit.state==='reviewed'?'旧任务素材序号已确认':'旧任务素材需要重新核对'}</strong><p>${esc(audit.summary)}</p><ul>${rows}</ul><p class="muted small">原任务和上游产物保留。${audit.state==='reviewed'?'继续任务仍需原有的服务、发送范围及费用确认。':'可先取回已完成步骤；能明确还原的范围可点击核对并确认。'}</p></section>`;
}

export function nativeInputReviewPreviewMarkup(preview,esc){
 if(preview?.format!=='jingchang.native-input-review-preview@1')throw Error('服务未返回可核对的原任务信息，请保留任务并刷新。');
 return legacyNativeInputAuditMarkup(preview.audit,esc)+`<p>${esc(preview.message||'请查看原任务。')}</p>`+(preview.canConfirm===true?'<label class="check-label"><input id="native-input-review-consent" type="checkbox">我已核对这些生产序号，确认用于本次原任务；此操作不开始生成</label>':'');
}

// A display copy explains the effective reviewed range in the existing
// authorization form. The saved legacy plan remains unchanged on the server.
export function reviewedNativeInputDisplaySteps(steps,audit){
 if(audit?.format!=='jingchang.legacy-native-input-audit@1'||audit.blocksResume||audit.state!=='reviewed')return steps;
 const out=structuredClone(steps);
 for(const row of audit.entries||[]){
  if(row.state!=='reviewed'||!Number.isSafeInteger(row.stepIndex)||!Number.isSafeInteger(row.detailIndex)||!Array.isArray(row.reconstructedIndices)||!row.reconstructedIndices.length||row.reconstructedIndices.some(n=>!Number.isSafeInteger(n)||n<0||n>63))continue;
  const detail=out[row.stepIndex]?.nativeReferences?.details?.[row.detailIndex];if(!detail||detail.sourceNodeId!==row.producerNodeId)continue;
  detail.expectedCount=row.reconstructedIndices.length;detail.producerIndices=[...row.reconstructedIndices];
 }
 return out;
}
