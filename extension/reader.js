const $=id=>document.getElementById(id);
let documentId=null,draft=false,dirty=false,busy=false,lastActive=-1;
const rpc=message=>chrome.runtime.sendMessage(message);
function render(){
  const text=$('input').value,units=VDReading.readingUnits(text,5000),fragment=document.createDocumentFragment();let cursor=0;
  for(const unit of units){fragment.append(document.createTextNode(text.slice(cursor,unit.start)));const span=document.createElement('span');span.className='sentence';span.dataset.start=unit.start;span.dataset.end=unit.end;span.textContent=unit.text;
    span.ondblclick=()=>read(unit.start);fragment.append(span);cursor=unit.end;}
  fragment.append(document.createTextNode(text.slice(cursor)));$('reading-view').replaceChildren(fragment);lastActive=-1;
}
async function read(offset=0){
  if(!$('input').value.trim()){$('status').textContent='请先粘贴要读的文字。';$('editor').open=true;return;}
  busy=true;try{const reply=await rpc({type:'read-document',text:$('input').value,offset,documentId});
    if(!reply?.ok)throw Error(reply?.error||'朗读已取消');draft=false;dirty=false;
    const state=await rpc({type:'get-reading-state'});documentId=state.document?.id||null;
  }catch(e){$('status').textContent=e.message;}finally{busy=false;}
}
async function poll(){
  if(busy)return;
  const state=await rpc({type:'get-reading-state'}),doc=state.document,play=state.playback||{};
  const {profiles=[],activeId}=await chrome.storage.local.get(['profiles','activeId']);
  const profile=profiles.find(p=>p.id===activeId)||profiles[0];
  $('voice').textContent=profile?.engine==='piper'&&(profile?.voice==='flash-default'||profile?.voice?.startsWith('cloud:'))
    ?'当前音色：'+profile.name+'（CosyVoice Flash 云端合成）'
    :'当前音色：'+(profile?.name||'尚未配置')+'。可在紫色插件中切换音色。';
  if(profile){$('rate').value=profile.rate??1;$('rate-value').textContent=(profile.rate??1).toFixed(1)+'×';}
  if(!draft&&!dirty&&doc&&doc.id!==documentId){documentId=doc.id;$('input').value=doc.text;render();}
  if(draft&&doc?.text===$('input').value)documentId=doc.id;
  $('highlight').checked=play.highlight!==false;
  if(play.isPlaying)$('status').textContent=play.isPaused?'已暂停':play.progress?.label||'正在准备…';
  else if(!busy)$('status').textContent=play.progress?.error||(lastActive>=0?'朗读已结束':'准备就绪');
  const progress=play.progress||{};
  if(progress.documentId!==documentId||!play.isPlaying||!$('highlight').checked){for(const span of $('reading-view').querySelectorAll('.active'))span.classList.remove('active');return;}
  if(progress.phase!=='playing')return;
  for(const span of $('reading-view').querySelectorAll('.sentence')){
    const active=+span.dataset.start<progress.end&&+span.dataset.end>progress.start;
    span.classList.toggle('active',active);
    if(active&&lastActive!==progress.start&&$('follow').checked&&$('show-text').checked){span.scrollIntoView({block:'center',behavior:'smooth'});}
  }
  lastActive=progress.start;
}
$('read').onclick=()=>read(0);$('from-cursor').onclick=()=>read($('input').selectionStart||0);
$('pause').onclick=()=>rpc({type:'keyboard-pause'});$('stop').onclick=()=>rpc({type:'stop-all'});
$('input').oninput=()=>{dirty=true;draft=true;documentId=null;render();};
$('show-text').onchange=()=>$('reading-view').hidden=!$('show-text').checked;
$('highlight').onchange=()=>rpc({type:'set-reading-highlight',value:$('highlight').checked}).then(poll);
$('rate').oninput=async()=>{
  const rate=+$('rate').value;$('rate-value').textContent=rate.toFixed(1)+'×';
  const {profiles=[],activeId}=await chrome.storage.local.get(['profiles','activeId']);
  await chrome.storage.local.set({profiles:profiles.map(p=>p.id===activeId?{...p,rate}:p)});rpc({type:'set-live-rate',rate});
};
(async()=>{
  const key=new URLSearchParams(location.search).get('draft');
  if(key){const stored=await chrome.storage.session.get(key);if(stored[key]?.text){draft=true;$('input').value=stored[key].text;$('editor').open=true;render();}await chrome.storage.session.remove(key);}
  await poll();setInterval(()=>poll().catch(()=>{}),700);
})();
