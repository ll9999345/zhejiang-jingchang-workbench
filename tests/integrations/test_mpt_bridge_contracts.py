"""Run with .runtime/mpt-python/bin/python. Real upstream signatures, no network."""
import importlib
import array
from pathlib import Path
import socket
import sys
import tempfile
import subprocess
from types import SimpleNamespace
import unittest
import wave
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from integrations.moneyprinterturbo import bridge
from integrations.moneyprinterturbo.catalog import PROVIDERS

BASE = dict(operation='script', provider='openai', topic='三清山', text='山间云雾。',
 language='zh-CN', paragraphs=3, terms_count=3, social_platform='youtube_shorts',
 duration=5, aspect_ratio='16:9', voice_rate=1, word_level=False, reference_audio='',
 video_path='source.mp4', video_paths=[], audio_path='voice.wav', subtitle_path='voice.srt',
 bgm_path='', bgm_volume=.1, transition='SlideIn', order='sequential',clip_duration=5,
 clip_speed=1.2,fit='contain',subtitle_animation='pop_spring',subtitle_position='bottom',
 font_size=60,text_color='#FFFFFF',background_color='',privacy='private',made_for_kids=False,
 public_video_url='https://example.org/public-video.mp4',platforms=['youtube'],
 listing_version_id='listing-v1',request_id='contract-1',remote_request_id='remote-1',model='')


