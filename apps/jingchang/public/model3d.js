import {nativeMediaFetch as fetch} from './native-media-session.js';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {inspectGlb,GLB_LIMIT} from './glb-validation.js';
const $=s=>document.querySelector(s),params=new URLSearchParams(location.search),id=params.get('asset'),project=params.get('project');
let renderer,controls,scene,camera,model;
const draw=()=>{if(renderer&&scene&&camera)renderer.render(scene,camera);};
function reset(){if(!model)return;const box=new THREE.Box3().setFromObject(model),center=box.getCenter(new THREE.Vector3()),size=box.getSize(new THREE.Vector3()),radius=Math.max(size.x,size.y,size.z);if(!Number.isFinite(radius)||radius<=0)throw Error('模型尺寸无效，仍可下载原文件');const distance=radius/Math.tan(camera.fov*Math.PI/360);camera.near=Math.max(radius/10000,.000001);camera.far=Math.max(distance*30,1);camera.position.copy(center).add(new THREE.Vector3(distance*.7,distance*.45,distance));camera.updateProjectionMatrix();controls.target.copy(center);controls.minDistance=radius*.05;controls.maxDistance=distance*10;controls.update();draw();}
async function open(){
 if(!/^[\w-]{1,100}$/.test(id||''))throw Error('请从三维素材的预览入口打开');if(project&&/^[\w-]{1,100}$/.test(project))$('#back').href='/?project='+encodeURIComponent(project);
 const response=await fetch('/api/model3d/'+id);const info=await response.json();if(!response.ok)throw Error(info.error||'无法读取三维素材');$('#name').textContent=info.name;document.title=info.name+' · 镜场';$('#download').href='/media/'+id;$('#download').download=info.name;$('#download').hidden=false;
 const file=await fetch('/media/'+id);if(!file.ok||Number(file.headers.get('content-length'))>GLB_LIMIT)throw Error('三维文件无法读取');const bytes=await file.arrayBuffer(),meta=inspectGlb(bytes);
 const manager=new THREE.LoadingManager();manager.setURLModifier(url=>{if(url.startsWith('blob:')||/^data:image\/(png|jpeg|webp);base64,/.test(url))return url;throw Error('预览不读取外部三维资源');});
 const gltf=await new GLTFLoader(manager).parseAsync(bytes,'');model=gltf.scene;
 try{renderer=new THREE.WebGLRenderer({antialias:true,alpha:true});}catch{throw Error('当前浏览器不能显示三维画面，请下载原文件');}
 renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.outputColorSpace=THREE.SRGBColorSpace;$('#viewport').append(renderer.domElement);scene=new THREE.Scene();scene.background=null;scene.add(new THREE.HemisphereLight(0xffffff,0x738375,2.5));const light=new THREE.DirectionalLight(0xffffff,3);light.position.set(3,4,5);scene.add(light);scene.add(model);camera=new THREE.PerspectiveCamera(42,1,.01,1000);controls=new OrbitControls(camera,renderer.domElement);controls.addEventListener('change',draw);
 const resize=()=>{const rect=$('#viewport').getBoundingClientRect();renderer.setSize(rect.width,rect.height);camera.aspect=rect.width/Math.max(1,rect.height);camera.updateProjectionMatrix();draw();};new ResizeObserver(resize).observe($('#viewport'));resize();reset();$('#reset').disabled=false;$('#wireframe').disabled=false;$('#stats').textContent=meta.meshes+' 个网格 · '+meta.vertices.toLocaleString()+' 个顶点';$('#status').textContent='已从本机打开原文件';$('#status').dataset.state='ready';
}
$('#reset').onclick=()=>{try{reset();}catch(e){$('#status').textContent=e.message;}};$('#wireframe').onchange=()=>{model?.traverse(object=>{if(object.isMesh)for(const m of Array.isArray(object.material)?object.material:[object.material])m.wireframe=$('#wireframe').checked;});draw();};
window.addEventListener('pagehide',()=>{controls?.dispose();model?.traverse(object=>{object.geometry?.dispose();for(const m of Array.isArray(object.material)?object.material:[object.material])if(m){for(const value of Object.values(m))if(value?.isTexture)value.dispose();m.dispose();}});renderer?.dispose();});
open().catch(e=>{$('#status').textContent=e.message||'三维预览失败；原素材保留';$('#status').dataset.state='error';});
