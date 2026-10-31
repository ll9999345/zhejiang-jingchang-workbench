"""Owned, explicit lifecycle for the local CPU Chinese speech adapter.

No process commands, executable paths, ports, input roots or model IDs come
from HTTP. Profiles are backed up before an explicit binding change. External
processes are observed but never adopted or stopped by a guessed PID.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading
import urllib.error
import urllib.request
import uuid

from tools.analysis.hypit_speech_service import IDENTITY, ROOT
from web_api.hypit_runtime import HypitRuntimeError, _safe_env
from web_api.hypit_reference_migration import _profile as validate_local_profile

CAPABILITY = '@hypit/whisperx@1#whisperx-alignment'
ENDPOINT = 'openmontage.cpu.zh'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class SpeechServiceController:
    def __init__(self, manager, *, port=8766, popen=subprocess.Popen):
        self.manager = manager
        self.port = port
        self.base_url = f'http://127.0.0.1:{port}'
        local_python = ROOT / '.venv/bin/python'
        self.python = local_python if local_python.is_file() else Path(sys.executable)
        self.script = ROOT / 'tools/analysis/hypit_speech_service.py'
        self.process = None
        self.owner = None
        self.instance = None
        self.lock = threading.RLock()
        self.popen = popen
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def _http(self, path, body=None):
        req = urllib.request.Request(self.base_url + path, data=None if body is None else json.dumps(body).encode(),
                                     headers={} if body is None else {'Content-Type': 'application/json'})
        with self.opener.open(req, timeout=.8) as response:
            raw = response.read(16385)
        if len(raw)>16384:
            raise ValueError('服务状态过长')
        return json.loads(raw)

    def _health(self):
        try:
            result = self._http('/health')
            return result if isinstance(result, dict) else None
        except (OSError, ValueError):
            return None

    def _port_used(self):
        with socket.socket() as probe:
            probe.settimeout(.2)
            return probe.connect_ex(('127.0.0.1', self.port)) == 0

    def _selected(self, project_id):
        if self.manager.distribution_version != '0.3.1':
            raise HypitRuntimeError('本机中文语音入口用于 Hypit 0.3.1')
        project = self.manager.project(project_id)
        self.manager.project_id(project)
        if project == self.manager.project_root:
            raise HypitRuntimeError('请先选择具体工程')
        path = self.manager._profile_path(project)
        if path is None or path.is_symlink() or path.stat().st_size>262144:
            raise HypitRuntimeError('当前工程没有可编辑的本机运行配置')
        raw = path.read_bytes()
        try:
            value = json.loads(raw)
        except ValueError:
            raise HypitRuntimeError('工程配置无法读取，未修改') from None
        return project, path, raw, value

    def _endpoint(self):
        return {'use':'@hypit/provider-whisperx-local','config':{
            'baseUrl':self.base_url,'expectedModel':IDENTITY['model'],'expectedDevice':'cpu',
            'expectedCompute':'int8','expectedBatchSize':1,
            'expectedServiceVersion':IDENTITY['serviceVersion'],
            'expectedWhisperXVersion':IDENTITY['whisperxVersion'],
            'defaultConcurrency':1,'requestTimeoutMs':120000,
            'serviceCommand':[str(self.python),str(self.script),'--managed-by-workbench'],
        }}

    def _configured(self, value):
        return (isinstance(value,dict) and isinstance(value.get('bindings',{}),dict)
                and isinstance(value.get('endpoints'),dict)
                and value.get('bindings',{}).get(CAPABILITY)==ENDPOINT
                and value['endpoints'].get(ENDPOINT)==self._endpoint())

    def _validate(self, value):
        # Validate before writing a backup: never copy credentials or shell
        # launch commands from an unknown Profile into another file.
        check = copy.deepcopy(value)
        if not isinstance(check,dict) or not isinstance(check.get('endpoints'),dict):
            raise HypitRuntimeError('运行配置格式无效')
        endpoint = check['endpoints'].get(ENDPOINT)
        if endpoint is not None:
            if endpoint != self._endpoint():
                raise HypitRuntimeError('本机语音配置名称已被其他配置使用，未覆盖')
            check['endpoints'][ENDPOINT]['config'].pop('serviceCommand')
        for row in check['endpoints'].values():
            if isinstance(row,dict):
                if not isinstance(row.get('use'),str):
                    raise HypitRuntimeError('处理服务类型无效')
                row['use']={'@hypit/media-local':'@hypit/provider-media-local',
                            '@hypit/provider-html-local':'@hypit/provider-hyperframes-local'}.get(row.get('use'),row.get('use'))
        try:
            validate_local_profile(check)
        except (TypeError,AttributeError,KeyError):
            raise HypitRuntimeError('运行配置类型无效') from None

    def status(self, project_id):
        with self.lock:
            project, _, raw, value = self._selected(project_id)
            configured = self._configured(value)
            reason = ''
            try:
                self._validate(value)
                eligible = True
            except HypitRuntimeError:
                eligible = False
                reason = '此工程含自定义或外部服务配置，需要单独接入；原配置保留。'
            health = self._health()
            live = bool(self.process is not None and self.process.poll() is None)
            ours = bool(live and self.owner==project and health and health.get('instanceId')==self.instance
                        and all(health.get(k)==v for k,v in IDENTITY.items()))
            if ours:
                state = 'busy' if health.get('busy') else 'stopping' if health.get('stopping') else 'running'
                message = {'running':'本机中文语音已运行，可以检查计划并渲染。','busy':'正在识别和对齐，完成后才能停止。','stopping':'本机语音正在停止。'}[state]
            elif live:
                state = 'starting' if self.owner==project and not health else 'unmanaged' if self.owner==project else 'other_project'
                message = '本机语音正在启动。' if state=='starting' else '语音端口状态与本次进程不符，未接管或停止。' if state=='unmanaged' else '本机语音正由其他工程使用，请在原工程停止后切换。'
            elif health or self._port_used():
                state = 'unmanaged';message = '语音端口由其他会话占用；此处不会接管或停止它。'
            elif self.owner==project and self.process is not None and self.process.returncode not in (None,0):
                state = 'failed';message = '语音服务未启动成功，请核对本机模型与依赖；没有自动安装或重试。'
            else:
                state = 'stopped';message = '本机中文语音未启动。' if configured else '尚未启用本机中文语音；启用时备份原配置并切换当前工程的对齐服务。'
            return {'state':state,'message':message,'configured':configured,'profile_sha256':hashlib.sha256(raw).hexdigest(),
                    'can_start':eligible and state in {'stopped','failed'},'can_stop':ours and state=='running',
                    'eligible':eligible,'configuration_note':reason,'languages':['zh'],'max_duration_seconds':30,
                    'implementation':IDENTITY['implementation'],'official_distribution':False}

    def _idle(self, project):
        if any(job.get('status') in {'queued','running','cancelling'} for job in self.manager.list(project)):
            raise HypitRuntimeError('此工程仍有任务执行中，完成后再调整语音配置或停止服务')

    def start(self, project_id, *, fingerprint, configure=False):
        with self.lock, self.manager._lock:
            status = self.status(project_id)
            if status['state'] in {'running','busy','starting'}:
                return status
            if not status['can_start']:
                raise HypitRuntimeError(status['configuration_note'] or status['message'])
            project, profile, original, value = self._selected(project_id)
            if hashlib.sha256(original).hexdigest()!=fingerprint:
                raise HypitRuntimeError('工程配置已经变化，请刷新后再启用')
            if not status['configured'] and not configure:
                raise HypitRuntimeError('请明确选择启用并启动，原配置会保留')
            self._idle(project)
            if not self.python.is_file() or not self.script.is_file():
                raise HypitRuntimeError('本机语音启动程序未就绪，没有安装或修改工程')
            if not status['configured']:
                self._validate(value)
                folder = project / 'artifacts/hypit_speech' / ('configuration-'+uuid.uuid4().hex)
                if not folder.resolve().is_relative_to(project):
                    raise HypitRuntimeError('配置备份目录超出工程范围')
                folder.mkdir(parents=True,exist_ok=False)
                (folder/'original.runtime.json').write_bytes(original)
                updated = copy.deepcopy(value)
                updated.setdefault('endpoints',{})[ENDPOINT] = self._endpoint()
                updated.setdefault('bindings',{})[CAPABILITY] = ENDPOINT
                body = (json.dumps(updated,ensure_ascii=False,indent=2)+'\n').encode()
                pending = folder/'selected.runtime.json'
                pending.write_bytes(body)
                if profile.read_bytes()!=original:
                    raise HypitRuntimeError('备份期间工程配置变化，未覆盖；备份保留')
                os.replace(pending,profile)
                (folder/'receipt.json').write_text(json.dumps({'operation':'select-local-chinese-speech',
                    'profile_path':str(profile.relative_to(project)),'before_sha256':fingerprint,
                    'after_sha256':hashlib.sha256(body).hexdigest(),'previous_profile':'original.runtime.json',
                    'official_distribution':False,'paid_calls':0},indent=2))
            instance = uuid.uuid4().hex
            output = project/'artifacts/hypit_speech'/('session-'+instance)
            if not output.resolve().is_relative_to(project):
                raise HypitRuntimeError('语音输出目录超出工程范围')
            output.mkdir(parents=True,exist_ok=False)
            command = [str(self.python),'-m','tools.analysis.hypit_speech_service','--port',str(self.port),'--input-root',str(project),
                       '--output-dir',str(output),'--instance-id',instance]
            try:
                process = self.popen(command,cwd=ROOT,env=_safe_env(),stdin=subprocess.DEVNULL,
                                     stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
            except OSError:
                raise HypitRuntimeError('语音进程未能启动；原配置备份与本次目录已保留') from None
            self.process,self.owner,self.instance = process,project,instance
            return self.status(project_id)

    def stop(self, project_id):
        with self.lock, self.manager._lock:
            project, _, _, _ = self._selected(project_id)
            state = self.status(project_id)
            if state['state']=='stopped':
                return state
            if not state['can_stop']:
                raise HypitRuntimeError(state['message'])
            self._idle(project)
            try:
                self._http('/shutdown',{'instance_id':self.instance})
                self.process.wait(timeout=4)
            except (OSError,ValueError,subprocess.TimeoutExpired):
                raise HypitRuntimeError('服务尚未确认停止，请刷新状态；没有强制终止进程') from None
            return self.status(project_id)
