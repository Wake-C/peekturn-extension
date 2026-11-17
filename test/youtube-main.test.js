import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../src/youtube-main.js',import.meta.url),'utf8');
const videoId='UF8uR6Z6KLc';
async function acquire(nativeUrl, cachedRequest=true, earlyUrl=null) {
  const listeners=new Map(),requests=[];
  let publish, observe, selectedNative=false;
  const nativeEntry={name:nativeUrl,initiatorType:'xmlhttprequest'};
  const result=new Promise(resolve=>publish=resolve);
  const track={languageCode:'en',baseUrl:`https://www.youtube.com/api/timedtext?v=${videoId}&lang=en`};
  const player={getPlayerResponse:()=>({videoDetails:{videoId},captions:{playerCaptionsTracklistRenderer:{captionTracks:[track]}}}),loadModule(){},
    getOption:()=>[{languageCode:'en',id:'en',vss_id:'.en'}],
    setOption(module,option,value){
      if(option==='track')selectedNative=value.id==='en'&&!value.baseUrl;
      if(option==='reload'&&!cachedRequest&&selectedNative)observe({getEntries:()=>[nativeEntry]});
    }};
  const context={URL,AbortSignal,Map,WeakSet,console,location:{pathname:'/watch',href:`https://www.youtube.com/watch?v=${videoId}`,origin:'https://www.youtube.com'},
    document:{getElementById:()=>player,querySelector:()=>null,addEventListener:(name,fn)=>listeners.set(name,fn),dispatchEvent:event=>publish(event.detail)},
    window:{},CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}},
    PerformanceObserver:class{constructor(callback){observe=callback;}observe(){}},performance:{getEntriesByType:()=>cachedRequest?[{...nativeEntry,name:earlyUrl||nativeUrl}]:[]},
    setTimeout:fn=>{fn();return 1;},
    fetch:async url=>{
      requests.push(url);
      if(url===earlyUrl)observe({getEntries:()=>[nativeEntry]});
      const accepted=url===nativeUrl&&new URL(url).searchParams.get('v')===videoId;
      return{ok:true,url,text:async()=>accepted?JSON.stringify({events:[{tStartMs:1000,dDurationMs:2200,segs:[{utf8:'A complete sentence.'}]}]}):''};
    }
  };
  vm.runInNewContext(source,context);
  await listeners.get('peekturn:request')({detail:{videoId,requestId:'test-request'}});
  return {result:JSON.parse(JSON.stringify(await result)),requests};
}

test('uses native verified caption URL unchanged and publishes only text with timings',async()=>{
  const url=`https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&fmt=json3&pot=native-verification&xobt=3`;
  const {result,requests}=await acquire(url);
  assert.deepEqual(requests,[url]);
  assert.deepEqual(result,{videoId,requestId:'test-request',cues:[{id:0,startMs:1000,endMs:3200,text:'A complete sentence.'}]});
});
test('does not reuse verified captions from a previous video after navigation',async()=>{
  const url='https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&fmt=json3&pot=old-video';
  const {result,requests}=await acquire(url);
  assert.ok(!requests.includes(url));
  assert.deepEqual(result.cues,[]);
  assert.equal(result.error,'Could not retrieve English captions');
});
test('acquires captions when the player has cached its track without a resource entry',async()=>{
  const url=`https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&fmt=json3&pot=fresh-verification`;
  const {result}=await acquire(url,false);
  assert.equal(result.error,undefined);
  assert.equal(result.cues[0]?.text,'A complete sentence.');
});
test('waits for verified request after an early empty native response',async()=>{
  const early=`https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&fmt=json3`;
  const verified=`${early}&pot=ready`;
  const {result,requests}=await acquire(verified,true,early);
  assert.equal(result.error,undefined);
  assert.equal(result.cues[0]?.text,'A complete sentence.');
  assert.deepEqual(requests,[early,verified]);
});
