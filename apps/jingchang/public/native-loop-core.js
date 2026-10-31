export const isNativeLoop=node=>['loop','smart-loop'].includes(node?.params?.nativeCanvas?.node?.type);
const fields=['version','enabled','mode','count','start','showPrompt','imageInput','imageBatchSize','videoInput','videoBatchSize','variablePrompt','variablePrompts'];
export function normalizeNativeLoopSettings(value){
 if(!value||value.version!==1||typeof value.enabled!=='boolean'||!['serial','parallel'].includes(value.mode)||!Number.isSafeInteger(value.count)||value.count<1||value.count>100||!Number.isSafeInteger(value.start)||value.start<1||value.start>9999||['showPrompt','imageInput','videoInput'].some(key=>typeof value[key]!=='boolean')||['imageBatchSize','videoBatchSize'].some(key=>!Number.isSafeInteger(value[key])||value[key]<1||value[key]>100)||typeof value.variablePrompt!=='string'||value.variablePrompt.length>200000||value.variablePrompts!==null&&(!Array.isArray(value.variablePrompts)||value.variablePrompts.length>100||value.variablePrompts.some(text=>typeof text!=='string'||text.length>32000)||value.variablePrompts.reduce((sum,text)=>sum+text.length,0)>200000)||Object.keys(value).some(key=>!fields.includes(key)))throw Error('原生循环设置无效：计数和媒体批次须为整数；1–100轮，起始计数1–9999，媒体批次1–100，提示词合计最多20万字');
 return Object.fromEntries(fields.map(key=>[key,key==='variablePrompts'&&value[key]!==null?[...value[key]]:value[key]]));
}
export function nativeLoopSettings(node){
 if(!isNativeLoop(node))throw Error('请选择原生循环节点');
 if(node.params.nativeLoop!==undefined)return normalizeNativeLoopSettings(node.params.nativeLoop);
 const raw=node.params.nativeCanvas.node,integer=(value,fallback,max)=>Math.max(1,Math.min(max,Number(value||fallback)));
 return normalizeNativeLoopSettings({version:1,enabled:false,mode:raw.mode==='parallel'||raw.parallel===true?'parallel':'serial',count:integer(raw.count,1,100),start:integer(raw.loopStart,1,9999),showPrompt:raw.showPrompt===true,imageInput:raw.imageInput===true,imageBatchSize:integer(raw.imageBatchSize,1,100),videoInput:raw.videoInput===true,videoBatchSize:integer(raw.videoBatchSize,1,100),variablePrompt:String(raw.variablePrompt||''),variablePrompts:Array.isArray(raw.variablePrompts)?raw.variablePrompts.map(text=>String(text||'')):null});
}
export const nativeLoopEnabled=node=>isNativeLoop(node)&&nativeLoopSettings(node).enabled;
export function nativeLoopLocalPromptFields(settings){
 if(settings.variablePrompts!==null&&settings.variablePrompts.length)return settings.variablePrompts.map(text=>text.trim()).filter(Boolean);
 const text=settings.variablePrompt.trim();if(!text)return[];
 const numbered=text.split(/\s*(?:^|\s)\d+\s*[.、)）．]\s+/).map(text=>text.trim()).filter(Boolean);if(numbered.length>=2)return numbered;
 const lines=text.split(/\r?\n+/).map(text=>text.trim()).filter(Boolean);return lines.length>=2?lines:[text];
}
export function nativeLoopRoundContext(node,round){
 const settings=nativeLoopSettings(node);if(!Number.isSafeInteger(round)||round<0||round>=settings.count)throw Error('原生循环回合不存在');
 const stride=settings.imageInput?settings.imageBatchSize:1;return{index:settings.start+round*stride,total:settings.start+(settings.count-1)*stride};
}
