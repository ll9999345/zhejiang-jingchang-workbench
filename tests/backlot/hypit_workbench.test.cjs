const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
const ctx=vm.createContext({window:{},URL});vm.runInContext(fs.readFileSync('backlot/ui/hypit.js','utf8'),ctx);const ui=ctx.window.ZhejiangHypit;
test('export URLs bind an installed version, current project and public export path',()=>{
 assert.equal(ui.mediaUrl('/model-api/hypit-v031','demo','exports/a b.mp4'),'/model-api/hypit-v031/projects/demo/files/exports/a%20b.mp4');
 for(const path of ['../private.mp4','exports/../private.mp4','exports/.private.mp4','/etc/private.mp4','exports//a.mp4','exports/a.html','hypit.runtime.json'])assert.throws(()=>ui.mediaUrl('/model-api/hypit-v031','demo',path));
 assert.throws(()=>ui.mediaUrl('https://external.example','demo','exports/a.mp4'));
 assert.throws(()=>ui.mediaUrl('/model-api/hypit','../other','exports/a.mp4'));
});
test('editor links accept local HTTP only, not arbitrary JS or credential URLs',()=>{
 assert.equal(ui.studioUrl('http://127.0.0.1:9844/'),'http://127.0.0.1:9844/');
 for(const raw of ['javascript:alert(1)','file:///etc/passwd','https://external.example','http://user:pass@127.0.0.1:9844','http://127.0.0.1.external.example/'])assert.equal(ui.studioUrl(raw),null);
});
test('plan summary requires coherent counts and never implies authorization',()=>{
 assert.match(ui.planText({requestCount:3,localRequestCount:3,providerRequestCount:0,ok:true,preflight:{ok:true}}),/本机处理 3 项/);
 assert.match(ui.planText({requestCount:3,localRequestCount:2,providerRequestCount:1,ok:true,preflight:{ok:true}}),/单独授权/);
 assert.match(ui.planText({requestCount:3,localRequestCount:2,providerRequestCount:0}),/信息不完整/);
});
