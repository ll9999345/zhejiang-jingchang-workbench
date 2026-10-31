import test from 'node:test';
import assert from 'node:assert/strict';

function event(){
  const listeners=new Set();
  return{addListener(listener){listeners.add(listener);},removeListener(listener){listeners.delete(listener);},emit(...args){for(const listener of [...listeners])listener(...args);},get size(){return listeners.size;}};
}

test('MV3 worker listens only during an authorized current-tab session and releases listener on stop/disconnect',async t=>{
  const onConnect=event(),onHeadersReceived=event();let permissionGranted=true;
  globalThis.chrome={
    runtime:{onConnect},
    permissions:{contains:async()=>permissionGranted},
    webRequest:{onHeadersReceived}
  };
  t.after(()=>{delete globalThis.chrome;});
  await import(`../tools/chrome-local-asset-importer/background.js?test=${Date.now()}`);
  const makePort=()=>{
    const onMessage=event(),onDisconnect=event(),messages=[];
    return{name:'network-capture',onMessage,onDisconnect,messages,postMessage(message){messages.push(message);},disconnect(){onDisconnect.emit();}};
  };
  const port=makePort();onConnect.emit(port);
  port.onMessage.emit({type:'start',tabId:7,allowedOrigins:['https://media.example.test'],initiators:['https://studio.example.test']});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(port.messages.at(-1).type,'capture-started');assert.equal(onHeadersReceived.size,1);
  const base={tabId:7,url:'https://media.example.test/clip.mp4?signature=temp',initiator:'https://studio.example.test',type:'xmlhttprequest',statusCode:206,responseHeaders:[{name:'content-type',value:'video/mp4'}]};
  onHeadersReceived.emit({...base,tabId:8});
  onHeadersReceived.emit({...base,initiator:'https://other.example.test'});
  onHeadersReceived.emit(base);
  assert.equal(port.messages.filter(message=>message.type==='candidate').length,1);
  assert.equal(port.messages.find(message=>message.type==='candidate').item.name,'clip.mp4');
  port.onMessage.emit({type:'stop'});
  assert.equal(port.messages.at(-1).reason,'user');assert.equal(onHeadersReceived.size,0);
  permissionGranted=false;
  const denied=makePort();onConnect.emit(denied);
  denied.onMessage.emit({type:'start',tabId:7,allowedOrigins:['https://media.example.test'],initiators:['https://studio.example.test']});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(denied.messages.at(-1).type,'capture-error');assert.equal(onHeadersReceived.size,0);
  denied.disconnect();port.disconnect();
});
