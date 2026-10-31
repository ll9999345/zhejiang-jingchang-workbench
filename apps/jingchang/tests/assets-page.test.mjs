import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

test('素材分页接口按全局/项目范围筛选与切片，并保留旧列表接口',async t=>{
  const data=await fs.mkdtemp(path.join(os.tmpdir(),'jingchang-assets-page-'));
  const reservation=http.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(r=>reservation.close(r));
  const child=spawn(process.execPath,['server.mjs'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),JINGCHANG_DATA_DIR:data,JINGCHANG_LLM_URL:'',JINGCHANG_LLM_MODEL:''},stdio:['ignore','pipe','pipe']});
  t.after(async()=>{child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));await fs.rm(data,{recursive:true,force:true});});
  await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw new Error('test server exited');}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('test server startup timeout')),30000).unref())]);
  const base='http://127.0.0.1:'+port;
  async function request(route,method='GET',body){const response=await fetch(base+route,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});let result;try{result=await response.json();}catch{result=await response.text();}return{status:response.status,body:result};}
  const project=(await request('/api/projects','POST',{name:'分页接口验收'})).body;
  async function upload(name,type,bytes=Buffer.from('local')){const response=await fetch(base+'/api/assets?name='+encodeURIComponent(name),{method:'POST',headers:{'content-type':type},body:bytes});if(response.status!==201)throw new Error(await response.text());return response.json();}
  const assets=[
    await upload('主角.png','image/png'),
    await upload('山景.png','image/png'),
    await upload('剧本.txt','text/plain'),
    await upload('样片.mp4','video/mp4')
  ];
  await request('/api/assets/'+assets[0].id,'PATCH',{name:assets[0].name,category:'角色',tags:['主角']});
  await request('/api/assets/'+assets[1].id,'PATCH',{name:assets[1].name,category:'场景',tags:['山景']});
  await request('/api/assets/'+assets[2].id,'PATCH',{name:assets[2].name,category:'文本',tags:['剧本']});
  project.assets=[assets[0],assets[2]];
  assert.equal((await request('/api/projects/'+project.id,'PUT',project)).status,200);

  const pageOne=await request('/api/assets/page?scope=global&offset=0&limit=2');
  assert.equal(pageOne.status,200);assert.equal(pageOne.body.total,4);assert.equal(pageOne.body.sourceTotal,4);assert.equal(pageOne.body.items.length,2);assert.equal(pageOne.body.limit,2);assert.ok(pageOne.body.categories.includes('角色'));
  const pageTwo=await request('/api/assets/page?scope=global&offset=2&limit=2');
  assert.equal(pageTwo.body.items.length,2);assert.equal(new Set([...pageOne.body.items,...pageTwo.body.items].map(a=>a.id)).size,4);
  const imageFilter=await request('/api/assets/page?scope=global&type=image&category=%E8%A7%92%E8%89%B2&search=%E4%B8%BB%E8%A7%92&limit=48');
  assert.equal(imageFilter.status,200);assert.equal(imageFilter.body.total,1);assert.equal(imageFilter.body.items[0].id,assets[0].id);
  const textFilter=await request('/api/assets/page?scope=global&type=text');
  assert.equal(textFilter.body.total,1);assert.equal(textFilter.body.items[0].id,assets[2].id);
  const projectPage=await request('/api/assets/page?scope=project&projectId='+project.id+'&limit=48');
  assert.equal(projectPage.status,200);assert.equal(projectPage.body.sourceTotal,2);assert.deepEqual(new Set(projectPage.body.items.map(a=>a.id)),new Set([assets[0].id,assets[2].id]));
  assert.equal((await request('/api/assets')).body.length,4);
  for(const query of ['/api/assets/page?offset=-1','/api/assets/page?limit=101','/api/assets/page?type=unknown','/api/assets/page?scope=project','/api/assets/page?scope=global&search='+encodeURIComponent('x'.repeat(201))])assert.equal((await request(query)).status,400,query);
  assert.equal((await request('/api/assets/page?scope=project&projectId=missing')).status,404);
});
