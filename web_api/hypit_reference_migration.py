"""Copy the known legacy reference bridge without changing its source project."""
from __future__ import annotations

import copy
import hashlib
import json
import math
import re
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit

from web_api.hypit_bridge_migration import bridge_model, render_bridge
from web_api.hypit_bridge import _MEDIA_EXTS
from web_api.hypit_runtime import HypitRuntimeError, MEDIA_SUFFIXES

CONTRACT = 'openmontage-reference-three-track-v1'
DOCUMENTS = ('reference.svml','reference.svs','reference.svrun','package.json',
             'assets.manifest.json','bridge.manifest.json','variants.json','NEEDS.md')
USES = {'@hypit/provider-media-local':'@hypit/media-local',
        '@hypit/provider-hyperframes-local':'@hypit/provider-html-local',
        '@hypit/provider-whisperx-local':'@hypit/provider-whisperx-local'}


def _profile(value: dict) -> dict:
    if not isinstance(value,dict) or set(value)-{'format','dataRoot','endpoints','credentials','bindings'}:
        raise HypitRuntimeError('旧Profile含其他配置，需独立适配')
    if value.get('format') not in {'hypit.runtime-local@1','hypit.runtime@1'} or value.get('credentials',{}) != {}:
        raise HypitRuntimeError('旧Profile包含凭据或格式未知，不复制凭据')
    endpoints=value.get('endpoints')
    if not isinstance(endpoints,dict) or not endpoints:
        raise HypitRuntimeError('旧Profile缺少本机处理配置')
    for name,row in endpoints.items():
        if not re.fullmatch(r'[A-Za-z0-9._-]{1,80}',name) or not isinstance(row,dict) or set(row)-{'use','config'} or row.get('use') not in USES:
            raise HypitRuntimeError('桥接包含未核对的处理服务，未替换服务选择')
        config=row.get('config',{});use=row['use']
        allowed={'ffmpegPath','ffprobePath','defaultConcurrency'}
        if use.endswith('hyperframes-local'):
            allowed|={'nodePath','chromePath','workers','maxWorkers','quality','browserGpu'}
        if use.endswith('whisperx-local'):
            allowed={'baseUrl','expectedModel','expectedDevice','expectedCompute','expectedBatchSize',
                     'expectedServiceVersion','expectedWhisperXVersion','defaultConcurrency',
                     'requestTimeoutMs','maxResponseBytes','alignmentLanguages'}
        if not isinstance(config,dict) or set(config)-allowed:
            raise HypitRuntimeError('处理服务配置含未适配项，未丢弃或执行额外命令')
        for key,item in config.items():
            valid=False
            if key.endswith('Path'):
                valid=isinstance(item,str) and Path(item).is_absolute() and '\x00' not in item
            elif key=='baseUrl':
                try:
                    url=urlsplit(item);valid=(url.scheme=='http' and url.hostname in {'127.0.0.1','localhost','::1'} and not url.username and not url.password and not url.query and not url.fragment)
                except (ValueError,TypeError):valid=False
            elif key=='quality':valid=item in ['draft','standard','high']
            elif key=='browserGpu':valid=item in ['auto','software','hardware']
            elif key=='workers' and item=='auto':valid=True
            elif key=='alignmentLanguages':valid=isinstance(item,list) and 0<len(item)<=20 and all(isinstance(x,str) and re.fullmatch('[a-z]{2,3}',x) for x in item)
            elif key.startswith('expected') and key!='expectedBatchSize':valid=isinstance(item,str) and bool(re.fullmatch(r'[A-Za-z0-9._-]{1,80}',item))
            else:valid=isinstance(item,(int,float)) and not isinstance(item,bool) and math.isfinite(item) and item==int(item) and 0<item<=64*1024*1024
            if not valid:raise HypitRuntimeError('处理服务配置值无效，未复制原配置')
    bindings=value.get('bindings',{})
    if not isinstance(bindings,dict):raise HypitRuntimeError('旧服务绑定无效')
    for capability,name in bindings.items():
        if capability!='@hypit/whisperx@1#whisperx-alignment' or not isinstance(name,str) or endpoints.get(name,{}).get('use')!='@hypit/provider-whisperx-local':
            raise HypitRuntimeError('其他服务绑定需要逐项迁移，未改为自动选择')
    result=copy.deepcopy(value);result['dataRoot']='.hypit/runtimes/migrated-local'
    for row in result['endpoints'].values():row['use']=USES[row['use']]
    return result


