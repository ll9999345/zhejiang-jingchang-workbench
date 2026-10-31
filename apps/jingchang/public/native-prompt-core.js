export const isNativePrompt=node=>node?.params?.nativeCanvas?.node?.type==='smart-prompt';
export function normalizeNativePromptSettings(value){
 if(!value||value.version!==1||typeof value.splitEnabled!=='boolean'||typeof value.llmEnabled!=='boolean'||typeof value.separator!=='string'||value.separator.length>8||typeof value.instruction!=='string'||value.instruction.length>32000||!Number.isSafeInteger(value.previewHeight)||value.previewHeight<40||value.previewHeight>220||Object.keys(value).some(key=>!['version','splitEnabled','separator','llmEnabled','instruction','previewHeight'].includes(key)))throw Error('智能提示词设置无效：分隔符最多8字，指令最多32000字，预览高度40–220');
 return{version:1,splitEnabled:value.splitEnabled,separator:value.separator,llmEnabled:value.llmEnabled,instruction:value.instruction,previewHeight:value.previewHeight};
}
export function nativePromptSettings(node){
 if(!isNativePrompt(node))throw Error('请选择原生智能提示词节点');
 if(node.params.nativePrompt!==undefined)return normalizeNativePromptSettings(node.params.nativePrompt);
 const raw=node.params.nativeCanvas.node,height=Number(raw.promptSplitPreviewHeight);
 return normalizeNativePromptSettings({version:1,splitEnabled:raw.promptSplitEnabled===true,separator:String(raw.promptSeparator??';'),llmEnabled:raw.llmEnabled===true,instruction:String(raw.llmInstruction||''),previewHeight:Number.isFinite(height)?Math.max(40,Math.min(220,Math.round(height))):70});
}
export const nativePromptLlmEnabled=node=>isNativePrompt(node)&&nativePromptSettings(node).llmEnabled;
export function nativePromptItems(node,text=node.text){
 const settings=nativePromptSettings(node),value=String(text||'').trim();if(!value)return[];if(!settings.splitEnabled)return[value];
 const parts=value.split(settings.separator||';').map(item=>item.trim()).filter(Boolean);return parts.length>1?parts:[value];
}
export function nativePromptSystemDefault(node){
 if(!isNativePrompt(node))return'';const raw=node.params.nativeCanvas.node;return raw.llmSystemEnabled===true?String(raw.llmSystemPrompt||'').trim()||'You are a helpful prompt assistant.':'';
}
export function nativePromptSuggestedReferences(project,node,choices){
 if(!isNativePrompt(node))return[];
 const direct=new Set(project.edges.filter(edge=>edge.target===node.id).map(edge=>edge.source));
 return[...new Set(choices.filter(choice=>typeof choice.value==='string'&&choice.value.startsWith('node:')&&direct.has(choice.value.slice(5))).map(choice=>choice.value.slice(5)))].map(sourceNodeId=>({sourceNodeId}));
}
