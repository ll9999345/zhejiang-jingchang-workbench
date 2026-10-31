import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeJimengRequest as normalize,jimengArguments as args,JIMENG_COMMANDS} from '../public/jimeng-cli-core.js';
const ref=(assetId,role='image')=>({assetId,role}),files={fileForAsset:id=>'/isolated/'+id+'.png'};
test('all eight pinned generation paths compile fixed argument vectors, never shell commands',()=>{
 const cases=[
  ['text2image',{},['--model_version=5.0','--resolution_type=2k','--ratio=16:9','--generate_num=1']],
  ['image2image',{references:[ref('a'),ref('b')]},['--images=/isolated/a.png,/isolated/b.png']],
  ['image_upscale',{references:[ref('a')],resolution:'8k'},['--image=/isolated/a.png','--resolution_type=8k']],
  ['text2video',{},['--model_version=seedance2.0','--duration=5','--video_resolution=720p']],
  ['image2video',{references:[ref('a')],model:'seedance1.0fast'},['--image=/isolated/a.png','--model_version=seedance1.0fast']],
  ['frames2video',{references:[ref('b','last'),ref('a','first')]},['--first=/isolated/a.png','--last=/isolated/b.png']],
  ['multiframe2video',{references:[ref('b','frame'),ref('a','frame'),ref('c','frame')],duration:4,prompt:'第一段\n第二段'},['--images=/isolated/b.png,/isolated/a.png,/isolated/c.png','--transition-prompt=第一段','--transition-prompt=第二段','--transition-duration=4']],
  ['multimodal2video',{references:[ref('a'),ref('v','video'),ref('s','audio')]},['--image=/isolated/a.png','--video=/isolated/v.png','--audio=/isolated/s.png']]
 ];
 assert.deepEqual(cases.map(c=>c[0]),JIMENG_COMMANDS);for(const [command,settings,expected]of cases){const input={command,prompt:command==='image_upscale'?'':'湖边漫步',...settings},out=args(input,{...files,downloadDirectory:'/isolated/out'});assert.equal(out[0],command);for(const a of expected)assert.ok(out.includes(a),command+':'+a);assert.ok(out.includes('--poll=0'));assert.ok(!out.some(a=>a.startsWith('--download_dir=')),'download_dir belongs only to query_result');assert.deepEqual(normalize(normalize(input)),normalize(input));if(command==='multiframe2video'){assert.ok(!out.some(a=>a.startsWith('--model_version')));assert.ok(!out.some(a=>a.startsWith('--prompt=')));}}
});
test('image model matrix, batch count, ratio and resolution are explicit rather than silently changed',()=>{
 assert.equal(normalize({command:'text2image',prompt:'x',model:'3.1',resolution:'1k',ratio:'2:3',generateNum:10}).generateNum,10);
 for(const model of ['4.0','4.1','4.5','4.6','4.7','5.0'])assert.throws(()=>normalize({command:'text2image',prompt:'x',model,resolution:'1k'}));
 assert.equal(normalize({command:'image2image',model:'5.0Pro',resolution:'1k',references:[ref('a')]}).resolution,'1k');
 assert.throws(()=>normalize({command:'image2image',model:'3.1',references:[ref('a')]}));assert.throws(()=>normalize({command:'text2image',prompt:'x',generateNum:11}));
 assert.throws(()=>normalize({command:'image_upscale',references:[ref('a')],generateNum:2}));
});
test('video command/model/time/resolution distinctions preserve the pinned baseline',()=>{
 for(const model of ['seedance1.0fast','seedance1.5pro'])assert.throws(()=>normalize({command:'text2video',prompt:'x',model}));
 assert.equal(normalize({command:'image2video',prompt:'x',references:[ref('a')],model:'seedance1.0fast',duration:10}).duration,10);
 assert.throws(()=>normalize({command:'image2video',prompt:'x',references:[ref('a')],model:'seedance1.0fast',duration:11}));
 assert.throws(()=>normalize({command:'frames2video',prompt:'x',references:[ref('a','first'),ref('b','last')],model:'seedance1.5pro',duration:4}));
 assert.equal(normalize({command:'text2video',prompt:'x',model:'seedance2.0_vip',resolution:'4k',duration:15}).resolution,'4k');
 assert.throws(()=>normalize({command:'text2video',prompt:'x',model:'seedance2.0fast_vip',resolution:'1080p'}));
 assert.throws(()=>normalize({command:'text2video',prompt:'x',ratio:'3:2'}));
});
test('reference roles, order, capacity and required media are validated before any execution',()=>{
 for(const command of JIMENG_COMMANDS)if(!['text2image','text2video'].includes(command))assert.throws(()=>normalize({command,prompt:'x'}));
 assert.throws(()=>normalize({command:'text2image',prompt:'x',references:[ref('a')]}));
 assert.throws(()=>normalize({command:'frames2video',prompt:'x',references:[ref('a','first'),ref('b','first')]}));
 assert.throws(()=>normalize({command:'multimodal2video',prompt:'x',references:[ref('s','audio')]}));
 assert.throws(()=>normalize({command:'multimodal2video',prompt:'x',references:Array.from({length:10},(_,i)=>ref('a'+i))}));
 assert.throws(()=>normalize({command:'multimodal2video',prompt:'x',references:[ref('a'),...Array.from({length:4},(_,i)=>ref('s'+i,'audio'))]}));
 assert.throws(()=>normalize({command:'image2image',references:[ref('a'),ref('a')]}));
 assert.throws(()=>normalize({command:'image2image',references:[{...ref('a'),path:'/private/file'}]}));
 const out=args({command:'multiframe2video',duration:3,references:[ref('a','frame'),ref('b','frame'),ref('c','frame')],prompt:'重复运镜'},files);assert.equal(out.filter(x=>x==='--transition-prompt=重复运镜').length,2);
});
test('prompts remain one opaque argument and arbitrary command/flag/path injection is rejected',()=>{
 const text='$(touch /tmp/no) `whoami` ; --session=private\n中文';const out=args({command:'text2image',prompt:text});assert.ok(out.includes('--prompt='+text));assert.equal(out.filter(x=>x.startsWith('--prompt=')).length,1);
 for(const command of ['login','logout','list_task','query_result','sh','text2image;whoami'])assert.throws(()=>normalize({command,prompt:'x'}));
 assert.throws(()=>normalize({command:'text2image',prompt:'x',extra_args:['--session=x']}));assert.throws(()=>args({command:'image2image',references:[ref('a')]},{fileForAsset:()=>'/tmp/a,b.png'}));
});
test('download directory is query-only; new Pro resolution is additive while old record values remain normalized',()=>{
 const old=normalize({command:'text2image',prompt:'old',model:'5.0Pro',resolution:'1k'});assert.deepEqual(normalize(old),old);assert.equal(normalize({command:'text2image',prompt:'new',model:'5.0Pro',resolution:'1.5k'}).resolution,'1.5k');assert.ok(!args(old,{downloadDirectory:'/not-a-generation-flag'}).some(x=>x.startsWith('--download_dir')));
 assert.throws(()=>normalize({command:'multiframe2video',duration:1,references:[ref('a','frame'),ref('b','frame')]}),/总时长/);assert.equal(normalize({command:'multiframe2video',duration:1,references:[ref('a','frame'),ref('b','frame'),ref('c','frame')]}).duration,1);
});
