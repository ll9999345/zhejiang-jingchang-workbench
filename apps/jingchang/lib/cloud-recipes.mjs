import {rhId,rhBase,normalizeRhFields} from './runninghub.mjs';
import {rhModel,normalizeRhModelFields,RH_CATALOG_VERSION} from './runninghub-models.mjs';
import {userError,textValue,assertNoCredentials} from './workspace.mjs';
import {normalizeRhWorkflow,applyRhWorkflowFields} from './rh-workflow.mjs';
import {minimaxGraphContract} from '../public/minimax-h3-core.js';
import {importNativeRhFields} from './native-workflow-config.mjs';

export function normalizeCloudRecipe(r){
 if(!['app','workflow','model'].includes(r.kind))throw userError('请选择应用、工作流或标准模型');
 const model=r.kind==='model';if(model&&r.catalogVersion&&r.catalogVersion!==RH_CATALOG_VERSION)throw userError('模型目录版本已变化，请重新加载参数');
 if(r.nativeConfig!==undefined&&(model||r.fields!==undefined))throw userError('原生字段配置只用于普通云工作流，不能与fields同时提供');
 const targetId=model?rhModel(r.targetId).endpoint:r.targetId?rhId(r.targetId):'',fields=model?normalizeRhModelFields(targetId,r.fields||[]):r.nativeConfig!==undefined?importNativeRhFields(r.nativeConfig):normalizeRhFields(r.fields||[]);
 assertNoCredentials(fields);if(JSON.stringify(fields).length>200000)throw userError('工作流字段内容过大');
 let workflowJson;if(r.workflowJson!==undefined){if(r.kind!=='workflow')throw userError('API 整图仅用于 RunningHub 工作流');workflowJson=normalizeRhWorkflow(r.workflowJson);applyRhWorkflowFields(workflowJson,fields);}
 if(r.minimaxProfile!==undefined){if(r.minimaxProfile!=='h3'||!workflowJson)throw userError('H3 云工作流需要本机保存的 API 整图');try{minimaxGraphContract(workflowJson);}catch(e){throw userError(e.message);}}
 return {name:textValue(r.name,120,'配置名称'),kind:r.kind,targetId,baseUrl:rhBase(r.baseUrl),fields,...(workflowJson?{workflowJson}:{}),...(r.minimaxProfile?{minimaxProfile:r.minimaxProfile}:{}),...(model?{catalogVersion:RH_CATALOG_VERSION,outputType:rhModel(targetId).output_type}:{})};
}
