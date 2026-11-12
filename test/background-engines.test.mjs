// End-to-end engine routing inside the service worker: a profile's engine
// decides which local server the offscreen player is pointed at, and an engine
// that is down falls back to the browser voice (or stays silent when the
// fallback is off). Runs background.js under a chrome shim with fetch mocked.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const online = { 'http://127.0.0.1:8766/voicedock': true, 'http://127.0.0.1:7478': true };
const calls = { runtime: [], tts: [], hints: [] };
const store = { fallback: true };
const listeners = {};

const event = (name) => ({ addListener: (fn) => { (listeners[name] ||= []).push(fn); } });
globalThis.chrome = {
  runtime: {
    lastError: null,
    onInstalled: event('runtime.onInstalled'),
    onStartup: event('runtime.onStartup'),
    onMessage: event('runtime.onMessage'),
    getURL: (p) => 'chrome-extension://test/' + p,
    getContexts: async () => [],
    sendMessage: async (msg) => { calls.runtime.push(msg); return { ok: true }; },
  },
  storage: {
    onChanged: event('storage.onChanged'),
    local: {
      get: async (keys) => {
        if (keys === null) return structuredClone(store);
        const list = [].concat(keys);
        return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, store[k]]));
      },
      set: async (obj) => { Object.assign(store, obj); },
      remove: async (keys) => { for (const k of [].concat(keys)) delete store[k]; },
    },
  },
  contextMenus: { onClicked: event('contextMenus.onClicked'), removeAll: async () => {}, create: () => {}, update: async () => {} },
  commands: { onCommand: event('commands.onCommand') },
  tts: { stop() {}, speak(text, opts) { calls.tts.push({ text, opts }); }, pause() {}, resume() {} },
  tabs: {
    query: (_q, cb) => cb?.([]),
    sendMessage: async (tabId, msg) => { if (msg.type === 'show-hint') calls.hints.push({ tabId, message: msg.message }); },
  },
  offscreen: { createDocument: async () => {} },
  alarms: {onAlarm:event('alarms.onAlarm'),create:async()=>{},clear:async()=>{}},
};

globalThis.fetch = async (url) => {
  const base = url.replace(/\/health$/, '');
  if (!online[base]) throw new TypeError('fetch failed');
  return { ok: true, json: async () => ({ status: 'ok' }) };
};

await import('../extension/background.js');
const onMessage = listeners['runtime.onMessage'][0];

function send(message, sender = {}) {
  return new Promise((resolve) => {
    const keepOpen = onMessage(message, sender, resolve);
    if (keepOpen !== true) resolve(undefined);
  });
}

async function stop() {
  await send({ type: 'stop-all' });
}

beforeEach(async () => {
  await stop();
  calls.runtime.length = 0;
  calls.tts.length = 0;
  calls.hints.length = 0;
  online['http://127.0.0.1:8766/voicedock'] = true;
  online['http://127.0.0.1:7478'] = true;
  store.fallback = true;
});

const speakTextMessages = () => calls.runtime.filter((m) => m.type === 'speak-text');

test('unfinished sentence is synthesized once with the next page instead of two fragments',async()=>{
 const original=chrome.tabs.sendMessage;const tab={id:77,url:'https://weread.qq.com/web/reader/cross-page'};const source={tab,url:tab.url};const requests=[];
 store.profiles=[{id:'active',engine:'piper',voice:'flash-default',name:'Voice'}];store.activeId='active';store.readerAutoTurn=true;
 chrome.tabs.sendMessage=async(id,m)=>{requests.push(m);if(m.type.startsWith('get-reading-context'))return {id:'part-one',text:'A complete sentence. I know I',scope:'weread-body',kind:'canvas',pageKey:'one',followPage:true,canAutoTurn:true};return {ok:true};};
 try{
  await send({type:'ball-read-selection'},source);
  assert.equal(speakTextMessages().at(-1).text,'A complete sentence.');
  await send({type:'playback-ended'});await new Promise(r=>setTimeout(r,15));
  assert(requests.some(m=>m.type==='continue-weread-page'));
  await send({type:'weread-page-change',previousId:'part-one',context:{id:'part-two',text:'can pin down the answer.',scope:'weread-body',kind:'canvas',pageKey:'two',followPage:true,canAutoTurn:false}},source);
  assert.equal(speakTextMessages().at(-1).text,'I know I can pin down the answer.');
  assert(requests.some(m=>m.type==='reading-page-prefix'&&m.prefix==='I know I '));
 }finally{chrome.tabs.sendMessage=original;}
});

