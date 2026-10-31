import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

test('Chrome素材导入仅接受扩展来源并保存图片与支持的视频到本机全局素材库',async t=>{
  const data=await fs.mkdtemp(path.join(os.tmpdir(),'jingchang-chrome-import-'));
  const reservation=http.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const child=spawn(process.execPath,['server.mjs'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),JINGCHANG_DATA_DIR:data,JINGCHANG_LLM_URL:'',JINGCHANG_LLM_MODEL:''},stdio:['ignore','pipe','pipe']});
  t.after(async()=>{child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));await fs.rm(data,{recursive:true,force:true});});
  await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw new Error('test server exited');}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('test server startup timeout')),30000).unref())]);
  const base='http://127.0.0.1:'+port,origin='chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  const health=await fetch(base+'/api/health',{headers:{Origin:origin}});assert.equal(health.status,200);assert.equal(health.headers.get('access-control-allow-origin'),origin);assert.equal((await health.json()).version,JSON.parse(await fs.readFile(path.join(process.cwd(),'package.json'),'utf8')).version);
  const preflight=await fetch(base+'/api/chrome-import',{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type','Access-Control-Request-Private-Network':'true'}});assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-methods'),'POST, OPTIONS');assert.equal(preflight.headers.get('access-control-allow-private-network'),'true');
  const bytes=Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
  const imported=await fetch(base+'/api/chrome-import?name='+encodeURIComponent('网页角色.png')+'&category='+encodeURIComponent('角色'),{method:'POST',headers:{Origin:origin,'Content-Type':'image/png'},body:bytes});assert.equal(imported.status,201);const asset=await imported.json();assert.equal(asset.name,'网页角色.png');assert.equal(asset.category,'角色');assert.equal(asset.source,'chrome-extension');assert.equal(asset.size,bytes.length);
  const flvBytes=Buffer.from([0x46,0x4c,0x56,0x01,0x05,0x00,0x00,0x00,0x09]);
  const flvResponse=await fetch(base+'/api/chrome-import?name='+encodeURIComponent('旧样片.flv'),{method:'POST',headers:{Origin:origin,'Content-Type':'video/x-flv'},body:flvBytes});assert.equal(flvResponse.status,201);const flvAsset=await flvResponse.json();assert.equal(flvAsset.name,'旧样片.flv');assert.equal(flvAsset.type,'video/x-flv');assert.equal(flvAsset.size,flvBytes.length);
  const listed=await (await fetch(base+'/api/assets')).json();assert.equal(listed.length,2);assert.deepEqual(new Set(listed.map(item=>item.id)),new Set([asset.id,flvAsset.id]));
  const deniedWeb=await fetch(base+'/api/chrome-import',{method:'POST',headers:{Origin:'https://example.com','Content-Type':'image/png'},body:bytes});assert.equal(deniedWeb.status,403);
  const deniedNoOrigin=await fetch(base+'/api/chrome-import',{method:'POST',headers:{'Content-Type':'image/png'},body:bytes});assert.equal(deniedNoOrigin.status,403);
  const deniedType=await fetch(base+'/api/chrome-import',{method:'POST',headers:{Origin:origin,'Content-Type':'image/svg+xml'},body:'<svg/>'});assert.equal(deniedType.status,415);
  assert.equal((await (await fetch(base+'/api/assets')).json()).length,2);
});

test('Chrome采集扩展以按需网页权限和本机服务权限声明最小必要权限',async()=>{
  const manifest=JSON.parse(await fs.readFile(path.join(process.cwd(),'tools/chrome-local-asset-importer/manifest.json'),'utf8'));
  assert.equal(manifest.manifest_version,3);
  assert.ok(manifest.permissions.includes('activeTab'));
  assert.ok(manifest.permissions.includes('scripting'));
  assert.equal(manifest.background.service_worker,'background.js');
  assert.equal(manifest.background.type,'module');
  assert.ok(manifest.host_permissions.every(pattern=>pattern.includes('127.0.0.1')||pattern.includes('localhost')));
  assert.ok(manifest.optional_host_permissions.includes('https://*/*'));
  assert.ok(!manifest.permissions.includes('webRequest'));
  assert.ok(manifest.optional_permissions.includes('webRequest'));
});
