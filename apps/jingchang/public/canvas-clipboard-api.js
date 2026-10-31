export async function applyCanvasClipboard(api,projectId,body){
 try{return await api('/api/projects/'+encodeURIComponent(projectId)+'/clipboard-pastes',{method:'POST',body:JSON.stringify(body)});}
 catch(error){for(let i=0;i<8;i++){let found;try{found=await api('/api/projects/'+encodeURIComponent(projectId)+'/clipboard-pastes/'+encodeURIComponent(body.requestId));}catch{throw error;}if(found.status==='completed')return {...found,recovered:true};if(found.error)throw error;if(i<7)await new Promise(r=>setTimeout(r,250));}throw Object.assign(Error('粘贴尚未确认，请读取或继续原记录，不要新建重复请求'),{requestId:body.requestId});}
}
