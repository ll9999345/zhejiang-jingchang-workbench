"""Explicit OpenMontage CPU adapter; not the official WhisperX 3.8.6 service.

Runs existing offline small ASR followed by pinned WhisperX Chinese CTC alignment.
No authored text is accepted, no synthetic timestamps, no downloads or fallback.
"""
from __future__ import annotations
import argparse
import hashlib
import io
import json
import math
from pathlib import Path
import socket
import sys
import tempfile
import threading
import uuid
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT=Path(__file__).resolve().parents[2]
REVISION='771b4a14a9486f8fd5aef18ef49e35d639523dd3'
IDENTITY={'ok':True,'protocol':'hypit.whisperx-service@1',
          'serviceVersion':'openmontage-cpu-0.1.0','whisperxVersion':'alignment-'+REVISION,
          'model':'small','device':'cpu','compute':'int8','batchSize':1,
          'implementation':'OpenMontage split-runtime ASR and Chinese CTC adapter',
          'languages':['zh'],'maxDurationSeconds':30,'officialDistribution':False}


def audio_bytes(raw,roots):
    if not isinstance(raw,str) or not Path(raw).is_absolute():raise ValueError('音频须为绝对路径')
    path=Path(raw).resolve(strict=True)
    runtime_temp=(path.name=='alignment-evidence.wav' and path.parent.name.startswith('hypit-whisperx-local-')
                  and path.parent.parent==Path(tempfile.gettempdir()).resolve())
    if not runtime_temp and not any(path.is_relative_to(root) for root in roots):raise ValueError('音频不在允许的输入目录')
    if not path.is_file() or path.stat().st_size>1_000_000:raise ValueError('音频文件无效或超过三十秒输入上限')
    with path.open('rb') as stream:data=stream.read(1_000_001)
    if len(data)>1_000_000:raise ValueError('音频超过输入上限')
    with wave.open(io.BytesIO(data)) as source:
        frames=source.getnframes()
        if source.getparams()[:3]!=(1,2,16000) or source.getcomptype()!='NONE' or not 0<frames<=480000:
            raise ValueError('仅支持三十秒以内的十六千赫单声道PCM音频')
        if len(source.readframes(frames+1))!=frames*2:raise ValueError('音频数据不完整')
    return data,frames/16000


def response_from_result(result,duration):
    if not result.success:raise RuntimeError('本机识别或对齐未完成；未回退到估算时间')
    data=result.data;alignment=data.get('alignment',{})
    if (data.get('language')!='zh' or data.get('device')!='cpu' or data.get('compute_type')!='int8'
        or alignment.get('engine')!='whisperx_forced_ctc' or alignment.get('source_revision')!=REVISION
        or alignment.get('interpolated_timestamps') is not False):raise RuntimeError('实际识别对齐实现与服务身份不一致')
    segments=[];last=0
    for row in data.get('segments',[]):
        words=[]
        for word in row.get('words',[]):
            start,end,score=word.get('start'),word.get('end'),word.get('score')
            if any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) for v in [start,end,score]):raise RuntimeError('模型时间戳无效')
            if not 0<=start<end<=duration+.02 or start<last or not 0<=score<=1:raise RuntimeError('模型时间戳越界或倒序')
            last=start
            if not isinstance(word.get('word'),str) or not word['word'].strip():raise RuntimeError('模型文字为空')
            words.append({'text':word['word'],'start':start,'end':end,'score':score})
        if words:segments.append({'text':row['text'],'start':words[0]['start'],'end':words[-1]['end'],'words':words})
    if not segments:raise RuntimeError('没有测得的字级对齐结果')
    return {'language':'zh','segments':segments}