class BridgeContracts(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.workspace=Path(tempfile.mkdtemp(prefix='mpt-contract-')).resolve()
  cls.config=bridge.setup(cls.workspace)
  cls.config.app.update(loomloom_api_token='contract-placeholder')
  from app.services import voice
  bridge.limit_tts_retries(voice)

 def setUp(self):
  self.project=self.workspace/self._testMethodName;self.project.mkdir()
  self.output=self.project/'output';self.output.mkdir()
  for name in ('source.mp4','voice.wav','voice.srt'):(self.project/name).write_bytes(b'contract fixture')
  self.setup_patch=patch.object(bridge,'setup',return_value=self.config);self.setup_patch.start();self.addCleanup(self.setup_patch.stop)
  self.network=patch.object(socket,'create_connection',side_effect=AssertionError('network forbidden'))
  self.network.start();self.addCleanup(self.network.stop)

 def run_bridge(self,**values):return bridge.run(dict(BASE,**values),self.project,self.output)
 def artifact(self,name):
  p=self.output/name;p.write_bytes(b'contract output');return str(p)

 def test_text_contracts(self):
  from app.services import llm
  for operation,function,value in [('script','generate_script','山色'),('terms','generate_terms',['Sanqing']),('social','generate_social_metadata',{'title':'山色'})]:
   with self.subTest(operation=operation),patch.object(llm,function,autospec=True,return_value=value) as call:
    self.assertEqual(self.run_bridge(operation=operation)['value'],value);call.assert_called_once()

 def test_provider_error_text_is_never_a_successful_script(self):
  from app.services import llm
  with patch.object(llm,'_generate_response',return_value='Error: account unavailable') as call:
   with self.assertRaises(ValueError):self.run_bridge(operation='script',provider='openai')
   call.assert_called_once()

 def test_connection_uses_one_fixed_prompt_and_selected_model(self):
  from app.services import llm
  with patch.object(llm,'_generate_response',autospec=True,return_value='OK') as call:
   value=self.run_bridge(operation='connection',provider='openai',model='chosen-connection-model',text='private project script')['value']
   call.assert_called_once_with(prompt='Reply with exactly: OK')
   self.assertTrue(value['connected']);self.assertEqual(value['provider'],'openai')
   self.assertEqual(self.config.app['openai_model_name'],'chosen-connection-model')
   self.assertGreaterEqual(value['elapsed_seconds'],0)
  for response in ('', 'Error: unavailable'):
   with patch.object(llm,'_generate_response',return_value=response) as call:
    with self.assertRaises(ValueError):self.run_bridge(operation='connection')
    call.assert_called_once()

 def test_local_connection_cannot_be_redirected_through_a_global_proxy(self):
  import os
  from app.services import llm
  with patch.dict(os.environ,{'MPT_OLLAMA_BASE_URL':'http://127.0.0.1:11434/v1','HTTP_PROXY':'http://proxy.invalid','https_proxy':'http://proxy.invalid'}):
   self.config.proxy={'http':'http://proxy.invalid'}
   def respond(**kwargs):
    self.assertNotIn('HTTP_PROXY',os.environ);self.assertNotIn('https_proxy',os.environ)
    self.assertEqual(self.config.proxy,{})
    return 'OK'
   with patch.object(llm,'_generate_response',side_effect=respond) as call:
    self.assertTrue(self.run_bridge(operation='connection',provider='ollama',model='local-model')['value']['connected'])
    call.assert_called_once()

 def test_llm_sdk_constructor_does_not_retry_and_uses_selected_model(self):
  from app.services import llm
  def generate(*args,**kwargs):
   llm.OpenAI(api_key='contract-placeholder')
   llm.AzureOpenAI(api_key='contract-placeholder',azure_endpoint='https://example.org',api_version='test')
   self.assertEqual(self.config.app['openai_model_name'],'chosen-model')
   return '山色'
  with patch.object(llm,'OpenAI') as standard,patch.object(llm,'AzureOpenAI') as azure,patch.object(llm,'generate_script',autospec=True,side_effect=generate):
   self.run_bridge(model='chosen-model')
   self.assertEqual(standard.call_args.kwargs['max_retries'],0)
   self.assertEqual(azure.call_args.kwargs['max_retries'],0)

 def test_all_tts_dispatch_and_subtitle_argument_order(self):
  from app.services import voice
  for provider,(_,__,default) in PROVIDERS['tts'].items():
   with self.subTest(provider=provider):
    marker=object()
    def synth(text,name,rate,path,**kwargs):Path(path).write_bytes(b'audio');return marker
    def subtitle(maker,text,path,**kwargs):
     self.assertIs(maker,marker);self.assertEqual(text,BASE['text']);Path(path).write_text('1\n00:00:00,000 --> 00:00:01,000\n山色\n')
    with patch.object(voice,'tts',autospec=True,side_effect=synth),patch.object(voice,'create_subtitle',autospec=True,side_effect=subtitle):
     result=self.run_bridge(operation='tts',provider=provider,voice=default or 'elevenlabs:voice-test')
     self.assertEqual(len(result['files']),2)
  with self.assertRaises(ValueError):self.run_bridge(operation='tts',provider='azure',voice='gemini:Kore')

 def test_all_tts_routes_reach_the_selected_real_leaf_function(self):
  from app.services import voice
  leaves={'edge':'azure_tts_v1','azure':'azure_tts_v2','siliconflow':'siliconflow_tts',
   'gemini':'gemini_tts','mimo':'mimo_tts','minimax':'minimax_tts','elevenlabs':'elevenlabs_tts',
   'chatterbox':'chatterbox_tts','kokoro':'kokoro_tts','fish':'fish_audio_tts','voxcpm':'voxcpm_tts'}
  for provider,leaf in leaves.items():
   marker=object()
   def synth(*args,**kwargs):
    self.artifact('voice.mp3');return marker
   with self.subTest(provider=provider),patch.object(voice,leaf,autospec=True,side_effect=synth) as call,patch.object(voice,'create_subtitle',autospec=True):
    self.run_bridge(operation='tts',provider=provider,voice=PROVIDERS['tts'][provider][2] or 'elevenlabs:voice-test')
    call.assert_called_once()

 def test_paid_tts_failure_submits_only_once(self):
  from app.services import voice
  import requests
  with patch.dict(self.config.siliconflow,{'api_key':'contract-placeholder'}),patch.object(voice.requests,'post',side_effect=requests.Timeout('contract failure')) as call:
   with self.assertRaises(ValueError):
    self.run_bridge(operation='tts',provider='siliconflow',voice=PROVIDERS['tts']['siliconflow'][2])
   call.assert_called_once()

 def test_voxcpm_reference_text_is_paired_with_prompt_audio(self):
  from app.services import voice
  def synth(*args,**kwargs):self.artifact('voice.mp3');return object()
  with patch.object(voice,'tts',autospec=True,side_effect=synth) as call,patch.object(voice,'create_subtitle',autospec=True):
   self.run_bridge(operation='tts',provider='voxcpm',voice='voxcpm:default',reference_audio='voice.wav',reference_text='参考文字')
   self.assertEqual(call.call_args.kwargs['voxcpm_reference_audio'],b'contract fixture')
   self.assertEqual(call.call_args.kwargs['voxcpm_prompt_audio'],b'contract fixture')
   self.assertEqual(call.call_args.kwargs['voxcpm_prompt_text'],'参考文字')

 def test_tts_volume_is_applied_locally_without_repeating_synthesis(self):
  from app.services import voice
  def synth(text,name,rate,path,**kwargs):Path(path).write_bytes(b'original audio');return object()
  def gain(source,target,volume,binary):
   self.assertEqual(volume,.5);target.write_bytes(b'quieter audio')
  with patch.object(voice,'tts',autospec=True,side_effect=synth) as call,patch.object(voice,'create_subtitle',autospec=True),patch.object(bridge,'apply_voice_volume',side_effect=gain) as apply:
   result=self.run_bridge(operation='tts',provider='edge',voice=PROVIDERS['tts']['edge'][2],voice_volume=.5)
   self.assertEqual((self.output/'voice-source.mp3').read_bytes(),b'original audio')
   self.assertEqual((self.output/'voice.mp3').read_bytes(),b'quieter audio')
   self.assertEqual(result['voice_volume'],.5);call.assert_called_once();apply.assert_called_once()

 def test_real_local_gain_changes_volume_and_preserves_source(self):
  source=self.output/'gain-source.wav';target=self.output/'gain.mp3'
  # Constant low-level PCM provides a stable measurement after MP3 encoding.
  with wave.open(str(source),'wb') as audio:
   audio.setnchannels(1);audio.setsampwidth(2);audio.setframerate(24000)
   audio.writeframes(array.array('h',[4000]*24000).tobytes())
  original=source.read_bytes()
  bridge.apply_voice_volume(source,target,.5,self.config.app['ffmpeg_path'])
  decoded=subprocess.run([self.config.app['ffmpeg_path'],'-nostdin','-i',str(target),'-f','s16le','-ac','1','-ar','24000','-'],check=True,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL).stdout
  samples=array.array('h');samples.frombytes(decoded)
  mean=sum(abs(value) for value in samples[2000:22000])/20000
  self.assertGreater(mean,1700);self.assertLess(mean,2300)
  self.assertEqual(source.read_bytes(),original)

 def test_all_video_and_image_contracts(self):
  from app.services import material
  for provider in PROVIDERS['video']:
   mod=material if provider=='wavespeed' else importlib.import_module('app.services.'+provider)
   name='generate_videos_wavespeed' if provider=='wavespeed' else 'generate_videos'
   with self.subTest(provider=provider),patch.object(mod,name,autospec=True,return_value=[SimpleNamespace(url=self.artifact(provider+'.mp4'))]) as call:
    self.assertEqual(len(self.run_bridge(operation='video',provider=provider)['files']),1);call.assert_called_once()
  with patch.object(material,'generate_images_openai',autospec=True,return_value=[SimpleNamespace(url=self.artifact('image-motion.mp4'))]):
   self.assertEqual(len(self.run_bridge(operation='image',provider='openai_image')['files']),1)

 def test_selected_video_image_models_and_source_evidence(self):
  from app.services import material
  from app.models.schema import MaterialInfo
  keys={'wavespeed':'wavespeed_text_to_video_model','volcengine_seedance':'volcengine_seedance_model','ofox':'ofox_text_to_video_model'}
  for provider,key in keys.items():
   mod=material if provider=='wavespeed' else importlib.import_module('app.services.'+provider)
   name='generate_videos_wavespeed' if provider=='wavespeed' else 'generate_videos'
   def generate(*args,**kwargs):
    self.assertEqual(self.config.app[key],'chosen-model')
    return [MaterialInfo(provider=provider,url=self.artifact(provider+'.mp4'),duration=5,
     source_info={'asset_id':'receipt-1','rendition':{'width':1920,'height':1080},'debug':'do-not-save'})]
   with self.subTest(provider=provider),patch.object(mod,name,autospec=True,side_effect=generate):
    result=self.run_bridge(operation='video',provider=provider,model='chosen-model')
    self.assertEqual(result['material_sources'][0]['asset_id'],'receipt-1')
    self.assertNotIn('debug',str(result['material_sources']))
  with patch.object(material,'generate_images_openai',autospec=True,return_value=[SimpleNamespace(url=self.artifact('image.png'))]):
   self.run_bridge(operation='image',provider='openai_image',model='chosen-image')
   self.assertEqual(self.config.app['openai_image_model'],'chosen-image')
  with self.assertRaises(ValueError):self.run_bridge(operation='video',provider='metaso_minimax',model='unsupported')

 def test_elevenlabs_music_catalog_matches_upstream_credential_section(self):
  from app.services import elevenlabs_music
  self.assertEqual(PROVIDERS['music']['elevenlabs'][1],['MPT_ELEVENLABS__API_KEY'])
  with patch.dict(self.config.elevenlabs,{'api_key':'contract-placeholder'}):
   self.assertTrue(elevenlabs_music.is_enabled())

 def test_image_transport_uses_plural_key_config_and_never_retries_submission(self):
  from app.services import material
  with patch.object(material,'generate_images_openai',autospec=True,return_value=[SimpleNamespace(url=self.artifact('image.png'))]):
   self.run_bridge(operation='image',provider='openai_image')
  response=SimpleNamespace(status_code=500,json=lambda:{'error':'contract failure'},text='contract failure')
  with patch.dict(self.config.app,{'openai_image_api_keys':['contract-placeholder']}),patch.object(material.requests,'post',return_value=response) as call:
   self.assertIsNone(material._request_openai_image('https://example.org/images/generations',{})[0])
   call.assert_called_once()
   self.assertEqual(call.call_args.kwargs['headers']['Authorization'],'Bearer contract-placeholder')

 def test_both_music_contracts(self):
  from app.services import material
  for provider,module in [('sonilo','sonilo'),('elevenlabs','elevenlabs_music')]:
   mod=importlib.import_module('app.services.'+module)
   def generate(video,path,duration,**kwargs):Path(path).write_bytes(b'music');return path
   with self.subTest(provider=provider),patch.object(material,'_get_downloaded_video_duration',return_value=12.5),patch.object(mod,'generate_bgm',autospec=True,side_effect=generate) as call:
    result=self.run_bridge(operation='music',provider=provider)
    self.assertEqual(len(result['files']),1);self.assertEqual(result['source_duration'],12.5)
    self.assertEqual(call.call_args.args[2],12.5)

 def test_edit_passes_actual_preferences_and_rejects_failed_mix(self):
  from app.services import video
  def combine(path,*args,**kwargs):Path(path).write_bytes(b'combined')
  def render(combined,audio,subtitle,path,params):
   self.assertEqual(params.subtitle_animation,'pop_spring')
   self.assertEqual(params.font_name,'Helvetica.ttc');self.assertEqual(params.stroke_color,'#112233')
   self.assertEqual(params.stroke_width,2);self.assertFalse(params.rounded_subtitle_background)
   self.assertEqual(params.custom_position,55);self.assertEqual(params.voice_volume,.8)
   self.assertTrue(Path(subtitle).read_text().endswith('\n\n'))
   self.assertEqual((self.project/'voice.srt').read_bytes(),b'contract fixture')
   Path(path).write_bytes(b'final');return True
  with patch.object(video,'combine_videos',autospec=True,side_effect=combine) as call,patch.object(video,'generate_video',autospec=True,side_effect=render):
   self.assertEqual(len(self.run_bridge(operation='edit',provider='moviepy',font_name='Helvetica.ttc',stroke_color='#112233',stroke_width=2,rounded_subtitle_background=False,custom_position=55,voice_volume=.8)['files']),1)
   self.assertEqual(call.call_args.kwargs['clip_speed'],1.2)
  with patch.object(video,'combine_videos',autospec=True,side_effect=combine),patch.object(video,'generate_video',autospec=True,return_value=False):
   with self.assertRaises(ValueError):self.run_bridge(operation='edit',provider='moviepy')

 def test_twelvelabs_contracts(self):
  from app.services import twelvelabs
  with patch.object(twelvelabs,'analyze_clip',autospec=True,return_value='cloudy mountain') as call:
   self.assertEqual(self.run_bridge(operation='analyze',provider='twelvelabs',model='chosen-pegasus')['value'],'cloudy mountain')
   self.assertEqual(call.call_args.kwargs['model'],'chosen-pegasus')
  with patch.object(twelvelabs,'rerank_terms_by_subject',autospec=True,return_value=['Sanqing','forest']) as call:
   self.assertEqual(len(self.run_bridge(operation='rerank',provider='twelvelabs',model='chosen-marengo',text='forest\n \nSanqing')['value']),2)
   self.assertEqual(call.call_args.args[1],['forest','Sanqing']);self.assertEqual(call.call_args.kwargs['model'],'chosen-marengo')
  with self.assertRaises(ValueError):self.run_bridge(operation='rerank',provider='twelvelabs',topic='',text='forest\nSanqing')

 def test_publishing_is_only_accepted_and_filters_service_response(self):
  from app.services.upload_post import UploadPostService
  with patch.object(UploadPostService,'upload_video',autospec=True,return_value={'success':True,'request_id':'remote-1','debug':'must-not-persist'}) as call:
   result=self.run_bridge(operation='publish',provider='upload_post')
   self.assertEqual(result['status'],'accepted');self.assertNotIn('debug',result['value'])
   self.assertEqual(call.call_args.kwargs['youtube_extra']['privacyStatus'],'private')
   self.assertIsNone(call.call_args.kwargs['privacy_level'])
  with patch.object(UploadPostService,'check_status',autospec=True,return_value={'status':'completed','request_id':'remote-1','debug':'must-not-persist'}):
   self.assertEqual(self.run_bridge(operation='publish_status',provider='upload_post')['value'],{'status':'completed','request_id':'remote-1'})

 def test_nonpublic_publishing_cannot_fall_back_to_public(self):
  from app.services.upload_post import UploadPostService
  for privacy in ('private','unlisted'):
   with self.subTest(privacy=privacy),patch.object(UploadPostService,'upload_video',autospec=True) as call:
    with self.assertRaises(ValueError):self.run_bridge(operation='publish',provider='upload_post',privacy=privacy,platforms=['youtube','tiktok'])
    call.assert_not_called()
  with patch.object(UploadPostService,'upload_video',autospec=True,return_value={'success':True,'request_id':'remote-1'}) as call:
   self.run_bridge(operation='publish',provider='upload_post',privacy='public',platforms=['tiktok'])
   self.assertEqual(call.call_args.kwargs['privacy_level'],'PUBLIC_TO_EVERYONE')

 def test_worker_preserves_safe_remote_receipt_without_exception_text(self):
  class ProviderUnconfirmedTaskError(Exception):pass
  error=ProviderUnconfirmedTaskError('signed URL or credentials must not persist')
  error.task_id='remote-task-1'
  result=bridge.failure_result(error)
  self.assertEqual(result['status'],'interrupted');self.assertEqual(result['remote_task_id'],'remote-task-1')
  self.assertNotIn(str(error),str(result))
  error.task_id='https://example.org/video?token=must-not-persist'
  self.assertNotIn('remote_task_id',bridge.failure_result(error))

 def test_loomloom_quote_execute_contracts(self):
  from app.services import loomloom as l
  quote=l.LoomLoomQuote('q','v','USD',1,1,'1',())
  execution=l.LoomLoomExecution('run','tx','accepted','v')
  result=l.LoomLoomScriptBatchResult((l.LoomLoomScriptCandidate(0,'三清山',('Sanqing',)),),())
  with patch.object(l.LoomLoomScriptBackend,'quote',autospec=True,return_value=quote),patch.object(l.LoomLoomScriptBackend,'execute',autospec=True,return_value=execution) as execute,patch.object(l.LoomLoomScriptBackend,'wait_for_run',autospec=True),patch.object(l.LoomLoomScriptBackend,'get_script_results',autospec=True,return_value=result),patch.object(l.LoomLoomVideoBackend,'download_video_results',autospec=True,return_value=[self.artifact('loom.mp4')]):
   for op in ('loomloom_quote','loomloom_script_quote'):
    self.assertEqual(self.run_bridge(operation=op,provider='loomloom',model='model-test' if op=='loomloom_quote' else '')['value']['quote_id'],'q')
   self.assertEqual(len(self.run_bridge(operation='loomloom_execute',provider='loomloom',model='model-test')['files']),1)
   self.assertEqual(len(self.run_bridge(operation='loomloom_script_execute',provider='loomloom')['value']['candidates']),1)
   self.assertTrue(execute.call_args.kwargs['confirm'])

if __name__=='__main__':unittest.main()
