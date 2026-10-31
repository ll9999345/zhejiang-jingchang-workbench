import {cameraProjection} from './camera-angle-core.js';
export function drawCameraPreview(canvas,img,angle){
 const w=canvas.width,h=canvas.height,c=canvas.getContext('2d');
 c.clearRect(0,0,w,h);c.fillStyle='#111c2a';c.fillRect(0,0,w,h);
 const point=p=>cameraProjection(p,angle,w,h);
 c.strokeStyle='#30445a';c.lineWidth=1;
 for(let i=-6;i<=6;i++)for(const line of [[[i,-1.2,-6],[i,-1.2,6]],[[-6,-1.2,i],[6,-1.2,i]]]){
  const [a,b]=line.map(point);if(!a||!b)continue;c.beginPath();c.moveTo(a.x,a.y);c.lineTo(b.x,b.y);c.stroke();
 }
 if(img?.naturalWidth){
  const aspect=img.naturalWidth/img.naturalHeight,pw=2*Math.min(aspect,1.7),ph=pw/aspect,cols=18,rows=12;
  function vertex(i,j){return {s:[i/cols*img.naturalWidth,j/rows*img.naturalHeight],d:point([(i/cols-.5)*pw,(.5-j/rows)*ph,0])};}
  function triangle(v){
   if(v.some(p=>!p.d))return;
   const [u,vv,t]=v.map(p=>p.s),[a,b,d]=v.map(p=>p.d),den=(vv[0]-u[0])*(t[1]-u[1])-(vv[1]-u[1])*(t[0]-u[0]);
   const m0=((b.x-a.x)*(t[1]-u[1])-(d.x-a.x)*(vv[1]-u[1]))/den;
   const m1=((b.y-a.y)*(t[1]-u[1])-(d.y-a.y)*(vv[1]-u[1]))/den;
   const m2=((d.x-a.x)*(vv[0]-u[0])-(b.x-a.x)*(t[0]-u[0]))/den;
   const m3=((d.y-a.y)*(vv[0]-u[0])-(b.y-a.y)*(t[0]-u[0]))/den;
   // Overlap neighboring clips slightly to avoid anti-aliased cracks in the texture.
   const center={x:(a.x+b.x+d.x)/3,y:(a.y+b.y+d.y)/3},expanded=[a,b,d].map(p=>{const dx=p.x-center.x,dy=p.y-center.y,len=Math.hypot(dx,dy)||1;return{x:p.x+dx/len*.7,y:p.y+dy/len*.7};});
   c.save();c.beginPath();expanded.forEach((p,i)=>i?c.lineTo(p.x,p.y):c.moveTo(p.x,p.y));c.closePath();c.clip();
   c.setTransform(m0,m1,m2,m3,a.x-m0*u[0]-m2*u[1],a.y-m1*u[0]-m3*u[1]);c.drawImage(img,0,0);c.restore();
  }
  for(let y=0;y<rows;y++)for(let x=0;x<cols;x++){const a=vertex(x,y),b=vertex(x+1,y),d=vertex(x,y+1),e=vertex(x+1,y+1);triangle([a,b,d]);triangle([b,e,d]);}
 }
 c.fillStyle='#c9dcf1';c.font='14px system-ui';c.fillText(`水平 ${angle.rotation}°  ·  俯仰 ${angle.pitch}°  ·  距离 ${angle.distance}`,18,h-20);
 canvas.dataset.rendered=JSON.stringify(angle);
}