class Adapter:
    def __init__(self,roots,output,transcriber=None,instance_id=None):
        self.roots=tuple(Path(p).resolve(strict=True) for p in roots);self.output=Path(output);self.output.mkdir(parents=True,exist_ok=True)
        self.lock=threading.Lock();self.closing=threading.Event();self.instance_id=instance_id or uuid.uuid4().hex
        if transcriber is None:
            import ctranslate2
            from tools.analysis.transcriber import Transcriber
            from tools.analysis.transcript_aligner import alignment_ready
            if ctranslate2.get_cuda_device_count()!=0:raise RuntimeError('此适配器限定CPU；请使用明确的其他设备配置')
            if not alignment_ready():raise RuntimeError('中文对齐模块或模型未就绪')
            Transcriber.local_model('small');transcriber=Transcriber()
        self.transcriber=transcriber

    def transcribe(self,request):
        if not isinstance(request,dict) or set(request)-{'audio_path','language'}:raise ValueError('请求仅接受音频路径与语言，不接受预设答案')
        if request.get('language')!='zh':raise ValueError('此兼容服务仅支持明确选择的中文zh')
        data,duration=audio_bytes(request.get('audio_path'),self.roots)
        if not self.lock.acquire(blocking=False):raise BlockingIOError('本机正在处理另一条语音')
        try:
            if self.closing.is_set():raise BlockingIOError('本机语音服务正在停止')
            job=self.output/('speech-'+uuid.uuid4().hex);job.mkdir()
            source=job/'input.wav';source.write_bytes(data)
            result=self.transcriber.execute({'input_path':str(source),'model_size':'small','language':'zh','alignment':'whisperx_zh','output_dir':str(job)})
            response=response_from_result(result,duration)
            (job/'response.json').write_text(json.dumps(response,ensure_ascii=False,allow_nan=False,indent=2))
            (job/'receipt.json').write_text(json.dumps({'identity':IDENTITY,'input_sha256':hashlib.sha256(data).hexdigest(),'duration':duration,'network_used':False,'authored_text_supplied':False},indent=2))
            return response
        finally:self.lock.release()

    def request_stop(self,instance_id):
        if instance_id!=self.instance_id:raise ValueError('不是当前会话')
        if not self.lock.acquire(blocking=False):raise BlockingIOError('语音识别尚未完成')
        try:self.closing.set()
        finally:self.lock.release()


def handler(adapter):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def respond(self,status,value):
            body=json.dumps(value,ensure_ascii=False,allow_nan=False).encode();self.send_response(status)
            self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        def do_GET(self):
            self.respond(200,{**IDENTITY,'instanceId':adapter.instance_id,'busy':adapter.lock.locked(),'stopping':adapter.closing.is_set()}) if self.path=='/health' else self.respond(404,{'error':'not found'})
        def do_POST(self):
            if self.path not in {'/transcribe','/shutdown'}:return self.respond(404,{'error':'not found'})
            # Browsers are not clients of this file-reading service.
            if self.headers.get('Origin') or self.headers.get('Transfer-Encoding'):return self.respond(403,{'error':'unsupported client'})
            if self.headers.get('Content-Type','').split(';')[0]!='application/json':return self.respond(415,{'error':'JSON required'})
            try:
                size=int(self.headers.get('Content-Length','0'))
                if not 0<size<=8192:raise ValueError('请求过大或为空')
                request=json.loads(self.rfile.read(size))
                if self.path=='/shutdown':
                    if not isinstance(request,dict) or set(request)!={'instance_id'}:raise ValueError('停止请求无效')
                    adapter.request_stop(request['instance_id']);self.respond(202,{'stopping':True})
                    threading.Thread(target=self.server.shutdown,daemon=True).start()
                else:self.respond(200,adapter.transcribe(request))
            except BlockingIOError:self.respond(503,{'error':'本机语音处理中'})
            except (ValueError,OSError,EOFError,wave.Error):self.respond(400,{'error':'音频、语言或路径不满足本机服务要求'})
            except Exception:self.respond(503,{'error':'本机识别对齐未完成，原音频保留；没有自动重试'})
    return Handler


def main():
    # A selected Profile must never fall back to installing the official locked
    # environment or starting an unowned process when the workbench is stopped.
    if sys.argv[1:]==['--managed-by-workbench']:
        print('请先在工作台启动本机中文语音服务',file=sys.stderr);raise SystemExit(2)
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--port',type=int,default=8766)
    parser.add_argument('--input-root',action='append',required=True);parser.add_argument('--output-dir',required=True)
    parser.add_argument('--instance-id')
    args=parser.parse_args();adapter=Adapter(args.input_root,args.output_dir,instance_id=args.instance_id)
    original=socket.socket.connect
    def offline(sock,address):
        if isinstance(address,tuple):raise PermissionError('Speech inference is offline')
        return original(sock,address)
    socket.socket.connect=offline
    server=ThreadingHTTPServer(('127.0.0.1',args.port),handler(adapter))
    try:server.serve_forever()
    finally:server.server_close()
if __name__=='__main__':main()
