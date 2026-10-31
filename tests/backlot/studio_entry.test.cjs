const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('backlot/ui/entry.js','utf8');
function entry(mode='guided', denied=false) {
  const nodes = {};
  const node = id => nodes[id] ||= {id,value:'',files:[],dataset:{},hidden:false,required:false,textContent:'',handlers:{},classList:{toggle(){}},setAttribute(){},focus(){this.focused=true;},addEventListener(name,fn){this.handlers[name]=fn;}};
  const cards=['guided','material','storyboard'].map(mode=>({...node(mode),dataset:{mode}}));
  const store=new Map();
  const ctx=vm.createContext({URL,URLSearchParams,Date,Set,JSON,
    window:{location:{search:'',origin:'http://localhost',href:'/create/'+mode}},
    document:{body:{dataset:{entryMode:mode}},getElementById:node,querySelectorAll:s=>s==='.mode-card'?cards:[]},
    sessionStorage:{removeItem:k=>store.delete(k),setItem:(k,v)=>{if(denied)throw Error('denied');store.set(k,v);}},
  });
  vm.runInContext(source,ctx);
  return {nodes,cards,ctx,store,submit:()=>nodes.entryForm.handlers.submit({preventDefault(){}})};
}
test('switching entry tabs retains text and only the active input is required',()=>{
  const f=entry();f.nodes.guidedPrompt.value='南北湖';
  f.cards[1].handlers.click();assert.equal(f.nodes.guidedPrompt.value,'南北湖');
  assert.equal(f.nodes.guidedPrompt.required,false);assert.equal(f.nodes.materialPanel.hidden,false);
  f.cards[0].handlers.click();assert.equal(f.nodes.guidedPrompt.required,true);assert.equal(f.nodes.materialPanel.hidden,true);
});
test('a filename without readable content cannot become a fabricated creative brief',()=>{
  for(const mode of ['material','storyboard']){
    const f=entry(mode);f.nodes[mode+'Files'].files=[{name:'placeholder.pdf'}];f.submit();
    assert.equal(f.store.size,0);assert.match(f.nodes.entryMessage.textContent,/填写内容/);
    assert.equal(f.ctx.window.location.href,'/create/'+mode);
  }
});
test('denied session storage preserves user content and does not navigate away',()=>{
  const f=entry('guided',true);f.nodes.guidedPrompt.value='西湖日落';f.submit();
  assert.equal(f.nodes.guidedPrompt.value,'西湖日落');assert.equal(f.ctx.window.location.href,'/create/guided');
  assert.match(f.nodes.entryMessage.textContent,/不能保存草稿/);
});
test('valid brief preserves workflow and budget without a production request',()=>{
  const f=entry();f.nodes.guidedPrompt.value='西湖日落';f.ctx.document.getElementById('guidedWorkflow').value='quality';f.ctx.document.getElementById('guidedBudget').value='8';
  f.submit();const saved=JSON.parse(f.store.get('openmontage.entry_draft'));
  assert.equal(saved.prompt,'西湖日落');assert.equal(saved.settings.budget,'8');
  assert.equal(f.ctx.window.location.href,'/model?entry=guided&view=quality');
});