test('a disappearing next-page button flushes the held tail once without a turning loop',async()=>{
 const original=chrome.tabs.sendMessage;const tab={id:78,url:'https://weread.qq.com/web/reader/cross-page'};let turns=0;
 store.profiles=[{id:'active',engine:'piper',voice:'flash-default',name:'Voice'}];store.activeId='active';store.readerAutoTurn=true;
 chrome.tabs.sendMessage=async(id,m)=>{if(m.type.startsWith('get-reading-context'))return {id:'last-page',text:'A complete sentence. Unfinished tail',scope:'weread-body',kind:'canvas',pageKey:'last',followPage:true,canAutoTurn:true};if(m.type==='continue-weread-page'){turns++;return {ok:false};}return {ok:true};};
 try{
  await send({type:'ball-read-selection'},{tab,url:tab.url});await send({type:'playback-ended'});await new Promise(r=>setTimeout(r,25));
  assert.equal(speakTextMessages().at(-1).text,'Unfinished tail');
  await send({type:'playback-ended'});await new Promise(r=>setTimeout(r,15));assert.equal(turns,1);
 }finally{chrome.tabs.sendMessage=original;}
});

test('a late new page waits for a fallback tail to finish instead of interrupting it',async()=>{
 const original=chrome.tabs.sendMessage;const tab={id:79,url:'https://weread.qq.com/web/reader/cross-page'};const source={tab,url:tab.url};
 const next={id:'late-page',text:'The next page starts here.',scope:'weread-body',kind:'canvas',pageKey:'late',followPage:true,canAutoTurn:false};
 store.profiles=[{id:'active',engine:'piper',voice:'flash-default',name:'Voice'}];store.activeId='active';store.readerAutoTurn=true;
 chrome.tabs.sendMessage=async(id,m)=>{if(m.type.startsWith('get-reading-context'))return m.fromTop?next:{id:'slow-page',text:'Complete sentence. Pending words',scope:'weread-body',kind:'canvas',pageKey:'slow',followPage:true,canAutoTurn:true};return {ok:false};};
 try{
  await send({type:'ball-read-selection'},source);await send({type:'playback-ended'});await new Promise(r=>setTimeout(r,20));
  assert.equal(speakTextMessages().at(-1).text,'Pending words');const count=speakTextMessages().length;
  const result=await send({type:'weread-page-change',previousId:'slow-page',context:next},source);
  assert.equal(result.deferred,true);assert.equal(speakTextMessages().length,count);
  await send({type:'playback-ended'});await new Promise(r=>setTimeout(r,20));
  assert.equal(speakTextMessages().at(-1).text,next.text);
 }finally{chrome.tabs.sendMessage=original;}
});

test('sentence gap persists and is bounded',async()=>{
 await send({type:'set-reading-gap',gapMs:800});assert.equal((await send({type:'get-playback-state'})).gapMs,800);
 assert.equal(store.readingGapMs,800);await send({type:'set-reading-gap',gapMs:0});
});
test('timer expiry stops audio and cancels page following',async()=>{
 await send({type:'set-sleep-timer',minutes:5});
 assert((await send({type:'get-playback-state'})).sleepDeadline>Date.now());
 await send({type:'test-voice',text:'Hello.',settings:{engine:'piper',voice:'flash-default'}});
 for(const listener of listeners['alarms.onAlarm'])listener({name:'reader-sleep'});
 await new Promise(r=>setTimeout(r,20));const state=await send({type:'get-playback-state'});
 assert.equal(state.isPlaying,false);assert.equal(state.sleepDeadline,0);assert.equal(state.pageFollow,null);assert.match(state.progress.label,/定时/);
});
test('next and previous sentence use full document offsets',async()=>{
 await send({type:'set-reading-mode',mode:'sentence'});
 store.profiles=[{id:'active',engine:'piper',voice:'flash-default',name:'Voice'}];store.activeId='active';
 await send({type:'read-document',text:'First sentence. Second sentence. Third sentence.'});
 await send({type:'playback-progress',start:16,end:32,phase:'playing'});
 await send({type:'reader-seek',delta:1});assert.equal(speakTextMessages().at(-1).text,'Third sentence.');
 await send({type:'reader-seek',delta:-1});assert.equal(speakTextMessages().at(-1).text,'Second sentence. Third sentence.');
 await send({type:'set-reading-mode',mode:'paragraph'});
});

