import {isLocalMiaoTarget} from './miao-credential-core.js';
const choices=new WeakMap();
// This control never reads a stored credential. The browser sends only a source
// selector and explicit consent; the server resolves it after request checks.
export async function mountMiaoCredentialChoice(input,platform,{purpose='chat'}={}){
 if(!input)return;const parent=input.closest('label')||input.parentElement;
 choices.get(input)?.remove();choices.delete(input);input.disabled=false;
 if(!isLocalMiaoTarget(platform,{purpose}))return;
 const block=document.createElement('div');block.dataset.miaoCredentialChoice='';
 block.innerHTML='<label>密钥来源<select data-miao-source><option value="manual">本次填写密钥</option><option value="miao-local" disabled>本机模型服务配置（检查中）</option></select></label><label class="check-label check" hidden style="display:none"><input type="checkbox" data-miao-consent>允许本次使用本机模型服务配置</label><p class="muted small" data-miao-status>只检查本机配置，不向模型发送请求。</p>';
 choices.set(input,block);parent.after(block);const select=block.querySelector('select'),consent=block.querySelector('[data-miao-consent]');
 select.onchange=()=>{const local=select.value==='miao-local';input.value='';input.disabled=local;consent.checked=false;consent.parentElement.hidden=!local;consent.parentElement.style.display=local?'flex':'none';};
 try{const response=await fetch('/api/miao-credentials/status');if(!response.ok)throw Error();const state=await response.json();if(!block.isConnected)return;
  if(choices.get(input)!==block)return;
  select.options[1].disabled=state.configured!==true;select.options[1].textContent='本机模型服务配置';
  block.querySelector('[data-miao-status]').textContent=state.configured?'已识别专用配置；模型权限与真实调用仍需验证。只发送本次明确确认的内容。':'未找到专用配置，请填写本次密钥。';
 }catch{if(block.isConnected)block.querySelector('[data-miao-status]').textContent='本机配置状态不可读取，仍可使用本次填写密钥。';}
}
export function readMiaoCredentialChoice(input){
 const block=input&&choices.get(input);
 if(block?.querySelector('[data-miao-source]')?.value==='miao-local'){
  if(!block.querySelector('[data-miao-consent]').checked)throw Error('请确认本次使用本机模型服务配置');
  return{apiKey:'',credentialSource:'miao-local',credentialConsent:true};
 }
 return{apiKey:input?.value||'',credentialSource:'manual'};
}
