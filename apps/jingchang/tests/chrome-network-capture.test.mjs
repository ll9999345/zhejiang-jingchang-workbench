import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyNetworkResponse,shouldCaptureRequest} from '../tools/chrome-local-asset-importer/network-capture-core.js';

test('sniffer classifies direct video URLs without exposing signed query text in filenames',()=>{
  const item=classifyNetworkResponse({url:'https://cdn.example.test/media/final%20cut.mp4?token=temporary-secret#player',statusCode:206,responseHeaders:[{name:'Content-Type',value:'video/mp4; charset=binary'}]});
  assert.deepEqual(item,{url:'https://cdn.example.test/media/final%20cut.mp4?token=temporary-secret',kind:'video',name:'final cut.mp4',source:'network',unsupported:false,stream:false,streamType:'',contentType:'video/mp4',initiatorOrigin:''});
});

test('sniffer recognizes extensionless video responses and stream manifests but rejects segments',()=>{
  const extensionless=classifyNetworkResponse({url:'https://cdn.example.test/v/123?sig=x',statusCode:200,responseHeaders:[{name:'Content-Type',value:'video/webm'}]});
  assert.equal(extensionless.name,'123.webm');assert.equal(extensionless.contentType,'video/webm');assert.equal(extensionless.unsupported,false);
  const hls=classifyNetworkResponse({url:'https://cdn.example.test/live/master.m3u8?key=x',statusCode:200,responseHeaders:[{name:'Content-Type',value:'application/vnd.apple.mpegurl'}]});
  assert.equal(hls.streamType,'HLS');assert.equal(hls.unsupported,true);
  const dash=classifyNetworkResponse({url:'https://cdn.example.test/live/stream.mpd',statusCode:200,responseHeaders:[]});
  assert.equal(dash.streamType,'DASH');assert.equal(dash.unsupported,true);
  assert.equal(classifyNetworkResponse({url:'https://cdn.example.test/segment.ts',statusCode:200,responseHeaders:[{name:'Content-Type',value:'video/mp2t'}]}),null);
});

test('sniffer rejects failures, credentials, HTML login responses and unknown binary downloads',()=>{
  assert.equal(classifyNetworkResponse({url:'https://cdn.example.test/a.mp4',statusCode:404,responseHeaders:[]}),null);
  assert.equal(classifyNetworkResponse({url:'https://user:pass@cdn.example.test/a.mp4',statusCode:200,responseHeaders:[]}),null);
  assert.equal(classifyNetworkResponse({url:'https://cdn.example.test/a.mp4',statusCode:200,responseHeaders:[{name:'content-type',value:'text/html'}]}),null);
  assert.equal(classifyNetworkResponse({url:'https://cdn.example.test/file.bin',statusCode:200,responseHeaders:[{name:'content-type',value:'application/octet-stream'}]}),null);
});

test('capture is restricted to its selected tab, permitted origins, initiators and one-minute window',()=>{
  const capture={tabId:9,expiresAt:60_000,allowedOrigins:['https://cdn.example.test'],initiators:['https://studio.example.test']};
  const request={tabId:9,url:'https://cdn.example.test/clip.mp4',initiator:'https://studio.example.test',type:'xmlhttprequest'};
  assert.equal(shouldCaptureRequest(capture,request,59_999),true);
  assert.equal(shouldCaptureRequest(capture,request,60_000),false);
  assert.equal(shouldCaptureRequest(capture,{...request,tabId:10},1),false);
  assert.equal(shouldCaptureRequest(capture,{...request,url:'https://other.example.test/clip.mp4'},1),false);
  assert.equal(shouldCaptureRequest(capture,{...request,initiator:'https://other.example.test'},1),false);
});
