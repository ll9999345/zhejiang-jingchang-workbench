import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {localServer} from './helpers/library-backup-server.mjs';

// Link the served ESM graph without evaluating it: missing module routes and
// missing named exports must fail before any DOM or generation code can run.
const linkServedGraph = String.raw`
import {SourceTextModule} from 'node:vm';
const entry=new URL('/app.js',process.argv[2]).href,origin=new URL(entry).origin;
const modules=new Map(),pending=[entry];
while(pending.length){
 const url=pending.shift();if(modules.has(url))continue;
 if(new URL(url).origin!==origin)throw Error('Static browser import left the owned loopback origin');
 const response=await fetch(url);
 if(!response.ok)throw Error(new URL(url).pathname+' returned '+response.status);
 if(!/^(text|application)\/javascript(?:;|$)/.test(response.headers.get('content-type')||''))throw Error(new URL(url).pathname+' is not served as JavaScript');
 const module=new SourceTextModule(await response.text(),{identifier:url});
 modules.set(url,module);
 for(const specifier of module.dependencySpecifiers){
  if(!specifier.startsWith('/')&&!specifier.startsWith('./')&&!specifier.startsWith('../'))throw Error('Unsupported browser import '+specifier);
  pending.push(new URL(specifier,url).href);
 }
}
await modules.get(entry).link((specifier,parent)=>modules.get(new URL(specifier,parent.identifier).href));
console.log(JSON.stringify({status:modules.get(entry).status,modules:modules.size,paths:[...modules.keys()].map(url=>new URL(url).pathname)}));
`;

function inspectGraph(base){
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--experimental-vm-modules','--input-type=module','-',base],{cwd:process.cwd(),stdio:['pipe','pipe','pipe']});
  let output='',error='';child.stdout.on('data',bytes=>output+=bytes);child.stderr.on('data',bytes=>error+=bytes);
  child.on('error',reject);child.on('close',code=>{if(code!==0)return reject(Error(error.trim()||'ESM linker exited '+code));try{resolve(JSON.parse(output));}catch(e){reject(e);}});
  child.stdin.end(linkServedGraph);
 });
}

test('浏览器公共模块别名与画布 ESM 闭包在隔离本机服务可加载',async t=>{
 const stage=process.env.CANVAS_MODULE_ROUTE_EVIDENCE||await fs.mkdtemp(path.join(os.tmpdir(),'jc-canvas-module-route-'));
 const data=path.join(stage,'isolated-data');await fs.mkdir(data,{recursive:true});
 const app=await localServer(data);t.after(app.stop);
 await t.test('ModelScope 公共别名返回 JavaScript 且与根路径一致',async()=>{
  const alias=await fetch(app.base+'/public/native-modelscope-core.js'),direct=await fetch(app.base+'/native-modelscope-core.js');
  assert.equal(alias.status,200);assert.equal(direct.status,200);
  assert.match(alias.headers.get('content-type'),/^text\/javascript(?:;|$)/);
  assert.equal(await alias.text(),await direct.text());
 });
 await t.test('app.js 的全部静态依赖和具名导出只链接，不运行页面代码',async()=>{
  const graph=await inspectGraph(app.base);
  assert.equal(graph.status,'linked');assert.ok(graph.modules>50);
  assert.ok(graph.paths.includes('/canvas-tools.mjs'));
  for(const name of ['native-copy-core.js','native-media-scope-core.js','native-media-map-core.js','native-execution-dependencies.js'])assert.ok(graph.paths.includes('/'+name),'Missing public-root copy dependency '+name);
  assert.ok(graph.paths.includes('/public/native-modelscope-core.js'));
  assert.ok(graph.paths.includes('/native-modelscope-core.js'));
  await fs.writeFile(path.join(stage,'esm-link-result.json'),JSON.stringify({...graph,evaluated:false,paidCalls:0,thirdPartyRequests:0},null,2));
 });
});
