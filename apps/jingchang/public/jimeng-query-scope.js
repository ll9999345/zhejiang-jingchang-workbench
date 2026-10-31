export function normalizeJimengResultQueries(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='budget,currency,intervalSeconds,requestLimit')throw Error('原编号查询范围无效');
 const {requestLimit,budget,currency,intervalSeconds}=value;
 if(!Number.isInteger(requestLimit)||requestLimit<1||requestLimit>30)throw Error('原编号查询次数须为1–30次');
 if(!Number.isFinite(budget)||budget<0||budget>1e6||!['credits','CNY','USD'].includes(currency))throw Error('请明确填写原编号查询总预算及单位');
 if(!Number.isInteger(intervalSeconds)||intervalSeconds<5||intervalSeconds>300)throw Error('原编号查询间隔须为5–300秒');
 return{requestLimit,budget,currency,intervalSeconds};
}
export function jimengScopedQueryAuthorization(plan,upstreamId){
 const policy=normalizeJimengResultQueries(plan.resultQueries);
 // Never round the authorized aggregate upwards. This is a consent ledger,
 // not a claim that the CLI/provider can enforce a monetary spending limit.
 const budget=Math.floor(policy.budget*1e6/policy.requestLimit)/1e6;
 return{service:'local-dreamina-login',action:'query',command:plan.request.command,model:plan.request.model,requestLimit:1,useLocalLogin:true,sendPrompt:false,sendOriginalMedia:false,budget,currency:policy.currency,consent:true,upstreamId};
}
