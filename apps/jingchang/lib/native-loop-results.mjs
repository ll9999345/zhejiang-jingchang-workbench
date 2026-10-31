// Completion order is deliberately separate from the saved plan order.
export function sortNativeLoopResults(job){
 if(!job.steps?.some(step=>step.nativeLoop))return job;
 const key=value=>JSON.stringify([value.sourceNodeId??value.nodeId,value.loopId??null,value.roundIndex??null]);
 const order=new Map(job.steps.map((step,index)=>[key(step),index]));
 for(const records of [job.assets,job.textResults])records?.sort((a,b)=>(order.get(key(a))??Infinity)-(order.get(key(b))??Infinity));
 return job;
}
