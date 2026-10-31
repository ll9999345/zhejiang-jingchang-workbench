import {userError} from './workspace.mjs';
// One service process shares this guard between account changes, submissions
// and the full lifetime of bounded-query sessions. It does not control external
// terminals or another independent server process.
export function jimengOperationGuard(){
 let readers=0,writer=false;
 function acquire({account=false}={}){
  if(writer||account&&readers)throw userError('即梦仍有生成、查询或账号操作进行中，请先停止并等待结束',409);
  if(account)writer=true;else readers++;let released=false;
  return()=>{if(released)return;released=true;if(account)writer=false;else readers--;};
 }
 return{acquire,status:()=>({readers,accountBusy:writer})};
}
