import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../extension/offscreen.js',import.meta.url),'utf8');
const ctx=vm.createContext({chrome:{runtime:{onMessage:{addListener(){}},sendMessage:async()=>{}}},console,AbortController,setTimeout,clearTimeout,setInterval,clearInterval});
vm.runInContext(source,ctx);

test('network recovery only asks for finished cached audio, not another paid synthesis',async()=>{
 const urls=[];ctx.fetch=async url=>{urls.push(url);if(url.endsWith('/tts'))throw new TypeError('network');return {status:200,blob:async()=>({cached:true})};};
 const result=await ctx.fetchEngineAudio('A sentence.','http://local/voicedock/tts','flash-default','piper');
 assert.equal(result.cached,true);assert.deepEqual(urls,['http://local/voicedock/tts','http://local/voicedock/cached-tts']);
});

test('custom sentence gap can be interrupted by stop',async()=>{
 vm.runInContext('currentGapMs=800;isPaused=false',ctx);let live=true;
 const start=Date.now(),pending=ctx.waitSentenceGap(()=>live);setTimeout(()=>live=false,30);await pending;
 assert(Date.now()-start<200);vm.runInContext('currentGapMs=0',ctx);
});

test('cloud playback sends a complete sentence beyond the old 140-character cut',()=>{
 vm.runInContext(fs.readFileSync(new URL('../extension/reading.js',import.meta.url),'utf8'),ctx);
 const text='Dr Packard '+ 'carefully examined the report, '.repeat(8)+'and closed the book.';
 assert.deepEqual(Array.from(ctx.splitIntoChunks(text)),[text]);
});
test('an unpunctuated selection is bounded without losing words',()=>{
  const text='word '.repeat(2400).trim();const parts=ctx.splitIntoChunks(text);
  assert(parts.length>1);assert(parts.every(p=>p.length<=5000));
  assert.equal(parts.join(' '),text);
});
test('an unbroken token is safely bounded',()=>{
  assert(ctx.splitIntoChunks('中'.repeat(12000)).every(p=>p.length<=5000));
});
test('stop during synthesis does not prefetch another chunk',async()=>{
  let requests=0;
  ctx.fetch=(_url,options)=>new Promise((_resolve,reject)=>{
    requests++;options.signal.addEventListener('abort',()=>reject(new Error('aborted')));
  });
  const playing=ctx.playQueue(['first','second'],'http://local/tts','','piper',0);
  ctx.stopAll();await playing;
  assert.equal(requests,1);
});
