// ─── Constants ────────────────────────────────────────────────────────────────
// Engine URLs, the seed profile, engine selection and the settings migration
// are shared with the React UI (src/shared.js) so they can't drift apart.
import {
  LOCAL_ENGINE_IDS,
  bridgeHeaders,
  chooseEngine,
  defaultProfile,
  engineBaseUrl,
  engineLabel,
  normalizeProfile,
  runSettingsMigration,
} from "./src/shared.js";
import './reading.js';

const OFFSCREEN_URL  = "offscreen.html";

async function getProfileState() {
  const state = await chrome.storage.local.get(["profiles", "activeId"]);
  const profiles = Array.isArray(state.profiles) ? state.profiles.map(normalizeProfile) : [];
  let activeId = state.activeId || "";

  if (profiles.length === 0) {
    const profile = defaultProfile();
    await chrome.storage.local.set({ profiles: [profile], activeId: profile.id });
    return { profiles: [profile], activeId: profile.id };
  }

  if (!activeId || !profiles.some(p => p.id === activeId)) {
    activeId = profiles[0].id;
    await chrome.storage.local.set({ activeId });
  }

  return { profiles, activeId };
}

// ─── Context Menu Builder ─────────────────────────────────────────────────────
// Rebuilds context menus from stored profiles. Called on install and whenever
// profiles change.
async function rebuildMenus() {
  await chrome.contextMenus.removeAll();

  const { profiles, activeId } = await getProfileState();

  // Main read item - uses the active profile
  chrome.contextMenus.create({
    id:       "read-selection",
    title:    "用我的声音朗读选中文字",
    contexts: ["selection"]
  });

  // Per-profile submenu (only shown when there's more than one profile)
  if (profiles.length > 1) {
    chrome.contextMenus.create({
      id:       "read-as",
      title:    "Read as…",
      contexts: ["selection"]
    });
    for (const p of profiles) {
      chrome.contextMenus.create({
        id:       `profile-${p.id}`,
        parentId: "read-as",
        title:    p.name + (p.id === activeId ? " ✓" : ""),
        contexts: ["selection"]
      });
    }
  }

  chrome.contextMenus.create({
    id:       "stop-reading",
    title:    "停止朗读",
    contexts: ["all"],
    visible:  _isPlaying
  });
}

async function setStopMenuVisible(visible) {
  try {
    await chrome.contextMenus.update("stop-reading", { visible });
  } catch (err) {
    // The menu may not exist yet immediately after install or service worker startup.
    if (!err.message?.includes("Cannot find menu item")) {
      console.error("[TTS] setStopMenuVisible failed:", err);
    }
  }
}

// Settings saved by Piper TTS 1.0.x (profiles without an engine, the single
// favorites list, fallbackToBrowser) are upgraded in place; see
// migrateSettings in src/shared.js. Runs on install/update and on browser
// startup, and is idempotent.
async function migrateAndRebuild() {
  await runSettingsMigration(chrome.storage.local);
  await rebuildMenus();
}

chrome.runtime.onInstalled.addListener(() => {
  migrateAndRebuild().catch(err => console.error("[VoiceDock] migration failed:", err));
});
chrome.runtime.onStartup?.addListener(() => {
  migrateAndRebuild().catch(err => console.error("[VoiceDock] migration failed:", err));
});

// Rebuild whenever profiles or activeId change (popup saved new data).
// Debounced to prevent concurrent rebuilds when both keys change in one save.
let _rebuildTimer = null;
chrome.storage.onChanged.addListener((changes) => {
  if (changes.profiles || changes.activeId) {
    clearTimeout(_rebuildTimer);
    _rebuildTimer = setTimeout(
      () => rebuildMenus().catch(err => console.error("[TTS] rebuildMenus failed:", err)),
      50
    );
  }
});

// ─── Offscreen Document ───────────────────────────────────────────────────────
async function ensureOffscreenDocument() {
  try {
    await chrome.offscreen.createDocument({
      url:           OFFSCREEN_URL,
      reasons:       ["BLOBS"],
      justification: "Create and play cached audio Blob URLs during synthesis and paused reading."
    });
  } catch (err) {
    if (!err.message?.includes("Only a single offscreen document")) throw err;
  }
}

// ─── Browser TTS ─────────────────────────────────────────────────────────────
function finishPlayback() {
  _isPlaying = false;
  _isPaused  = false;
  _playbackEngine = null;
  _playingSourceTabId = null;
  _activeEngineRequest = null;
  resetProgress();
  _playbackProgress.label=_pageFollow?'本页已读完，等待翻页。':'当前正文已读完。';
  if(_pageFollow){
    const completed=_pageFollow,run=_playbackRunId;
    completed.tailReady=true;
    if(completed.deferredPage)resumeDeferredPage(completed).catch(()=>{});
    else turnAfterPage(completed,run).catch(()=>{});
  }
  setStopMenuVisible(false);
  notifyPlaybackState();
}

