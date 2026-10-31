import {promises as fs} from 'node:fs';
import path from 'node:path';
import {GLB_MIME,GLB_LIMIT,inspectGlb} from '../public/glb-validation.js';
import {loadAsset,safeId,userError} from './workspace.mjs';
export {GLB_MIME,GLB_LIMIT};
export function validateGlb(bytes){try{return inspectGlb(bytes);}catch(e){throw userError(e.message);}}
export async function model3dInfo(data,id){
 if(!safeId(id))throw userError('三维素材编号无效');const a=await loadAsset(data,id);if(a.type!==GLB_MIME)throw userError('此素材不是 GLB 三维文件');
 const root=await fs.realpath(path.join(data,'assets')),file=path.join(root,id),st=await fs.lstat(file);if(!st.isFile()||st.size!==a.size||st.size>GLB_LIMIT||await fs.realpath(file)!==file)throw userError('三维素材文件缺失或已改变');
 return {...a,model3d:validateGlb(await fs.readFile(file))};
}
