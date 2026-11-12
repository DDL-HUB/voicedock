import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  APP_NAME,
  bridgeHeaders,
  defaultProfile,
  describeProfileVoice,
  engineBaseUrl,
  engineLabel,
  fmt,
  MAX_PROFILES,
  normalizeProfile,
  runSettingsMigration,
} from './shared.js';

function PopupApp() {
  const [profiles, setProfiles] = useState([]);
  const [activeId, setActiveId] = useState('');
  const [newProfileOpen, setNewProfileOpen] = useState(false);
  const [newProfileName, setNewProfileName] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('checking');
  const [version, setVersion] = useState('');
  const [testing, setTesting] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [cloudVoices,setCloudVoices]=useState([]);
  const [cloudConfigured,setCloudConfigured]=useState(false);
  const [syncingVoices,setSyncingVoices]=useState(false);
  const [voiceName,setVoiceName]=useState('');
  const [showReadingText,setShowReadingText]=useState(true);
  const [playback, setPlayback] = useState({ isPlaying: false, isPaused: false, progress: null });
  const errorTimer = useRef(null);
  const readAttempt = useRef(0);
  const inputRef = useRef(null);

  const activeIdx = Math.max(0, profiles.findIndex((profile) => profile.id === activeId));
  const activeProfile = profiles[activeIdx] || null;

  function showError(message) {
    setError(message);
    clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setError(''), 5000);
  }

  async function loadCloudVoices(type='get-cloud-voices',extra={}){
    setSyncingVoices(true);
    try{
      const reply=await chrome.runtime.sendMessage({type,...extra});
      if(reply?.cancelled)return;
      if(!reply?.ok)throw Error(reply?.error||'音色服务暂不可用，请启动朗读器。');
      setCloudVoices(reply.voices||[]);
      const stored=await chrome.storage.local.get(['profiles','activeId']);
      if(stored.profiles){setProfiles(stored.profiles.map(normalizeProfile));setActiveId(stored.activeId);}
    }catch(error){showError(error.message);}finally{setSyncingVoices(false);}
  }
  useEffect(()=>{
    chrome.storage.local.get('bridgePairingCode').then(({bridgePairingCode})=>{
      setCloudConfigured(Boolean(bridgePairingCode));
      if(bridgePairingCode)loadCloudVoices();
    });
  },[]);

  async function persist(nextProfiles, nextActiveId = activeId) {
    setProfiles(nextProfiles);
    setActiveId(nextActiveId);
    await chrome.storage.local.set({ profiles: nextProfiles, activeId: nextActiveId });
  }

  useEffect(() => {
    let disposed = false;
    async function init() {
      setVersion(`v${chrome.runtime.getManifest().version}`);
      // Upgrades settings saved by Piper TTS 1.0.x before reading them.
      const stored = await runSettingsMigration(chrome.storage.local);
      let nextProfiles = Array.isArray(stored.profiles) ? stored.profiles.map(normalizeProfile) : [];
      let nextActiveId = stored.activeId || '';

      if (nextProfiles.length === 0) {
        const profile = defaultProfile();
        nextProfiles = [profile];
        nextActiveId = profile.id;
        await chrome.storage.local.set({ profiles: nextProfiles, activeId: nextActiveId });
      }

      if (!disposed) {
        setProfiles(nextProfiles);
        setActiveId(nextProfiles.some((profile) => profile.id === nextActiveId) ? nextActiveId : nextProfiles[0].id);
      }
    }
    init();
    return () => {
      disposed = true;
      clearTimeout(errorTimer.current);
    };
  }, []);

  // The status dot follows the active profile's engine; the browser voice is
  // always available.
  const activeEngine = activeProfile?.engine || 'browser';
  useEffect(() => {
    let disposed = false;
    async function checkStatus() {
      const baseUrl = engineBaseUrl(activeEngine);
      if (!baseUrl) {
        setStatus('online');
        return;
      }
      setStatus('checking');
      let ok = false;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 2500);
        const headers = activeEngine === 'piper' ? await bridgeHeaders() : {};
        const res = await fetch(`${baseUrl}/health`, { signal: ctrl.signal, headers, redirect: 'error' });
        clearTimeout(timer);
        ok = res.ok;
      } catch (_) {
        ok = false;
      }
      if (!disposed) setStatus(ok ? 'online' : 'offline');
    }
    checkStatus();
    return () => { disposed = true; };
  }, [activeEngine]);

  useEffect(() => {
    function poll() {
      chrome.runtime.sendMessage({ type: 'get-playback-state' }, (response) => {
        if (chrome.runtime.lastError || !response) return;
        setPlayback(response);
      });
    }
    poll();
    const timer = setInterval(poll, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (newProfileOpen) inputRef.current?.focus();
  }, [newProfileOpen]);

  async function selectProfile(index) {
    if (profiles.length <= 1) return;
    const next = profiles[(index + profiles.length) % profiles.length];
    setActiveId(next.id);
    await chrome.storage.local.set({ activeId: next.id });
  }

  async function updateActiveProfile(patch) {
    if (!activeProfile) return;
    const nextProfiles = profiles.map((profile) =>
      profile.id === activeProfile.id ? { ...profile, ...patch } : profile,
    );
    await persist(nextProfiles, activeProfile.id);
  }

  async function saveNewProfile() {
    const name = newProfileName.trim();
    if (!name) {
      inputRef.current?.focus();
      return;
    }
    if (profiles.length >= MAX_PROFILES) {
      setNewProfileOpen(false);
      setNewProfileName('');
      showError(`You're at the ${MAX_PROFILES}-profile limit. Delete one in Settings first.`);
      return;
    }
    if (profiles.some((profile) => profile.name.toLowerCase() === name.toLowerCase())) {
      showError('A profile with this name already exists.');
      return;
    }

    const base = activeProfile || defaultProfile();
    const profile = {
      id: crypto.randomUUID(),
      name,
      engine: base.engine,
      voice: base.voice,
      rate: base.rate,
      volume: base.volume,
    };
    await persist([...profiles, profile], profile.id);
    setNewProfileOpen(false);
    setNewProfileName('');
  }

  function readPasted() {
    const text=pasteText.trim();
    if(!text){showError('请先粘贴需要朗读的文字。');return;}
    setTesting(true);
    chrome.runtime.sendMessage({
      type: 'test-voice',
      text,
      settings: normalizeProfile(activeProfile || defaultProfile()),
    }, (response) => {
      setTesting(false);
      const runtimeErr = chrome.runtime.lastError;
      if (runtimeErr) {
        showError(`Extension error: ${runtimeErr.message}`);
        return;
      }
      if (response && !response.ok) {
        if(!response.cancelled)showError(response.error || '无法开始朗读。');
      } else if (response?.fellBack) {
        showError(`${engineLabel(activeEngine)} is offline. Played the browser voice instead.`);
      }
    });
  }

  function stopReading() {
    readAttempt.current++;
    chrome.runtime.sendMessage({ type: 'stop-all' });
    setPlayback({ isPlaying: false, isPaused: false, progress: null });
  }

  async function readSelected() {
    const attempt=++readAttempt.current;
    let runtime;
    try{runtime=await Promise.race([chrome.runtime.sendMessage({type:'reader-runtime-version'}),new Promise(resolve=>setTimeout(()=>resolve(null),1200))]);}catch(_){}
    if(attempt!==readAttempt.current)return;
    if(runtime?.build!=='1110-A'){
      showError('朗读后台需要更新，正在重新加载插件。请稍后重新点紫色 P。');
      setTimeout(()=>{if(attempt===readAttempt.current)chrome.runtime.reload();},1000);return;
    }
    try {
      const result=await chrome.runtime.sendMessage({type:'popup-read-selection'});
      if(attempt!==readAttempt.current)return;
      if (!result?.ok) showError(result?.error || '无法开始朗读，请先启动本机朗读器。');
    } catch (_) { showError('无法开始朗读，请刷新网页后再试。'); }
  }

  function openSettings() {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html#settings') });
  }
  async function openReader(){
    let suffix='';
    if(pasteText.trim()){const key='draft:'+crypto.randomUUID();await chrome.storage.session.set({[key]:{text:pasteText}});suffix='?draft='+encodeURIComponent(key);}
    chrome.tabs.create({url:chrome.runtime.getURL('reader.html')+suffix});
  }

  const progress = playback?.progress;
  async function seek(delta){readAttempt.current++;const result=await chrome.runtime.sendMessage({type:'reader-seek',delta});if(!result?.ok&&!result?.cancelled)showError(result?.error||'请重新选择正文。');}
  const showProgress = playback?.isPlaying || progress?.active;
  const progressPercent = useMemo(() => {
    if (!progress?.total) return 0;
    return Math.round(Math.max(0, Math.min(1, progress.percent ?? progress.current / progress.total)) * 100);
  }, [progress]);

  return (
      <div className="app">
        {cloudConfigured && <div style={{marginBottom:12}}>
          <label htmlFor="cloud-voice">朗读音色</label>
          <select id="cloud-voice" aria-label="朗读音色" value={activeProfile?.voice||''} disabled={syncingVoices||!cloudVoices.length}
            onChange={e=>loadCloudVoices('select-cloud-voice',{id:e.target.value})} style={{width:'100%',padding:8,margin:'6px 0',borderRadius:8}}>
            <option value="" disabled>选择云端音色</option>
            {cloudVoices.map(voice=><option key={voice.id} value={voice.id}>{voice.name} · Flash</option>)}
          </select>
          <button className="btn" disabled={syncingVoices} onClick={()=>loadCloudVoices('refresh-cloud-voices')}>{syncingVoices?'正在同步…':'同步平台音色'}</button>
          <details><summary>修改当前音色名称</summary><input aria-label="音色名称" value={voiceName} onChange={e=>setVoiceName(e.target.value)} maxLength={60}/><button className="btn" disabled={!voiceName.trim()||syncingVoices} onClick={()=>loadCloudVoices('rename-cloud-voice',{id:activeProfile?.voice,name:voiceName.trim()})}>保存名称</button></details>
        </div>}
      <header className="app-header">
        <img className="app-icon" src="icons/icon48.png" alt="" />
        <span className="app-title">{APP_NAME}</span>
        <span className={`status-dot ${status}`} title={status === 'online' ? `${engineLabel(activeEngine)} online` : status === 'offline' ? `${engineLabel(activeEngine)} offline` : 'Checking...'} />
        <span className="app-version">{version}</span>
        <button className="btn-gear" aria-label="设置" title="设置" onClick={openSettings}>⚙</button>
      </header>

      <div className="profile-card">
        <button className="btn-nav" title="Previous profile" disabled={profiles.length <= 1} onClick={() => selectProfile(activeIdx - 1)}>‹</button>
        <div className="profile-info">
          <span className="profile-name">{activeProfile?.name || 'No profiles'}</span>
          <span className="profile-voice" title={activeProfile ? describeProfileVoice(activeProfile) : ''}>{activeProfile ? describeProfileVoice(activeProfile, { compact: true }) : 'Open Settings to create one'}</span>
        </div>
        <button className="btn-nav" title="Next profile" disabled={profiles.length <= 1} onClick={() => selectProfile(activeIdx + 1)}>›</button>
        <button className="btn-add-profile" title="New profile" onClick={() => {
          if (profiles.length >= MAX_PROFILES) {
            showError(`You're at the ${MAX_PROFILES}-profile limit. Delete one in Settings first.`);
            return;
          }
          setNewProfileOpen(true);
        }}>＋</button>
      </div>

      {newProfileOpen && (
        <div className="new-profile-form">
          <span className="new-profile-header">New Profile</span>
          <input
            ref={inputRef}
            className="new-profile-input"
            type="text"
            placeholder="e.g. Audiobooks"
            maxLength={40}
            value={newProfileName}
            onChange={(event) => setNewProfileName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') saveNewProfile();
              if (event.key === 'Escape') {
                setNewProfileOpen(false);
                setNewProfileName('');
              }
            }}
          />
          <div className="new-profile-actions">
            <button className="btn new-profile-save" onClick={saveNewProfile}>Save</button>
            <button className="btn new-profile-cancel" onClick={() => {
              setNewProfileOpen(false);
              setNewProfileName('');
            }}>Cancel</button>
          </div>
        </div>
      )}

      <div className="sliders">
        <div className="slider-row">
          <span className="slider-lbl">语速</span>
          <input className="slider" type="range" min="0.5" max="2.5" step="0.1" value={activeProfile?.rate ?? 1.0} disabled={!activeProfile} onChange={(event) => updateActiveProfile({ rate: Number.parseFloat(event.target.value) })} />
          <span className="slider-val">{fmt(activeProfile?.rate ?? 1.0)}×</span>
        </div>
        <div className="slider-row">
          <span className="slider-lbl">音量</span>
          <input className="slider" type="range" min="0" max="2" step="0.05" value={activeProfile?.volume ?? 1.0} disabled={!activeProfile} onChange={(event) => updateActiveProfile({ volume: Number.parseFloat(event.target.value) })} />
          <span className="slider-val">{fmt(activeProfile?.volume ?? 1.0)}</span>
        </div>
      </div>

      <div className="actions">
        <button className="btn btn-test" disabled={!activeProfile} onClick={readSelected}>从这里往后读</button>
        <button className="btn" disabled={!playback.isPlaying} onClick={()=>chrome.runtime.sendMessage({type:'keyboard-pause'})}>{playback.isPaused?'继续':'暂停'}</button>
        <button className="btn btn-stop" onClick={stopReading}>■ 停止</button>
      </div>

      {showProgress && (
        <div className="progress-card">
          <div className="progress-row">
            <span className="progress-status">{playback.isPaused ? 'Paused' : 'Reading'}</span>
            <span className="progress-label">{progress?.total > 0 ? (progress.label || `${progress.current}/${progress.total}`) : (progress?.label || 'Browser voice')}</span>
          </div>
          <div className="progress-track">
            <span className={`progress-fill ${progress?.total > 0 ? '' : 'is-indeterminate'}`} style={progress?.total > 0 ? { width: `${progressPercent}%` } : undefined} />
          </div>
        </div>
      )}

      {error && <p className="test-error">{error}</p>}
      <div style={{marginTop:12,fontSize:12}}>
        <label>朗读模式<select aria-label="朗读模式" value={playback.readingMode||'paragraph'} onChange={e=>chrome.runtime.sendMessage({type:'set-reading-mode',mode:e.target.value})}><option value="paragraph">自然段 · 语气连贯 / 按段高亮</option><option value="sentence">逐句 · 按句高亮</option></select></label>
        <label><input type="checkbox" checked={playback.highlight!==false} onChange={e=>chrome.runtime.sendMessage({type:'set-reading-highlight',value:e.target.checked})}/>同步高亮</label>
        <label><input type="checkbox" checked={showReadingText} onChange={e=>setShowReadingText(e.target.checked)}/>显示当前{playback.readingMode==='sentence'?'句':'段'}</label>
        {showReadingText&&playback.progress?.text&&<p style={{padding:8,background:'#3e3451',borderRadius:6}}>{playback.progress.text}</p>}
        <button className="btn" onClick={openReader}>展开粘贴阅读窗口（可选）</button>
      </div>

      <details style={{marginTop:12}}>
        <summary style={{cursor:'pointer'}}>粘贴文字朗读（微信读书等）</summary>
        <textarea aria-label="粘贴需要朗读的文字" value={pasteText} onChange={event=>setPasteText(event.target.value)}
          placeholder="先在微信读书选区菜单点复制，再到这里按 Ctrl+V。" rows={4} maxLength={20000}
          style={{boxSizing:'border-box',width:'100%',margin:'8px 0',padding:8,borderRadius:6}} />
        <button className="btn" disabled={testing || !activeProfile} onClick={readPasted}>{testing?'正在准备…':'朗读粘贴文字'}</button>
      </details>

      {playback.progress?.error && <p role="alert">{playback.progress.error}</p>}
      <details><summary>连续播放与定时</summary>
        <label>{playback.readingMode==='sentence'?'句':'段'}间停顿 {((playback.gapMs||0)/1000).toFixed(1)} 秒<input aria-label="朗读间隔" type="range" min="0" max="2000" step="100" value={playback.gapMs||0} onChange={e=>chrome.runtime.sendMessage({type:'set-reading-gap',gapMs:+e.target.value})}/></label>
        <div className="actions"><button className="btn" onClick={()=>seek(-1)}>上一{playback.readingMode==='sentence'?'句':'段'}</button><button className="btn" onClick={()=>seek(0)}>从本{playback.readingMode==='sentence'?'句':'段'}继续</button><button className="btn" onClick={()=>seek(1)}>下一{playback.readingMode==='sentence'?'句':'段'}</button></div>
        <label>定时停止<select aria-label="定时停止" defaultValue="0" onChange={e=>chrome.runtime.sendMessage({type:'set-sleep-timer',minutes:+e.target.value})}><option value="0">不定时</option>{[5,15,30,60,120].map(n=><option key={n} value={n}>{n} 分钟</option>)}</select></label>
        {playback.sleepDeadline>0&&<p>将于 {new Date(playback.sleepDeadline).toLocaleTimeString()} 停止</p>}
      </details>
      {!playback.isPlaying&&progress?.label&&<p role="status">{progress.label}</p>}
      {!cloudConfigured && <button className="btn" onClick={openSettings}>配置可选的 Flash 云端音色</button>}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<PopupApp />);
