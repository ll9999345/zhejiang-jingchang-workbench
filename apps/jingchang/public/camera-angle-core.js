export const cameraAngleDefaults=Object.freeze({rotation:0,pitch:0,distance:4});
export const cameraAngleLimits=Object.freeze({rotation:[-90,90],pitch:[-90,90],distance:[.1,8]});
export function normalizeCameraAngle(value={}){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('机位设置无效');
 const result={};
 for(const [key,[min,max]] of Object.entries(cameraAngleLimits)){
  const n=value[key]??cameraAngleDefaults[key];
  if(typeof n!=='number'||!Number.isFinite(n)||n<min||n>max)throw Error(`机位 ${key} 须在 ${min}–${max} 之间`);
  result[key]=Math.round(n*1000)/1000;
 }
 return result;
}
export function cameraInstruction(value){
 const a=normalizeCameraAngle(value),parts=['根据参考图改变观察机位，保留主体身份、外观和场景关系。'];
 parts.push(a.rotation===0?'水平正面观察。':`绕主体向${a.rotation>0?'右':'左'}旋转 ${Math.abs(a.rotation)} 度。`);
 parts.push(a.pitch===0?'保持平视。':`从${a.pitch>0?'上方俯视':'下方仰视'} ${Math.abs(a.pitch)} 度。`);
 parts.push(a.distance===4?'保持原有取景距离。':`将相对拍摄距离调为原来的 ${Number((a.distance/4).toFixed(3))} 倍，${a.distance<4?'靠近主体，收紧景别':'远离主体，扩大取景范围'}。`);
 return parts.join('\n');
}
export function cameraNodeText(node){
 const text=String(node?.text||'').trim();
 return node?.params?.cameraAngle?[text,cameraInstruction(node.params.cameraAngle)].filter(Boolean).join('\n\n'):text;
}
// A perspective view of a flat reference plane; it does not invent hidden surfaces.
export function cameraProjection(point,angle,width,height){
 const a=normalizeCameraAngle(angle),yaw=a.rotation*Math.PI/180,pitch=a.pitch*Math.PI/180;
 const sy=Math.sin(yaw),cy=Math.cos(yaw),sp=Math.sin(pitch),cp=Math.cos(pitch),[x,y,z]=point;
 const depth=a.distance-(x*sy*cp+y*sp+z*cy*cp),f=height/(2*Math.tan(75*Math.PI/360));
 if(depth<=.05)return null;
 return{x:width/2+f*(x*cy-z*sy)/depth,y:height/2-f*(-x*sy*sp+y*cp-z*cy*sp)/depth,depth};
}