test('paragraph mode persists and mode switching never starts paid synthesis',async()=>{
 const before=speakTextMessages().length;
 await send({type:'set-reading-mode',mode:'paragraph'});
 assert.equal(store.readingMode,'paragraph');assert.equal((await send({type:'get-playback-state'})).readingMode,'paragraph');
 assert.equal(speakTextMessages().length,before);
 await send({type:'read-document',text:'First thought. More context.\nNext paragraph.'});
 assert.equal(speakTextMessages().at(-1).readingMode,'paragraph');
 await send({type:'reader-seek',delta:1});assert.equal(speakTextMessages().at(-1).text,'Next paragraph.');
 await send({type:'set-reading-mode',mode:'sentence'});
 assert.equal((await send({type:'get-playback-state'})).isPlaying,false);
 await send({type:'set-reading-mode',mode:'paragraph'});
});

test('last mode selection wins when an earlier stop completes late',async()=>{
 const original=chrome.runtime.getContexts;let release;
 chrome.runtime.getContexts=()=>new Promise(resolve=>{if(!release)release=()=>resolve([]);else resolve([]);});
 try{
  const first=send({type:'set-reading-mode',mode:'sentence'});
  for(let i=0;i<20&&!release;i++)await new Promise(r=>setTimeout(r,1));
  assert(release);await send({type:'set-reading-mode',mode:'paragraph'});release();
  assert.equal((await first).cancelled,true);
  assert.equal(store.readingMode,'paragraph');assert.equal((await send({type:'get-playback-state'})).readingMode,'paragraph');
 }finally{chrome.runtime.getContexts=original;}
});

test('latest voice choice wins when metadata replies arrive out of order',async()=>{
  const originalFetch=globalThis.fetch;const pending=[];
  store.profiles=[{id:'active',engine:'piper',voice:'flash-default',name:'First'}];store.activeId='active';
  try{
    globalThis.fetch=()=>new Promise(resolve=>pending.push(resolve));
    const first=send({type:'select-cloud-voice',id:'cloud:A'});
    await new Promise(r=>setTimeout(r,5));
    const second=send({type:'select-cloud-voice',id:'cloud:B'});
    await new Promise(r=>setTimeout(r,5));
    const response={ok:true,json:async()=>({voiceDetails:[{id:'cloud:A',name:'A'},{id:'cloud:B',name:'B'}]})};
    pending[1](response);await second;pending[0](response);await first;
    assert.equal(store.profiles[0].voice,'cloud:B');
  }finally{globalThis.fetch=originalFetch;}
});

test('WeRead follows a new page only during the same reading session',async()=>{
  const oldQuery=chrome.tabs.query,oldSend=chrome.tabs.sendMessage;
  try{
    chrome.tabs.query=async()=>[{id:42}];
    chrome.tabs.sendMessage=async(id,m)=>m.type.startsWith('get-reading-context')?{id:'book-page-one',text:'First page.',followPage:true,kind:'canvas',scope:'weread-body'}:oldSend(id,m);
    await send({type:'popup-read-selection'});
    const next={type:'weread-page-change',previousId:'book-page-one',context:{id:'book-page-two',text:'Second page.',followPage:true,kind:'canvas',scope:'weread-body'}};
    const sender={tab:{id:42},url:'https://weread.qq.com/web/reader/book'};
    const count=speakTextMessages().length;
    const rejected=await send({...next,context:{...next.context,kind:'page',text:'首页 我的书架'}},sender);
    assert.equal(rejected.ok,false);assert.equal(speakTextMessages().length,count);
    const changed=await send(next,sender);
    assert.equal(changed?.ok,true);
    assert.equal(speakTextMessages().at(-1).text,'Second page.');
    await stop();
    const before=speakTextMessages().length;
    const stopped=await send({...next,previousId:'book-page-two',context:{id:'book-page-three',text:'Third page.',followPage:true}},sender);
    assert.equal(stopped?.ok,false);assert.equal(speakTextMessages().length,before);
  }finally{chrome.tabs.query=oldQuery;chrome.tabs.sendMessage=oldSend;}
});

