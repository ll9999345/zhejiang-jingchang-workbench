const number=(value,fallback,min,max,label)=>{const n=value??fallback;if(typeof n!=='number'||!Number.isFinite(n)||n<min||n>max)throw Error(label+'超出允许范围');return n;};
const choice=(value,fallback,allowed,label)=>{const v=value??fallback;if(!allowed.includes(v))throw Error(label+'无效');return v;};
const safeId=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(id);
export function normalizeSubtitleCues(cues,duration){
 if(cues==null)return null;
 if(!Array.isArray(cues)||cues.length>500)throw Error('每镜最多500段细分字幕');
 let previous=-1,total=0;
 return cues.map(c=>{if(!c||typeof c!=='object'||typeof c.text!=='string'||!c.text.trim()||c.text.length>4000)throw Error('细分字幕文字须为1–4000字');const start=number(c.start,0,0,duration,'字幕开始时间'),end=number(c.end,null,start+.001,duration,'字幕结束时间');if(start<previous)throw Error('细分字幕请按开始时间排列');previous=start;total+=c.text.length;if(total>100000)throw Error('每镜细分字幕文字超过容量');return{start,end,text:c.text};});
}
export const subtitleStamp=s=>{const ms=Math.round(s*1000);return[String(Math.floor(ms/3600000)).padStart(2,'0'),String(Math.floor(ms/60000)%60).padStart(2,'0'),String(Math.floor(ms/1000)%60).padStart(2,'0')].join(':')+','+String(ms%1000).padStart(3,'0');};
export function subtitleCuesSrt(cues=[]){return cues.map((c,i)=>`${i+1}\n${subtitleStamp(c.start)} --> ${subtitleStamp(c.end)}\n${c.text}\n`).join('\n');}
export function parseSubtitleSrt(text,duration){
 if(typeof text!=='string'||text.length>250000)throw Error('细分字幕文本超过容量');
 if(!text.trim())return[];
 const time=s=>{const match=/^(\d{2,}):([0-5]\d):([0-5]\d)[,.](\d{3})$/.exec(s);if(!match)throw Error('字幕时间格式须为 00:00:01,500');return +match[1]*3600+ +match[2]*60+ +match[3]+ +match[4]/1000;};
 const cues=text.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').trim().split(/\n\s*\n/).map(block=>{const lines=block.split('\n');if(/^\d+$/.test(lines[0].trim()))lines.shift();const match=/^(\S+)\s+-->\s+(\S+)$/.exec(lines.shift()?.trim()||'');if(!match)throw Error('字幕须包含开始时间 --> 结束时间和正文');return{start:time(match[1]),end:time(match[2]),text:lines.join('\n')};});
 return normalizeSubtitleCues(cues,duration);
}
export function normalizeShotEdit(shot){
 const e=shot.edit??{};if(!e||typeof e!=='object'||Array.isArray(e))throw Error('镜头剪辑参数无效');
 const duration=number(shot.duration,5,.001,600,'镜头时长'),sourceStart=number(e.sourceStart,0,0,86400,'画面入点'),sourceEnd=e.sourceEnd==null?null:number(e.sourceEnd,null,sourceStart+.001,86400,'画面出点');
 return{sourceStart,sourceEnd,endMode:choice(e.endMode,'loop',['loop','hold','strict'],'片段不足处理'),fit:choice(e.fit,'contain',['contain','cover'],'画面适配'),sourceAudio:choice(e.sourceAudio,'auto',['auto','keep','mute'],'原声模式'),sourceVolume:number(e.sourceVolume,1,0,2,'原声音量'),voiceStart:number(e.voiceStart,0,0,86400,'配音入点'),voiceOffset:number(e.voiceOffset,0,0,duration,'配音延迟'),voiceVolume:number(e.voiceVolume,1,0,2,'配音音量'),fadeIn:number(e.fadeIn,0,0,duration,'声音淡入'),fadeOut:number(e.fadeOut,0,0,duration,'声音淡出'),subtitleCues:normalizeSubtitleCues(e.subtitleCues,duration)};
}
export function normalizeEditSettings(settings={}){
 const e=settings.edit??{};if(!e||typeof e!=='object'||Array.isArray(e))throw Error('剪辑设置无效');const sub=e.subtitle??{};
 const color=sub.color??'#ffffff',outlineColor=sub.outlineColor??'#000000';if([color,outlineColor].some(c=>typeof c!=='string'||!/^#[0-9a-fA-F]{6}$/.test(c)))throw Error('字幕颜色无效');
 const font=sub.font??'';if(typeof font!=='string'||font.length>80||!/^[\p{L}\p{N} _.-]*$/u.test(font))throw Error('字幕字体名称无效');
 const transition=e.transition??{};if(!transition||typeof transition!=='object'||Array.isArray(transition))throw Error('转场设置无效');
 if(e.duckMusic!==undefined&&typeof e.duckMusic!=='boolean')throw Error('自动压低配乐设置无效');
 if(!Array.isArray(e.music??[])||(e.music??[]).length>16)throw Error('最多添加16条背景音频片段');const ids=new Set();const music=(e.music??[]).map(t=>{if(!t||!safeId(t.id)||ids.has(t.id)||!safeId(t.assetId))throw Error('背景音频编号或素材无效');ids.add(t.id);const duration=number(t.duration,10,.01,86400,'背景音频时长');return{id:t.id,assetId:t.assetId,start:number(t.start,0,0,86400,'背景音频位置'),sourceStart:number(t.sourceStart,0,0,86400,'背景音频入点'),duration,volume:number(t.volume,.2,0,2,'背景音量'),fadeIn:number(t.fadeIn,0,0,duration,'背景音淡入'),fadeOut:number(t.fadeOut,0,0,duration,'背景音淡出'),loop:t.loop===true};});
 return{burnSubtitles:e.burnSubtitles===true,duckMusic:e.duckMusic===true,transition:{mode:choice(transition.mode,'cut',['cut','fade','crossfade'],'转场'),seconds:number(transition.seconds,.4,0,2,'转场时长')},subtitle:{font,fontSize:number(sub.fontSize,32,8,240,'字幕字号'),color,outlineColor,outline:number(sub.outline,2,0,24,'字幕描边'),position:choice(sub.position,'bottom',['bottom','center','top'],'字幕位置'),bottom:number(sub.bottom,36,0,1024,'字幕边距'),backgroundOpacity:number(sub.backgroundOpacity,.45,0,1,'字幕背景透明度')},music};
}
export function validateEditing(project){
 for(const shot of project.shots){normalizeShotEdit(shot);if(shot.dialogue!==undefined&&(typeof shot.dialogue!=='string'||shot.dialogue.length>4000))throw Error('每个镜头字幕最多4000字');}
 if(project.shots.reduce((n,s)=>n+(s.edit?.subtitleCues?.length??(s.dialogue?.trim()?1:0)),0)>2000)throw Error('一次导出最多2000段字幕');
 const edit=normalizeEditSettings(project.settings);for(const track of edit.music)if(!project.assets.some(a=>a.id===track.assetId&&a.type.startsWith('audio/')))throw Error('背景音频素材不属于当前项目');return edit;
}
export function shotTimings(project){let cursor=0;return project.shots.map(shot=>{const frames=Math.max(1,Math.round(shot.duration*project.settings.fps)),duration=frames/project.settings.fps,start=cursor;cursor+=duration;return{shot,frames,start,duration,end:cursor,edit:normalizeShotEdit(shot)};});}
export const filmDuration=project=>shotTimings(project).at(-1)?.end||0;
export function editingCaptions(project){return shotTimings(project).flatMap(t=>{const cues=t.edit.subtitleCues??(t.shot.dialogue?.trim()?[{start:0,end:t.duration,text:t.shot.dialogue}]:[]);return cues.map(c=>({...c,start:t.start+Math.min(c.start,t.duration),end:t.start+Math.min(c.end,t.duration)})).filter(c=>c.end>c.start);});}
export function editingSrt(project){return subtitleCuesSrt(editingCaptions(project));}
// Older readers would silently fall back to shot dialogue/cuts/fixed music.
// A new backup format makes that loss explicit instead of accepting the file.
export function usesAdvancedEditing(project){const e=project.settings?.edit,s=e?.subtitle;return project.shots?.some(t=>t.edit?.subtitleCues!=null)||e?.duckMusic===true||!!(e?.transition?.mode&&e.transition.mode!=='cut')||!!(s&&(s.font||s.position&&s.position!=='bottom'||s.outlineColor&&s.outlineColor.toLowerCase()!=='#000000'||s.fontSize<12||s.fontSize>96||s.outline>8||s.bottom>240));}
