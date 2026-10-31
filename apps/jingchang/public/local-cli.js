import {localCliHelpTopics} from './local-cli-core.js';
let sequence = 0, controller;
const $ = selector => document.querySelector(selector);
function controls(root, busy) {
  root.querySelectorAll('[data-cli-run], [data-cli-topic], [data-cli-refresh]').forEach(el => { el.disabled = busy || el.dataset.available === 'false'; });
}
export async function localCliAction(button, {modal,api,esc,toast,projectId,save,cliTasksAvailable=false,codexChatTasksAvailable=false,selectedNodeId}) {
  if(button.dataset.geminiCliChat!==undefined){if(!projectId)throw Error('请先打开工程');await save?.();location.href='/gemini-cli-chat.html?project='+encodeURIComponent(projectId)+(selectedNodeId?'&node='+encodeURIComponent(selectedNodeId):'');return true;}
  if(button.dataset.codexChat!==undefined){if(!projectId)throw Error('请先打开工程');await save?.();location.href='/codex-chat.html?project='+encodeURIComponent(projectId)+(selectedNodeId?'&node='+encodeURIComponent(selectedNodeId):'');return true;}
  if(button.dataset.cliAccount!==undefined){await save?.();location.href='/jimeng-account.html'+(projectId?'?project='+encodeURIComponent(projectId):'');return true;}
  if(button.dataset.cliGenerate!==undefined){if(!projectId)throw Error('请先打开工程');await save?.();location.href='/jimeng-cli.html?project='+encodeURIComponent(projectId);return true;}
  if (button.dataset.action === 'local-cli' || button.dataset.cliRefresh !== undefined) {
    controller?.abort(); const current = ++sequence;
    const {tools} = await api('/api/local-cli');const geminiAvailable=(await api('/api/health')).capabilities?.geminiCliChats===true; if (sequence !== current) return true;
    modal('本机工具 · 版本与帮助', `<div id="local-cli-panel"><p class="muted small">CLI 是通过命令运行的本机程序。打开此页只查找程序；点击下方按钮才执行一次版本或帮助查看。登录状态尚未检查。即梦生成使用独立任务页，需另外确认账号范围、素材和预算。</p>${tools.map(tool => `<section class="local-cli-card" data-cli-card="${esc(tool.id)}"><div class="row"><strong>${esc(tool.variant==='antigravity'?'Antigravity CLI':tool.variant==='gemini'?'Gemini CLI':tool.name)}</strong><span class="muted small">${tool.installed===true?'已找到程序':tool.installed===false?'未找到程序':'WSL 状态待核实'}</span></div><p class="muted small" data-cli-details>${esc(tool.message)}</p>${tool.projectManaged?'<p class="muted small">项目内程序；版本和帮助在离线隔离中读取，不检查登录或积分。</p>':''}<div class="local-cli-controls"><button data-cli-run="version" data-cli-tool="${esc(tool.id)}" data-available="${tool.installed===true&&tool.infoAvailable!==false}" ${tool.installed===true&&tool.infoAvailable!==false?'':'disabled'}>查看版本</button><label>帮助主题<select aria-label="${esc(tool.id)} 帮助主题" data-cli-topic data-available="${tool.installed===true&&tool.infoAvailable!==false}" ${tool.installed===true&&tool.infoAvailable!==false?'':'disabled'}>${(tool.helpTopics||localCliHelpTopics(tool.id,tool.variant)).map(t=>`<option value="${esc(t.command)}">${esc(t.label)}</option>`).join('')}</select></label><button data-cli-run="help" data-cli-tool="${esc(tool.id)}" data-available="${tool.installed===true&&tool.infoAvailable!==false}" ${tool.installed===true&&tool.infoAvailable!==false?'':'disabled'}>查看帮助</button></div><p class="muted small">登录、安装、积分或生成主题只显示帮助说明，不执行相应操作。</p><div class="local-cli-result" hidden><p class="muted small" data-cli-caption></p><pre tabindex="0" data-cli-output></pre><button data-cli-copy>复制显示内容</button></div>${tool.id==='gemini-cli'&&tool.variant==='gemini'&&geminiAvailable?'<button data-gemini-cli-chat>Gemini文字与看图任务</button>':''}${tool.id==='codex'&&codexChatTasksAvailable?'<button data-codex-chat>Codex文字与看图任务</button>':''}${tool.id==='jimeng'?'<button data-cli-account>即梦登录与积分（需单独确认）</button>':''}<p data-cli-status role="status"></p></section>`).join('')}<p class="muted small">本页不填写 API Key；结果仅显示在当前页面，不写入项目或任务记录。未找到程序时，请使用相应工具的官方安装说明。</p></div>`, (cliTasksAvailable?'<button data-cli-generate>即梦生成与原任务记录</button>':'')+'<button data-cli-refresh>刷新程序状态</button>');
    $('#modal').addEventListener('close', () => { if (!$('#modal').open) { controller?.abort(); sequence++; $('#modal').querySelectorAll('[data-cli-output]').forEach(el=>{el.textContent='';});$('#modal').querySelectorAll('.local-cli-result').forEach(el=>{el.hidden=true;}); } }, {once:true});
    return true;
  }
  if (button.dataset.cliCopy !== undefined) {
    await navigator.clipboard.writeText(button.closest('[data-cli-card]').querySelector('[data-cli-output]').textContent);
    toast('已复制显示内容'); return true;
  }
  if (button.dataset.cliRun) {
    const root=$('#local-cli-panel'); if (!root || root.dataset.busy==='true') return true;
    const card=button.closest('[data-cli-card]'),action=button.dataset.cliRun,id=button.dataset.cliTool,command=card.querySelector('[data-cli-topic]').value;
    const payload={consent:true,...(action==='help'?{command}:{})},current=sequence;
    controller=new AbortController(); root.dataset.busy='true';controls(root,true);
    card.querySelector('[data-cli-status]').textContent=action==='version'?'正在查看本机版本…':'正在查看帮助说明…';
    card.querySelector('.local-cli-result').hidden=true;card.querySelector('[data-cli-output]').textContent='';
    try {
      const result=await api(`/api/${id}/${action}`,{method:'POST',body:JSON.stringify(payload),signal:controller.signal});
      if(sequence!==current || !root.isConnected) return true;
      card.querySelector('[data-cli-output]').textContent=result.text;
      card.querySelector('[data-cli-details]').textContent=action==='version'?'已实际读取本机版本；登录与账户状态未检查。':'已实际读取所选帮助；登录与账户状态未检查。';
      card.querySelector('[data-cli-caption]').textContent=`${result.executable} ${result.arguments.join(' ')} · ${new Date(result.checkedAt).toLocaleTimeString()}`;
      card.querySelector('.local-cli-result').hidden=false;card.querySelector('[data-cli-status]').textContent='查看完成 · 未检查登录或账户';
    } catch(e) { if(sequence===current && root.isConnected)card.querySelector('[data-cli-status]').textContent=e.name==='AbortError'?'已停止查看':e.message; }
    finally { if(root.isConnected) {root.dataset.busy='false';controls(root,false);} }
    return true;
  }
  return false;
}
