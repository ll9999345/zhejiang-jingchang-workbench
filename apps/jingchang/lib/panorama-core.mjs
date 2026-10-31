const num=(n,min,max,label)=>{if(typeof n!=='number'||!Number.isFinite(n)||n<min||n>max)throw Error(`${label}须在 ${min}–${max} 范围内`);return n;};
export function panoramaOptions({width=1280,height=720,yaw=0,pitch=0,roll=0,fov=90}={}){num(width,16,4096,'宽度');num(height,16,4096,'高度');if(!Number.isInteger(width)||!Number.isInteger(height)||width*height>8388608)throw Error('截图尺寸须为整数，最多838万像素');return{width,height,yaw:num(yaw,-180,180,'水平角度'),pitch:num(pitch,-90,90,'俯仰角度'),roll:num(roll,-180,180,'旋转角度'),fov:num(fov,20,120,'水平视野')};}
export function panoramaSource(width,height){if(!Number.isInteger(width)||!Number.isInteger(height)||width<8||height<4||width>8192||height>8192||width*height>16777216||Math.abs(width/height-2)>.02)throw Error('请选择宽高约为2:1的等距柱状全景图，最多1677万像素');}
export function projectPanorama(pixels,sourceWidth,sourceHeight,options){
 panoramaSource(sourceWidth,sourceHeight);const o=panoramaOptions(options);if(pixels.length!==sourceWidth*sourceHeight*4)throw Error('全景图像素不完整');const result=new Uint8ClampedArray(o.width*o.height*4),r=Math.PI/180,cy=Math.cos(o.yaw*r),sy=Math.sin(o.yaw*r),cp=Math.cos(o.pitch*r),sp=Math.sin(o.pitch*r),cr=Math.cos(o.roll*r),sr=Math.sin(o.roll*r),scale=Math.tan(o.fov*r/2),vertical=scale*o.height/o.width;
 for(let y=0;y<o.height;y++)for(let x=0;x<o.width;x++){
  const vx=(2*(x+.5)/o.width-1)*scale,vy=(1-2*(y+.5)/o.height)*vertical,rx=vx*cr-vy*sr,ry=vx*sr+vy*cr,py=ry*cp+sp,pz=cp-ry*sp,px=rx*cy+pz*sy,z=pz*cy-rx*sy;
  const u=(Math.atan2(px,z)/(2*Math.PI)+.5)*sourceWidth-.5,v=Math.max(0,Math.min(sourceHeight-1,(.5-Math.atan2(py,Math.hypot(px,z))/Math.PI)*sourceHeight-.5)),floorX=Math.floor(u),x0=((floorX%sourceWidth)+sourceWidth)%sourceWidth,x1=(x0+1)%sourceWidth,y0=Math.floor(v),y1=Math.min(sourceHeight-1,y0+1),fx=u-floorX,fy=v-y0;
  const indices=[(y0*sourceWidth+x0)*4,(y0*sourceWidth+x1)*4,(y1*sourceWidth+x0)*4,(y1*sourceWidth+x1)*4],weights=[(1-fx)*(1-fy),fx*(1-fy),(1-fx)*fy,fx*fy];let alpha=0,red=0,green=0,blue=0;
  for(let k=0;k<4;k++){const i=indices[k],a=weights[k]*pixels[i+3];alpha+=a;red+=pixels[i]*a;green+=pixels[i+1]*a;blue+=pixels[i+2]*a;}const at=(y*o.width+x)*4;if(alpha){result[at]=red/alpha;result[at+1]=green/alpha;result[at+2]=blue/alpha;}result[at+3]=alpha;
 }return result;
}
