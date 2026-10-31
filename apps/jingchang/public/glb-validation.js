export const GLB_MIME='model/gltf-binary';
export const GLB_LIMIT=64*1024*1024;

// Accept a self-contained glTF 2 binary. External resources would change the
// sending/reading scope and are deliberately excluded from this local viewer.
export function inspectGlb(input){
 const bytes=input instanceof Uint8Array?input:new Uint8Array(input),bad=()=>{throw Error('三维文件不是受支持的自包含 GLB 2.0');};
 if(bytes.length<24||bytes.length>GLB_LIMIT)throw Error('GLB 三维文件须为24字节至64MB');
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 if(view.getUint32(0,true)!==0x46546c67||view.getUint32(4,true)!==2||view.getUint32(8,true)!==bytes.length)bad();
 let offset=12,json=null,binLength=0;
 while(offset<bytes.length){if(offset+8>bytes.length)bad();const size=view.getUint32(offset,true),type=view.getUint32(offset+4,true);offset+=8;if(!size||size%4||offset+size>bytes.length)bad();
  if(json===null){if(type!==0x4e4f534a||size>4*1024*1024)bad();try{json=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(offset,offset+size)));}catch{bad();}}
  else {if(type!==0x004e4942||binLength)bad();binLength=size;}
  offset+=size;
 }
 if(!json||json.asset?.version!=='2.0'||!binLength||!Array.isArray(json.buffers)||json.buffers.length!==1||json.buffers[0].uri!==undefined||!Number.isSafeInteger(json.buffers[0].byteLength)||json.buffers[0].byteLength<1||json.buffers[0].byteLength>binLength||binLength-json.buffers[0].byteLength>3)bad();
 let objects=0;function scan(value,depth=0){if(depth>40||++objects>200000)bad();if(!value||typeof value!=='object')return;for(const [key,x] of Object.entries(value)){if(['__proto__','constructor','prototype'].includes(key))bad();if(key==='uri'&&(typeof x!=='string'||!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(x)))throw Error('三维文件引用了外部资源，请使用自包含 GLB');scan(x,depth+1);}}scan(json);
 if(!Array.isArray(json.meshes)||!json.meshes.length||json.meshes.length>10000||!Array.isArray(json.accessors)||json.accessors.length>50000||!Array.isArray(json.bufferViews)||json.bufferViews.length>50000)bad();
 for(const b of json.bufferViews){if(b.buffer!==0||!Number.isSafeInteger(b.byteLength)||b.byteLength<1||!Number.isSafeInteger(b.byteOffset??0)||(b.byteOffset??0)<0||(b.byteOffset??0)+b.byteLength>json.buffers[0].byteLength)bad();}
 let primitives=0,vertices=0;for(const m of json.meshes){if(!Array.isArray(m.primitives)||!m.primitives.length)bad();for(const p of m.primitives){const a=json.accessors[p.attributes?.POSITION];if(!a||a.type!=='VEC3'||!Number.isSafeInteger(a.count)||a.count<1||a.count>5000000)bad();vertices+=a.count;primitives++;if(vertices>10000000||primitives>20000)throw Error('三维模型过大，暂不能在本机预览');}}
 return {format:'GLB 2.0',meshes:json.meshes.length,primitives,vertices,animations:Array.isArray(json.animations)?json.animations.length:0,size:bytes.length};
}

export const assetNodeType=a=>a.type===GLB_MIME?'scene':['image','video','audio'].includes(a.type?.split('/')[0])?a.type.split('/')[0]:'text';
