import {promises as fs} from 'node:fs';
import {userError} from './workspace.mjs';
let renderer;
async function canvasLibrary(){if(!renderer){try{renderer=await import('@napi-rs/canvas');}catch{throw userError('字幕绘制组件未安装，请在项目目录安装依赖后再导出字幕');}}return renderer;}
export async function subtitleFont(text='中文',requested=''){
 const {GlobalFonts}=await canvasLibrary(),available=GlobalFonts.families.map(f=>f.family);if(requested&&!available.includes(requested))throw userError('字幕字体未安装：'+requested+'。请在声音与字幕设置中换用系统自动字体。');
 const font=requested||['PingFang SC','Microsoft YaHei','Noto Sans CJK SC','Noto Sans SC','WenQuanYi Micro Hei','Arial Unicode MS','Heiti SC','Arial'].find(f=>available.includes(f));
 if(!font||font==='Arial'&&/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text))throw userError('没有找到可用的字幕字体，请安装支持当前文字的系统字体后再导出');return font;
}
export async function subtitleImage(text,width,height,style,file){
 const {createCanvas}=await canvasLibrary(),font=await subtitleFont(text,style.font);
 const canvas=createCanvas(width,height),ctx=canvas.getContext('2d'),maxWidth=width*.88,pad=12,segments=s=>[...new Intl.Segmenter('zh',{granularity:'grapheme'}).segment(s)].map(x=>x.segment);let size=style.fontSize,lines;
 if(!text.trim()){await fs.writeFile(file,await canvas.encode('png'),{flag:'wx'});return{font,fontSize:size,lines:[]};}
 const wrap=()=>{ctx.font=`${size}px "${font}"`;const out=[];for(const paragraph of text.split(/\r?\n/)){let line='';for(const ch of segments(paragraph)){if(line&&ctx.measureText(line+ch).width>maxWidth){out.push(line);line='';}line+=ch;}out.push(line);}return out;};
 while(true){lines=wrap();if(lines.length*size*1.45+pad*2<=height*.45)break;if(size<=8)throw userError('当前字幕太长，请拆分字幕或减少文字');size=Math.max(8,size-2);}
 const lineHeight=size*1.45,boxHeight=lines.length*lineHeight+pad*2,position=style.position||'bottom',y=position==='center'?(height-boxHeight)/2:position==='top'?style.bottom:height-style.bottom-boxHeight;if(y<0||y+boxHeight>height)throw userError('字幕边距与字号超出画面');const boxWidth=Math.min(width,Math.max(...lines.map(line=>ctx.measureText(line).width))+pad*2);
 ctx.fillStyle=`rgba(0,0,0,${style.backgroundOpacity})`;ctx.fillRect((width-boxWidth)/2,y,boxWidth,boxHeight);ctx.textAlign='center';ctx.textBaseline='middle';ctx.lineJoin='round';ctx.strokeStyle=style.outlineColor||'#000000';ctx.lineWidth=style.outline*2;ctx.fillStyle=style.color;
 lines.forEach((line,i)=>{const top=y+pad+lineHeight*(i+.5);if(style.outline)ctx.strokeText(line,width/2,top);ctx.fillText(line,width/2,top);});await fs.writeFile(file,await canvas.encode('png'),{flag:'wx'});return{font,fontSize:size,lines};
}
