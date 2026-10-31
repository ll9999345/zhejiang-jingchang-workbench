export async function abortableRequest(req,res,operation){
 const controller=new AbortController(),abort=()=>controller.abort(new Error('本机请求已断开，已收到的文件保留')),close=()=>{if(!res.writableEnded)abort();};
 req.once('aborted',abort);res.once('close',close);
 try{
  if(req.aborted||res.destroyed)abort();
  controller.signal.throwIfAborted();
  return await operation(controller.signal);
 }finally{req.off('aborted',abort);res.off('close',close);}
}
