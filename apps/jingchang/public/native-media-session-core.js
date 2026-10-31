// A page keeps the media interpretation it saw at boot. This is a compatibility
// contract, not account authentication or permission to generate anything.
export const NATIVE_MEDIA_SESSION_HEADER='x-jingchang-media-session';
export const nativeMediaSession=enabled=>({version:1,storedMedia:enabled===true});
export const nativeMediaSessionToken=value=>`1;smart=${value?.storedMedia===true?'1':'0'}`;
export function nativeMediaSessionFromHealth(health){
 const value=health?.nativeMediaSession;
 if(value!==undefined&&(value?.version!==1||typeof value.storedMedia!=='boolean'))throw nativeMediaSessionError('页面与服务的素材规则版本不匹配，请保留未保存内容后刷新。');
 const enabled=health?.capabilities?.smartGroupStoredMedia===true;
 if(value&&value.storedMedia!==enabled)throw nativeMediaSessionError('服务返回的素材规则不一致，请保留当前内容并检查服务版本。');
 return nativeMediaSession(enabled);
}
export function nativeMediaSessionError(message='页面与服务的素材规则已变化。请先下载未保存草稿，再刷新页面。',code='NATIVE_MEDIA_SESSION_CHANGED'){
 return Object.assign(new Error(message),{status:409,code});
}
export function nativeMediaRecoveryOperation(pathname,method='GET'){
 if(['GET','HEAD'].includes(method))return pathname==='/api/health'||pathname==='/api/jobs'||/^\/api\/jobs\/[^/]+$/.test(pathname)||pathname==='/api/projects';
 return method==='POST'&&(/^\/api\/(jobs|library-crops|asset-library-backups|library-copies|classification-batches|asset-classification-tasks|shared-folder-imports|jimeng-tasks|apimart-materials|codex-chats|gemini-cli-chats|asset-caption-batches)\/[^/]+\/(cancel|stop)$/.test(pathname)||/^\/api\/(studios|conversations)\/[^/]+\/jobs\/[^/]+\/cancel$/.test(pathname)||/^\/api\/jimeng\/account\/requests\/[^/]+\/stop$/.test(pathname));
}
export function nativeMediaPreservationOperation(pathname,method='GET'){
 return nativeMediaRecoveryOperation(pathname,method)||method==='POST'&&/^\/api\/projects\/[^/]+\/(bundle|task-history-archive|assets\/archive)$/.test(pathname)||['GET','HEAD'].includes(method)&&(/^\/api\/(project-bundles|native-canvas|task-history-archives)\/exports\/[^/]+\/download$/.test(pathname)||/^\/api\/asset-library-backups\/[^/]+\/download$/.test(pathname)||/^\/api\/asset-catalog\/items\/[^/]+\/download$/.test(pathname));
}
export function nativeMediaSessionRequired(pathname,method='GET'){
 if(nativeMediaPreservationOperation(pathname,method))return false;
 return /^\/api\/projects(?:\/|$)/.test(pathname)||method==='POST'&&(/^\/api\/(native-canvas|project-bundles|task-history-archives|native-library-imports|asset-library-backups)(?:\/|$)/.test(pathname)||/^\/api\/asset-catalog\/items\/[^/]+\/(insert|open-project)$/.test(pathname)||/\/resume$/.test(pathname));
}
export function assertNativeMediaSession(header,{enabled,pathname,method='GET',required=false}){
 if(nativeMediaPreservationOperation(pathname,method))return;
 const expected=nativeMediaSessionToken(nativeMediaSession(enabled));
 if(header!==undefined&&header!==expected||enabled&&(required||nativeMediaSessionRequired(pathname,method))&&header!==expected)throw nativeMediaSessionError();
}
export const projectUsesModernNativeMedia=project=>project?.settings?.nativeMediaVersion===2||project?.nodes?.some(n=>n.params?.nativeMediaVersion===2||n.params?.nativeMediaMap!==undefined)===true;
export function assertNativeMediaProjectSession(project,context,enabled){
 if(!context||nativeMediaPreservationOperation(context.pathname,context.method))return;
 assertNativeMediaSession(context.header,{...context,enabled,required:enabled});
 if(!enabled&&projectUsesModernNativeMedia(project))throw nativeMediaSessionError('该工程包含当前服务未启用的素材规则。工程仍保留，请使用匹配的服务版本；刷新页面不会自动转换工程。','NATIVE_MEDIA_RULES_UNAVAILABLE');
}
