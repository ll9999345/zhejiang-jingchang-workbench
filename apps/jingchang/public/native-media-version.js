export const NATIVE_MEDIA_LEGACY=1;
export const NATIVE_MEDIA_COMPLETE=2;
export function checkedNativeMediaVersion(value){
 if(value!==1&&value!==2)throw Error('素材顺序版本无效，请保留原工程并重新检查');
 return value;
}
// Missing markers are always legacy: old projects and immutable task snapshots
// must never change interpretation merely because the server was updated.
export function nativeMediaVersion(project,node){
 return checkedNativeMediaVersion(node?.params?.nativeMediaVersion!==undefined?node.params.nativeMediaVersion:project?.settings?.nativeMediaVersion!==undefined?project.settings.nativeMediaVersion:1);
}
export function hasNativeMediaVersion(project){
 return project.settings?.nativeMediaVersion!==undefined||project.nodes.some(n=>n.params?.nativeMediaVersion!==undefined);
}
