import {validateNativeMediaMap} from '../public/native-media-map-core.js';
import {validateSmartGroupEditReceipt} from '../public/smart-group-core.js';
import {checkedNativeMediaVersion} from '../public/native-media-version.js';
import {normalizeEnhancement} from '../public/image-enhance-core.js';
import {normalizeRandomSelection} from '../public/workflow-random-core.js';
import {normalizeCloudOverrides} from './native-workflow-config.mjs';
import {normalizeMinimaxTimeline,minimaxTimelineOf,minimaxAssetIds} from '../public/minimax-h3-core.js';
import {normalizeLtxTimeline,ltxReferences} from '../public/ltx-director-core.js';
import {normalizeCameraAngle} from '../public/camera-angle-core.js';
import {validateEditing} from '../public/editing-core.js';
import {normalizeLoop} from './loop-core.mjs';
import { validateGroups } from './canvas-tools.mjs';
import {promptAssetIds} from './prompt-assets.mjs';
import {validateNativeNode,validateNativeUrls} from '../public/native-canvas-core.js';
import { randomUUID } from 'node:crypto';
export const types = ['text','script','image','video','audio','character','scene','loop'];
export const labels = {text:'文本',script:'剧本',image:'图片',video:'视频',audio:'音频',character:'角色',scene:'场景',loop:'循环'};
export function makeNode(type, x=180, y=180, data={}) {
  if (!types.includes(type)) throw new Error('不支持的节点类型');
  return {id:randomUUID(),type,x,y,title:labels[type],text:'',assetId:null,params:{ratio:'16:9',duration:5,resolution:'720p',model:'',negativePrompt:'',seed:'',voice:''},...data};
}
export function makeProject(name='未命名项目') {
  return {id:randomUUID(),name,revision:0,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),nodes:[makeNode('image',200,160)],edges:[],assets:[],shots:[],messages:[],runs:[],viewport:{x:0,y:0,zoom:1},settings:{ratio:'16:9',fps:24},archived:false};
}
export function validateProject(p) {
  validateSmartGroupEditReceipt(p);
  const safeId=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(id);
  if (!p || typeof p.name!=='string' || !p.name.trim() || p.name.length>120) throw new Error('项目名称须为 1–120 个字符');
  for (const key of ['nodes','edges','assets','shots','messages','runs']) if(!Array.isArray(p[key])) throw new Error(`缺少项目数据：${key}`);
  if(p.nodes.length>1500 || p.edges.length>5000 || p.shots.length>2000) throw new Error('项目超过当前版本容量');
  const ids = new Set();
  for(const n of p.nodes) {
    if(!safeId(n.id) || !types.includes(n.type) || !Number.isFinite(n.x) || !Number.isFinite(n.y) || typeof n.title!=='string' || typeof n.text!=='string' || ids.has(n.id)) throw new Error('节点数据格式错误');
    if(n.text.length>200000 || Math.abs(n.x)>1e7 || Math.abs(n.y)>1e7) throw new Error('节点内容或坐标超出范围');
    if(n.type==='loop')normalizeLoop(n.params?.loop);
    if(n.params?.workflowBinding?.ltxDirector){if(n.type!=='video')throw Error('LTX 导演只用于视频节点');normalizeLtxTimeline(n.params.workflowBinding.ltxDirector);}
    if(minimaxTimelineOf(n)){if(n.type!=='video'||[n.params?.minimaxH3,n.params?.workflowBinding?.minimaxH3,n.params?.cloudBinding?.minimaxH3].filter(Boolean).length!==1)throw Error('H3 时间轴只用于视频节点且不能重复保存');const t=normalizeMinimaxTimeline(minimaxTimelineOf(n));if(n.params?.workflowBinding?.minimaxH3&&t.engine!=='comfyui'||n.params?.cloudBinding?.minimaxH3&&t.engine!=='runninghub')throw Error('H3 时间轴执行方式与绑定不一致');}
    for(const b of [n.params?.workflowBinding,n.params?.studioBinding])if(b?.imageEnhance){if(n.type!=='image')throw Error('增强和放大只用于图片节点');normalizeEnhancement(b.imageEnhance);}
    if(n.params?.cameraAngle){if(n.type!=='image')throw Error('机位控制只用于图片节点');normalizeCameraAngle(n.params.cameraAngle);}
    if(n.params?.nativeMediaVersion!==undefined)checkedNativeMediaVersion(n.params.nativeMediaVersion);
    ids.add(n.id);
  }
  for(const e of p.edges) if(!safeId(e.id)||!ids.has(e.source)||!ids.has(e.target)||e.source===e.target) throw new Error('连接指向不存在的节点或自身');
  for(const a of p.assets) if(!safeId(a.id)||typeof a.name!=='string'||typeof a.type!=='string') throw new Error('素材数据无效');
  for(const n of p.nodes) promptAssetIds(p,n);
  for(const n of p.nodes) if(n.assetId&&!p.assets.some(a=>a.id===n.assetId))throw new Error('节点引用的素材不存在');
  for(const n of p.nodes){validateNativeNode(n,p);validateNativeMediaMap(n,p);}
  for(const n of p.nodes){
    for(const ref of n.params?.nativeCanvas?.inputOrder||[]){
      if(ref.itemType!==undefined&&!['generated','group-media','group-prompts'].includes(ref.itemType)||ref.itemType==='generated'&&(!Number.isSafeInteger(ref.itemIndex)||ref.itemIndex<0||ref.itemIndex>999||typeof ref.itemUrl!=='string'||!ref.itemUrl||ref.itemUrl.length>12000000)||ref.itemType==='group-media'&&(typeof ref.memberId!=='string'||!safeId(ref.memberId)))throw Error('原生素材条目次序无效');
      if(ref.itemUrl!==undefined){if(typeof ref.itemUrl!=='string'||ref.itemUrl.length>12000000)throw Error('原生素材条目地址无效');validateNativeUrls(ref.itemUrl);}
    }
    for(const binding of [n.params?.workflowBinding,n.params?.cloudBinding])if(binding?.randomFields!==undefined)normalizeRandomSelection(binding.randomFields);
    if(n.params?.cloudBinding?.overrides!==undefined)normalizeCloudOverrides(n.params.cloudBinding.overrides);
    for(const field of n.params?.workflowBinding?.imageSources||[])if(field.sourceIndex!==undefined&&(!safeId(field.sourceNodeId)||!Number.isSafeInteger(field.sourceIndex)||field.sourceIndex<0||field.sourceIndex>999))throw Error('素材序号须为0–999的整数，且只能用于上游节点映射');
  }
  for(const n of p.nodes)for(const id of minimaxAssetIds(minimaxTimelineOf(n)))if(!p.assets.some(a=>a.id===id))throw Error('H3 时间轴引用的素材或结果不存在');
  const loras=new Set(p.assets.filter(a=>a.type==='application/x-safetensors').map(a=>a.id));if(p.nodes.some(n=>loras.has(n.assetId))||p.shots.some(s=>loras.has(s.assetId)||loras.has(s.audioId)))throw Error('LoRA 模型文件应在云工作流字段中选用，不能作为画面或音频素材');
  for(const n of p.nodes)for(const r of ltxReferences(n.params?.workflowBinding?.ltxDirector)){if(r.assetId&&!p.assets.some(a=>a.id===r.assetId))throw Error('LTX 时间线引用的素材不存在');}
  const visiting=new Set(),visited=new Set();
  function visit(id){if(visiting.has(id)) throw new Error('工作流不能形成循环依赖');if(visited.has(id))return;visiting.add(id);for(const e of p.edges.filter(e=>e.source===id))visit(e.target);visiting.delete(id);visited.add(id);}
  for(const id of ids) visit(id);
  for(const s of p.shots) {if(!safeId(s.id)||!Number.isFinite(s.duration)||s.duration<=0||s.duration>600||typeof s.description!=='string') throw new Error('分镜时长须大于 0 且不超过 600 秒');if(s.assetId&&!p.assets.some(a=>a.id===s.assetId))throw new Error('分镜引用的素材不存在');if(s.audioId&&!p.assets.some(a=>a.id===s.audioId))throw new Error('分镜声音素材不存在');}
  if(p.settings?.nativeMediaVersion!==undefined)checkedNativeMediaVersion(p.settings.nativeMediaVersion);
  if (!p.settings || !['16:9','9:16','1:1','4:3'].includes(p.settings.ratio) || ![24,25,30,60].includes(p.settings.fps)) throw new Error('项目画幅或帧率无效');
  if(!p.viewport || !Number.isFinite(p.viewport.x)||!Number.isFinite(p.viewport.y)||!Number.isFinite(p.viewport.zoom)||p.viewport.zoom<.15||p.viewport.zoom>3) throw new Error('画布视图参数无效');
  validateGroups(p);
  validateEditing(p);
  return p;
}
export function executionOrder(p) {
  validateProject(p);
  const result=[],seen=new Set();
  function walk(id){if(seen.has(id))return;for(const edge of p.edges.filter(e=>e.target===id))walk(edge.source);seen.add(id);result.push(id);}
  p.nodes.forEach(n=>walk(n.id));return result;
}
