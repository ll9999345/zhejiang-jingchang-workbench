import {safeId,userError} from './workspace.mjs';
export function assertCanvasParent(activeJobs,parentId,projectId){const parent=activeJobs.get(parentId);if(!safeId(parentId)||!parent||parent.kind!=='canvas-run'||parent.projectId!==projectId||parent.controller.signal.aborted)throw userError('子任务缺少正在执行的所属画布任务');return parent;}
export function conflictingCanvasChild(activeJobs,projectId,parentId,kind){
 if(parentId)assertCanvasParent(activeJobs,parentId,projectId);
 return[...activeJobs.entries()].some(([id,job])=>job.projectId===projectId&&id!==parentId&&(parentId?job.parentId!==parentId:(!kind||job.kind===kind)));
}
export function linkCanvasChild(activeJobs,parentId,controller){
 const signal=activeJobs.get(parentId)?.controller.signal;if(!signal)return()=>{};
 const abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});if(signal.aborted)controller.abort();return()=>signal.removeEventListener('abort',abort);
}
