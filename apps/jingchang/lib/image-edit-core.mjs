const MAX_PIXELS=16777216,MAX_WORK=120000000;
const integer=(n,min,max,label)=>{if(!Number.isSafeInteger(n)||n<min||n>max)throw Error(`${label}超出允许范围`);return n;};
const number=(n,min,max,label)=>{if(typeof n!=='number'||!Number.isFinite(n)||n<min||n>max)throw Error(`${label}超出允许范围`);return n;};
export function editSize(width,height){integer(width,1,8192,'宽度');integer(height,1,8192,'高度');if(width*height>MAX_PIXELS)throw Error('画布最多1677万像素');return{width,height};}
export function normalizeEdits(width,height,operations){
 editSize(width,height);if(!Array.isArray(operations)||operations.length>500)throw Error('最多保存500步编辑');let cost=0,points=0;
 const ops=operations.map(op=>{if(!op||typeof op!=='object')throw Error('编辑步骤无效');
  if(op.type==='expand'){const next={type:op.type};for(const k of ['left','top','right','bottom'])next[k]=integer(op[k]??0,0,4096,'扩展边距');if(!next.left&&!next.top&&!next.right&&!next.bottom)throw Error('请填写至少一个扩展边距');width+=next.left+next.right;height+=next.top+next.bottom;editSize(width,height);cost+=width*height;return next;}
  if(['mask-clear','mask-all','mask-invert'].includes(op.type)){cost+=width*height;return{type:op.type};}
  if(op.type==='mask-rect'){const x=integer(op.x,0,width-1,'选区X'),y=integer(op.y,0,height-1,'选区Y'),w=integer(op.width,1,width-x,'选区宽度'),h=integer(op.height,1,height-y,'选区高度');cost+=w*h;return{type:op.type,x,y,width:w,height:h};}
  if(!['paint','erase','mask','unmask'].includes(op.type))throw Error('不支持的编辑工具');
  const size=number(op.size,1,512,'笔刷大小'),opacity=number(op.opacity??1,0.01,1,'不透明度'),hardness=number(op.hardness??1,0,1,'硬度');
  if(!Array.isArray(op.points)||op.points.length<1||op.points.length>5000)throw Error('笔画坐标无效');points+=op.points.length;if(points>20000)throw Error('笔画点过多，请先保存后继续');
  const coordinates=op.points.map(p=>{if(!Array.isArray(p)||p.length!==2)throw Error('笔画坐标无效');return[number(p[0],0,width,'笔画X'),number(p[1],0,height,'笔画Y')];});
  let stamps=1;for(let i=1;i<coordinates.length;i++)stamps+=Math.ceil(Math.hypot(coordinates[i][0]-coordinates[i-1][0],coordinates[i][1]-coordinates[i-1][1])/Math.max(1,size/4));cost+=stamps*(size+2)**2;
  if(op.type==='paint'&&(typeof op.color!=='string'||!/^#[a-f\d]{6}$/i.test(op.color)))throw Error('画笔颜色无效');return{type:op.type,size,opacity,hardness,points:coordinates,...(op.type==='paint'?{color:op.color}:{})};
 });if(cost>MAX_WORK)throw Error('本次编辑过于复杂，请保存当前结果后分段编辑');return{operations:ops,width,height};
}
export function createEditState(width,height,rgba){editSize(width,height);if(rgba.length!==width*height*4)throw Error('原图像素不完整');const mask=new Uint8ClampedArray(width*height);for(let i=0;i<mask.length;i++)mask[i]=255-rgba[i*4+3];return{width,height,base:rgba,paint:new Uint8ClampedArray(rgba.length),mask};}
export function applyEdit(s,op){
 if(op.type==='expand'){const w=s.width+op.left+op.right,h=s.height+op.top+op.bottom,base=new Uint8ClampedArray(w*h*4),paint=new Uint8ClampedArray(w*h*4),mask=new Uint8ClampedArray(w*h).fill(255);
  for(let y=0;y<s.height;y++){const at=(y+op.top)*w+op.left,from=y*s.width;base.set(s.base.subarray(from*4,(from+s.width)*4),at*4);paint.set(s.paint.subarray(from*4,(from+s.width)*4),at*4);mask.set(s.mask.subarray(from,from+s.width),at);}Object.assign(s,{width:w,height:h,base,paint,mask});return;
 }
 if(op.type==='mask-clear'){s.mask.fill(0);return;}if(op.type==='mask-all'){s.mask.fill(255);return;}if(op.type==='mask-invert'){for(let i=0;i<s.mask.length;i++)s.mask[i]=255-s.mask[i];return;}
 if(op.type==='mask-rect'){for(let y=op.y;y<op.y+op.height;y++)s.mask.fill(255,y*s.width+op.x,y*s.width+op.x+op.width);return;}
 const radius=op.size/2,inner=radius*op.hardness,color=op.color?.slice(1).match(/../g).map(n=>parseInt(n,16));
 const stamp=(cx,cy)=>{for(let y=Math.max(0,Math.floor(cy-radius));y<Math.min(s.height,Math.ceil(cy+radius));y++)for(let x=Math.max(0,Math.floor(cx-radius));x<Math.min(s.width,Math.ceil(cx+radius));x++){
  const d=Math.hypot(x+.5-cx,y+.5-cy);if(d>radius)continue;const a=op.opacity*(d<=inner||inner===radius?1:(radius-d)/(radius-inner)),i=y*s.width+x,j=i*4;
  if(op.type==='mask'||op.type==='unmask')s.mask[i]=s.mask[i]*(1-a)+(op.type==='mask'?255:0)*a;
  else if(op.type==='erase')s.paint[j+3]*=1-a;
  else{const before=s.paint[j+3]/255,after=a+before*(1-a);for(let k=0;k<3;k++)s.paint[j+k]=(color[k]*a+s.paint[j+k]*before*(1-a))/after;s.paint[j+3]=after*255;}
 }};
 stamp(...op.points[0]);for(let i=1;i<op.points.length;i++){const [x,y]=op.points[i-1],[tx,ty]=op.points[i],n=Math.ceil(Math.hypot(tx-x,ty-y)/Math.max(1,op.size/4));for(let step=1;step<=n;step++)stamp(x+(tx-x)*step/n,y+(ty-y)*step/n);}
}
export function editPixels(s,mode='image'){
 const out=new Uint8ClampedArray(s.width*s.height*4);
 for(let i=0;i<s.mask.length;i++){const j=i*4;if(mode==='mask'){out[j]=out[j+1]=out[j+2]=s.mask[i];out[j+3]=255;continue;}
  const pa=s.paint[j+3]/255,ba=s.base[j+3]/255,alpha=pa+ba*(1-pa);for(let k=0;k<3;k++)out[j+k]=alpha?(s.paint[j+k]*pa+s.base[j+k]*ba*(1-pa))/alpha:s.base[j+k];out[j+3]=alpha*255;
  if(mode==='input')out[j+3]=Math.min(out[j+3],255-s.mask[i]);
  if(mode==='preview'&&s.mask[i]){const a=s.mask[i]/255*.45;out[j]=out[j]*(1-a)+255*a;out[j+1]*=1-a;out[j+2]*=1-a;out[j+3]=Math.max(out[j+3],s.mask[i]*.45);}
 }return out;
}
export function replayEdits(width,height,rgba,operations){const valid=normalizeEdits(width,height,operations),state=createEditState(width,height,rgba);for(const op of valid.operations)applyEdit(state,op);return state;}