def _data(project: Path, files: dict) -> dict:
    from web_api.hypit_migration import _read, _parse, digest
    for name in DOCUMENTS:
        _read(project/name)
    extra=[name for name in files if Path(name).suffix in {'.svml','.svs','.svrun'} and name not in DOCUMENTS and not name.startswith(('.hypit/','artifacts/'))]
    if extra or any(name.startswith('packages/') for name in files):
        raise HypitRuntimeError('工程含额外作者文件或自定义组件，需要完整适配')
    model=bridge_model(_read(project/'reference.svml'),_read(project/'reference.svs'))
    if model['width']%2 or model['height']%2:
        raise HypitRuntimeError('旧作者画幅为奇数，H.264无法直接编码；请另存偶数画幅版本后再迁移，原工程未改写')
    run_text=_read(project/'reference.svrun');run=_parse(run_text)
    if not run_text.startswith('<?svml using="@hypit/run-markup@1"?>') or run.tag!='svrun' or run.attrib!={'version':'1'} or [(n.tag,n.attrib) for n in run]!=[('author',{'source':'./reference.svml'}),('target',{'output':'final.video'})] or any(len(n) or (n.text or '').strip() or (n.tail or '').strip() for n in run) or (run.text or '').strip():
        raise HypitRuntimeError('Run含其他输出/复用/候选关系，未舍弃')
    profile=_profile(json.loads(_read(project/'hypit.runtime.json')))
    manifest=json.loads(_read(project/'assets.manifest.json'))
    if not isinstance(manifest,dict) or manifest.get('asset_mode')!='copy' or not isinstance(manifest.get('assets'),list):
        raise HypitRuntimeError('仅对自包含素材副本迁移；外部引用需另行核对')
    assets={};paths=set()
    for row in manifest['assets']:
        if not isinstance(row,dict) or not isinstance(row.get('id'),str) or row['id'] in assets:
            raise HypitRuntimeError('素材清单编号无效或重复')
        raw=row.get('package_path');path=PurePosixPath(raw) if isinstance(raw,str) else PurePosixPath('/')
        if not isinstance(raw,str) or '\\' in raw or path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0]!='assets' or path.suffix.lower() not in _MEDIA_EXTS or row.get('mode')!='copy':
            raise HypitRuntimeError('素材路径不是工程内已复制媒体')
        relative=path.as_posix();actual=project/relative
        if relative in paths or relative not in files or any((project/Path(*path.parts[:i])).is_symlink() for i in range(1,len(path.parts)+1)) or not actual.resolve().is_relative_to(project.resolve()):
            raise HypitRuntimeError('素材路径重复、缺失或含外部链接')
        if files[relative]!=row.get('sha256') or actual.stat().st_size!=row.get('size_bytes') or digest(actual)!=row['sha256']:
            raise HypitRuntimeError('素材已变化或清单与原文件不符，请先核对')
        assets[row['id']]={**row,'copy_path':relative};paths.add(relative)
    if any(s['id'] not in assets or s['src']!=assets[s['id']]['package_path'] for s in model['sources']):
        raise HypitRuntimeError('作者来源与素材清单不一致，未猜测替换')
    variants=json.loads(_read(project/'variants.json'))
    rows=variants.get('variants') if isinstance(variants,dict) else None
    if not isinstance(rows,list) or len(rows)!=variants.get('count') or any(not isinstance(row,dict) or row.get('run')!='reference.svrun' for row in rows):
        raise HypitRuntimeError('变体含其他运行入口，需要逐项迁移')
    package=json.loads(_read(project/'package.json'))
    if not isinstance(package,dict) or set(package)-{'name','version','private','type','description'} or package.get('type')!='module':
        raise HypitRuntimeError('工程包包含额外依赖或脚本，需要单独适配')
    return {'model':model,'profile':profile,'assets':list(assets.values())}


def inspect_reference(old, project_id: str, files: dict, fingerprint: str) -> dict:
    from web_api.hypit_migration import _read
    project=old.project(project_id);problems=[];data=None
    try:
        for path in project.glob('artifacts/hypit_jobs/hypit-*/job.json'):
            if json.loads(_read(path)).get('status') in {'queued','running','cancelling'}:
                raise HypitRuntimeError('旧工程仍有未结束任务，先处理该会话')
        if (project/'exports').is_symlink() or any(p.is_symlink() for p in (project/'exports').rglob('*')):
            raise HypitRuntimeError('原导出含链接，不自动展开')
        data=_data(project,files)
    except (HypitRuntimeError,OSError,ValueError,TypeError,KeyError) as exc:
        problems.append(str(exc) if isinstance(exc,HypitRuntimeError) else '桥接资料或配置无效，需要核对')
    return {'project_id':project_id,'source_version':'0.2.12','target_version':'0.3.1',
            'supported':not problems,'contract':CONTRACT if not problems else None,
            'fingerprint':fingerprint,'source_files_count':len(files),'diagnostics':problems,
            'preserved_exports':[{'path':name,'sha256':sha,'bytes':(project/name).stat().st_size} for name,sha in files.items() if name.startswith('exports/') and Path(name).suffix.lower() in MEDIA_SUFFIXES],
            'preserved_asset_count':len(data['assets']) if data else 0,
            'author_source':'reference.svml','run_source':'reference.svrun',
            'runtime_check':'pending','requires_speech_alignment':bool(data and any(s['text'].strip() for s in data['model']['shots'])),
            'message':'可以另存完整素材与三轨作者副本；有词字幕仍需本机对齐服务，通过执行计划后才可生成。' if not problems else '保留旧工程；此桥接还不能自动迁移。'}


