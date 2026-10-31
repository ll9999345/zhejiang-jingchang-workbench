"""Explicit 0.2 -> 0.3 engineering migrations; never mutate an old Result.

The first supported contract is the official semantic chat scene. Unknown
components/relationships require a separate adapter, rather than global text
replacement. All work is local, on a new copy, without generation.
"""
from __future__ import annotations
import hashlib
import html
import json
import math
import os
import re
import shutil
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
import xml.etree.ElementTree as ET

from web_api.hypit_runtime import HypitRuntime, HypitRuntimeError, MEDIA_SUFFIXES, _run_subprocess

ALIASES = {'time','spatial','fonts','chat','film','render','style','media','html'}
OLD_USES = {'@hypit/provider-media-local':'@hypit/media-local', '@hypit/provider-hyperframes-local':'@hypit/provider-html-local'}
SENSITIVE = re.compile(r'api.?key|password|secret|credential|access.?token|authorization', re.I)
ID = re.compile(r'^[A-Za-z_][A-Za-z0-9._-]*$')


def digest(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def _read(path: Path) -> str:
    if not path.is_file() or path.is_symlink() or path.stat().st_size > 512_000:
        raise HypitRuntimeError('作者文件缺失、超限或是符号链接，需要单独检查')
    return path.read_text('utf-8')


def _parse(text: str, *, author: bool = False) -> ET.Element:
    if re.search(r'<!DOCTYPE|<!ENTITY',text,re.I):
        raise HypitRuntimeError('不处理含外部声明的作者文件')
    # This contract allows simple reference paths, not arbitrary expressions.
    quoted = re.sub(r'(\s[\w:-]+\s*=\s*)(\{[\w.-]+\})',r'\1"\2"',text)
    if author:
        declarations=' '.join(f'xmlns:{name}="urn:migrate:{name}"' for name in ALIASES)
        quoted=quoted.replace('<svml>',f'<svml {declarations}>',1)
    try:return ET.fromstring(quoted)
    except ET.ParseError as exc:raise HypitRuntimeError('作者结构不在已验证迁移范围，需要单独适配') from exc


def _tag(alias: str, name: str) -> str:
    return f'{{urn:migrate:{alias}}}{name}'


def _exact(node: ET.Element, allowed: set[str], required: set[str] | None = None):
    if set(node.attrib)-allowed or not (required or allowed).issubset(node.attrib):
        raise HypitRuntimeError('检测到未适配的作者属性，未自动丢弃或覆盖')
    if node.text and node.text.strip():raise HypitRuntimeError('检测到额外作者正文，需要单独适配')


def chat_model(text: str) -> dict:
    root=_parse(text,author=True)
    if root.tag!='svml' or root.attrib:raise HypitRuntimeError('不是支持的SVML作者根节点')
    if any((n.text and n.text.strip()) or (n.tail and n.tail.strip()) for n in root.iter()):
        raise HypitRuntimeError('含额外作者正文，不能在迁移时自动舍弃')
    children=list(root);imports=[n for n in children if n.tag=='import']
    expected={'time':'@hypit/timeline-author@1','spatial':'@hypit/spatial@1','fonts':'@hypit/fonts-open@1','chat':'@example/chat-scene@1','film':'@hypit/film@1','render':'@hypit/render-hyperframes@1'}
    if len(imports)!=7 or {n.get('as'):n.get('from') for n in imports if 'from' in n.attrib}!=expected:
        raise HypitRuntimeError('此工程使用其他模块关系，需独立迁移适配')
    for n in imports:
        _exact(n,{'as','source'} if n.get('as')=='style' else {'as','from'})
        if len(n):raise HypitRuntimeError('导入声明有额外内容')
    if next(n for n in imports if n.get('as')=='style').get('source')!='./chat.svs':
        raise HypitRuntimeError('Recipe路径需要单独适配')
    expected_tags=[_tag('time','Clock'),_tag('time','Timeline'),_tag('spatial','Canvas'),_tag('fonts','Stack'),_tag('chat','Scene'),_tag('film','Film'),_tag('render','Video')]
    nodes=[n for n in children if n.tag!='import']
    if [n.tag for n in nodes]!=expected_tags:raise HypitRuntimeError('此工程包含其他创作结构，未自动简化')
    clock,timeline,canvas,font,scene,film,video=nodes
    for node,attrs in [(clock,{'id','frame-rate'}),(timeline,{'id','clock','end'}),(canvas,{'id','width','height'}),(font,{'id','family','weight','style'}),(film,{'id','canvas','timeline','appearance'}),(video,{'id','composition','timeline'})]:_exact(node,attrs)
    _exact(scene,{'id','timeline','canvas','font','during','title','entrance-frames'},{'id','timeline','canvas','font','during','title'})
    ids=[node.get('id') for node in nodes]
    if any(not ID.fullmatch(value or '') for value in ids) or len(set(ids))!=len(ids):raise HypitRuntimeError('作者标识符无效或重复')
    ref=lambda node,field,value:node.get(field)==f'{{{value}}}'
    if not (ref(timeline,'clock',clock.get('id')) and ref(scene,'timeline',timeline.get('id')+'.timeline') and ref(scene,'canvas',canvas.get('id')) and ref(scene,'font',font.get('id')) and scene.get('during')=='program' and ref(film,'canvas',canvas.get('id')) and ref(film,'timeline',timeline.get('id')+'.timeline') and film.get('appearance')=='{style.film.main}' and ref(video,'composition',film.get('id')+'.composition') and ref(video,'timeline',timeline.get('id')+'.timeline')):
        raise HypitRuntimeError('时间/空间/输出关系超出已验证迁移契约')
    tracks=list(film)
    if len(tracks)!=1 or tracks[0].tag!=_tag('film','Track') or tracks[0].attrib!={'source':f'{{{scene.get("id")}.track}}'}:raise HypitRuntimeError('检测到其他轨道，不能自动舍弃')
    if any(len(n) for n in [clock,timeline,canvas,font,video]):raise HypitRuntimeError('检测到其他子节点，需单独迁移')
    if font.get('family')!='inter' or font.get('style') not in {'normal','italic'}:raise HypitRuntimeError('所选字体尚未对应到当前本机字体包')
    try:
        fps=int(clock.get('frame-rate'));width=int(canvas.get('width'));height=int(canvas.get('height'));weight=int(font.get('weight'));end=float(timeline.get('end').removesuffix('s'));entrance=int(scene.get('entrance-frames','10'))
        assert 1<=fps<=120 and 64<=width<=4096 and 64<=height<=4096 and 100<=weight<=900 and math.isfinite(end) and 0<end<=600 and entrance>=1 and timeline.get('end').endswith('s')
    except (ValueError,TypeError,AssertionError) as exc:raise HypitRuntimeError('画幅、时长或字体参数不受支持') from exc
    messages=[]
    for message in scene:
        if message.tag!=_tag('chat','Message') or len(message):raise HypitRuntimeError('聊天场景包含其他结构')
        _exact(message,{'id','sender','side','at','text'})
        if not ID.fullmatch(message.get('id','')) or message.get('side') not in {'left','right'}:raise HypitRuntimeError('消息标识符/方向无效')
        try:
            seconds=float(message.get('at').removesuffix('s'));assert message.get('at').endswith('s') and math.isfinite(seconds) and 0<=seconds<end
        except (ValueError,TypeError,AssertionError) as exc:raise HypitRuntimeError('消息时间需要单独适配') from exc
        messages.append(dict(message.attrib))
    if not messages or len(messages)>100 or len({m['id'] for m in messages})!=len(messages) or len(set(ids+[m['id'] for m in messages]))!=len(ids)+len(messages):raise HypitRuntimeError('消息为空或标识符重复')
    if any(float(a['at'][:-1])>float(b['at'][:-1]) for a,b in zip(messages,messages[1:])):raise HypitRuntimeError('消息时序不合法')
    return {'ids':dict(zip(['clock','timeline','canvas','font','scene','film','video'],ids)),'fps':fps,'width':width,'height':height,'weight':weight,'font_style':font.get('style'),'end':timeline.get('end'),'title':scene.get('title'),'entrance':entrance,'messages':messages}


def render_chat(model: dict) -> str:
    q=lambda value:html.escape(str(value),quote=True)
    ids=model['ids'];clock,timeline,canvas,font,scene,film,video=[ids[k] for k in ['clock','timeline','canvas','font','scene','film','video']]
    face='migration-font-'+hashlib.sha256(font.encode()).hexdigest()[:12]
    instants=[('migration-time-'+hashlib.sha256(m['id'].encode()).hexdigest()[:12],m) for m in model['messages']]
    existing=set(ids.values())|{m['id'] for m in model['messages']}
    if face in existing or any(name in existing for name,_ in instants):raise HypitRuntimeError('迁移生成标识符发生冲突')
    lines=['<?svml using="@hypit/markup@1"?>','<svml>']
    for alias,module in [('time','timeline-author'),('spatial','spatial'),('media','media'),('fonts','fontsource'),('chat','@example/chat-scene'),('film','film'),('html','html-video')]:
        address=module if module.startswith('@') else '@hypit/'+module
        lines.append(f'  <import as="{alias}" from="{address}@1"/>')
    lines.append('  <import as="style" source="./chat.svs"/>')
    lines += [f'  <time:Clock id="{q(clock)}" frame-rate="{model["fps"]}"/>',f'  <time:Timeline id="{q(timeline)}" clock={{{clock}}} end="{q(model["end"])}">']
    lines.extend(f'    <time:Instant id="{name}" at="{q(m["at"])}"/>' for name,m in instants)
    lines += ['  </time:Timeline>',f'  <spatial:Canvas id="{q(canvas)}" width="{model["width"]}" height="{model["height"]}"/>',f'  <fonts:Face id="{face}" package="@fontsource-variable/inter" weight="{model["weight"]}" style="{q(model["font_style"])}"/>',f'  <media:FontStack id="{q(font)}" primary={{{face}}}/>',f'  <chat:Scene id="{q(scene)}" timeline={{{timeline}.timeline}} within={{{canvas}.bounds}} font={{{font}}} during={{{timeline}.window}} title="{q(model["title"])}" entrance-frames="{model["entrance"]}">']
    lines.extend(f'    <chat:Message id="{q(m["id"])}" sender="{q(m["sender"])}" side="{m["side"]}" at={{{timeline}.{name}}} text="{q(m["text"])}"/>' for name,m in instants)
    lines += ['  </chat:Scene>',f'  <film:Film id="{q(film)}" canvas={{{canvas}.canvas}} timeline={{{timeline}.timeline}} appearance={{style.film.main}}>',f'    <film:Track source={{{scene}.visual}}/>','  </film:Film>',f'  <html:Video id="{q(video)}" composition={{{film}.composition}} timeline={{{timeline}.timeline}}/>','</svml>','']
    return '\n'.join(lines)


def _inventory(project: Path) -> dict[str,str]:
    values={}
    for current,dirs,files in os.walk(project,followlinks=False):
        current=Path(current);dirs[:]=[name for name in dirs if name not in {'node_modules','.git','__pycache__'} and not (current/name).is_symlink()]
        for name in files:
            path=current/name
            if name=='.env' or name.startswith('.env.') or path.is_symlink():continue
            if path.is_file():values[path.relative_to(project).as_posix()]=digest(path)
            if len(values)>20000:raise HypitRuntimeError('工程文件较多，需要单独迁移')
    return values


def inspect_legacy(old: HypitRuntime, project_id: str) -> dict:
    project=old.project(project_id)
    try:files=_inventory(project)
    except OSError as exc:raise HypitRuntimeError('无法完整读取旧工程，未创建迁移副本') from exc
    fingerprint=hashlib.sha256(json.dumps(files,sort_keys=True).encode()).hexdigest()
    if (project/'reference.svml').exists() and not (project/'chat.svml').exists():
        from web_api.hypit_reference_migration import inspect_reference
        return inspect_reference(old,project_id,files,fingerprint)
    problems=[];model=None
    try:
        if (project/'reference.svml').exists():
            raise HypitRuntimeError('工程同时包含多种作者入口，需要逐项迁移，未忽略其他入口')
        for path in project.glob('artifacts/hypit_jobs/hypit-*/job.json'):
            if json.loads(path.read_text()).get('status') in {'queued','running','cancelling'}:raise HypitRuntimeError('旧工程存在未结束任务，先处理该会话')
        if any(p.is_symlink() for p in (project/'exports').rglob('*')):
            raise HypitRuntimeError('原版导出目录含符号链接，需单独核对，不自动展开')
        model=chat_model(_read(project/'chat.svml'))
        recipe=_read(project/'chat.svs')
        if not recipe.startswith('<?svml using="@hypit/svs@1"?>'):raise HypitRuntimeError('旧Recipe入口不在此迁移契约内')
        run=_parse(_read(project/'chat.svrun'))
        if run.tag!='svrun' or run.attrib!={'version':'1'} or [(n.tag,n.attrib) for n in run]!=[('author',{'source':'./chat.svml'}),('target',{'output':model['ids']['video']+'.video'})]:raise HypitRuntimeError('Run包含其他Target/Candidate或复用声明，不能自动舍弃')
        baseline=old.hypit_root/'examples/semantic-composition/packages/chat-scene'
        for name in ['src/activation.ts','src/render.ts','package.json','tsconfig.json']:
            actual=project/'packages/chat-scene'/name
            if not actual.is_file() or actual.is_symlink() or actual.read_bytes()!=(baseline/name).read_bytes():raise HypitRuntimeError('项目组件已自定义，需逐项迁移SDK而不是替换成官方组件')
        profile=json.loads(_read(project/'hypit.runtime.json'))
        if not isinstance(profile,dict) or profile.get('format') not in {'hypit.runtime-local@1','hypit.runtime@1'}:
            raise HypitRuntimeError('Runtime Profile格式不在迁移契约内')
        if set(profile)-{'format','dataRoot','endpoints'}:
            raise HypitRuntimeError('Profile含额外存储或凭据字段，需单独迁移，不复制其内容')
        if not isinstance(profile.get('endpoints'),dict) or not profile['endpoints'] or any(not isinstance(row,dict) or row.get('use') not in OLD_USES for row in profile['endpoints'].values()):raise HypitRuntimeError('其他Provider需单独核对迁移，不自动替换服务配置')
        for row in profile['endpoints'].values():
            if set(row)-{'use','config'}:raise HypitRuntimeError('Endpoint含额外配置，需单独核对，不自动省略')
            config=row.get('config',{})
            allowed={'ffmpegPath','ffprobePath','defaultConcurrency'}
            if row['use'].endswith('hyperframes-local'):
                allowed|={'nodePath','chromePath','workers','maxWorkers','quality','browserGpu'}
            if not isinstance(config,dict) or set(config)-allowed:raise HypitRuntimeError('Provider含未适配配置项，未自动丢弃')
            if any(key.endswith('Path') and (not isinstance(value,str) or not Path(value).is_absolute()) for key,value in config.items()):raise HypitRuntimeError('相对工具路径需要单独检查，不自动改变解析位置')
            if any(key not in {'browserGpu'} and not key.endswith('Path') and (isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or value<0 or value>100) for key,value in config.items()):raise HypitRuntimeError('本机Provider参数类型无效，未复制配置')
            if 'browserGpu' in config and config['browserGpu'] not in {'auto','software','hardware'}:raise HypitRuntimeError('浏览器渲染方式无效')
        def secrets(value):
            if isinstance(value,dict):
                for key,item in value.items():
                    if SENSITIVE.search(key):raise HypitRuntimeError('Profile包含凭据字段，不复制或打印；请在新工程单独配置')
                    secrets(item)
            elif isinstance(value,list):
                for item in value:secrets(item)
        secrets(profile)
    except (HypitRuntimeError,OSError,ValueError,TypeError,KeyError) as exc:
        problems.append(str(exc) if isinstance(exc,HypitRuntimeError) else '工程结构不完整或配置无效，需要单独检查')
    exports=[{'path':name,'sha256':sha,'bytes':(project/name).stat().st_size} for name,sha in files.items() if name.startswith('exports/') and Path(name).suffix.lower() in MEDIA_SUFFIXES]
    return {'project_id':project_id,'source_version':'0.2.12','target_version':'0.3.1','supported':not problems,'contract':'official-semantic-chat-v1' if not problems else None,'fingerprint':fingerprint,'source_files_count':len(files),'preserved_exports':exports,'diagnostics':problems,'message':'将另存副本；升级已核对的官方组件并保留原消息、时间、画幅和已导出媒体' if not problems else '保留旧工程；此结构需要单独适配，未进行全局替换'}


def migrate_legacy(old: HypitRuntime, new: HypitRuntime, project_id: str, expected_fingerprint: str) -> dict:
    preview=inspect_legacy(old,project_id)
    if not preview['supported']:raise HypitRuntimeError('；'.join(preview['diagnostics']))
    if preview['fingerprint']!=expected_fingerprint:raise HypitRuntimeError('旧工程已变化，请重新检查；没有创建迁移副本')
    source=old.project(project_id);source_map=_inventory(source)
    if hashlib.sha256(json.dumps(source_map,sort_keys=True).encode()).hexdigest()!=preview['fingerprint']:
        raise HypitRuntimeError('旧工程在检查后发生变化，没有创建副本')
    if sum((source/name).stat().st_size for name in source_map)>512*1024*1024:
        raise HypitRuntimeError('旧工程超过512MB，需单独规划复制范围，未创建副本')
    if preview['contract']=='openmontage-reference-three-track-v1':
        from web_api.hypit_reference_migration import copy_reference
        return copy_reference(old,new,project_id,preview,source_map)
    project_name='hypit-migrated-'+datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:8]
    target=new.project_root/project_name;target.mkdir(exist_ok=False)
    state=target/'.migration/job.json';state.parent.mkdir()
    state.write_text(json.dumps({'status':'running','operation':'migration','source_project_id':project_id}))
    try:
        def copy_file(src: Path,dst: Path):
            if src.is_symlink() or not src.is_file():raise HypitRuntimeError('迁移不展开来源符号链接')
            dst.parent.mkdir(parents=True,exist_ok=True)
            with src.open('rb') as inp,dst.open('xb') as output:shutil.copyfileobj(inp,output)
            if src.is_relative_to(source) and digest(dst)!=source_map.get(src.relative_to(source).as_posix()):
                raise HypitRuntimeError('复制来源发生变化，副本已保留供检查')
        def write(name: str,text: str):
            p=target/name;p.parent.mkdir(parents=True,exist_ok=True)
            with p.open('x',encoding='utf-8') as stream:stream.write(text)
        # Keep old Author/Recipe/Run and component implementation out of active
        # package discovery, while preserving original Results in the old project.
        for name in ['chat.svml','chat.svs','chat.svrun']:
            copy_file(source/name,target/'.migration/original'/name)
        component=source/'packages/chat-scene'
        for p in component.rglob('*'):
            if p.is_file() and not p.is_symlink() and 'node_modules' not in p.relative_to(component).parts:
                rel=p.relative_to(component);dest=target/'.migration/original/packages/chat-scene'/rel
                if p.name=='package.json':dest=dest.with_name('package.json.original')
                copy_file(p,dest)
        model=chat_model(_read(target/'.migration/original/chat.svml'))
        write('chat.svml',render_chat(model))
        write('chat.svs',_read(target/'.migration/original/chat.svs').replace('<?svml using="@hypit/svs@1"?>','<?svml using="@hypit/recipe@1"?>',1))
        write('chat.svrun',_read(target/'.migration/original/chat.svrun').replace('<?svml using="@hypit/run-markup@1"?>','<?svml using="@hypit/markup/run@1"?>',1))
        modern=new.hypit_root/'examples/semantic-composition/packages/chat-scene'
        for p in modern.rglob('*'):
            rel=p.relative_to(modern)
            if p.is_file() and not p.is_symlink() and not any(part in {'node_modules','dist'} for part in rel.parts):copy_file(p,target/'packages/chat-scene'/rel)
        # Link only declared, installed dependencies of the official new component.
        dependencies=new._link_example_dependencies(new.hypit_root/'examples/semantic-composition',target)
        if dependencies['unavailable']:raise HypitRuntimeError('新组件的本机依赖未完整安装，已保留副本，未执行安装或生成')
        profile=json.loads(_read(source/'hypit.runtime.json'));profile['dataRoot']='.hypit/runtimes/migrated-local'
        for row in profile['endpoints'].values():
            row['use']=OLD_USES[row['use']]
            if row['use']=='@hypit/provider-html-local':
                row.setdefault('config',{}).setdefault('nodePath',shutil.which(new.settings.node_executable) or new.settings.node_executable)
                row['config'].setdefault('browserGpu','software')
        write('hypit.runtime.json',json.dumps(profile,ensure_ascii=False,indent=2)+'\n')
        write('.hypit/runtime','hypit.runtime.json\n')
        compiler=(new.hypit_root/'node_modules/typescript/bin/tsc').resolve()
        if not compiler.is_relative_to(new.hypit_root.resolve()) or not compiler.is_file():raise HypitRuntimeError('固定发行版TypeScript编译器未就绪，副本已保留')
        result=_run_subprocess([new.settings.node_executable,str(compiler),'-p',str(target/'packages/chat-scene/tsconfig.json')],cwd=target,env=new._command_env(target),cancel_event=threading.Event(),timeout_seconds=90)
        if result.returncode!=0 or not all((target/'packages/chat-scene/dist'/name).is_file() for name in ['activation.js','render.js']):raise HypitRuntimeError('新组件构建失败，副本已保留；没有改动旧工程或提交生成')
        exports=[]
        for item in preview['preserved_exports']:
            original=Path(item['path']);stem=re.sub(r'[^A-Za-z0-9._-]','-',original.stem)[:48].strip('-') or 'media'
            path_key=hashlib.sha256(item['path'].encode()).hexdigest()[:12]
            name='exports/legacy-'+item['sha256'][:12]+'-'+path_key+'-'+stem+original.suffix.lower()
            copy_file(source/item['path'],target/name)
            if digest(target/name)!=item['sha256']:raise HypitRuntimeError('原媒体复制校验失败，旧工程保持不变')
            exports.append({**item,'source_path':item['path'],'path':name,'reused_without_generation':True})
        after=inspect_legacy(old,project_id)
        if after['fingerprint']!=preview['fingerprint']:raise HypitRuntimeError('复制期间旧工程发生变化；保留部分副本，请重新检查')
        receipt={'format':'openmontage.hypit-migration@1','contract':preview['contract'],'source_project_id':project_id,'target_project_id':project_name,'source_version':'0.2.12','target_version':'0.3.1','source_fingerprint':preview['fingerprint'],'original_unchanged':True,'old_results':'preserved_in_source_project_not_rewritten','accepted_media':exports,'authoring_summary':{'message_count':len(model['messages']),'message_ids':[m['id'] for m in model['messages']],'arrival_times':[m['at'] for m in model['messages']],'width':model['width'],'height':model['height'],'fps':model['fps'],'end':model['end'],'content_sha256':hashlib.sha256(json.dumps(model,sort_keys=True,ensure_ascii=False).encode()).hexdigest()},'dependencies':dependencies,'component_upgrade':'verified_official_0.2_component_to_official_0.3.1_source_rebuilt','compiler_exit_code':result.returncode,'source_check':'pending','paid_calls':0,'generation_submitted':False}
        write('migration.receipt.json',json.dumps(receipt,ensure_ascii=False,indent=2)+'\n')
        state.write_text(json.dumps({'status':'completed','operation':'migration','source_project_id':project_id,'source_check':'pending'}))
        return {'hypit_project_id':project_name,'migration_status':'copied_needs_check','receipt':receipt,'author_source':'chat.svml','run_source':'chat.svrun','message':'迁移副本与原版成片已保留；请检查新作者文件和执行计划，未重新生成媒体。'}
    except Exception:
        state.write_text(json.dumps({'status':'failed','operation':'migration','source_project_id':project_id,'message':'迁移未完成；原工程保持，部分副本保留供检查'}))
        raise
