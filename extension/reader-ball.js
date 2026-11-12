/* Persistent reading controls. No credentials or remote audio requests here. */
(() => {
  if(globalThis.__vdBall)return;
  const host=document.createElement('div');host.id='voicedock-ball';
  host.style.cssText='position:fixed!important;z-index:2147483647!important;width:44px!important;height:44px!important;pointer-events:auto!important;';
  const shadow=host.attachShadow({mode:'open'});
  shadow.innerHTML=`<style>
  :host{all:initial;font:14px/1.5 system-ui,'Microsoft YaHei',sans-serif;color:#f1edf8;color-scheme:dark}
  *{box-sizing:border-box}button,select,input{font:inherit}button{cursor:pointer;color:inherit;border:1px solid #645276;border-radius:10px;background:#342b43;padding:8px 11px}button:disabled{opacity:.5;cursor:default}button:hover{background:#4a395e}button:focus-visible,select:focus-visible{outline:2px solid #e2c2ff;outline-offset:2px}
  #handle{width:44px;height:44px;border-radius:50%;padding:0;background:#6850a1;color:white;border:1px solid #c7b0ed;box-shadow:0 4px 20px #231a4050;font-size:20px;font-weight:700;touch-action:none;user-select:none;display:grid;place-items:center}
  #handle.playing{box-shadow:0 0 0 4px #ae86e632,0 4px 20px #231a4050;background:#8661bb}
  #panel{position:absolute;width:min(306px,calc(100vw - 20px));max-height:calc(100vh - 20px);overflow-y:auto;padding:16px;background:#242130;border:1px solid #55465e;border-radius:16px;box-shadow:0 12px 42px #0005;right:54px;top:0;color:#f1edf8}
  [hidden]{display:none!important}.head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}.head strong{font-size:15px}.close{padding:1px 7px;border:0;background:none;font-size:20px}.row{display:flex;gap:7px;margin:10px 0}.primary{background:#b798df;color:#21172f;font-weight:650;flex:1}select{width:100%;border:1px solid #645276;border-radius:9px;padding:9px;background:#322b40;color:#f1edf8}label{display:block}small{font-size:11px;color:#b8a9c7}.status{font-size:12px;line-height:1.6;color:#d8c9e8;max-height:86px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}.tools{display:flex;justify-content:space-between;gap:6px}.tools button{font-size:12px;padding:6px 8px}.speed{display:flex;align-items:center;gap:8px;margin:12px 0}.speed input{width:130px;flex:1;accent-color:#bd94e5}
  </style><button id="handle" aria-label="打开朗读控制" aria-expanded="false" title="朗读 · 拖动调整位置">读</button>
  <section id="panel" role="dialog" aria-label="网页朗读控制" hidden><div class="head"><strong>我的朗读</strong><button class="close" id="close" aria-label="收起朗读控制">×</button></div>
  <label>朗读音色<select id="voice" aria-label="朗读音色" disabled><option value="">浏览器语音</option></select></label>
  <label>朗读模式<select id="readingMode" aria-label="朗读模式"><option value="paragraph">自然段 · 语气连贯 / 按段高亮</option><option value="sentence">逐句 · 按句高亮</option></select></label>
  <div class="row"><button id="read" class="primary">从这里往后读</button></div><div class="row"><button id="pause">暂停</button><button id="stop">停止</button><button id="highlight">高亮：开</button></div>
  <label class="speed">语速<input id="rate" type="range" min="0.5" max="2" step="0.1" value="1"><span id="rateValue">1.0×</span></label>
  <label class="speed"><span id="gapLabel">段间停顿</span><input id="gap" aria-label="朗读间隔" type="range" min="0" max="2000" step="100" value="0"><span id="gapValue">0.0秒</span></label>
  <div class="row"><button id="previous">上一句</button><button id="retry">从本句继续</button><button id="next">下一句</button></div>
  <label>定时停止<select id="sleep" aria-label="定时停止"><option value="0">不定时</option><option value="5">5 分钟</option><option value="15">15 分钟</option><option value="30">30 分钟</option><option value="60">60 分钟</option><option value="120">120 分钟</option></select></label><small id="timerStatus"></small>
  <label style="margin-top:10px"><input id="autoTurn" type="checkbox" checked> 微信读书读完后自动翻页</label>
  <p class="status" id="status" role="status">选好正文起点，再点朗读。</p><div class="tools"><button id="sync" hidden>同步音色</button><button id="paste">粘贴阅读窗口</button></div><small>拖动小球调整位置</small></section>`;
  const $=id=>shadow.getElementById(id),handle=$('handle'),panel=$('panel');
  let state={},position={x:.97,y:.55},drag=null,suppressClick=false;
  const rpc=async message=>{try{return await chrome.runtime.sendMessage(message);}catch(_){throw Error('朗读连接已更新，请刷新当前网页。');}};
  const hint=text=>{$('status').textContent=text;};
  function positionBall(){
    const x=Math.max(8,Math.min(innerWidth-52,position.x*(innerWidth-44))),y=Math.max(8,Math.min(innerHeight-52,position.y*(innerHeight-44)));
    host.style.setProperty('left',x+'px','important');host.style.setProperty('top',y+'px','important');
    const width=panel.offsetWidth||Math.min(306,innerWidth-20),height=panel.offsetHeight;
    const left=Math.max(10,Math.min(innerWidth-width-10,x>innerWidth/2?x-width-10:x+54));
    panel.style.right='auto';panel.style.left=(left-x)+'px';panel.style.bottom='auto';
    panel.style.top=(Math.max(10,Math.min(innerHeight-height-10,y))-y)+'px';
  }
  function mount(){
    const target=document.fullscreenElement||document.documentElement;
    // WeRead fullscreens its reader container; browser F11 keeps document root.
    const parent=['CANVAS','VIDEO','IMG','IFRAME'].includes(target.tagName)?document.documentElement:target;
    if(host.parentElement!==parent)parent.appendChild(host);
    if(parent===document.documentElement&&document.fullscreenElement&&host.showPopover){host.setAttribute('popover','manual');try{if(!host.matches(':popover-open'))host.showPopover();}catch(_){}}
    else if(host.hasAttribute('popover')){try{host.hidePopover();}catch(_){}host.removeAttribute('popover');}
    positionBall();
  }
  async function voices(type='get-cloud-voices'){
    const {bridgePairingCode}=await chrome.storage.local.get('bridgePairingCode');
    $('sync').hidden=!bridgePairingCode;
    $('voice').disabled=!bridgePairingCode;
    if(!bridgePairingCode){$('voice').replaceChildren(new Option('浏览器语音',''));return;}
    $('sync').disabled=true;
    try{
      const reply=await rpc({type});if(!reply?.ok)throw Error(reply?.error||'请先启动本机朗读器。');
      const placeholder=new Option('选择云端音色','');placeholder.disabled=true;
      $('voice').replaceChildren(placeholder,...(reply.voices||[]).map(v=>new Option(v.name+' · Flash',v.id)));
      $('voice').value=reply.activeVoice||'';$('voice').disabled=!reply.voices?.length;
      if(type==='refresh-cloud-voices')hint(`已同步 ${reply.voices?.length||0} 个 Flash 音色。`);
    }catch(error){hint(error.message);}finally{$('sync').disabled=false;}
  }
  function open(value){panel.hidden=!value;handle.setAttribute('aria-expanded',String(value));positionBall();if(value)voices();}
  handle.addEventListener('pointerdown',event=>{
    if(event.button!==0)return;event.preventDefault();handle.setPointerCapture(event.pointerId);drag={id:event.pointerId,x:event.clientX,y:event.clientY,left:host.getBoundingClientRect().left,top:host.getBoundingClientRect().top,moved:false};
  });
  handle.addEventListener('pointermove',event=>{
    if(!drag||event.pointerId!==drag.id)return;
    const dx=event.clientX-drag.x,dy=event.clientY-drag.y;if(Math.hypot(dx,dy)>5)drag.moved=true;
    if(!drag.moved)return;position={x:(drag.left+dx)/Math.max(1,innerWidth-44),y:(drag.top+dy)/Math.max(1,innerHeight-44)};positionBall();
  });
  handle.addEventListener('pointerup',event=>{if(!drag)return;suppressClick=drag.moved;drag=null;position={x:Math.max(0,Math.min(1,position.x)),y:Math.max(0,Math.min(1,position.y))};chrome.storage.local.set({readerBallPosition:position});});
  handle.addEventListener('pointercancel',()=>{drag=null;suppressClick=true;});
  handle.onclick=()=>{if(suppressClick){suppressClick=false;return;}open(panel.hidden);};
  $('close').onclick=()=>open(false);
  // Clicking controls must not clear the selection in the source document.
  for(const id of ['read','pause','stop','highlight','sync','paste','previous','retry','next'])$(id).addEventListener('mousedown',event=>event.preventDefault());
  for(const [id,delta]of [['previous',-1],['retry',0],['next',1]])$(id).onclick=async event=>{if(!event.isTrusted)return;try{const reply=await rpc({type:'reader-seek',delta});if(!reply?.ok&&!reply?.cancelled)hint(reply?.error||'无法恢复，请重新选正文。');}catch(e){hint(e.message);}};
  $('gap').oninput=()=>{$('gapValue').textContent=(+$('gap').value/1000).toFixed(1)+'秒';rpc({type:'set-reading-gap',gapMs:+$('gap').value}).catch(e=>hint(e.message));};
  $('sleep').onchange=()=>rpc({type:'set-sleep-timer',minutes:+$('sleep').value}).catch(e=>hint(e.message));
  $('autoTurn').onchange=()=>chrome.storage.local.set({readerAutoTurn:$('autoTurn').checked});
  $('readingMode').onchange=async()=>{try{const reply=await rpc({type:'set-reading-mode',mode:$('readingMode').value});if(!reply?.ok)throw Error(reply?.error||'模式切换失败');}catch(e){hint(e.message);}};
  $('read').onclick=async event=>{if(!event.isTrusted)return;const button=$('read');button.disabled=true;try{hint('正在准备朗读…');const reply=await rpc({type:'ball-read-selection'});if(!reply?.ok)throw Error(reply?.error||'请先选中正文起点。');}catch(error){hint(error.message);}finally{button.disabled=false;}};
  $('pause').onclick=()=>rpc({type:'keyboard-pause'}).catch(e=>hint(e.message));
  $('stop').onclick=()=>rpc({type:'stop-all'}).then(()=>hint('已停止，翻页也不会自动播放。')).catch(e=>hint(e.message));
  $('voice').onchange=async()=>{
    $('voice').disabled=true;$('read').disabled=true;
    try{const reply=await rpc({type:'select-cloud-voice',id:$('voice').value});if(reply?.cancelled)return;if(!reply?.ok)throw Error(reply?.error||'音色切换失败');hint('已选择音色，点击朗读开始。');}catch(e){hint(e.message);}finally{$('voice').disabled=false;$('read').disabled=false;}
  };
  $('sync').onclick=()=>voices('refresh-cloud-voices');
  $('paste').onclick=()=>rpc({type:'open-reader-window'}).catch(e=>hint(e.message));
  $('highlight').onclick=()=>rpc({type:'set-reading-highlight',value:state.highlight===false}).catch(e=>hint(e.message));
  $('rate').oninput=async()=>{
    const rate=+$('rate').value;$('rateValue').textContent=rate.toFixed(1)+'×';
    try{const {profiles=[],activeId}=await chrome.storage.local.get(['profiles','activeId']);await chrome.storage.local.set({profiles:profiles.map(p=>p.id===activeId?{...p,rate}:p)});await rpc({type:'set-live-rate',rate});}catch(e){hint(e.message);}
  };
  function update(next){
    $('readingMode').value=next.readingMode||'paragraph';
    const unit=next.readingMode==='sentence'?'句':'段';$('previous').textContent='上一'+unit;$('next').textContent='下一'+unit;$('retry').textContent='从本'+unit+'继续';
    $('gapLabel').textContent=unit+'间停顿';
    state={...state,...next};handle.classList.toggle('playing',!!state.isPlaying);$('pause').textContent=state.isPaused?'继续':'暂停';$('pause').disabled=!state.isPlaying;
    if(shadow.activeElement!==$('gap')){$('gap').value=state.gapMs||0;$('gapValue').textContent=((state.gapMs||0)/1000).toFixed(1)+'秒';}
    $('timerStatus').textContent=state.sleepDeadline?'将于 '+new Date(state.sleepDeadline).toLocaleTimeString()+' 停止':'';
    if(!state.sleepDeadline)$('sleep').value='0';
    $('highlight').textContent='高亮：'+(state.highlight===false?'关':'开');
    if(!shadow.activeElement?.matches('input')){$('rate').value=state.rate||1;$('rateValue').textContent=(state.rate||1).toFixed(1)+'×';}
    if(state.progress?.error)hint(state.progress.error);
    else if(state.isPlaying)hint(state.isPaused?'已暂停':state.progress?.phase==='playing'?(state.progress.text||'正在朗读…'):'正在准备下一句…');
    else if(state.progress?.label)hint(state.progress.label);
  }
  globalThis.__vdBall={update,showHint:hint};
  chrome.runtime.onMessage.addListener(message=>{if(message.type==='playback-state')update(message.state);if(message.type==='show-hint')hint(message.message);});
  chrome.storage.onChanged.addListener(changes=>{if(changes.profiles||changes.activeId||changes.bridgePairingCode){if(!panel.hidden)voices();}});
  document.addEventListener('fullscreenchange',mount);addEventListener('resize',positionBall);
  chrome.storage.local.get('readerBallPosition').then(saved=>{if(Number.isFinite(saved.readerBallPosition?.x)&&Number.isFinite(saved.readerBallPosition?.y))position=saved.readerBallPosition;positionBall();});
  chrome.storage.local.get('readerAutoTurn').then(saved=>$('autoTurn').checked=saved.readerAutoTurn!==false);
  mount();rpc({type:'get-playback-state'}).then(update).catch(e=>hint(e.message));
})();
