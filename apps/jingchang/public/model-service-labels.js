// Display names only: never rewrite provider IDs, model IDs or API URLs.
export function serviceDisplayText(value,fallback='模型服务'){
 if(/^https?:\/\//i.test(String(value??'')))return String(value);
 const text=String(value??'').replace(/喵喵(?:\s*(?:中转站|API|接口|平台))?|Miao\s*API(?:\s*中转站)?/gi,'').replace(/^[\s·|｜/—–-]+|[\s·|｜/—–-]+$/g,'').replace(/\s*[·|｜]\s*[·|｜]\s*/g,' · ').trim();
 return text||fallback;
}
export const platformDisplayName=platform=>serviceDisplayText(platform?.name);
export const modelDisplayName=model=>serviceDisplayText(model?.label||model?.id,model?.id||'请选择模型');