test('an old tab adapter is replaced before continuous reading',async()=>{
  const oldQuery=chrome.tabs.query,oldSend=chrome.tabs.sendMessage,oldScripting=chrome.scripting;
  let injected=false;
  try{
    chrome.tabs.query=async()=>[{id:42}];
    chrome.scripting={executeScript:async()=>{injected=true;return [];}};
    chrome.tabs.sendMessage=async(id,message)=>{
      if(message.type==='get-reading-context')return {text:'Only old selected sentence.'};
      if(message.type==='get-reading-context-1110a'){
        if(!injected)throw Error('old adapter');
        return {id:'fresh-document',text:'Selected sentence. Following paragraph.'};
      }
      return oldSend(id,message);
    };
    const result=await send({type:'popup-read-selection'});
    assert.equal(result.ok,true);assert.equal(injected,true);
    assert.equal(speakTextMessages()[0].text,'Selected sentence. Following paragraph.');
    assert.equal((await send({type:'reader-runtime-version'})).build,'1110-A');
  }finally{chrome.tabs.query=oldQuery;chrome.tabs.sendMessage=oldSend;chrome.scripting=oldScripting;}
});

test('an unreadable book body reports the reason instead of reading navigation', async()=>{
  const oldQuery=chrome.tabs.query,oldSend=chrome.tabs.sendMessage;
  try{
    chrome.tabs.query=async()=>[{id:42}];
    chrome.tabs.sendMessage=async(id,msg)=>msg.type==='get-reading-context-1110a'
      ?{text:'',error:'未获取到微信读书正文'}:oldSend(id,msg);
    const result=await send({type:'popup-read-selection'});
    assert.equal(result.error,'未获取到微信读书正文');
    assert.equal(speakTextMessages().length,0);
  }finally{chrome.tabs.query=oldQuery;chrome.tabs.sendMessage=oldSend;}
});

test('Flash never changes to browser voice with a legacy fallback setting', async () => {
  online['http://127.0.0.1:8766/voicedock'] = false;
  const result = await send({type:'test-voice',text:'Hello',settings:{engine:'piper',voice:'flash-default'}});
  assert.equal(result.ok,false);
  assert.equal(calls.tts.length,0);
});

test('Flash playback errors stay visible and never start browser speech', async () => {
  await send({type:'test-voice',text:'Hello',settings:{engine:'piper',voice:'flash-default'}});
  await send({type:'playback-error',engine:'piper',error:'test connection lost'});
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(calls.tts.length,0);
  const state=await send({type:'get-playback-state'});
  assert.match(state.progress.error,/test connection lost/);
});

test('a pre-existing tab cannot silently degrade continuous reading to selection-only',async()=>{
  const oldQuery=chrome.tabs.query,oldSend=chrome.tabs.sendMessage,oldScripting=chrome.scripting;
  let selectionReads=0;
  try{
    chrome.tabs.query=(_q,cb)=>cb?cb([{id:42}]):Promise.resolve([{id:42}]);
    chrome.tabs.sendMessage=(id,msg)=>msg.type==='get-selection'?Promise.reject(new Error('Receiving end does not exist')):oldSend(id,msg);
    chrome.scripting={executeScript:async options=>{selectionReads++;assert.equal(options.target.tabId,42);return [{result:'Selected text from the old tab'}];}};
    const result=await send({type:'popup-read-selection'});
    assert.equal(result.ok,false);assert.match(result.error,/刷新/);
    assert.equal(speakTextMessages().length,0);
  }finally{chrome.tabs.query=oldQuery;chrome.tabs.sendMessage=oldSend;chrome.scripting=oldScripting;}
});

test('stop during the health check prevents delayed playback',async()=>{
  const originalFetch=globalThis.fetch;let release;
  try{
    globalThis.fetch=()=>new Promise(resolve=>release=resolve);
    const pending=send({type:'test-voice',text:'Hello',settings:{engine:'piper',voice:'flash-default'}});
    await new Promise(resolve=>setTimeout(resolve,10));
    await stop();release({ok:true,json:async()=>({status:'ok'})});
    await pending;
    assert.equal(speakTextMessages().length,0);
  } finally{globalThis.fetch=originalFetch;}
});

