// Protocol-only: every HTTP request is intercepted, with no real model/build.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {fixture}=require('./montage_director_browser.cjs');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const OUT=process.env.WORKBENCH_QA_OUTPUT || path.join(os.tmpdir(),'zhejiang-director-submission-ui');
const ready={status:'ready',can_execute:true,requirements:[],would_write:false,budget_usd:1,
  checks:[{id:'model',label:'导演模型',status:'ready',messages:['测试模型 · 本机目录已核对']},
    {id:'permissions',label:'数据传输与预算',status:'ready',messages:['本机模型；具体制作工具仍单独确认']},
    {id:'tools',label:'制作工具',status:'warning',messages:['测试工具须在步骤中核对']}],
  warnings:['仅检查条件；不代表成品已完成。'],message:'检查未调用模型、运行工具或新建制作文件。'};
const needs={status:'needs_setup',can_execute:false,would_write:false,requirements:['选择实际模型'],
  checks:[{id:'model',label:'导演模型',status:'needs_setup',messages:['选择实际模型']},
    {id:'tools',label:'制作工具',status:'not_checked',messages:['先补齐模型条件']}],warnings:[]};
async function fillRequest(p){
  await p.getByLabel('创作需求与素材说明',{exact:true}).fill('保留真实素材，制作浙江旅行短片。');
  await p.getByLabel('模型名',{exact:true}).fill('test-local-model');
  await p.getByLabel('确认本次管线、需求与模型，开始独立导演任务',{exact:true}).check();
}
async function main(){
  fs.mkdirSync(OUT,{recursive:true});const passed=[];
  const browser=await chromium.launch({executablePath:process.env.CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--no-sandbox']});
  try{
    let currentCheck=needs;
    const checks=await fixture(browser,{handleRequest:async({route,name})=>{
      if(!name.endsWith('/director/preflight'))return false;
      await route.fulfill({json:currentCheck});return true;
    }}),p=checks.p;
    await fillRequest(p);await p.getByRole('button',{name:'检查导演条件',exact:true}).click();
    await p.locator('#montageDirectorReadiness[data-state="needs_setup"]').waitFor();
    assert.match(await p.locator('#montageDirectorReadiness').textContent(),/尚未检查/);
    await p.getByRole('button',{name:'去设置',exact:true}).click();
    assert(await p.locator('#montageDirectorModelSettings').evaluate(node=>node.open));
    assert(await p.getByLabel('模型名',{exact:true}).evaluate(node=>document.activeElement===node));
    await p.getByLabel('创作需求与素材说明',{exact:true}).fill('修改后的需求。');
    await p.locator('#montageDirectorReadiness[data-state="stale"]').waitFor();
    assert.equal(await p.locator('#montageDirectorReadiness li').count(),0);
    currentCheck=ready;await p.getByRole('button',{name:'检查导演条件',exact:true}).click();
    await p.locator('#montageDirectorReadiness[data-state="ready"]').waitFor();
    assert.match(await p.locator('#montageDirectorReadiness').textContent(),/可开始导演规划/);
    assert.match(await p.locator('#montageDirectorReadiness').textContent(),/步骤中核对/);
    assert(!(await p.locator('#montageDirectorReadiness details').evaluate(node=>node.open)));
    assert.equal(checks.calls.filter(c=>c.path.endsWith('/director/start')).length,0);
    await p.setViewportSize({width:390,height:844});assert(!(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1)));
    await p.screenshot({path:path.join(OUT,'readiness-mobile.png'),fullPage:true});assert.deepEqual(checks.errors,[]);await p.close();
    passed.push('structured actionable checks, stale invalidation, deferred tool warning and compact mobile layout');

    let release,entered;const enteredCheck=new Promise(r=>entered=r);
    const stale=await fixture(browser,{handleRequest:async({route,name})=>{
      if(!name.endsWith('/director/preflight'))return false;
      entered();await new Promise(r=>release=r);await route.fulfill({json:ready});return true;
    }});
    await fillRequest(stale.p);await stale.p.getByRole('button',{name:'检查导演条件',exact:true}).click();await enteredCheck;
    await stale.p.getByLabel('创作需求与素材说明',{exact:true}).fill('检查期间又修改了需求。');release();
    await stale.p.waitForFunction(()=>document.querySelector('.montage-message').textContent.includes('检查期间参数已修改'));
    assert.equal(await stale.p.locator('#montageDirectorReadiness[data-state="ready"]').count(),0);
    assert(stale.calls.find(c=>c.path.endsWith('/director/preflight')).body.brief.includes('保留真实素材'));
    assert.deepEqual(stale.errors,[]);await stale.p.close();passed.push('late successful check cannot certify edited input');

    let failCheck=false;
    const offline=await fixture(browser,{handleRequest:async({route,name})=>{
      if(!name.endsWith('/director/preflight'))return false;
      if(failCheck)await route.abort('failed');else await route.fulfill({json:ready});return true;
    }});
    await fillRequest(offline.p);await offline.p.getByRole('button',{name:'检查导演条件',exact:true}).click();
    await offline.p.locator('#montageDirectorReadiness[data-state="ready"]').waitFor();
    failCheck=true;await offline.p.getByRole('button',{name:'检查导演条件',exact:true}).click();
    await offline.p.locator('#montageDirectorReadiness[data-state="check_failed"]').waitFor();
    assert.equal(await offline.p.locator('#montageDirectorReadiness li').count(),0);
    assert(offline.calls.filter(c=>c.path.endsWith('/director/preflight')).every(c=>c.body.confirm===false));
    assert.equal(offline.calls.filter(c=>c.path.endsWith('/director/start')).length,0);
    assert.deepEqual(offline.errors,[]);await offline.p.close();passed.push('failed condition recheck replaces old ready verdict without submitting production');

    for(const blockStorage of [false,true]){
      let original;
      const lost=await fixture(browser,{blockStorage,handleRequest:async({route,req,name})=>{
        if(name.endsWith('/director/start')){original=req.postDataJSON();await route.abort('failed');return true;}
        if(name.includes('/director/requests/')){assert(name.endsWith(original.client_request_id));await route.fulfill({json:{request_status:'accepted',session_id:'original-session',project_id:'alpha',status:'queued'}});return true;}
        return false;
      }});
      await fillRequest(lost.p);await lost.p.getByRole('button',{name:'开始制作',exact:true}).click();
      await lost.p.waitForFunction(()=>document.querySelector('#montageDirectorRecovery')?.textContent.includes('未收到本次提交回执'));
      assert(await lost.p.getByRole('button',{name:'开始制作',exact:true}).isDisabled());
      assert(await lost.p.getByLabel('创作需求与素材说明',{exact:true}).isDisabled());
      assert.equal(lost.calls.filter(c=>c.path.endsWith('/director/start')).length,1);
      if(blockStorage)assert.match(await lost.p.locator('#montageDirectorRecovery').textContent(),/保持页面打开/);
      else{
        await lost.p.reload();await lost.p.getByLabel('制作方式',{exact:true}).selectOption('director');
        await lost.p.locator('#montageDirectorRecovery').waitFor();
        assert.match(await lost.p.locator('#montageDirectorRecovery').textContent(),/保留真实素材/);
        assert(await lost.p.getByRole('button',{name:'开始制作',exact:true}).isDisabled());
      }
      await lost.p.getByRole('button',{name:'核对本次提交',exact:true}).click();
      await lost.p.waitForFunction(()=>document.querySelector('.montage-message').textContent.includes('没有另开任务'));
      assert(!(await lost.p.locator('#montageDirectorRecovery').isVisible()));
      assert(await lost.p.getByRole('button',{name:'开始制作',exact:true}).isEnabled());
      assert(!(await lost.p.getByLabel('确认本次管线、需求与模型，开始独立导演任务',{exact:true}).isChecked()));
      assert.equal(lost.calls.filter(c=>c.path.endsWith('/director/start')).length,1);
      assert.deepEqual(lost.errors,[]);await lost.p.close();
      passed.push(blockStorage?'blocked storage retains in-page recovery without a second POST':'lost receipt survives reload, verifies original session using GET and never automatically resubmits');
    }

    let starts=[];
    const retry=await fixture(browser,{handleRequest:async({route,req,name})=>{
      if(name.endsWith('/director/start')){
        starts.push(req.postDataJSON());
        if(starts.length===1)await route.abort('failed');else await route.fulfill({json:{request_status:'accepted',session_id:'retry-original',status:'queued'}});
        return true;
      }
      if(name.includes('/director/requests/')){await route.fulfill({json:{request_status:'not_found',message:'未发现提交记录，可使用相同编号重试。'}});return true;}
      return false;
    }});
    await fillRequest(retry.p);await retry.p.getByRole('button',{name:'开始制作',exact:true}).click();
    await retry.p.waitForFunction(()=>document.querySelector('#montageDirectorRecovery')?.textContent.includes('未收到本次提交回执'));
    assert(!(await retry.p.getByRole('button',{name:'重试同一次提交',exact:true}).isVisible()));
    await retry.p.getByRole('button',{name:'核对本次提交',exact:true}).click();
    await retry.p.getByRole('button',{name:'重试同一次提交',exact:true}).waitFor();
    assert.equal(starts.length,1);await retry.p.getByRole('button',{name:'重试同一次提交',exact:true}).click();
    await retry.p.waitForFunction(()=>document.querySelector('.montage-message').textContent.includes('导演任务已建立'));
    assert.equal(starts.length,2);assert.deepEqual(starts[0],starts[1]);assert.match(starts[0].client_request_id,/^[a-f0-9]{32}$/);
    assert.deepEqual(retry.errors,[]);await retry.p.close();passed.push('explicit submission retry keeps identical parameters, consent and request ID');

    const blocked=await fixture(browser,{handleRequest:async({route,name})=>{
      if(!name.endsWith('/director/start'))return false;await route.fulfill({json:needs});return true;
    }});
    await fillRequest(blocked.p);await blocked.p.getByRole('button',{name:'开始制作',exact:true}).click();
    await blocked.p.locator('#montageDirectorReadiness[data-state="needs_setup"]').waitFor();
    assert(!(await blocked.p.locator('#montageDirectorRecovery').isVisible()));
    assert(await blocked.p.getByLabel('创作需求与素材说明',{exact:true}).isEnabled());
    assert(!(await blocked.p.getByLabel('确认本次管线、需求与模型，开始独立导演任务',{exact:true}).isChecked()));
    assert.deepEqual(blocked.errors,[]);await blocked.p.close();passed.push('server refusal releases pending submit, retains draft and requires renewed start confirmation');

    const unknown=await fixture(browser,{handleRequest:async({route,name})=>{
      if(name.endsWith('/director/start')){await route.fulfill({json:{status:'running'}});return true;}
      if(name.includes('/director/requests/')){await route.fulfill({status:503,json:{detail:'本机服务暂时不可读'}});return true;}return false;
    }});
    await fillRequest(unknown.p);await unknown.p.getByRole('button',{name:'开始制作',exact:true}).click();
    await unknown.p.waitForFunction(()=>document.querySelector('#montageDirectorRecovery')?.textContent.includes('可核验的任务回执'));
    await unknown.p.getByRole('button',{name:'核对本次提交',exact:true}).click();
    await unknown.p.waitForFunction(()=>document.querySelector('#montageDirectorRecovery')?.textContent.includes('暂时无法核对'));
    assert(await unknown.p.getByRole('button',{name:'开始制作',exact:true}).isDisabled());
    assert.equal(unknown.calls.filter(c=>c.path.endsWith('/director/start')).length,1);
    assert.deepEqual(unknown.errors,[]);await unknown.p.close();passed.push('unknown response or recovery failure remains pending without false success or new POST');

    let releaseStart,enteredStart;const startEntered=new Promise(r=>enteredStart=r);
    const switched=await fixture(browser,{handleRequest:async({route,name})=>{
      if(!name.endsWith('/director/start'))return false;enteredStart();await new Promise(r=>releaseStart=r);
      await route.fulfill({json:{session_id:'alpha-session',status:'queued'}});return true;
    }});
    await fillRequest(switched.p);await switched.p.getByRole('button',{name:'开始制作',exact:true}).click();await startEntered;
    await switched.p.locator('#mediaProjectId').fill('beta');await switched.p.locator('#mediaProjectId').dispatchEvent('change');
    releaseStart();await switched.p.getByRole('button',{name:'开始制作',exact:true}).waitFor();
    await switched.p.waitForFunction(()=>document.querySelector('#montageDirectorRecovery')?.hidden && !document.querySelector('[aria-label="OpenMontage AI 导演"] button.primary').disabled);
    assert(!(await switched.p.locator('.montage-message').textContent()).includes('导演任务已建立'));
    assert.equal(switched.calls.find(c=>c.path.endsWith('/director/start')).body.project_id,'alpha');
    assert.deepEqual(switched.errors,[]);await switched.p.close();passed.push('late accepted submit keeps its original project and cannot overwrite the newly selected project');

    fs.writeFileSync(path.join(OUT,'submission-browser-results.json'),JSON.stringify({passed,allApiMocked:true,realModelCalled:false,realBuildCalled:false},null,2));
    console.log(passed.join('\n'));
  }finally{await browser.close()}
}
main().catch(e=>{console.error(e);process.exitCode=1});
