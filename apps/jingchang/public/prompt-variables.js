const VARIABLE=/\{\{([^{}]*)\}\}/gu;
const NAME=/^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

export function promptVariables(template){
 const source=String(template),names=[],seen=new Set();
 for(const match of source.matchAll(VARIABLE)){
  const name=match[1];
  if(!NAME.test(name))throw new Error('提示词变量使用英文字母、数字和下划线，且须以字母或下划线开头');
  if(!seen.has(name)){seen.add(name);names.push(name);}
 }
 const remainder=source.replace(VARIABLE,'');
 if(remainder.includes('{{')||remainder.includes('}}'))throw new Error('提示词变量括号不完整');
 if(names.length>50)throw new Error('一条提示词最多使用 50 个变量');
 return names;
}

export function renderPromptVariables(template,values){
 const names=promptVariables(template),source=String(template);
 for(const name of names)if(typeof values?.[name]!=='string'||values[name].length>2000)throw new Error(`请填写变量 ${name}（不超过 2000 字）`);
 const rendered=source.replace(VARIABLE,(_,name)=>values[name]);
 if(rendered.length>40000)throw new Error('填入变量后的提示词不能超过 40000 字');
 return rendered;
}
