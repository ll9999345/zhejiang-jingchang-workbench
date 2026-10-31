import path from 'node:path';
const changes=new Map();
// Coordinate metadata edits inside one server. Model requests stay outside the
// lock; only a short read/merge/write section is serialized per actual asset.
export async function withAssetMetadataLock(data,assetId,operation){
 const key=path.resolve(data)+':'+assetId,previous=changes.get(key)||Promise.resolve(),next=previous.catch(()=>{}).then(operation);changes.set(key,next);
 try{return await next;}finally{if(changes.get(key)===next)changes.delete(key);}
}
