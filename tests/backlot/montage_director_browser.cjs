// Entire transport is intercepted: no real import, model call or build occurs.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const ROOT=path.resolve(__dirname,'../..');
const OUT=process.env.WORKBENCH_QA_OUTPUT || path.join(os.tmpdir(),'zhejiang-hypit-director-ui');
const html='<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/ui/montage-studio.css"><style>body{max-width:900px;margin:20px;font:14px system-ui}label{display:block}input,select,textarea{box-sizing:border-box;max-width:100%}video{max-width:100%}[hidden]{display:none!important}</style></head><body><input id="mediaProjectId" value="alpha"><div id="montageTools"></div><script src="/ui/montage-studio.js"></script><script src="/ui/montage-tools.js"></script></body></html>';
async function fixture(browser,{available=true,directorConfig={},handleRequest=null,blockStorage=false}={}) {
  const p=await browser.newPage({viewport:{width:1000,height:1000}}),calls=[],errors=[];
  if(blockStorage)await p.addInitScript(()=>Object.defineProperty(window,'sessionStorage',{get(){throw new Error('storage blocked')}}));
  let sessions=[],imported=false;
  p.on('pageerror',e=>errors.push(e.message));
  await p.route('**/*',async route=>{
    const req=route.request(),u=new URL(req.url()),name=u.pathname;
    assert.equal(u.hostname,'montage.test','No external request is allowed in the UI test');
    if(name==='/model')return route.fulfill({contentType:'text/html',body:html});
    if(name.startsWith('/ui/'))return route.fulfill({body:fs.readFileSync(path.join(ROOT,'backlot',name)),contentType:name.endsWith('.js')?'application/javascript':'text/css'});
    const json=req.headers()['content-type']?.includes('application/json');
    calls.push({path:name,query:u.search,method:req.method(),body:json?req.postDataJSON():null});
    if(handleRequest && await handleRequest({route,req,u,name,calls}))return;
    if(name.startsWith('/model-api/montage/files/'))return route.fulfill({status:422,json:{detail:'只下载 OpenMontage 独立运行的产物'}});
    if(name.startsWith('/model-api/footage/assets/')){
      assert.equal(req.method(),'GET');
      assert(['assets/video/ref-a.mp4','assets/video/ref-b.mp4','assets/video/manual.mp4','analysis/reference_imports/imported.mp4'].includes(u.searchParams.get('path')));
      return route.fulfill({contentType:'video/mp4',body:''});
    }
    let data={};
    if(name.endsWith('/tools'))data={tools:[{name:'local_test',label:'本机测试工具',provider:'本机',capability:'test',group:'测试',status:'available',effects:{},dependencies:[],input_schema:{type:'object',properties:{text:{type:'string'}},required:[]}}]};
    else if(name.endsWith('/director/capabilities'))data={pipelines:[{id:'documentary-montage',label:'纪录片'}],providers:[{id:'ollama',label:'本机 Ollama',local:true,configured:true}],provider_default:'ollama',model_default:'',hypit:{available,status:available?'ready':'needs_setup',message:available?'本机可用':'Hypit 尚未配置，请配置本机运行时',execution_scope:'local_only',version:'test'},...directorConfig};
    else if(name.includes('/footage/context/'))data={assets:[{path:name.endsWith('/alpha')?'assets/video/ref-a.mp4':'assets/video/ref-b.mp4',kind:'video',label:'项目参考'}, {path:'assets/audio/voice.wav',kind:'audio'},...(imported&&name.endsWith('/alpha')?[{path:'analysis/reference_imports/imported.mp4',kind:'video'}]:[])]};
    else if(name.endsWith('/jobs'))data={jobs:[]};
    else if(name.endsWith('/director/sessions'))data={sessions};
    else if(name.endsWith('/director/preflight'))data={status:'needs_setup',can_execute:false,requirements:['请配置实际视觉模型'],would_write:false};
    else if(name.endsWith('/reference/upload')){imported=true;data={path:'analysis/reference_imports/imported.mp4',label:'本地参考.mp4',duration:3,has_video:true};}
    else if(name.endsWith('/director/start'))data={session_id:'session-ui',status:'queued'};
    else if(name.endsWith('/director/approve')){sessions=[];data={status:'queued'};}
    else if(name.endsWith('/director/cancel')){sessions=[];data={status:'cancelled'};}
    return route.fulfill({json:data});
  });
  await p.goto('http://montage.test/model');
  await p.getByLabel('制作方式',{exact:true}).selectOption('director');
  await p.waitForFunction(()=>document.querySelector('[aria-label="制作管线"]')?.options.length===1);
  await p.waitForFunction(()=>document.querySelector('#montageDirectorReference')?.options.length===2);
  return {p,calls,errors,setSessions:rows=>{sessions=rows}};
}
async function main(){
  fs.mkdirSync(OUT,{recursive:true});
  const browser=await chromium.launch({executablePath:process.env.CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--no-sandbox']});
  const passed=[];
  try {
    const f=await fixture(browser),p=f.p;
    const engine=p.locator('#montageDirectorEngine'),ref=p.locator('#montageDirectorReference'),refPath=p.locator('#montageDirectorReferencePath');
    const status=p.locator('.montage-message'),brief=p.getByLabel('创作需求与素材说明',{exact:true}),confirm=p.getByLabel('确认本次管线、需求与模型，开始独立导演任务',{exact:true});
    assert.equal(await engine.inputValue(),'openmontage');
    await engine.selectOption('hypit');
    assert.match(await p.locator('#montageDirectorHypitStatus').textContent(),/命令和依赖可用，工程仍需检查/);
    assert.equal(await p.locator('#montageDirectorReferenceFile').getAttribute('accept'),'.mp4,.mov,.m4v,.webm,.mkv,.ogv,.avi,.ts');
    assert.equal(await ref.inputValue(),'');assert.equal(await refPath.inputValue(),'');
    assert(await p.getByRole('button',{name:'检查导演条件',exact:true}).isEnabled());
    await p.getByRole('button',{name:'开始制作',exact:true}).click();
    assert.match(await status.textContent(),/填写想怎样改编视频/);
    assert.equal(f.calls.filter(c=>c.path.endsWith('/director/start')).length,0);
    passed.push('Hypit offers current project video without automatically choosing or starting');
    await brief.fill('保留节奏，改编为浙江旅行短片。');
    await ref.selectOption('assets/video/ref-a.mp4');
    assert.equal(await p.getByLabel('播放参考视频',{exact:true}).getAttribute('src'),'/model-api/footage/assets/alpha?path=assets%2Fvideo%2Fref-a.mp4');
    await p.getByRole('button',{name:'检查导演条件',exact:true}).click();
    await p.waitForFunction(()=>document.querySelector('.montage-message').textContent.includes('请配置实际视觉模型'));
    const check=f.calls.find(c=>c.path.endsWith('/director/preflight'));
    assert.equal(check.body.execution_engine,'hypit');assert.equal(check.body.reference_path,'assets/video/ref-a.mp4');assert.equal(check.body.project_id,'alpha');assert.equal(check.body.model,'');assert.equal(check.body.confirm,false);
    passed.push('preflight carries engine/reference/current project and accepts unconfigured model feedback');
    await p.getByLabel('模型名',{exact:true}).fill('vision-model');
    await confirm.check();await brief.fill('需求修改后必须重新确认。');assert(!(await confirm.isChecked()));
    assert(!(await p.locator('#montageDirectorReferenceAdvanced').evaluate(node=>node.open)));
    await p.getByText('手动填写视频路径',{exact:true}).click();
    await confirm.check();await refPath.fill('assets/video/manual.mp4');assert(!(await confirm.isChecked()));
    await confirm.check();await engine.selectOption('openmontage');assert(!(await confirm.isChecked()));
    await p.evaluate(()=>document.getElementById('montageTools').prepareMontageDirector({execution_engine:'hypit',reference_path:'assets/video/ref-a.mp4',pipeline:'documentary-montage'}));
    assert.equal(await p.getByLabel('制作方式',{exact:true}).inputValue(),'director');assert.equal(await engine.inputValue(),'hypit');assert.equal(await brief.inputValue(),'需求修改后必须重新确认。');assert(!(await confirm.isChecked()));
    assert.equal(f.calls.filter(c=>c.path.endsWith('/director/start')).length,0);
    passed.push('prepareMontageDirector switches wrapper to director, preserves brief and never executes');
    await p.locator('#mediaProjectId').fill('beta');await p.locator('#mediaProjectId').dispatchEvent('change');
    await p.waitForFunction(()=>document.querySelector('#montageDirectorReference')?.options[1]?.value==='assets/video/ref-b.mp4');
    assert.equal(await ref.inputValue(),'');assert.equal(await refPath.inputValue(),'');assert.equal(await brief.inputValue(),'需求修改后必须重新确认。');
    await ref.selectOption('assets/video/ref-b.mp4');await p.getByRole('button',{name:'检查导演条件',exact:true}).click();
    await p.waitForTimeout(40);const latest=f.calls.filter(c=>c.path.endsWith('/director/preflight')).at(-1);assert.equal(latest.body.project_id,'beta');assert.equal(latest.body.reference_path,'assets/video/ref-b.mp4');
    passed.push('project change clears old reference and sends only the newly chosen project video');
    await p.locator('#mediaProjectId').fill('alpha');await p.locator('#mediaProjectId').dispatchEvent('change');
    await p.locator('#montageDirectorReferenceFile').setInputFiles({name:'本地参考.mp4',mimeType:'video/mp4',buffer:Buffer.from('mock-video')});
    await p.getByRole('button',{name:'导入到当前项目',exact:true}).click();
    await p.waitForFunction(()=>document.querySelector('#montageDirectorReferencePath').value==='analysis/reference_imports/imported.mp4');
    assert.equal(await p.getByLabel('播放参考视频',{exact:true}).getAttribute('src'),'/model-api/footage/assets/alpha?path=analysis%2Freference_imports%2Fimported.mp4');
    const upload=f.calls.find(c=>c.path.endsWith('/reference/upload'));assert.match(upload.query,/project_id=alpha/);assert.equal(upload.method,'POST');
    assert.equal(f.calls.filter(c=>/\/(analyze|director\/start)$/.test(c.path)).length,0);
    assert.equal(f.calls.filter(c=>c.path.startsWith('/model-api/montage/files/')).length,0);
    passed.push('local reference import fills returned path without analysis or production; preview uses footage assets GET protocol');
    await confirm.check();await p.getByRole('button',{name:'开始制作',exact:true}).click();
    await p.waitForFunction(()=>document.querySelector('.montage-message').textContent.includes('导演任务已建立'));
    const start=f.calls.find(c=>c.path.endsWith('/director/start'));assert.equal(start.body.execution_engine,'hypit');assert.equal(start.body.reference_path,'analysis/reference_imports/imported.mp4');assert.equal(start.body.confirm,true);
    await engine.selectOption('openmontage');await p.getByRole('button',{name:'检查导演条件',exact:true}).click();await p.waitForTimeout(40);
    const normal=f.calls.filter(c=>c.path.endsWith('/director/preflight')).at(-1);assert.equal(normal.body.execution_engine,'openmontage');assert.equal(normal.body.reference_path,null);await engine.selectOption('hypit');
    passed.push('explicit approved start carries Hypit reference; OpenMontage payload excludes old reference');
    f.setSessions([{session_id:'hypit-session',project_id:'alpha',pipeline:'documentary-montage',status:'waiting_approval',created_at:'2026-10-02T10:00:00Z',provider:'ollama',model:'vision-model',budget_usd:1,hypit:{build_id:'build-real-id',status:'running',summary:'实际 Hypit 执行回执'},pending:{approval_id:'approval-one',message:'核对实际工程',action:{action:'hypit',arguments:{operation:'build'}},files:[{path:'reference.svml',sha256:'test-sha'}],plan:{steps:[{provider:'local',operation:'render'}]}}}]);
    await p.getByRole('button',{name:'刷新制作记录',exact:true}).click();
    await p.locator('[data-hypit-build="build-real-id"]').waitFor();
    const history=p.locator('.montage-history');assert.match(await history.textContent(),/Build ID: build-real-id/);assert.match(await history.textContent(),/执行状态：制作中/);assert.match(await history.textContent(),/reference\.svml/);assert.match(await history.textContent(),/实际执行计划/);assert.match(await history.textContent(),/local/);
    await p.getByRole('button',{name:'确认此步骤',exact:true}).click();assert.equal(f.calls.filter(c=>c.path.endsWith('/director/approve')).length,0);
    await p.getByRole('button',{name:'取消本次任务',exact:true}).click();await p.waitForTimeout(40);assert.equal(f.calls.filter(c=>c.path.endsWith('/director/cancel')).length,1);
    passed.push('history presents Build ID, status, exact pending files/plan and retains explicit approval/cancel');
    await p.setViewportSize({width:390,height:844});assert(!(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1)));
    await p.screenshot({path:path.join(OUT,'hypit-director-mobile.png'),fullPage:true});assert.deepEqual(f.errors,[]);await p.close();
    const blocked=await fixture(browser,{available:false});await blocked.p.locator('#montageDirectorEngine').selectOption('hypit');
    await blocked.p.getByLabel('创作需求与素材说明',{exact:true}).fill('参考视频改编。');await blocked.p.getByLabel('模型名',{exact:true}).fill('vision-model');await blocked.p.locator('#montageDirectorReference').selectOption('assets/video/ref-a.mp4');
    assert.match(await blocked.p.locator('#montageDirectorHypitStatus').textContent(),/Hypit 尚未配置/);assert(await blocked.p.getByRole('button',{name:'检查导演条件',exact:true}).isEnabled());
    await blocked.p.getByLabel('确认本次管线、需求与模型，开始独立导演任务',{exact:true}).check();await blocked.p.getByRole('button',{name:'开始制作',exact:true}).click();
    assert.match(await blocked.p.locator('.montage-message').textContent(),/Hypit 尚未配置/);assert.equal(blocked.calls.filter(c=>c.path.endsWith('/director/start')).length,0);
    await blocked.p.getByRole('button',{name:'检查导演条件',exact:true}).click();await blocked.p.waitForTimeout(40);assert.equal(blocked.calls.filter(c=>c.path.endsWith('/director/preflight')).length,1);assert.deepEqual(blocked.errors,[]);await blocked.p.close();
    passed.push('unavailable Hypit blocks start with actual reason while condition checking stays usable');
    const deepseek=await fixture(browser,{directorConfig:{provider_default:'deepseek',model_default:'deepseek-flash',reasoning_effort_default:'high',providers:[
      {id:'deepseek',label:'DeepSeek',configured:true,local:false,credential_source:'CC Switch · 只读测试配置',default_model:'deepseek-flash',models:[{id:'deepseek-flash',label:'DeepSeek V4.1 Flash',vision:true,max_output_tokens:8192,pricing:{input_per_million:.30,output_per_million:1.20}}]},
      {id:'openai',label:'OpenAI',configured:true,local:false,default_model:'openai-test-model',models:[]}
    ]}});
    const d=deepseek.p,service=d.locator('#montageDirectorProvider'),model=d.getByLabel('模型名',{exact:true}),input=d.getByLabel('输入单价（美元 / 百万令牌）',{exact:true}),output=d.getByLabel('输出单价（美元 / 百万令牌）',{exact:true}),thinking=d.locator('#montageDirectorThinking');
    await d.locator('#montageDirectorModelSettings').evaluate(node=>node.open=true);
    assert.equal(await service.inputValue(),'deepseek');assert.equal(await model.inputValue(),'deepseek-flash');
    assert.equal(await input.inputValue(),'0.3');assert.equal(await output.inputValue(),'1.2');assert.equal(await thinking.inputValue(),'high');
    assert.match(await d.locator('#montageDirectorModelSetup').textContent(),/支持画面理解/);
    assert.equal(deepseek.calls.filter(call=>call.method==='POST').length,0);
    passed.push('DeepSeek preset prefills model, conservative prices and thinking without submitting production');
    const remote=d.getByLabel('允许将本次创作文字与工具记录发给所选导演模型',{exact:true}),paid=d.getByLabel('允许在上述总预算内调用所选导演模型',{exact:true}),final=d.getByLabel('确认本次管线、需求与模型，开始独立导演任务',{exact:true});
    await input.fill('0.25');await output.fill('1.05');await thinking.selectOption('off');await remote.check();await paid.check();await final.check();
    await service.selectOption('openai');assert(!(await remote.isChecked()));assert(!(await paid.isChecked()));assert(!(await final.isChecked()));
    assert.equal(await model.inputValue(),'openai-test-model');assert(!(await thinking.isVisible()));
    await model.fill('chosen-openai-model');await input.fill('2.5');await output.fill('10');
    await service.selectOption('deepseek');assert.equal(await model.inputValue(),'deepseek-flash');assert.equal(await input.inputValue(),'0.25');assert.equal(await output.inputValue(),'1.05');assert.equal(await thinking.inputValue(),'off');
    await service.selectOption('openai');assert.equal(await model.inputValue(),'chosen-openai-model');assert.equal(await input.inputValue(),'2.5');assert.equal(await output.inputValue(),'10');await service.selectOption('deepseek');
    passed.push('switching providers preserves each draft and revokes old upload, billing and start consent');
    await d.getByLabel('创作需求与素材说明',{exact:true}).fill('只检查试用模型配置。');await d.getByRole('button',{name:'检查导演条件',exact:true}).click();
    await d.waitForFunction(()=>document.querySelector('.montage-message').textContent.includes('请配置实际视觉模型'));
    const deepcheck=deepseek.calls.find(call=>call.path.endsWith('/director/preflight'));
    assert.equal(deepcheck.body.provider,'deepseek');assert.equal(deepcheck.body.model,'deepseek-flash');assert.equal(deepcheck.body.reasoning_effort,'off');assert.equal(deepcheck.body.max_output_tokens,8192);
    assert.equal(deepcheck.body.allow_network,false);assert.equal(deepcheck.body.allow_paid,false);assert.equal(deepcheck.body.confirm,false);
    assert.equal(deepseek.calls.filter(call=>call.path.endsWith('/director/start')).length,0);
    await d.setViewportSize({width:390,height:844});assert(!(await d.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1)));
    assert.deepEqual(deepseek.errors,[]);await d.close();
    passed.push('DeepSeek preflight carries selected effort/token limit without production or inherited permissions');
    fs.writeFileSync(path.join(OUT,'director-browser-results.json'),JSON.stringify({passed,allApiMocked:true,realModelCalled:false,realBuildCalled:false},null,2));
    console.log(passed.join('\n'));
  } finally {await browser.close();}
}
module.exports={fixture};
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1});
