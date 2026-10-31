const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

// CSS contracts complement liquid_canvas.test.cjs, whose DOM fixture does not
// apply styles. Browser acceptance remains responsible for rendered geometry.
const css=fs.readFileSync(path.join(__dirname,'../../backlot/ui/canvas-module/unified.css'),'utf8').replace(/\/\*[\s\S]*?\*\//g,'');

function splitSelectors(value){
 const items=[];let depth=0,start=0;
 for(let i=0;i<value.length;i++){
  if(value[i]==='('||value[i]==='[')depth++;
  if(value[i]===')'||value[i]===']')depth--;
  if(value[i]===','&&depth===0){items.push(value.slice(start,i).trim());start=i+1;}
 }
 items.push(value.slice(start).trim());return items;
}
function expandIs(selector){
 const start=selector.indexOf(':is(');if(start<0)return [selector.replace(/\s+/g,' ').trim()];
 let depth=1,end=start+4;
 for(;end<selector.length&&depth;end++){if(selector[end]==='(')depth++;if(selector[end]===')')depth--;}
 assert.equal(depth,0,'Unclosed :is() selector');
 return splitSelectors(selector.slice(start+4,end-1)).flatMap(part=>expandIs(selector.slice(0,start)+part+selector.slice(end)));
}
function readRules(source,media=[]){
 const rules=[];let offset=0;
 while(offset<source.length){
  const open=source.indexOf('{',offset);if(open<0)break;
  const selector=source.slice(offset,open).trim();let depth=1,end=open+1;
  for(;end<source.length&&depth;end++){if(source[end]==='{')depth++;if(source[end]==='}')depth--;}
  assert.equal(depth,0,'Unclosed CSS rule');
  const content=source.slice(open+1,end-1);
  if(selector.startsWith('@media'))rules.push(...readRules(content,[...media,selector.slice(6).trim()]));
  else if(!selector.startsWith('@')){
   const declarations={};
   for(const declaration of content.split(';')){
    const colon=declaration.indexOf(':');if(colon>=0)declarations[declaration.slice(0,colon).trim()]=declaration.slice(colon+1).trim();
   }
   rules.push({selectors:splitSelectors(selector).flatMap(expandIs),declarations,media});
  }
  offset=end;
 }
 return rules;
}
const rules=readRules(css);
const selectorFor=surface=>'body[data-unified-canvas] '+surface;
const forSurface=surface=>rules.filter(rule=>rule.selectors.includes(selectorFor(surface)));
const withPosition=surface=>forSurface(surface).filter(rule=>rule.declarations.position);
const minimumWidth=rule=>Math.max(0,...rule.media.flatMap(query=>[...query.matchAll(/min-width\s*:\s*(\d+)px/g)].map(match=>Number(match[1]))));

test('absolute glass foreground stays non-interactive and fills its containing surface',()=>{
 const foreground=forSurface('.studio-glass-front').find(rule=>rule.declarations.position==='absolute');
 assert.ok(foreground,'The foreground copy needs an explicit absolute layout');
 assert.equal(foreground.declarations.inset,'-1px');
 assert.equal(foreground.declarations.width,'calc(100% + 2px)');
 assert.equal(foreground.declarations.height,'calc(100% + 2px)');
 assert.equal(foreground.declarations['pointer-events'],'none');
 assert.equal(foreground.declarations['z-index'],'-1');
});

test('static native topbar and rail provide containing blocks at every viewport width',()=>{
 for(const surface of ['.app .topbar','.app .rail','.studio .canvas-toolbar']){
  const positions=withPosition(surface);
  assert.ok(positions.some(rule=>rule.media.length===0&&rule.declarations.position==='relative'),`${surface} needs an unconditional containing block`);
  assert.ok(positions.every(rule=>rule.declarations.position==='relative'),`${surface} must retain its grid/flex position`);
 }
});

test('panel containing blocks only activate above their native mobile breakpoints',()=>{
 for(const [surface,breakpoint] of [['.app .panel',801],['.studio .left-panel',761],['.studio .right-panel',761]]){
  const positions=withPosition(surface);
  assert.ok(positions.length>0,`${surface} needs a desktop containing block`);
  assert.ok(positions.every(rule=>rule.declarations.position==='relative'&&minimumWidth(rule)===breakpoint),`${surface} must leave the native mobile absolute rule in control below ${breakpoint}px`);
 }
});

test('native dock, canvas controls and floating menus keep ownership of absolute positioning',()=>{
 // Applying position:relative to the complete glass surface list would also
 // move these native overlays out of their absolute workspace placement.
 for(const name of ['dock','canvas-controls','floating-menu']){
  const overrides=rules.filter(rule=>rule.declarations.position&&rule.selectors.some(selector=>new RegExp('\\.'+name+'(?:[\\s.:#\\[]|$)').test(selector)));
  assert.deepEqual(overrides,[],`.${name} must not receive a position override from the presentation layer`);
 }
});

for(const [base,state,label] of [['.app .node','selected','canvas node'],['.studio .workflow-node','active-node','director workflow node']])test(`selected ${label} retains a DOM indicator independent of transparent WebGL borders`,()=>{
 const selected=forSurface(base+'.'+state).find(rule=>rule.declarations.outline);
 assert.ok(selected,'Selection needs its own DOM outline after WebGL makes borders transparent');
 assert.match(selected.declarations.outline,/^2px\s+solid\s+var\(--accent\)(?:\s*!important)?$/,'The selection outline follows the active theme accent');
 assert.match(selected.declarations['outline-offset']||'',/^1px(?:\s*!important)?$/);
 assert.match(selected.declarations['box-shadow']||'',/0\s+0\s+0\s+(?:[2-9]|\d{2,})px\s/,'The selected node needs an outer halo in addition to the outline');
 // A general important shadow would defeat the more specific selected rule.
 for(const rule of forSurface(base))assert.doesNotMatch(rule.declarations['box-shadow']||'',/!important/);
 for(const rule of forSurface('[data-glass-surface="webgl"]')){
  assert.doesNotMatch(rule.declarations.outline||'',/^(?:none|0)(?:\s|$)/,'The material layer must not clear the selection outline');
  assert.doesNotMatch(rule.declarations['box-shadow']||'',/!important/,'The material layer must not override the selection halo');
 }
});
