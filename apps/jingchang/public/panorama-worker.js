import {projectPanorama} from '/panorama-core.mjs';
let source;
self.onmessage=e=>{try{if(e.data.type==='source'){source=e.data;return;}if(!source)throw Error('全景图尚未加载');const pixels=projectPanorama(source.pixels,source.width,source.height,e.data.options);self.postMessage({id:e.data.id,options:e.data.options,pixels},[pixels.buffer]);}catch(error){self.postMessage({id:e.data.id,error:error.message});}};