function speakWithBrowser(text, settings = {}) {
  const generation = ++_browserSpeakGeneration;
  const units = VDReading.readingAudioUnits(text, 5000, _readingMode);
  const document = _readingDocument;
  chrome.tts.stop();
  _activeEngineRequest = null;
  _isPlaying = true;
  _isPaused = false;
  _playbackEngine = 'browser';
  _currentVolume = Math.min(1, settings.volume ?? 1);
  _currentRate = settings.rate ?? 1;
  setStopMenuVisible(true);

  function live() {
    return generation === _browserSpeakGeneration && _playbackEngine === 'browser';
  }

  function fail() {
    if (!live()) return;
    _pageFollow = null;
    finishPlayback();
    _playbackProgress.error = '浏览器语音播放失败。请检查系统语音，或切换音色后重试。';
    notifyPlaybackState();
  }

  function next(index) {
    if (!live()) return;
    const unit = units[index];
    if (!unit) {
      finishPlayback();
      return;
    }
    const start = unit.start + (document?.offset || 0);
    const end = unit.end + (document?.offset || 0);
    const progress = phase => {
      _playbackProgress = {
        active: true, engine: 'browser', current: index + 1, total: units.length,
        percent: (index + 1) / units.length, label: '浏览器语音',
        phase, text: unit.text, documentId: document?.id, start, end
      };
      if (document) document.resumeOffset = start;
      if (document) chrome.storage.session?.set({readingDocument: document}).catch(() => {});
      notifyPlaybackState();
    };
    progress('waiting');
    chrome.tts.speak(unit.text, {
      rate: _currentRate,
      pitch: 1,
      volume: _currentVolume,
      enqueue: false,
      onEvent: event => {
        if (!live()) return;
        if (event.type === 'start' || event.type === 'word') {
          if (_playbackProgress.phase !== 'playing') progress('playing');
        } else if (event.type === 'end') {
          next(index + 1);
        } else if (event.type === 'error') {
          fail();
        } else if (event.type === 'cancelled' || event.type === 'interrupted') {
          _pageFollow = null;
          finishPlayback();
        }
      }
    }, () => {
      if (chrome.runtime.lastError) fail();
    });
  }

  next(0);
}

// ─── Engine Health Checks (per engine, 5-second cache) ───────────────────────
const _engineOnlineCache = Object.fromEntries(
  LOCAL_ENGINE_IDS.map(id => [id, { value: false, expiresAt: 0 }])
);

async function checkEngineOnline(engine) {
  const cache = _engineOnlineCache[engine];
  const baseUrl = engineBaseUrl(engine);
  if (!cache || !baseUrl) return false;
  if (Date.now() < cache.expiresAt) return cache.value;
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const headers = engine === 'piper' ? await bridgeHeaders() : {};
    const res = await fetch(`${baseUrl}/health`, { signal: ctrl.signal, headers, redirect: 'error' });
    clearTimeout(timer);
    _engineOnlineCache[engine] = { value: res.ok, expiresAt: Date.now() + 5000 };
    return res.ok;
  } catch (_) {
    _engineOnlineCache[engine] = { value: false, expiresAt: Date.now() + 2000 };
    return false;
  }
}

function invalidateEngineCache() {
  for (const id of LOCAL_ENGINE_IDS) _engineOnlineCache[id].expiresAt = 0;
}