def copy_reference(old,new,project_id: str,preview: dict,source_map: dict) -> dict:
    from web_api.hypit_migration import _inventory, _read, digest
    source=old.project(project_id);data=_data(source,source_map)
    name='hypit-migrated-'+datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:8]
    target=new.project_root/name;target.mkdir(exist_ok=False)
    state=target/'.migration/job.json';state.parent.mkdir()
    state.write_text(json.dumps({'status':'running','operation':'migration','source_project_id':project_id}))
    try:
        def write(relative,text):
            dest=target/relative;dest.parent.mkdir(parents=True,exist_ok=True)
            with dest.open('x',encoding='utf-8') as stream:stream.write(text)
        def cp(relative,destination):
            src=source/relative;dst=target/destination
            if src.is_symlink() or not src.resolve().is_relative_to(source.resolve()) or digest(src)!=source_map.get(relative):
                raise HypitRuntimeError('复制来源发生变化，原工程与部分副本保留')
            dst.parent.mkdir(parents=True,exist_ok=True)
            with src.open('rb') as inp,dst.open('xb') as out:shutil.copyfileobj(inp,out)
            if digest(dst)!=source_map[relative]:raise HypitRuntimeError('复制校验失败，保留部分副本')
        for document in DOCUMENTS:
            original='.migration/original/'+document+('.original' if document=='package.json' else '')
            cp(document,original)
        for document in ['package.json','assets.manifest.json','bridge.manifest.json','variants.json','NEEDS.md']:cp(document,document)
        for row in data['assets']:cp(row['copy_path'],row['copy_path'])
        write('reference.svml',render_bridge(data['model']))
        write('reference.svs',data['model']['recipe'].replace('@hypit/svs@1','@hypit/recipe@1',1))
        write('reference.svrun',_read(source/'reference.svrun').replace('@hypit/run-markup@1','@hypit/markup/run@1',1))
        profile=data['profile']
        write('hypit.runtime.json',json.dumps(profile,ensure_ascii=False,indent=2)+'\n')
        write('.hypit/runtime','hypit.runtime.json\n')
        dependencies=new._link_example_dependencies(new.hypit_root/'examples/semantic-composition',target)
        if dependencies['unavailable']:raise HypitRuntimeError('新版本机字体依赖不完整，副本保留，未下载或生成')
        exports=[]
        for item in preview['preserved_exports']:
            original=Path(item['path']);stem=re.sub(r'[^A-Za-z0-9._-]','-',original.stem)[:48].strip('-') or 'media'
            key=hashlib.sha256(item['path'].encode()).hexdigest()[:12]
            relative='exports/legacy-'+item['sha256'][:12]+'-'+key+'-'+stem+original.suffix.lower()
            cp(item['path'],relative);exports.append({**item,'source_path':item['path'],'path':relative,'reused_without_generation':True})
        if _inventory(source)!=source_map:raise HypitRuntimeError('复制期间旧工程发生变化；部分副本保留，请重新检查')
        receipt={'format':'openmontage.hypit-migration@1','contract':CONTRACT,'source_project_id':project_id,
                 'target_project_id':name,'source_version':'0.2.12','target_version':'0.3.1',
                 'source_fingerprint':preview['fingerprint'],'original_unchanged':True,
                 'old_results':'preserved_in_source_project_not_rewritten','accepted_media':exports,
                 'copied_assets':[{'id':a['id'],'path':a['copy_path'],'sha256':a['sha256']} for a in data['assets']],
                 'author_source':'reference.svml','run_source':'reference.svrun','dependencies':dependencies,
                 'authoring_summary':{'source_order':[data['model']['by_shot'][s['id']] for s in data['model']['shots']],
                     'segment_ids':[s['id'] for s in data['model']['shots']],'width':data['model']['width'],
                     'height':data['model']['height'],'fps':data['model']['fps'],'tracks':['picture','soundtrack','captions']},
                 'source_check':'pending','runtime_check':'pending','requires_speech_alignment':preview['requires_speech_alignment'],
                 'paid_calls':0,'generation_submitted':False}
        write('migration.receipt.json',json.dumps(receipt,ensure_ascii=False,indent=2)+'\n')
        state.write_text(json.dumps({'status':'completed','operation':'migration','source_check':'pending','source_project_id':project_id}))
        return {'hypit_project_id':name,'migration_status':'copied_needs_check','receipt':receipt,
                'author_source':'reference.svml','run_source':'reference.svrun','message':preview['message']}
    except Exception:
        state.write_text(json.dumps({'status':'failed','operation':'migration','source_project_id':project_id,'message':'迁移未完成；原工程和部分副本保留'}))
        raise
