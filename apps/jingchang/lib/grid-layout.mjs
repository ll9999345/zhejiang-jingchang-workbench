// Shared integer geometry for browser previews and server rendering.
const integer=(v,min,max,label)=>{if(!Number.isSafeInteger(v)||v<min||v>max)throw new Error(`${label}须为 ${min}–${max} 的整数`);return v;};
export function splitGridLayout({width,height,rows=3,columns=3,margin=0,gap=0}) {
  integer(width,1,8192,'原图宽度');integer(height,1,8192,'原图高度');integer(rows,1,8,'行数');integer(columns,1,8,'列数');integer(margin,0,4096,'边距');integer(gap,0,4096,'格间距');
  const w=width-2*margin-(columns-1)*gap,h=height-2*margin-(rows-1)*gap;
  if(w<columns||h<rows)throw new Error('边距或间距过大，每格至少需要一个像素');
  return Array.from({length:rows*columns},(_,index)=>{const row=Math.floor(index/columns),column=index%columns,x=margin+Math.floor(column*w/columns)+column*gap,y=margin+Math.floor(row*h/rows)+row*gap;return{index,row,column,x,y,width:Math.floor((column+1)*w/columns)-Math.floor(column*w/columns),height:Math.floor((row+1)*h/rows)-Math.floor(row*h/rows)};});
}
export function composeGridLayout({count,columns=3,tileWidth=512,tileHeight=512,margin=0,gap=0,fit='contain',background='#00000000'}) {
  integer(count,1,64,'图片数量');integer(columns,1,8,'列数');integer(tileWidth,1,4096,'每格宽度');integer(tileHeight,1,4096,'每格高度');integer(margin,0,4096,'边距');integer(gap,0,4096,'格间距');
  if(!['contain','cover','stretch'].includes(fit))throw new Error('请选择留边、裁满或拉伸模式');
  if(typeof background!=='string'||!/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(background))throw new Error('背景颜色须为六位RGB或八位RGBA十六进制颜色');
  const rows=Math.ceil(count/columns),width=columns*tileWidth+(columns-1)*gap+2*margin,height=rows*tileHeight+(rows-1)*gap+2*margin;
  if(rows>8||width>8192||height>8192||width*height>16_777_216)throw new Error('拼图最多8行、单边8192像素、总计1677万像素，请减小尺寸');
  return{width,height,rows,columns,tileWidth,tileHeight,margin,gap,fit,background,tiles:Array.from({length:count},(_,index)=>({index,x:margin+(index%columns)*(tileWidth+gap),y:margin+Math.floor(index/columns)*(tileHeight+gap)}))};
}