// ─── Playback State ───────────────────────────────────────────────────────────
let _isPlaying    = false;
let _isPaused     = false;
let _playbackEngine    = null; // "piper", "kokoro" or "browser"
let _playingSourceTabId = null; // tab that triggered the current playback
let _currentVolume     = 1.0;  // cached from active profile; sent to content script overlay
let _currentRate       = 1.0;  // cached from active profile; sent to content script overlay
let _playbackProgress  = { active: false, engine: null, current: 0, total: 0, percent: null, label: "" };
let _activeEngineRequest = null;
let _browserSpeakGeneration = 0;
let _speakRequestGeneration = 0;
let _readingDocument=null,_playbackRunId='',_highlightEnabled=true;
let _pageFollow=null;
let _voiceSelectionGeneration=0,_voiceSelectionWrite=Promise.resolve();
let _gapMs=0,_sleepDeadline=0,_readingMode='paragraph',_readingModeGeneration=0;
async function saveTimer(minutes){
  _sleepDeadline=minutes>0?Date.now()+minutes*60000:0;
  await chrome.storage.local.set({readerSleepDeadline:_sleepDeadline});
  await chrome.alarms?.clear('reader-sleep');
  if(_sleepDeadline)await chrome.alarms?.create('reader-sleep',{when:_sleepDeadline});
  notifyPlaybackState();
}
async function finishTimer(){await saveTimer(0);await stopAll();_playbackProgress.label='定时已到，已停止朗读。';notifyPlaybackState();}
chrome.alarms?.onAlarm.addListener(alarm=>{if(alarm.name==='reader-sleep')finishTimer();});
chrome.storage.session?.get('readingDocument').then(saved=>{if(!_readingDocument)_readingDocument=saved.readingDocument||null;});
chrome.storage.local.get(['readingGapMs','readerSleepDeadline','readingMode']).then(async saved=>{
  _readingMode=saved.readingMode==='sentence'?'sentence':'paragraph';
  _gapMs=Math.max(0,Math.min(2000,Number(saved.readingGapMs)||0));_sleepDeadline=Number(saved.readerSleepDeadline)||0;
  if(_sleepDeadline>Date.now())await chrome.alarms?.create('reader-sleep',{when:_sleepDeadline});
  else if(_sleepDeadline){_sleepDeadline=0;await chrome.storage.local.set({readerSleepDeadline:0});}
});
const _cancelledRuns=new Set();
const readingId=()=>globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random()}`;

function resetProgress() {
  _playbackProgress = { active: false, engine: null, current: 0, total: 0, percent: null, label: "" };
}

function playbackStateForTab(tabId) {
  return {
    isPlaying: _isPlaying,
    isPaused:  _isPaused,
    volume:    _currentVolume,
    rate:      _currentRate,
    engine:    _playbackEngine,
    progress:  _playbackProgress
    ,highlight:_highlightEnabled,documentId:_readingDocument?.id||'',sourceTabId:_playingSourceTabId,pageFollow:_pageFollow,gapMs:_gapMs,sleepDeadline:_sleepDeadline,readingMode:_readingMode
  };
}

function sendPlaybackStateToTab(tabId) {
  chrome.tabs.sendMessage(tabId, {
    type: "playback-state",
    state: playbackStateForTab(tabId)
  }).catch(() => {});
}

function notifyPlaybackState(tabId = null) {
  if (tabId != null) {
    sendPlaybackStateToTab(tabId);
    return;
  }

  chrome.tabs.query({}, (tabs) => {
    if (chrome.runtime.lastError) return;
    for (const tab of tabs) {
      if (tab.id != null) sendPlaybackStateToTab(tab.id);
    }
  });
}

// ─── Local engine TTS (Piper or Kokoro, played by the offscreen document) ────
async function speakWithEngine(engine, text, settings, requestGeneration) {
  const online = await checkEngineOnline(engine);
  if(requestGeneration!==_speakRequestGeneration)return false;
  if (!online) throw new Error(`${engineLabel(engine)} server is offline`);

  _browserSpeakGeneration++;
  chrome.tts.stop();
  _activeEngineRequest = { text, settings: { ...settings } };
  _isPlaying = true;
  _isPaused  = false;
  _playbackEngine = engine;
  _currentVolume  = settings.volume ?? 1.0;
  _currentRate    = settings.rate ?? 1.0;
  _playbackProgress = {
    active: true,
    engine,
    current: 0,
    total: 0,
    percent: 0,
    label: "Starting"
  };
  setStopMenuVisible(true);
  notifyPlaybackState();
  try {
    await ensureOffscreenDocument();
  } catch (err) {
    if(requestGeneration!==_speakRequestGeneration)return false;
    // Unexpected offscreen creation error - reset flag so the popup/shortcut
    // don't get stuck in "Playing" state forever.
    _isPlaying = false;
    _playbackEngine = null;
    _activeEngineRequest = null;
    resetProgress();
    setStopMenuVisible(false);
    notifyPlaybackState();
    throw err;
  }
  if(requestGeneration!==_speakRequestGeneration)return false;
  const headers = engine === 'piper' ? await bridgeHeaders() : {};
  if(requestGeneration!==_speakRequestGeneration)return false;
  chrome.runtime.sendMessage({
    type:    "speak-text",
    text,
    engine,
    ttsUrl:  `${engineBaseUrl(engine)}/tts`,
    rate:    settings.rate   ?? 1.0,
    volume:  settings.volume ?? 1.0,
    voice:   settings.voice  || ""
    ,bridgePairingCode:headers['X-VoiceDock-Pairing']
    ,documentId:_readingDocument?.id||'',runId:_playbackRunId,gapMs:_gapMs,readingMode:_readingMode
  }).catch((err) => {
    if(requestGeneration!==_speakRequestGeneration)return;
    console.error("speak-text delivery failed:", err);
    _isPlaying = false; // delivery failed - no playback-ended will ever arrive
    _playbackEngine = null;
    _activeEngineRequest = null;
    resetProgress();
    setStopMenuVisible(false);
    notifyPlaybackState();
  });
  return true;
}

// ─── Stop All ────────────────────────────────────────────────────────────────
async function stopAll(preserveFollow=false,preserveTimer=true) {
  if(!preserveTimer&&_sleepDeadline){_sleepDeadline=0;chrome.storage.local.set({readerSleepDeadline:0});chrome.alarms?.clear('reader-sleep');}
  if(!preserveFollow)_pageFollow=null;
  if(_playbackRunId)_cancelledRuns.add(_playbackRunId);
  const stopGeneration=++_speakRequestGeneration;
  _isPlaying    = false;
  _isPaused     = false;
  _playbackEngine    = null;
  _playingSourceTabId = null;
  _activeEngineRequest = null;
  _browserSpeakGeneration++;
  resetProgress();
  invalidateEngineCache(); // so the next read checks the engines fresh
  await setStopMenuVisible(false);
  if(stopGeneration!==_speakRequestGeneration)return;
  notifyPlaybackState();
  chrome.tts.stop();
  try {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
    });
    if (existing.length > 0 && stopGeneration===_speakRequestGeneration) chrome.runtime.sendMessage({ type: "stop-audio" }).catch(() => {});
  } catch (_) {}
}

// ─── Speak with a profile (its engine, falling back to the browser voice) ────
// Returns { ok, engine, fellBack, error } so callers (the popup's Test button,
// the page hint) can say what actually happened.
async function speakText(text, profile, tabId = null, requestGeneration=++_speakRequestGeneration,context=null) {
  if(requestGeneration!==_speakRequestGeneration)return {ok:false,cancelled:true};
  const settings = normalizeProfile(profile || {});
  const { fallback: storedFallback = true,readingHighlight=true,readerAutoTurn=true } = await chrome.storage.local.get(["fallback","readingHighlight","readerAutoTurn"]);
  const fallback = storedFallback && !(settings.engine === 'piper' && (settings.voice === 'flash-default'||settings.voice.startsWith('cloud:')));
  if(requestGeneration!==_speakRequestGeneration)return {ok:false,cancelled:true};

  let online = {};
  if (settings.engine !== "browser") {
    online = { [settings.engine]: await checkEngineOnline(settings.engine) };
  }
  if(requestGeneration!==_speakRequestGeneration)return {ok:false,cancelled:true};
  _highlightEnabled=readingHighlight!==false;
  _playingSourceTabId=tabId;
  _readingDocument={id:context?.id||readingId(),text:context?.documentText||text,offset:context?.offset||0,
    kind:context?.kind||(tabId==null?'paste':'page'),sourceTabId:tabId,context:{...(context||{}),pendingTail:'',deferredPage:false},resumeOffset:context?.offset||0};
  _pageFollow=context?.followPage&&tabId!=null?{tabId,documentId:_readingDocument.id,pageKey:context.pageKey||'',kind:context.kind}:null;
  if(_pageFollow&&context.suppressAutoTurn)_pageFollow.suppressAutoTurn=true;
  if(_pageFollow&&context.flushingTail)_pageFollow.flushingTail=true;
  if(_pageFollow&&context.scope==='weread-body'&&context.canAutoTurn===true&&readerAutoTurn!==false&&!context.documentText&&settings.engine==='piper'&&(settings.voice==='flash-default'||settings.voice.startsWith('cloud:'))){
    const parts=VDReading.pageSpeechParts(text);
    if(parts.tail){text=parts.text;_pageFollow.pendingTail=parts.tail;_readingDocument.context={..._readingDocument.context,pendingTail:parts.tail};}
  }
  _playbackRunId=readingId();
  chrome.storage.session?.set({readingDocument:_readingDocument}).catch(()=>{});
  let choice = chooseEngine(settings, online, fallback);

  if (choice.engine && choice.engine !== "browser") {
    try {
      if(!text&&_pageFollow?.pendingTail){
        _pageFollow.tailReady=true;_isPlaying=false;_isPaused=false;resetProgress();_playbackProgress.label='正在翻页连接未完的句子…';
        notifyPlaybackState();turnAfterPage(_pageFollow,_playbackRunId).catch(()=>{});return {ok:true,engine:choice.engine,fellBack:false};
      }
      const started=await speakWithEngine(choice.engine, text, { ...settings, voice: choice.voice },requestGeneration);
      if(!started)return {ok:false,cancelled:true};
      return { ok: true, engine: choice.engine, fellBack: false };
    } catch (err) {
      console.error(`${engineLabel(choice.engine)} failed:`, err.message);
      choice = fallback
        ? { engine: "browser", fellBack: true, reason: err.message }
        : { engine: null, reason: err.message };
    }
  }

  if (choice.engine === "browser") {
    if (choice.fellBack) {
      console.log(`${choice.reason}; falling back to the browser voice`);
      if (tabId != null) showTabHint({ id: tabId }, `${choice.reason}. Using the browser voice.`);
    }
    speakWithBrowser(text, settings);
    return { ok: true, engine: "browser", fellBack: choice.fellBack };
  }

  if (tabId != null) showTabHint({ id: tabId }, `${choice.reason}. Turn on the browser fallback in Settings to hear it anyway.`);
  return { ok: false, engine: null, fellBack: false, error: choice.reason };
}

async function turnAfterPage(completed,run){
  if(completed.turnPending||completed.suppressAutoTurn)return;completed.turnPending=true;
  const live=()=>run===_playbackRunId&&_pageFollow===completed&&!_isPaused&&!(_sleepDeadline&&Date.now()>=_sleepDeadline);
  const saved=await chrome.storage.local.get('readerAutoTurn');
  if(!live())return;
  let turned=false;
  if(saved.readerAutoTurn!==false){
    // Deliver the new follow id before asking the content script to click.
    await chrome.tabs.sendMessage(completed.tabId,{type:'playback-state',state:playbackStateForTab(completed.tabId)}).catch(()=>{});
    if(!live())return;
    const reply=await chrome.tabs.sendMessage(completed.tabId,{type:'continue-weread-page',id:completed.documentId}).catch(()=>null);
    turned=reply?.ok===true;
  }
  if(!live()||!completed.pendingTail)return;
  if(turned){
    // A click can succeed while the site fails to load the next page. Keep the
    // held sentence bounded in time and fall back to reading it once.
    setTimeout(()=>{if(live())flushPageTail(completed,run).catch(()=>{});},10000);return;
  }
  await flushPageTail(completed,run);
}
async function flushPageTail(completed,run){
  if(_pageFollow!==completed||_playbackRunId!==run||_isPaused||!completed.pendingTail)return;
  // The next button may disappear or automatic turning may be disabled while
  // audio plays. Never lose the held text: read it on the current page instead.
  const doc=_readingDocument,tail=completed.pendingTail;
  const stopping=stopAll(true),generation=_speakRequestGeneration;await stopping;
  const {profiles,activeId}=await getProfileState();if(generation!==_speakRequestGeneration)return;
  const offset=Math.max(0,doc.text.lastIndexOf(tail));
  await speakText(tail,profiles.find(p=>p.id===activeId)||profiles[0],completed.tabId,generation,{...doc.context,id:doc.id,documentText:doc.text,offset,canAutoTurn:false,suppressAutoTurn:true,flushingTail:true});
}
async function resumeDeferredPage(completed){
  const stopping=stopAll(true),generation=_speakRequestGeneration;await stopping;
  if(generation!==_speakRequestGeneration||_pageFollow!==completed)return;
  const context=await chrome.tabs.sendMessage(completed.tabId,{type:'get-reading-context-1110a',fromHere:true,fromTop:true});
  if(generation!==_speakRequestGeneration||_pageFollow!==completed)return;
  if(context?.scope!=='weread-body'||!context.text?.trim()||(completed.kind==='canvas'&&context.kind!=='canvas')){
    _playbackProgress.label='下一页正文尚未就绪，请重新点击朗读。';notifyPlaybackState();return;
  }
  const {profiles,activeId}=await getProfileState();if(generation!==_speakRequestGeneration||_pageFollow!==completed)return;
  await speakText(context.text,profiles.find(p=>p.id===activeId)||profiles[0],completed.tabId,generation,context);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function getTabSelection(tab) {
  if (!tab?.id) return "";
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "get-selection" });
    if(response?.text?.trim())return response.text.trim();
  } catch (_) { /* The tab may predate installation or an extension reload. */ }
  if(!chrome.scripting?.executeScript)return '';
  try{
    const frames=await chrome.scripting.executeScript({
      target:{tabId:tab.id,allFrames:true},
      func:()=>{
        const text=window.getSelection()?.toString().trim();
        if(text)return text;
        const element=document.activeElement;
        if(element && (element.tagName==='TEXTAREA' || (element.tagName==='INPUT' && element.type!=='password'))
            && Number.isInteger(element.selectionStart) && element.selectionEnd>element.selectionStart){
          return element.value.slice(element.selectionStart,element.selectionEnd).trim();
        }
        return '';
      }
    });
    return frames.map(frame=>typeof frame.result==='string'?frame.result.trim():'').find(Boolean)||'';
  }catch(_){throw new Error('无法读取此页面。请刷新阅读页重试，或在下方粘贴文字朗读。');}
}

async function getReadingContext(tab,fromHere){
  try{const response=await chrome.tabs.sendMessage(tab.id,{type:'get-reading-context-1110a',fromHere});if(response?.text||response?.error)return response;}catch(_){}
  if(!chrome.scripting?.executeScript)return null;
  try{
    await chrome.scripting.executeScript({target:{tabId:tab.id},files:['reading.js','reading-content.js','content.js']});
    const response=await chrome.tabs.sendMessage(tab.id,{type:'get-reading-context-1110a',fromHere});
    return response?.text||response?.error?response:null;
  }catch(_){return null;}
}

function showTabHint(tab, message) {
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "show-hint", message }).catch(() => {});
}

async function readSelectionFromActiveTab(restart=false,fromHere=true,sourceTab=null) {
  if (_isPlaying && !restart) {
    await stopAll();
    return;
  }

  let requestGeneration=++_speakRequestGeneration;
  if(restart){const stopping=stopAll();requestGeneration=_speakRequestGeneration;await stopping;}
  if(requestGeneration!==_speakRequestGeneration)return {ok:false,cancelled:true};
  const tab = sourceTab||await getActiveTab();
  if(requestGeneration!==_speakRequestGeneration)return {ok:false,cancelled:true};
  const context=await getReadingContext(tab,fromHere);
  if(requestGeneration!==_speakRequestGeneration)return {ok:false,cancelled:true};
  if(context?.error)return {ok:false,error:context.error};
  if(tab?.url?.startsWith('https://weread.qq.com/web/reader/')&&context?.scope!=='weread-body')return {ok:false,error:'没有获取到微信读书正文，请刷新书页后重新选中起点。不会朗读菜单。'};
  if(fromHere&&!context?.text)return {ok:false,error:'未读取到可继续朗读的正文起点。请刷新当前网页，在正文中重新选中起点，再点击「从这里往后读」。'};
  const text = context?.text||await getTabSelection(tab);
  if(requestGeneration!==_speakRequestGeneration)return {ok:false,cancelled:true};
  if (!text) {
    showTabHint(tab, "请先在网页中选中文字");
    return {ok:false,error:'没有读到选中文字。微信读书可先点选区菜单「复制」，再用下方的「粘贴文字朗读」。'};
  }

  const { profiles, activeId } = await getProfileState();
  if(requestGeneration!==_speakRequestGeneration)return {ok:false,cancelled:true};
  const profile = profiles.find(p => p.id === activeId) || profiles[0];
  if (!profile) return;

  _playingSourceTabId = tab.id;
  return await speakText(text, profile, tab.id,requestGeneration,context);
}

async function togglePauseResume() {
  if (_isPaused) {
    _isPaused = false;
    if (_playbackEngine === "browser") {
      chrome.tts.resume();
    } else {
      const existing = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
      }).catch(() => []);
      if (existing.length > 0) chrome.runtime.sendMessage({ type: "resume-audio" }).catch(() => {});
    }
  } else if (_isPlaying) {
    _isPaused = true;
    if (_playbackEngine === "browser") {
      chrome.tts.pause();
    } else {
      const existing = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
      }).catch(() => []);
      if (existing.length > 0) chrome.runtime.sendMessage({ type: "pause-audio" }).catch(() => {});
    }
  }
  notifyPlaybackState();
}

// ─── Context Menu Click Handler ───────────────────────────────────────────────
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "stop-reading") { await stopAll(false,false); return; }

  let text = info.selectionText?.trim();
  if (!text) return;
  const requestGeneration=++_speakRequestGeneration;

  let { profiles, activeId } = await getProfileState();
  if(requestGeneration!==_speakRequestGeneration)return;
  const context=tab?.id?await getReadingContext(tab,false):null;
  if(requestGeneration!==_speakRequestGeneration)return;
  if(context?.text)text=context.text;

  // If a specific profile was chosen from the submenu, switch to it and read
  // with the newly selected profile.
  if (info.menuItemId.startsWith("profile-")) {
    activeId = info.menuItemId.replace("profile-", "");
    // Cancel any pending debounced rebuild before our own await so the
    // storage.onChanged listener (which fires when we set activeId below)
    // doesn't schedule a second rebuild that races with the one we're about to do.
    clearTimeout(_rebuildTimer);
    await chrome.storage.local.set({ activeId });
    await rebuildMenus();
    if(requestGeneration!==_speakRequestGeneration)return;
    // Also read the selected text with the newly chosen profile
    const selectedProfile = profiles.find(p => p.id === activeId);
    _playingSourceTabId = tab?.id ?? null;
    if (selectedProfile && text) await speakText(text, selectedProfile, tab?.id ?? null,requestGeneration,context);
    return;
  }

  const profile = profiles.find(p => p.id === activeId) || profiles[0];
  if (!profile) return;

  _playingSourceTabId = tab?.id ?? null;
  await speakText(text, profile, tab?.id ?? null,requestGeneration,context);
});

// ─── Messages from Popup / Content Script / Offscreen ────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if(message.type==='set-reading-mode'){
    if(!['sentence','paragraph'].includes(message.mode)){sendResponse({ok:false,error:'请选择有效朗读模式。'});return;}
    const generation=++_readingModeGeneration;
    (async()=>{await stopAll();if(generation!==_readingModeGeneration)return sendResponse({ok:false,cancelled:true});_readingMode=message.mode;await chrome.storage.local.set({readingMode:_readingMode});if(generation!==_readingModeGeneration)return sendResponse({ok:false,cancelled:true});_playbackProgress.label='已切换朗读模式，请点击朗读继续。';notifyPlaybackState();sendResponse({ok:true});})().catch(()=>sendResponse({ok:false,error:'模式保存失败，请重试。'}));return true;
  }
  if(message.type==='set-reading-gap'){
    _gapMs=Math.max(0,Math.min(2000,Number(message.gapMs)||0));chrome.storage.local.set({readingGapMs:_gapMs});
    chrome.runtime.sendMessage({type:'set-gap',gapMs:_gapMs}).catch(()=>{});notifyPlaybackState();sendResponse({ok:true});return;
  }
  if(message.type==='set-sleep-timer'){
    const minutes=Number(message.minutes);
    if(!Number.isFinite(minutes)||minutes<0||minutes>240){sendResponse({ok:false,error:'定时范围为0–240分钟。'});return;}
    saveTimer(minutes).then(()=>sendResponse({ok:true,deadline:_sleepDeadline}));return true;
  }
  if(message.type==='reader-seek'){
    (async()=>{
      const doc=_readingDocument||(await chrome.storage.session?.get('readingDocument'))?.readingDocument;
      if(!doc?.text)return sendResponse({ok:false,error:'请先选择正文开始一次朗读。'});
      const stopping=stopAll(true),generation=_speakRequestGeneration;await stopping;
      if(doc.sourceTabId!=null){
        const valid=await chrome.tabs.sendMessage(doc.sourceTabId,{type:'validate-reading-document',id:doc.id}).catch(()=>null);
        if(!valid?.ok){_pageFollow=null;notifyPlaybackState();return sendResponse({ok:false,error:'书页已变化，请在当前正文重新选起点。'});}
      }
      if(generation!==_speakRequestGeneration)return sendResponse({ok:false,cancelled:true});
      const units=VDReading.readingAudioUnits(doc.text,5000,_readingMode);let index=units.findIndex(u=>u.end>(doc.resumeOffset||0));if(index<0)index=units.length-1;
      index+=Math.sign(Number(message.delta)||0);
      if(index>=units.length)return sendResponse({ok:false,error:'已到当前正文末尾，请翻页或选择新的正文。'});
      const offset=units[Math.max(0,index)]?.start||0;
      const {profiles,activeId}=await getProfileState();if(generation!==_speakRequestGeneration)return sendResponse({ok:false,cancelled:true});
      sendResponse(await speakText(doc.text.slice(offset),profiles.find(p=>p.id===activeId)||profiles[0],doc.sourceTabId,generation,{...doc.context,id:doc.id,documentText:doc.text,offset}));
    })().catch(()=>sendResponse({ok:false,error:'无法恢复原书页，请重新选中正文。'}));return true;
  }
  if(message.type==='open-reader-window'){chrome.tabs.create({url:chrome.runtime.getURL('reader.html')});sendResponse({ok:true});return;}
  if(['get-cloud-voices','refresh-cloud-voices','rename-cloud-voice','select-cloud-voice'].includes(message.type)){
    const selectionGeneration=message.type==='select-cloud-voice'?++_voiceSelectionGeneration:null;
    (async()=>{
      if(selectionGeneration!==null)await stopAll();
      const base=engineBaseUrl('piper');
      const headers=await bridgeHeaders();
      let url=base+'/voices',options={signal:AbortSignal.timeout(35000),headers,redirect:'error'};
      if(message.type==='refresh-cloud-voices'||message.type==='rename-cloud-voice'){
        url=base+'/cloud-voices/'+(message.type==='refresh-cloud-voices'?'refresh':'rename');
        options={...options,method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({id:message.id,name:message.name})};
      }
      const response=await fetch(url,options),body=await response.json();
      if(selectionGeneration!==null&&selectionGeneration!==_voiceSelectionGeneration)return sendResponse({ok:false,cancelled:true});
      if(!response.ok)throw Error(body.error||'无法连接本机音色服务。');
      const voices=body.voiceDetails||((body.voices||[]).filter(v=>typeof v==='object'));
      if(message.type==='select-cloud-voice'){
        const voice=voices.find(v=>v.id===message.id);if(!voice)throw Error('请先同步并选择列表中的音色。');
        _voiceSelectionWrite=_voiceSelectionWrite.catch(()=>{}).then(async()=>{
          if(selectionGeneration!==_voiceSelectionGeneration)return;
          const {profiles,activeId}=await getProfileState();
          if(selectionGeneration!==_voiceSelectionGeneration)return;
          const active=profiles.find(p=>p.id===activeId)||profiles[0];
          const next=profiles.map(p=>p.id===active.id?{...p,engine:'piper',voice:voice.id,name:voice.name+' · Flash'}:p);
          await chrome.storage.local.set({profiles:next,activeId:active.id,fallback:false});
        });
        await _voiceSelectionWrite;
        if(selectionGeneration!==_voiceSelectionGeneration)return sendResponse({ok:false,cancelled:true});
      }
      if(message.type==='rename-cloud-voice'){
        const renamed=voices.find(v=>v.id===message.id);
        if(renamed){const {profiles}=await getProfileState();await chrome.storage.local.set({profiles:profiles.map(p=>p.voice===message.id?{...p,name:renamed.name+' · Flash'}:p)});}
      }
      const {profiles,activeId}=await getProfileState(),active=profiles.find(p=>p.id===activeId)||profiles[0];
      sendResponse({ok:true,voices,activeVoice:active?.voice,activeName:active?.name});
    })().catch(error=>sendResponse({ok:false,error:error.message||'音色操作失败，请检查本机服务。'}));return true;
  }
  if(message.type==='ball-read-selection'&&sender.tab){
    readSelectionFromActiveTab(true,true,sender.tab).then(sendResponse).catch(()=>sendResponse({ok:false,error:'无法读取当前页面，请刷新后重试。'}));return true;
  }
  if(message.type==='weread-page-change'){
    if(!sender.url?.startsWith('https://weread.qq.com/web/reader/')||!_pageFollow||sender.tab?.id!==_pageFollow.tabId||message.previousId!==_pageFollow.documentId||_isPaused){sendResponse({ok:false,cancelled:true});return;}
    const context=message.context;
    if(context?.scope!=='weread-body'||(_pageFollow.kind==='canvas'&&context?.kind!=='canvas')){sendResponse({ok:false,cancelled:true});return;}
    if(!context?.text?.trim()||context.text.length>50000||!context.id||(context.pageKey&&context.pageKey===_pageFollow.pageKey)){sendResponse({ok:false,cancelled:true});return;}
    if(_pageFollow.flushingTail&&_isPlaying){_pageFollow.deferredPage=true;if(_readingDocument){_readingDocument.context.deferredPage=true;chrome.storage.session?.set({readingDocument:_readingDocument}).catch(()=>{});}sendResponse({ok:true,deferred:true});return;}
    (async()=>{
      const carry=_pageFollow?.tailReady?_pageFollow.pendingTail||'':'';
      const stopping=stopAll(true),generation=_speakRequestGeneration;await stopping;
      if(generation!==_speakRequestGeneration||!_pageFollow)return sendResponse({ok:false,cancelled:true});
      const {profiles,activeId}=await getProfileState();
      if(generation!==_speakRequestGeneration||!_pageFollow)return sendResponse({ok:false,cancelled:true});
      let text=context.text;
      if(carry){
        text=VDReading.joinPageSpeech(carry,text);
        const prefix=text.slice(0,text.length-context.text.length);
        const mapped=await chrome.tabs.sendMessage(sender.tab.id,{type:'reading-page-prefix',id:context.id,prefix});
        if(generation!==_speakRequestGeneration||!_pageFollow)return sendResponse({ok:false,cancelled:true});
        if(!mapped?.ok)throw Error('跨页文字定位失败。');
      }
      sendResponse(await speakText(text,profiles.find(p=>p.id===activeId)||profiles[0],sender.tab.id,generation,{...context,text,followPage:true}));
    })().catch(()=>sendResponse({ok:false,error:'翻页续读失败，请重新点击朗读。'}));return true;
  }
  if(message.type==='reader-runtime-version'){sendResponse({build:'1110-A'});return;}
  if(message.type==='set-reading-highlight'){
    _highlightEnabled=message.value!==false;chrome.storage.local.set({readingHighlight:_highlightEnabled});notifyPlaybackState();sendResponse({ok:true});return;
  }
  if(message.type==='get-reading-state'){
    if(sender.tab&&!sender.url?.startsWith(chrome.runtime.getURL(''))){sendResponse({error:'Extension reader only'});return;}
    (async()=>{if(!_readingDocument&&chrome.storage.session)_readingDocument=(await chrome.storage.session.get('readingDocument')).readingDocument||null;
      sendResponse({document:_readingDocument,playback:playbackStateForTab()});})();return true;
  }
  if(message.type==='read-document'){
    const text=String(message.text||'').slice(0,50000),offset=Math.max(0,Math.min(text.length,Number(message.offset)||0));
    if(!text.slice(offset).trim()){sendResponse({ok:false,error:'没有可朗读的文字。'});return;}
    (async()=>{const stopping=stopAll();const generation=_speakRequestGeneration;await stopping;
      if(generation!==_speakRequestGeneration)return sendResponse({ok:false,cancelled:true});
      const {profiles,activeId}=await getProfileState();if(generation!==_speakRequestGeneration)return sendResponse({ok:false,cancelled:true});
      const old=message.documentId===_readingDocument?.id?_readingDocument:null;
      const profile=profiles.find(p=>p.id===activeId)||profiles[0];
      sendResponse(await speakText(text.slice(offset),profile,old?.sourceTabId??null,generation,
        {id:old?.id||readingId(),documentText:text,offset,kind:old?.kind||'paste'}));
    })().catch(err=>sendResponse({ok:false,error:err.message}));return true;
  }
  if (message.type==='popup-read-selection') {
    readSelectionFromActiveTab(true,message.fromHere!==false).then(sendResponse).catch(err=>sendResponse({ok:false,error:err.message}));
    return true;
  }
  // Content script tab is navigating/closing - stop if it was the source tab
  if (message.type === "tab-unloading") {
    if (_playingSourceTabId !== null && sender.tab?.id === _playingSourceTabId) {
      stopAll();
    }
    return;
  }
  // stop-all: fire-and-forget - respond immediately so the popup can close
  // without leaving an open message channel that Chrome will kill mid-flight.
  if (message.type === "stop-all") {
    stopAll(false,false);
    sendResponse({ ok: true });
    return; // synchronous - no return true, no dangling channel
  }

  if (message.type === "playback-ended") {
    if(message.runId&&(_cancelledRuns.has(message.runId)||message.runId!==_playbackRunId))return;
    finishPlayback();
    return;
  }

  if (message.type === "playback-error") {
    if(message.runId&&(_cancelledRuns.has(message.runId)||message.runId!==_playbackRunId))return;
    const request = _activeEngineRequest;
    _pageFollow=null;
    _isPlaying = false;
    _isPaused  = false;
    _playbackEngine = null;
    _playingSourceTabId = null;
    _activeEngineRequest = null;
    resetProgress();
    setStopMenuVisible(false);
    notifyPlaybackState();

    (async () => {
      const { fallback = true } = await chrome.storage.local.get("fallback");
      const label = engineLabel(message.engine || request?.settings?.engine);
    if (fallback && request?.text && !(request.settings?.engine === 'piper' && (request.settings?.voice === 'flash-default'||request.settings?.voice?.startsWith('cloud:')))) {
        console.warn(`${label} playback failed; falling back to browser TTS:`, message.error);
        speakWithBrowser(request.text, request.settings || {});
      } else {
        console.error(`${label} playback failed:`, message.error);
      _playbackProgress.error = `声音播放失败：${message.error || '请检查本机朗读器是否运行。'}`;
      notifyPlaybackState();
      }
    })().catch(err => console.error("[playback-error]", err));
    return;
  }

  if (message.type === "playback-progress") {
    if(_sleepDeadline&&Date.now()>=_sleepDeadline){finishTimer();return;}
    if(!_playbackRunId&&_readingDocument?.id===message.documentId){
      _playbackRunId=message.runId||'';_playingSourceTabId=_readingDocument.sourceTabId;
      if(_readingDocument.context?.followPage)_pageFollow={tabId:_playingSourceTabId,documentId:_readingDocument.id,pageKey:_readingDocument.context.pageKey,kind:_readingDocument.kind,pendingTail:_readingDocument.context.pendingTail||'',suppressAutoTurn:_readingDocument.context.suppressAutoTurn===true,flushingTail:_readingDocument.context.flushingTail===true,deferredPage:_readingDocument.context.deferredPage===true};
    }
    if(message.runId&&(_cancelledRuns.has(message.runId)||(_playbackRunId&&message.runId!==_playbackRunId)))return;
    _isPlaying=true;if(typeof message.paused==='boolean')_isPaused=message.paused;
    const current = Math.max(0, Number(message.current) || 0);
    const total = Math.max(0, Number(message.total) || 0);
    _playbackProgress = {
      active: true,
      engine: message.engine || _playbackEngine,
      current,
      total,
      percent: typeof message.percent === "number" ? Math.max(0, Math.min(1, message.percent)) : null,
      label: message.label || (total > 0 ? `${current}/${total}` : "")
      ,phase:message.phase||'waiting',text:message.text||_playbackProgress.text||'',documentId:message.documentId||'',
      start:message.start==null?_playbackProgress.start:message.start+(_readingDocument?.offset||0),
      end:message.end==null?_playbackProgress.end:message.end+(_readingDocument?.offset||0)
    };
    if(_readingDocument&&message.start!=null){_readingDocument.resumeOffset=message.start+(_readingDocument.offset||0);chrome.storage.session?.set({readingDocument:_readingDocument}).catch(()=>{});}
    notifyPlaybackState();
    return;
  }

  // Content scripts use this once on startup; playback changes are pushed to
  // every tab so the overlay follows the user across normal webpages.
  if (message.type === "get-playback-state") {
    sendResponse(playbackStateForTab(sender.tab?.id));
    return; // synchronous
  }

  // Test button (popup / options): speak with the given settings and report
  // which engine actually played, so the UI can say "Kokoro is offline, used
  // the browser voice" instead of silently sounding different.
  if (message.type === "test-voice") {
    const { text, settings = {} } = message;
    speakText(text, settings)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  // Keyboard shortcut: Alt+Shift+R - always START reading with selected text.
  // Stop is handled in the content script (sends stop-all when _localPlaying is true).
  // This avoids the wrong-tab problem where Tab B's poll saw Tab A as "playing"
  // and keyboard-read would stop instead of start.
  if (message.type === "keyboard-read") {
    const text = message.text || "";
    if (!text) return;
    const requestGeneration=++_speakRequestGeneration;
    _playingSourceTabId = sender.tab?.id ?? null;
    (async () => {
      const { profiles, activeId } = await getProfileState();
      if(requestGeneration!==_speakRequestGeneration)return;
      const profile = profiles.find(p => p.id === activeId) || profiles[0];
      if (profile) await speakText(text, profile, sender.tab?.id ?? null,requestGeneration);
    })().catch(err => console.error("[keyboard-read]", err));
    return;
  }

  // Overlay rocker: change the CURRENT playback's volume/speed only. These are
  // deliberately NOT written back to the active profile - the profile keeps its
  // saved presets; this just nudges what's playing right now.
  if (message.type === "set-live-volume" || message.type === "set-live-rate") {
    const isVolume = message.type === "set-live-volume";
    const value = isVolume
      ? Math.max(0, Math.min(2.0, message.volume ?? 1.0))
      : Math.max(0.5, Math.min(2.5, message.rate ?? 1.0));

    if (isVolume) _currentVolume = value; else _currentRate = value;

    // Forward to the offscreen player for real-time adjustment. (The
    // browser-TTS engine can't change mid-utterance, so the overlay disables
    // the rocker in that case and won't send these.)
    (async () => {
      try {
        const existing = await chrome.runtime.getContexts({
          contextTypes: ["OFFSCREEN_DOCUMENT"],
          documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
        }).catch(() => []);
        if (existing.length > 0) {
          chrome.runtime.sendMessage(
            isVolume ? { type: "set-volume", volume: value } : { type: "set-rate", rate: value }
          ).catch(() => {});
        }
      } catch (_) {}
    })();

    sendResponse({ ok: true, value });
    return true; // async response
  }

  // Keyboard shortcut: Alt+Shift+D - pause/resume toggle
  if (message.type === "keyboard-pause") {
    togglePauseResume().catch(err => console.error("[keyboard-pause]", err));
    return;
  }
});