test('stop while retrieving the selection prevents delayed playback',async()=>{
  const originalQuery=chrome.tabs.query,originalSend=chrome.tabs.sendMessage;let release;
  try{
    chrome.tabs.query=(_query,callback)=>callback?callback([{id:42}]):Promise.resolve([{id:42}]);
    chrome.tabs.sendMessage=(id,message)=>message.type==='get-reading-context-1110a'
      ?new Promise(resolve=>release=resolve):originalSend(id,message);
    const pending=send({type:'popup-read-selection'});
    await new Promise(resolve=>setTimeout(resolve,10));
    await stop();release({text:'Hello world'});await pending;
    assert.equal(speakTextMessages().length,0);
  }finally{chrome.tabs.query=originalQuery;chrome.tabs.sendMessage=originalSend;}
});

test('a Kokoro profile is sent to the Kokoro server', async () => {
  const res = await send({ type: 'test-voice', text: 'Hi', settings: { engine: 'kokoro', voice: 'bf_emma', rate: 1.2, volume: 0.8 } });
  assert.deepEqual(res, { ok: true, engine: 'kokoro', fellBack: false });
  const [msg] = speakTextMessages();
  assert.equal(msg.engine, 'kokoro');
  assert.equal(msg.ttsUrl, 'http://127.0.0.1:7478/tts');
  assert.equal(msg.voice, 'bf_emma');
  assert.equal(msg.rate, 1.2);
  assert.equal(calls.tts.length, 0);
});

test('a Piper profile (old voice-only shape) is sent to the Piper server', async () => {
  const res = await send({ type: 'test-voice', text: 'Hi', settings: { voice: 'en_US-amy-medium.onnx' } });
  assert.equal(res.engine, 'piper');
  const [msg] = speakTextMessages();
  assert.equal(msg.ttsUrl, 'http://127.0.0.1:8766/voicedock/tts');
  assert.equal(msg.voice, 'en_US-amy-medium.onnx');
});

test('an offline engine falls back to the browser voice and tells the page', async () => {
  online['http://127.0.0.1:7478'] = false;
  // keyboard-read reads with the active profile; make it a Kokoro one.
  store.profiles = [{ id: 'k', name: 'K', engine: 'kokoro', voice: 'af_heart', rate: 1, volume: 1 }];
  store.activeId = 'k';
  await send({ type: 'keyboard-read', text: 'Hello there' }, { tab: { id: 42 } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(speakTextMessages().length, 0, 'nothing is sent to the offline engine');
  assert.equal(calls.tts.length, 1);
  assert.equal(calls.tts[0].text, 'Hello there');
  assert.deepEqual(calls.hints, [{ tabId: 42, message: 'Kokoro is offline. Using the browser voice.' }]);
});

test('the Test button reports a fallback', async () => {
  online['http://127.0.0.1:8766/voicedock'] = false;
  const res = await send({ type: 'test-voice', text: 'Hi', settings: { engine: 'piper', voice: '' } });
  assert.deepEqual(res, { ok: true, engine: 'browser', fellBack: true });
  assert.equal(calls.tts.length, 1);
});

test('with the fallback off, an offline engine reports an error and stays silent', async () => {
  online['http://127.0.0.1:7478'] = false;
  store.fallback = false;
  const res = await send({ type: 'test-voice', text: 'Hi', settings: { engine: 'kokoro', voice: 'af_heart' } });
  assert.deepEqual(res, { ok: false, engine: null, fellBack: false, error: 'Kokoro is offline' });
  assert.equal(calls.tts.length, 0);
  assert.equal(speakTextMessages().length, 0);
});

test('the browser engine never touches a server', async () => {
  online['http://127.0.0.1:8766/voicedock'] = false;
  online['http://127.0.0.1:7478'] = false;
  const res = await send({ type: 'test-voice', text: 'Hi', settings: { engine: 'browser' } });
  assert.deepEqual(res, { ok: true, engine: 'browser', fellBack: false });
  assert.equal(calls.tts.length, 1);
});

test('install runs the settings migration', async () => {
  for (const k of Object.keys(store)) delete store[k];
  Object.assign(store, {
    profiles: [{ id: 'x', name: 'X', voice: 'en_US-amy-medium.onnx', rate: 1, volume: 1 }],
    favorites: ['en_US-amy-medium.onnx'],
    fallbackToBrowser: true,
  });
  for (const fn of listeners['runtime.onInstalled']) fn({ reason: 'update' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.profiles[0].engine, 'piper');
  assert.deepEqual(store.favoritesByEngine, { piper: ['en_US-amy-medium.onnx'], kokoro: [] });
  assert.equal(store.fallback, true);
  assert.equal('favorites' in store, false);
});
