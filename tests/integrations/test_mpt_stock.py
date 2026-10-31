"""Offline actual pinned stock functions + host adapter/manifest contracts.

Run with .runtime/mpt-python/bin/python. Only synthetic keys/HTTP responses.
No real .env/config.toml is loaded and all socket connections are forbidden.
"""
from __future__ import annotations
import copy
import inspect
import json
import os
from pathlib import Path
import socket
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
FFMPEG=shutil.which('ffmpeg')
EVIDENCE_DIR=os.environ.get('MPT_STOCK_EVIDENCE_DIR')
sys.path.insert(0,str(ROOT))

# tools.base_tool normally loads .env on import. Keep this test self-contained.
_is_file=Path.is_file
def _no_dotenv(path):
    return False if path.name=='.env' else _is_file(path)
with patch.object(Path,'is_file',_no_dotenv):
    from integrations.moneyprinterturbo import bridge,stock
    from tools.video.direct_clip_search import DirectClipSearch
    from tools.video.stock_sources.base import SearchFilters,Candidate


class FixtureSource:
    def __init__(self,name='pexels'):
        self.name=name;self.searches=[];self.downloads=[]
    def is_available(self):return True
    def search(self,*args):self.searches.append(args);raise AssertionError('native search must not replace selected MPT search')
    def download(self,candidate,destination):
        self.downloads.append(candidate);shutil.copyfile(self.fixture_video,destination);return destination


def provider_payload(provider,*,duration=12,width=1920,height=1080):
    media='https://cdn.example.test/asset-101.mp4'
    if provider=='pexels':
        return {'videos':[{'id':101,'url':'https://www.pexels.com/video/mount-sanqing-clouds-101/?private=scrub#fragment',
            'duration':duration,'user':{'id':11,'name':'Fixture Creator','url':'https://www.pexels.com/@fixture/'},
            'video_files':[{'id':77,'width':width,'height':height,'link':media}]}]}
    if provider=='pixabay_video':
        return {'hits':[{'id':101,'pageURL':'https://pixabay.com/videos/mount-sanqing-clouds-101/',
            'duration':duration,'user':'Fixture Creator','user_id':11,
            'videos':{'large':{'width':width,'height':height,'url':media}}}]}
    return {'hits':[{'id':'asset-101','canonical_url':'https://coverr.co/videos/mount-sanqing-clouds-101/',
        'duration':duration,'creator':{'name':'Fixture Creator'},'max_width':width,'max_height':height,
        'is_vertical':width<height,'urls':{'mp4_download':media}}]}


class MptStockTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Keep only the installed media-binary path; all credentials/config env remain absent.
        cls.environment=patch.dict(os.environ,{'PATH':str(Path(FFMPEG).parent)+os.pathsep+os.defpath},clear=True);cls.environment.start()
        cls.no_network=patch.object(socket.socket,'connect',side_effect=AssertionError('external network forbidden'));cls.no_network.start()
        cls.workspace=Path(tempfile.mkdtemp(prefix='mpt-stock-offline-')).resolve()
        cls.fixture_video=cls.workspace/'fixture-video.mp4'
        subprocess.run([FFMPEG,'-v','error','-n','-f','lavfi','-i','color=c=blue:s=160x90:r=12:d=1',
                        '-c:v','libx264','-pix_fmt','yuv420p',str(cls.fixture_video)],check=True,timeout=20)
        FixtureSource.fixture_video=cls.fixture_video
        cls.config=bridge.setup(cls.workspace)
        cls.config.app.update(pexels_api_keys=['synthetic-pexels'],pixabay_api_keys=['synthetic-pixabay'],coverr_api_keys=['synthetic-coverr'])
        from app.services import material
        cls.material=material
        from loguru import logger
        logger.remove()
        from app.models.schema import VideoAspect
        cls.VideoAspect=VideoAspect

    @classmethod
    def tearDownClass(cls):
        cls.no_network.stop();cls.environment.stop()

    def setUp(self):
        self.project=self.workspace/self._testMethodName;self.project.mkdir()
        self.output=self.project/'output';self.output.mkdir()
        self.setup_patch=patch.object(bridge,'setup',return_value=self.config);self.setup_patch.start();self.addCleanup(self.setup_patch.stop)

    def run_search(self,provider='pexels',**kwargs):
        req=dict(operation='stock_search',provider=provider,text='Mount Sanqing clouds',aspect_ratio='16:9',minimum_duration=5)
        req.update(kwargs);return bridge.run(req,self.project,self.output)

    def response(self,payload,status=200):
        return SimpleNamespace(status_code=status,headers={'content-type':'application/json'},text=json.dumps(payload),json=lambda:copy.deepcopy(payload))

    def adapter(self,provider='pexels',result=None,returncode=0):
        source=FixtureSource(provider);calls=[]
        def runner(command,**kwargs):
            calls.append((command,kwargs));payload=json.loads(kwargs['input'])
            data=result if result is not None else {'status':'completed','engine':'moneyprinterturbo','upstream_function':stock.UPSTREAM_FUNCTIONS[provider],
                'items':[{'url':'https://cdn.example.test/asset-101.mp4','duration':12,
                    'source_info':{'asset_id':'101','source_page':'https://example.test/mount-sanqing-clouds-101/?private=scrub#fragment',
                        'creator':{'name':'Fixture Creator'},'rendition':{'width':1920,'height':1080},'search_term':'not-provider-metadata','debug':'never-copy'}}]}
            (Path(payload['output'])/'result.json').write_text(json.dumps(data));return SimpleNamespace(returncode=returncode)
        return stock.MoneyPrinterStockSource(source,self.output,deadline=time.time()+60,runner=runner),source,calls

    def test_actual_upstream_signature_and_each_provider_body_mapping(self):
        for provider,function in stock.UPSTREAM_FUNCTIONS.items():
            with self.subTest(provider=provider):
                upstream=getattr(self.material,function)
                self.assertEqual(list(inspect.signature(upstream).parameters),['search_term','minimum_duration','video_aspect'])
                self.assertEqual(inspect.getsourcefile(upstream),str(bridge.UPSTREAM/'app/services/material.py'))
                with patch.object(self.material.requests,'get',return_value=self.response(provider_payload(provider))) as get:
                    result=self.run_search(provider)
                get.assert_called_once();self.assertFalse(get.call_args.kwargs['allow_redirects']);self.assertTrue(get.call_args.kwargs['verify'])
                self.assertEqual(result['upstream_function'],function);self.assertEqual(result['engine'],'moneyprinterturbo')
                item=result['items'][0];self.assertEqual(item['duration'],12);self.assertEqual(item['url'],'https://cdn.example.test/asset-101.mp4')
                self.assertEqual(item['source_info']['creator']['name'],'Fixture Creator');self.assertEqual(item['source_info']['rendition']['width'],1920)
                self.assertNotIn('search_term',item['source_info']);self.assertNotIn('private=scrub',str(result));self.assertNotIn('synthetic-',str(result))

    def test_real_pexels_filters_minimum_duration_and_exact_resolution(self):
        for changes in [{'duration':4},{'width':1280,'height':720},{'width':1080,'height':1920}]:
            with self.subTest(changes=changes),patch.object(self.material.requests,'get',return_value=self.response(provider_payload('pexels',**changes))) as get:
                self.assertEqual(self.run_search()['items'],[]);get.assert_called_once()
        with patch.object(self.material.requests,'get',return_value=self.response(provider_payload('pexels',width=1080,height=1920))):
            self.assertEqual(len(self.run_search(aspect_ratio='9:16')['items']),1)

    def test_provider_tags_preserved_without_turning_search_query_into_metadata(self):
        body=provider_payload('pixabay_video')
        body['hits'][0]['pageURL']='https://pixabay.com/videos/id-101/'
        body['hits'][0]['tags']='forest, trees, green'
        body['hits'][0]['debug']={'api_key':'not-public-metadata'}
        with patch.object(self.material.requests,'get',return_value=self.response(body)):
            result=self.run_search('pixabay_video',text='ocean sunset')
        metadata=result['items'][0].get('source_metadata',{})
        self.assertEqual(metadata.get('source_tags'),'forest, trees, green')
        self.assertEqual(metadata.get('origin'),'provider_tags')
        self.assertNotIn('ocean sunset',str(result));self.assertNotIn('not-public-metadata',str(result))
        adapter,source,_=self.adapter('pixabay_video',result={'status':'completed',**result})
        candidate=adapter.search('ocean sunset',SearchFilters(kind='video'))[0]
        self.assertEqual(candidate.source_tags,'forest, trees, green')
        from tools.video.direct_clip_search import _candidate_metadata_matches
        self.assertTrue(_candidate_metadata_matches(candidate,[['forest']]))
        self.assertFalse(_candidate_metadata_matches(candidate,[['ocean']]))

    def test_public_page_slug_is_labeled_and_missing_metadata_stays_missing(self):
        with patch.object(self.material.requests,'get',return_value=self.response(provider_payload('pexels'))):
            result=self.run_search(text='ocean sunset')
        metadata=result['items'][0].get('source_metadata',{})
        self.assertEqual(metadata.get('source_tags'),'mount sanqing clouds')
        self.assertEqual(metadata.get('origin'),'source_page_slug')
        body=provider_payload('pixabay_video');body['hits'][0]['pageURL']='https://pixabay.com/videos/101/'
        body['hits'][0]['tags']={'authorization':'never-copy'}
        with patch.object(self.material.requests,'get',return_value=self.response(body)):
            result=self.run_search('pixabay_video',text='forest trees')
        self.assertEqual(result['items'][0].get('source_metadata',{}),{})
        self.assertNotIn('forest trees',str(result));self.assertNotIn('never-copy',str(result))

    @unittest.skipUnless(FFMPEG,'real local FFmpeg required')
    def test_provider_metadata_to_download_manifest_selection_and_actual_render(self):
        import hashlib
        from web_api.footage_selection import assign_automatic
        from web_api.footage_render import render_footage
        import tools.video.stock_sources as registry
        raw=provider_payload('pixabay_video')
        forest=raw['hits'][0];forest['pageURL']='https://pixabay.com/videos/101/';forest['tags']='forest, trees'
        cloud=copy.deepcopy(forest);cloud.update(id=202,pageURL='https://pixabay.com/videos/202/',tags='cloud, mist')
        cloud['videos']['large']['url']='https://cdn.example.test/asset-202.mp4'
        raw['hits']=[forest,cloud]
        with patch.object(self.material.requests,'get',return_value=self.response(raw)):
            result=self.run_search('pixabay_video',text='forest cloud')
        adapter,source,_=self.adapter('pixabay_video',result={'status':'completed',**result})
        originals={}
        for identity,color in [('101','red'),('202','blue')]:
            path=self.project/(identity+'.mp4')
            subprocess.run([FFMPEG,'-v','error','-n','-f','lavfi','-i',f'color=c={color}:s=320x180:r=24',
                            '-t','1.5','-c:v','libx264','-pix_fmt','yuv420p',str(path)],check=True,capture_output=True)
            originals[identity]=path
        before={identity:hashlib.sha256(path.read_bytes()).hexdigest() for identity,path in originals.items()}
        source.download=lambda candidate,destination:Path(shutil.copyfile(originals[candidate.source_id],destination))
        with patch.object(registry,'all_sources',return_value=[source]),patch.object(stock,'MoneyPrinterStockSource',return_value=adapter):
            search=DirectClipSearch().execute({'output_dir':str(self.output),'queries':[{'query':'forest cloud'}],
                'sources':['pixabay_video'],'stock_engine':'moneyprinterturbo','clips_per_query':2,'extract_thumbnails':False})
        self.assertTrue(search.success,search.error);self.assertEqual(len(search.data['clips']),2)
        candidates=[]
        for record in search.data['clips']:
            self.assertEqual(record['provenance']['metadata_origin'],'provider_tags')
            candidates.append(dict(record,path=Path(record['path']).relative_to(self.project).as_posix(),
                                   match_kind='place_candidate',location_verified=False))
        rows=[dict(id='cloud',title='Cloud',text='云雾',source_path='',duration_seconds=1,candidates=copy.deepcopy(candidates)),
              dict(id='forest',title='Forest',text='树林',source_path='',duration_seconds=1,candidates=copy.deepcopy(candidates))]
        assignment=assign_automatic(rows)
        self.assertEqual([r['selected_source']['source_id'] for r in rows],['202','101'])
        self.assertEqual(assignment['missing_shots'],[])
        self.assertTrue(all(r['selected_source']['location_verified'] is False for r in rows))
        with patch.dict(os.environ,{'PATH':str(Path(FFMPEG).parent)+os.pathsep+os.defpath}):
            rendered=render_footage(self.project,self.project/'renders/metadata-test',rows,
                {'aspect_ratio':'16:9','resolution':480,'fps':24,'transition':'cut','subtitles':{'enabled':False}})
        self.assertEqual(rendered['status'],'completed')
        output=self.project/rendered['output_path'];pixels=[]
        for second in [.4,1.4]:
            data=subprocess.run([FFMPEG,'-v','error','-ss',str(second),'-i',str(output),'-frames:v','1',
                '-vf','scale=1:1:flags=area','-f','rawvideo','-pix_fmt','rgb24','-'],check=True,capture_output=True).stdout
            self.assertEqual(len(data),3);pixels.append(list(data))
        self.assertGreater(pixels[0][2],pixels[0][0]+100);self.assertGreater(pixels[1][0],pixels[1][2]+100)
        self.assertEqual(before,{identity:hashlib.sha256(path.read_bytes()).hexdigest() for identity,path in originals.items()})
        if EVIDENCE_DIR:
            evidence=Path(EVIDENCE_DIR);evidence.mkdir(parents=True,exist_ok=False)
            final=evidence/'metadata-selected-blue-then-red.mp4';shutil.copy2(output,final)
            report={'status':'passed','scope':'actual pinned search functions with synthetic HTTP; real local media download copies, assignment and FFmpeg render',
                'selected_source_ids':[r['selected_source']['source_id'] for r in rows],'sample_rgb':pixels,
                'metadata':[{'source_id':c['source_id'],'source_tags':c['source_tags'],'provenance':c['provenance']} for c in candidates],
                'location_verified':False,'originals_unchanged':True,'output_sha256':hashlib.sha256(final.read_bytes()).hexdigest(),
                'real_provider_requests':0,'paid_generation_requests':0}
            (evidence/'receipt.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))

    def test_empty_success_is_distinct_from_http_auth_network_and_bad_json_failure(self):
        for provider in stock.UPSTREAM_PROVIDERS:
            key='videos' if provider=='pexels' else 'hits'
            with self.subTest(provider=provider),patch.object(self.material.requests,'get',return_value=self.response({key:[]})) as get:
                self.assertEqual(self.run_search(provider)['items'],[]);get.assert_called_once()
            for status in [301,401,403,429,500]:
                with self.subTest(provider=provider,status=status),patch.object(self.material.requests,'get',return_value=self.response({'error':'synthetic-sensitive-text'},status)) as get:
                    with self.assertRaisesRegex(ValueError,'stock source request failed'):self.run_search(provider)
                    get.assert_called_once()
            for response in [self.response({'error':'invalid shape'}),SimpleNamespace(status_code=200,json=lambda:(_ for _ in ()).throw(ValueError('synthetic-private-body')))]:
                with patch.object(self.material.requests,'get',return_value=response) as get:
                    with self.assertRaisesRegex(ValueError,'stock source request failed'):self.run_search(provider)
                    get.assert_called_once()
            with patch.object(self.material.requests,'get',side_effect=TimeoutError('synthetic-secret-must-not-persist')) as get:
                with self.assertRaisesRegex(ValueError,'stock source request failed'):self.run_search(provider)
                get.assert_called_once()

    def test_invalid_requests_and_missing_key_do_not_search_or_fallback(self):
        for values in [{'provider':'other'},{'text':''},{'text':123},{'minimum_duration':float('nan')},{'minimum_duration':-1},{'minimum_duration':121},{'aspect_ratio':'4:3'}]:
            with self.subTest(values=values),patch.object(self.material.requests,'get') as get:
                with self.assertRaises((ValueError,TypeError)):self.run_search(**values)
                get.assert_not_called()
        with patch.dict(self.config.app,{'pexels_api_keys':[]}),patch.object(self.material.requests,'get') as get:
            with self.assertRaises(ValueError):self.run_search()
            get.assert_not_called()

    def test_stock_bridge_does_not_dispatch_generation_download_or_publish(self):
        with patch.object(self.material,'download_videos',side_effect=AssertionError('not stock search')) as download,patch.object(self.material,'generate_videos_wavespeed',side_effect=AssertionError('no generation')) as generate,patch.object(self.material.requests,'get',return_value=self.response(provider_payload('pexels'))):
            self.run_search();download.assert_not_called();generate.assert_not_called()
        self.assertFalse((self.output/'config-not-persisted.toml').exists())

    def test_host_environment_key_maps_to_upstream_plural_field_and_explicit_mpt_setting_wins(self):
        for explicit in [False,True]:
            env={'PEXELS_API_KEY':'synthetic-host-key'}
            if explicit:env['MPT_PEXELS_API_KEYS']='["synthetic-explicit-key"]'
            configured=['synthetic-explicit-key'] if explicit else []
            with self.subTest(explicit=explicit),patch.dict(os.environ,env,clear=True),patch.dict(self.config.app,{'pexels_api_keys':configured}),patch.object(self.material.requests,'get',return_value=self.response(provider_payload('pexels'))) as get:
                result=self.run_search();get.assert_called_once()
                self.assertEqual(get.call_args.kwargs['headers']['Authorization'],'synthetic-explicit-key' if explicit else 'synthetic-host-key')
                self.assertNotIn('synthetic-',str(result))

    def test_adapter_request_is_nonsecret_unique_bounded_and_download_delegates(self):
        adapter,source,calls=self.adapter();filters=SearchFilters(kind='video',orientation='portrait',min_duration=4)
        rows=adapter.search('Mount Sanqing clouds',filters);adapter.search('Mount Sanqing clouds',filters)
        self.assertEqual(source.searches,[]);self.assertEqual(len(rows),1)
        first=json.loads(calls[0][1]['input']);second=json.loads(calls[1][1]['input'])
        self.assertNotEqual(first['output'],second['output']);self.assertEqual(first['request'],{'operation':'stock_search','provider':'pexels','text':'Mount Sanqing clouds','minimum_duration':4,'aspect_ratio':'9:16'})
        self.assertGreater(calls[0][1]['timeout'],0);self.assertLessEqual(calls[0][1]['timeout'],60)
        self.assertEqual(len(calls[0][0]),2);self.assertNotIn('api_key',str(first));self.assertNotIn('synthetic-',str(first))
        candidate=rows[0];self.assertEqual(candidate.clip_id,'pexels_101');self.assertEqual(candidate.source_tags,'')
        self.assertEqual(candidate.source_url,'https://example.test/mount-sanqing-clouds-101/')
        self.assertEqual(candidate.extra,{'search_engine':'moneyprinterturbo','upstream_function':'search_videos_pexels'})
        destination=self.output/'download.mp4';self.assertEqual(adapter.download(candidate,destination),destination);self.assertEqual(source.downloads,[candidate])

    def test_adapter_rejects_bad_receipts_and_never_runs_native_search(self):
        for result in [{'status':'failed'},{'status':'completed','engine':'native','items':[]},{'status':'completed','engine':'moneyprinterturbo','upstream_function':'search_videos_pixabay','items':[]},[],{'status':'completed','engine':'moneyprinterturbo','upstream_function':'search_videos_pexels','items':{}}]:
            adapter,source,calls=self.adapter(result=result)
            with self.subTest(result=result),self.assertRaises(ValueError):adapter.search('clouds',SearchFilters())
            self.assertEqual(source.searches,[]);self.assertEqual(len(calls),1)
        adapter,source,calls=self.adapter(returncode=1)
        with self.assertRaises(ValueError):adapter.search('clouds',SearchFilters())
        self.assertEqual(len(calls),1);self.assertEqual(source.searches,[])

    def test_adapter_bad_rows_dedup_ids_and_duration_width_filters(self):
        adapter,_,_=self.adapter();base=adapter.search('clouds',SearchFilters())[0]
        good={'url':base.download_url,'duration':12,'source_info':{'asset_id':'../../escape','rendition':{'width':1920,'height':1080}}}
        rows=[None,{'url':'http://cdn.example.test/a.mp4','duration':12},{'url':'https://user:pass@cdn.example.test/a.mp4','duration':12},dict(good,duration='nan'),dict(good,source_info={'rendition':'bad'}),good,good]
        adapter,_,_=self.adapter(result={'status':'completed','engine':'moneyprinterturbo','upstream_function':'search_videos_pexels','items':rows})
        result=adapter.search('clouds',SearchFilters(min_duration=5,max_duration=15,min_width=1920));self.assertEqual(len(result),1);self.assertNotIn('/',result[0].source_id)
        self.assertEqual(adapter.search('clouds',SearchFilters(max_duration=10)),[])
        self.assertEqual(adapter.search('clouds',SearchFilters(min_width=3840)),[])

    def test_adapter_deadline_kind_and_missing_runtime_stop_before_runner(self):
        adapter,source,calls=self.adapter();adapter.deadline=time.time()-1
        with self.assertRaises(TimeoutError):adapter.search('clouds',SearchFilters())
        self.assertEqual(calls,[])
        adapter.deadline=time.time()+60
        with self.assertRaises(ValueError):adapter.search('clouds',SearchFilters(kind='image'))
        with patch.object(stock,'PYTHON',self.output/'absent-runtime'):
            self.assertFalse(adapter.is_available())
            with self.assertRaises(ValueError):adapter.search('clouds',SearchFilters())
        self.assertEqual(calls,[]);self.assertEqual(source.searches,[])

    def test_direct_search_mpt_provenance_survives_download_and_reuse(self):
        import tools.video.stock_sources as registry
        source=FixtureSource();adapter,_,_=self.adapter()
        def wrapper(real_source,output_dir,**kwargs):
            self.assertIs(real_source,source);adapter.source=real_source;return adapter
        inputs={'output_dir':str(self.output),'queries':[{'query':'Mount Sanqing clouds'}],
            'sources':['pexels'],'stock_engine':'moneyprinterturbo','metadata_groups':[['Sanqing'],['clouds']],
            'extract_thumbnails':False,'clips_per_query':1}
        with patch.object(registry,'all_sources',return_value=[source]),patch.object(stock,'MoneyPrinterStockSource',side_effect=wrapper):
            first=DirectClipSearch().execute(inputs);second=DirectClipSearch().execute(inputs)
        self.assertTrue(first.success,first.error);self.assertTrue(second.success,second.error)
        expected={'search_engine':'moneyprinterturbo','provider':'pexels','upstream_function':'search_videos_pexels'}
        self.assertEqual(first.data['clips'][0]['provenance'],expected);self.assertEqual(second.data['clips'][0]['provenance'],expected)
        self.assertFalse(first.data['clips'][0]['skipped_existing']);self.assertTrue(second.data['clips'][0]['skipped_existing'])
        self.assertEqual(len(source.downloads),1);self.assertEqual(source.searches,[])

    def test_direct_search_keeps_nonupstream_sources_native_and_rejects_unknown_engine(self):
        import tools.video.stock_sources as registry
        source=FixtureSource('wikimedia')
        source.search=lambda *args:[Candidate(source='wikimedia',source_id='1',source_url='https://example.test/clouds',download_url='https://example.test/1.mp4',kind='video')]
        inputs={'output_dir':str(self.output),'queries':[{'query':'clouds'}],'sources':['wikimedia'],'stock_engine':'moneyprinterturbo','extract_thumbnails':False}
        with patch.object(registry,'all_sources',return_value=[source]),patch.object(stock,'MoneyPrinterStockSource',side_effect=AssertionError('do not wrap unsupported source')):
            result=DirectClipSearch().execute(inputs)
        self.assertTrue(result.success,result.error);self.assertEqual(result.data['clips'][0]['provenance'],{'search_engine':'native','provider':'wikimedia'})
        bad=DirectClipSearch().execute(dict(inputs,stock_engine='invented'));self.assertFalse(bad.success);self.assertIn('Unknown stock search engine',bad.error)

    def test_footage_request_routes_mpt_and_persists_search_provenance_without_location_claim(self):
        from web_api import footage_pipeline as pipeline
        import tools.video.stock_sources as registry
        project=self.project/'demo';(project/'assets').mkdir(parents=True);media=project/'assets/fixture.mp4';media.write_bytes(b'local fixture')
        calls=[];provenance={'search_engine':'moneyprinterturbo','provider':'pexels','upstream_function':'search_videos_pexels'}
        def search(inputs):
            calls.append(inputs);return {'clips':[{'clip_id':'pexels_101','source':'pexels','source_id':'101','path':str(media),'duration':12,
                'source_url':'https://www.pexels.com/video/mount-sanqing-clouds-101/','license':'Pexels License','provenance':provenance}]}
        request=pipeline.FootageRequest(project_id='demo',action='collect',sources=['pexels'],confirm_network=True,options={'aspect_ratio':'9:16'})
        manager=pipeline.FootageJobs(self.project,search=search)
        plan={'shots':[{'id':'cloud','text':'三清山云海','duration_seconds':4,'source_path':'','candidates':[],
            'queries':[{'text':'Mount Sanqing clouds','kind':'place_intent'}]}]};warnings=[];job='footage-'+'b'*24
        with patch.object(registry,'source_catalog',return_value=[{'name':'pexels','status':'available'}]),patch.object(manager,'update'),patch.object(pipeline,'probe',return_value={'duration':12,'width':1920,'height':1080,'has_video':True}):
            manager._collect(request,plan,job,threading.Event(),warnings)
        self.assertEqual(calls[0]['stock_engine'],'moneyprinterturbo');self.assertEqual(calls[0]['filters']['orientation'],'portrait');self.assertEqual(calls[0]['filters']['min_duration'],4)
        manifest=json.loads((manager.directory('demo',job)/'stock_manifest.json').read_text());self.assertEqual(manifest['clips'][0]['provenance'],provenance)
        self.assertFalse(manifest['clips'][0]['location_verified']);self.assertEqual(plan['shots'][0]['selected_source']['provenance'],provenance)


if __name__=='__main__':unittest.main(verbosity=2)
