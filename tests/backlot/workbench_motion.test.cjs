const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const motion=require('../../backlot/ui/workbench-interactions.js');
test('independent edge springs carry exact position and velocity when interrupted',()=>{
 let left={x:0,v:0,target:100,time:0,omega:27},right={x:100,v:0,target:200,time:0,omega:35};
 for(const time of [15,40,71,100,120]){for(const state of [left,right]){const sample=motion.springAt(state,time),next=motion.retarget(state,-50,time,30),continued=motion.springAt(next,time);assert(Math.abs(continued.x-sample.x)<1e-9);assert(Math.abs(continued.v-sample.v)<1e-9)}}
 assert(motion.springAt(right,70).x-100>motion.springAt(left,70).x,'leading edge travels ahead');
});
test('tab spring has restrained overshoot and settles without a second visible bounce',()=>{const s={x:0,v:0,target:100,time:0,omega:30};let max=0;for(let t=0;t<1000;t++)max=Math.max(max,motion.springAt(s,t).x);assert(max>100&&max<101.3);assert(Math.abs(motion.springAt(s,600).x-100)<.01)});
test('all legacy controls remain unique and unrenamed in the four panels',()=>{const html=fs.readFileSync(path.join(__dirname,'../../backlot/ui/model.html'),'utf8');for(const id of ['mediaSegments','mediaTranscriptPath','mediaTranscriptAlignment','mediaAudioProvider','mediaAudioRate','mediaRenderAudio','mediaRenderSubtitles','mediaTranscribe','mediaClips','mediaSubtitlePath'])assert.equal((html.match(new RegExp(`id="${id}"`,'g'))||[]).length,1,id);for(const group of ['copy','video','audio','subtitle'])assert(html.includes(`data-settings-tab="${group}"`));assert(!html.includes('data-testid="fake'))});
