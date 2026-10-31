import path from 'node:path';
const locks=new Map();
export async function withPromptWriteLock(data,id,operation){const key=path.resolve(data)+':'+id,task=(locks.get(key)||Promise.resolve()).catch(()=>{}).then(operation);locks.set(key,task);try{return await task;}finally{if(locks.get(key)===task)locks.delete(key);}}
