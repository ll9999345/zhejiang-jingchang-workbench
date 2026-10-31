// Only the embedding local workbench may request a save receipt. No project
// contents or credentials cross this channel.
export function installExchangeSaveGuard({win=window,getProject,save,isEditing}){
  if(win.parent===win)return()=>{};
  let parentOrigin;
  try{
    const referrer=new URL(win.document.referrer);
    if(referrer.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(referrer.hostname))return()=>{};
    parentOrigin=referrer.origin;
  }catch{return()=>{};}
  let pending=false;
  const receive=async event=>{
    const data=event.data;
    if(event.source!==win.parent||event.origin!==parentOrigin||!data||data.type!=='jingchang:prepare-exchange'||typeof data.requestId!=='string'||data.requestId.length>100||typeof data.projectId!=='string')return;
    const reply=result=>event.source.postMessage({type:'jingchang:exchange-ready',requestId:data.requestId,projectId:data.projectId,...result},parentOrigin);
    if(pending){reply({ok:false,error:'画布正在保存，请稍后再试。'});return;}
    pending=true;
    try{
      if(getProject()?.id!==data.projectId)throw Error('画布已切换作品，请重新打开当前作品的画布后再带入。');
      if(isEditing())throw Error('请先保存或关闭画布中的编辑窗口，再带入资料。');
      await save();
      if(getProject()?.id!==data.projectId)throw Error('画布已切换作品，未带入资料。');
      reply({ok:true});
    }catch(error){reply({ok:false,error:String(error.message||'画布尚未保存，未带入资料。').slice(0,500)});}
    finally{pending=false;}
  };
  win.addEventListener('message',receive);
  return()=>win.removeEventListener('message',receive);
}
