export function scanPage(){
  const items=[],seen=new Set();
  const MAX_CANVAS_PIXELS=16_000_000,MAX_CANVAS_DATA_URI_CHARS=28*1024*1024;
  const frameOrigins=[...new Set([...document.querySelectorAll('iframe[src]')].flatMap(frame=>{try{const url=new URL(frame.getAttribute('src'),location.href);return ['http:','https:'].includes(url.protocol)&&url.origin!==location.origin?[url.origin+'/*']:[];}catch{return []}}))].slice(0,12);
  const fileName=value=>{try{return decodeURIComponent(new URL(value,location.href).pathname.split('/').filter(Boolean).at(-1)||'');}catch{return '';}};
  const add=(raw,kind,element,label='')=>{
    if(!raw||items.length>=500)return;
    let url;try{url=new URL(raw,location.href).href;}catch{return;}
    if(!['http:','https:','data:','blob:'].includes(new URL(url).protocol))return;
    const key=kind+'\n'+url;if(seen.has(key))return;seen.add(key);
    const parsed=new URL(url),streamType=/\.mpd$/i.test(parsed.pathname)?'DASH':/\.m3u8$/i.test(parsed.pathname)?'HLS':'',stream=!!streamType,svg=kind==='image'&&(/\.svg$/i.test(parsed.pathname)||/^data:image\/svg\+xml/i.test(url));
    const unsupported=stream||svg||kind==='video'&&!/\.(mp4|webm|mov|m4v|flv)$/i.test(parsed.pathname)&&!/^blob:|^data:/i.test(url);
    const name=label||element?.getAttribute('alt')||element?.getAttribute('title')||fileName(url)||`${kind==='video'?'网页视频':'网页图片'}-${items.length+1}`;
    const item={url,kind,frameUrl:location.href,name:name.slice(0,180),width:element?.naturalWidth||element?.videoWidth||(typeof element?.width==='number'?element.width:0),height:element?.naturalHeight||element?.videoHeight||(typeof element?.height==='number'?element.height:0),unsupported:!!unsupported,stream:!!stream,streamType,svg:!!svg};items.push(item);return item;
  };
  for(const image of document.querySelectorAll('img'))add(image.currentSrc||image.src,'image',image);
  for(const image of document.querySelectorAll('svg image')){
    const href=image.getAttribute('href')||image.getAttribute('xlink:href')||image.getAttributeNS('http://www.w3.org/1999/xlink','href');
    if(href)add(href,'image',image,image.getAttribute('aria-label')||image.getAttribute('title')||'SVG 内嵌图片');
  }
  for(const video of document.querySelectorAll('video')){
    const src=video.currentSrc||video.src;if(src)add(src,'video',video);
    for(const source of video.querySelectorAll('source'))add(source.src,'video',source,source.getAttribute('label')||'');
  }
  for(const source of document.querySelectorAll('video source'))add(source.src,'video',source);
  let canvasIndex=0;
  for(const canvas of document.querySelectorAll('canvas')){
    if(!canvas.width||!canvas.height||canvas.width*canvas.height>MAX_CANVAS_PIXELS)continue;
    try{
      const url=canvas.toDataURL('image/png');if(!url.startsWith('data:image/png')||url.length>MAX_CANVAS_DATA_URI_CHARS)continue;
      const name=canvas.getAttribute('aria-label')||canvas.getAttribute('title')||`网页画布-${++canvasIndex}`;
      const item=add(url,'image',canvas,name);if(item)item.source='canvas';
    }catch{/* A tainted canvas cannot be exported; the visible-page capture remains available. */}
  }
  for(const element of document.querySelectorAll('[style*="background"]')){
    const style=getComputedStyle(element).backgroundImage;
    for(const match of style.matchAll(/url\(["']?(.*?)['"]?\)/g))add(match[1],'image',element,element.getAttribute('aria-label')||element.getAttribute('title')||'背景图片');
  }
  return {title:document.title||location.hostname,items,frameOrigins};
}
