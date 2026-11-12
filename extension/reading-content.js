/* Read only rendered body text, keep source ranges for synchronized highlighting. */
(() => {
  if(globalThis.__vdReading?.build==='1110-A'&&globalThis.__vdReading?.alive())return;
  let cachedRange=null,current=null,highlightRange=null,host=null,shadow=null;
  let paintFrame=0,highlightRows=null,highlightKey='',lastFollowKey='',manualScrollUntil=0;
  const READER='.readerChapterContent,[data-reader-content]';
  function bodyRoots(){
    const roots=Array.from(document.querySelectorAll(READER)).filter(visible);
    return roots.filter(root=>!roots.some(other=>other!==root&&root.contains(other)));
  }
  let follow=null,lastState=null,pageTimer=null,checking=false,needsCheck=false,autoScrollUntil=0;
  function pageKey(text){let hash=2166136261;for(const c of text.trim())hash=Math.imul(hash^c.charCodeAt(0),16777619);return (hash>>>0).toString(16)+':'+text.trim().length;}
  function schedulePageCheck(){
    if(location.hostname!=='weread.qq.com'||!follow||lastState?.isPaused)return;
    if(checking){needsCheck=true;return;}
    clearTimeout(pageTimer);pageTimer=setTimeout(checkPage,700);
  }
  async function checkPage(){
    if(checking||!follow||lastState?.isPaused||document.hidden)return;
    checking=true;const expected=follow.documentId,old=current;
    try{
      const context=await readingContext(true,true);
      if(!follow||follow.documentId!==expected)return;
      if(!context?.text){current=old;clearHighlight();if(context?.error)globalThis.__vdBall?.showHint('正在等待书页正文加载，不会朗读书架或菜单。');return;}
      if(context.pageKey===follow.pageKey){
        const fresh=current;
        current={...fresh,id:old.id,text:old.text,canvasStart:old.canvasStart,
          prefix:old.prefix||'',base:old.canvas?(fresh.map[old.canvasStart||0]?.start||0)-(old.prefix?.length||0):old.base};
        highlightKey='';highlightRows=null;
        if(lastState)applyState(lastState);return;
      }
      const reply=await chrome.runtime.sendMessage({type:'weread-page-change',previousId:expected,context});
      if(!reply?.ok){current=old;if(!reply?.cancelled)follow=null;}
    }catch(_){current=old;}finally{checking=false;if(needsCheck){needsCheck=false;schedulePageCheck();}}
  }
  let canvasPointer=null;
  document.addEventListener('pointerdown',event=>{
    if(event.composedPath().some(node=>node instanceof Element&&node.matches('#voicedock-ball,[id^="voicedock-"],#vd-reading-highlight')))return;
    if(location.hostname!=='weread.qq.com')return;
    for(const canvas of document.querySelectorAll('.readerChapterContent canvas,[data-reader-content] canvas')){
      const r=canvas.getBoundingClientRect();
      if(event.clientX>=r.left&&event.clientX<=r.right&&event.clientY>=r.top&&event.clientY<=r.bottom){
        canvasPointer={canvas,x:(event.clientX-r.left)*canvas.width/r.width,y:(event.clientY-r.top)*canvas.height/r.height};break;
      }
    }
  },true);
  async function canvasContext(fromTop=false){
    if(!fromTop&&!canvasPointer?.canvas.isConnected)return {text:'',error:'请在微信读书正文中拖选起点，再点击「从这里往后读」。更新插件后需刷新书页，才能读取画布文字。'};
    const token=crypto.randomUUID();
    const canvases=await new Promise(resolve=>{
      const receive=event=>{if(event.source===window&&event.data?.type==='vd-canvas-response'&&event.data.token===token){clearTimeout(timer);removeEventListener('message',receive);resolve(event.data.canvases||[]);}};
      const timer=setTimeout(()=>{removeEventListener('message',receive);resolve([]);},700);
      addEventListener('message',receive);window.postMessage({type:'vd-canvas-request',token},location.origin);
    });
    // Identify the entire spread independently of where the user began reading.
    // Reusing the right-hand canvas is correct on redraw, but not on a new page.
    const spreadKey=pageKey(canvases.map(c=>(c.glyphs||[]).map(g=>g.text).join('')).join('\n'));
    const anchor=current?.canvas?current.map[0]?.node:canvasPointer?.canvas;
    const anchored=anchor?.getAttribute('data-vd-canvas');
    const sameSpread=current?.canvas&&current.spreadKey===spreadKey;
    const source=fromTop?((sameSpread&&canvases.find(c=>c.key===anchored&&c.glyphs?.length))||canvases.find(c=>c.glyphs?.length)):canvases.find(c=>c.key===canvasPointer.canvas.getAttribute('data-vd-canvas'));
    if(!source?.glyphs?.length)return {text:'',error:'尚未捕获到本页画布文字，请刷新微信读书书页后重新选中正文。'};
    const canvas=fromTop?Array.from(document.querySelectorAll('canvas[data-vd-canvas]')).find(c=>c.getAttribute('data-vd-canvas')===source.key):canvasPointer.canvas;
    const startPage=canvases.indexOf(source);
    const glyphs=canvases.slice(startPage).flatMap(page=>{
      const node=Array.from(document.querySelectorAll('canvas[data-vd-canvas]')).find(c=>c.getAttribute('data-vd-canvas')===page.key);
      return page.glyphs.filter(g=>typeof g.text==='string'&&[g.x,g.y,g.w,g.h].every(Number.isFinite)).map(g=>({...g,node,generation:page.generation}));
    });
    let chosen=0,distance=Infinity;
    if(!fromTop)glyphs.forEach((g,i)=>{
      if(g.node!==canvas)return;
      const dy=Math.max(g.y-canvasPointer.y,canvasPointer.y-g.y-g.h,0),dx=Math.max(g.x-canvasPointer.x,canvasPointer.x-g.x-g.w,0);
      const d=dy*1000+dx;if(d<distance){distance=d;chosen=i;}
    });
    const lineSpacing=VDReading.canvasLineSpacing(glyphs);
    let text='',map=[],previous=null;
    for(const g of glyphs.slice(chosen)){
      const lineY=Number.isFinite(g.lineY)?g.lineY:g.y,previousLineY=previous?(Number.isFinite(previous.lineY)?previous.lineY:previous.y):0;
      if(previous&&(g.node!==previous.node||Math.abs(lineY-previousLineY)>Math.max(g.h,previous.h)*.65||g.x<previous.x-5||g.x-previous.x-previous.w>g.h*.2)){
        const paragraph=g.node!==previous.node?!VDReading.pageSpeechParts(text).tail:VDReading.canvasParagraphBreak(previous,g,lineSpacing);
        text+=paragraph?'\n':' ';
      }
      map.push({...g,start:text.length,end:text.length+g.text.length});text+=g.text;previous=g;
    }
    const id=crypto.randomUUID(),key=spreadKey;current={id,map,base:0,text,canvas:true,canvasStart:chosen,generation:source.generation,spreadKey};return {id,text,kind:'canvas',scope:'weread-body',fromHere:true,followPage:true,pageKey:key,canAutoTurn:!!nextPageButton()};
  }
  const EXCLUDE='script,style,noscript,canvas,nav,header,footer,button,input,textarea,select,svg,figure,picture,img,time,[role="button"],[role="navigation"],[aria-hidden="true"],.readerTopBar,.readerControls,.readerFooter,.readerNavBar,.author,.avatar,.timestamp,.vote,.votes,[data-testid*="vote"],[slot="vote"],#vd-reading-highlight,[id^="voicedock-"]';
  const COMMENTS='shreddit-comment,[data-testid="comment"],.comment';
  const BODIES='shreddit-comment [slot="comment"],shreddit-comment [slot="comment-body"],shreddit-comment .md,[data-testid="comment-body"],.comment-body,.comment-content,.comment .md';
  function visible(element){
    if(!element||element.closest(EXCLUDE))return false;
    const style=getComputedStyle(element);return style.display!=='none'&&style.visibility!=='hidden'&&element.getClientRects().length>0;
  }
  function visibleControl(element){const r=element.getBoundingClientRect(),s=getComputedStyle(element);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';}
  function nextPageButton(){return Array.from(document.querySelectorAll('button,a,[role="button"],.readerFooter_button,.readerFooter_nextPage')).find(el=>/^下一页\s*[›>]?$/u.test(el.textContent.trim())&&visibleControl(el)&&!el.matches('[disabled],[aria-disabled="true"],.disabled'));}
  function snapshot(){
    const selection=getSelection();
    if(selection?.rangeCount&&!selection.isCollapsed&&selection.toString().trim())cachedRange=selection.getRangeAt(0).cloneRange();
  }
  document.addEventListener('selectionchange',snapshot,true);document.addEventListener('mouseup',snapshot,true);
  function makeMap(roots){
    let text='',map=[],lastBlock=null;
    for(const root of roots){
      const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;
      while((node=walker.nextNode())){
        if(!visible(node.parentElement))continue;
        const value=node.nodeValue;if(!value)continue;
        const block=node.parentElement.closest('p,li,blockquote,pre,h1,h2,h3,h4,section,article,[slot="comment"]')||root;
        if(lastBlock&&block!==lastBlock&&text&&!text.endsWith('\n'))text+='\n';
        map.push({node,original:value,start:text.length,end:text.length+value.length});text+=value;lastBlock=block;
      }
      if(text&&!text.endsWith('\n'))text+='\n';lastBlock=null;
    }
    return {text,map};
  }
  function readingContext(fromHere,fromTop=false){
    snapshot();let range=cachedRange;
    if(fromTop&&location.hostname==='weread.qq.com'){
      // A canvas reading session must never switch to navigation DOM during a
      // redraw. Broad .readerContent also contains header, shelf and translators.
      if(current?.canvas)return canvasContext(true);
      const root=bodyRoots().find(el=>makeMap([el]).text.trim());
      if(!root)return canvasContext(true);
      range=document.createRange();range.selectNodeContents(root);
    }
    if(!range||!range.startContainer.isConnected||!range.toString().trim())return location.hostname==='weread.qq.com'?canvasContext(fromTop):{text:''};
    const element=range.startContainer.nodeType===Node.ELEMENT_NODE?range.startContainer:range.startContainer.parentElement;
    if(location.hostname==='weread.qq.com'){
      const root=element.closest(READER);
      if(!root||!root.contains(range.endContainer)||element.closest(EXCLUDE)){
        if(canvasPointer?.canvas.isConnected&&canvasPointer.canvas.closest(READER))return canvasContext(fromTop);
        return {text:'',error:'未获取到微信读书正文，请在书页正文里重新选起点。不会朗读书架或菜单。'};
      }
      if(canvasPointer?.canvas.isConnected&&canvasPointer.canvas.closest(READER)&&
        (range.startContainer.nodeType!==Node.TEXT_NODE||element.closest('canvas')))return canvasContext(fromTop);
    }
    const comment=element.closest(COMMENTS);let roots=[];
    if(comment){
      const all=Array.from(document.querySelectorAll(BODIES)).filter(visible);
      roots=all.filter((el,index)=>!all.some((parent,i)=>i!==index&&parent.contains(el)));
      if(!roots.length)roots=[comment];
    }else{
      roots=[element.closest('.mw-parser-output')||element.closest(READER)||element.closest('main,[role="main"]')||element.closest('article')||document.body];
    }
    const source=makeMap(roots);let start=-1,end=-1;
    for(const item of source.map){
      if(item.node===range.startContainer)start=item.start+range.startOffset;
      if(item.node===range.endContainer)end=item.start+range.endOffset;
    }
    if(start<0){
      const first=source.map.find(item=>{try{return range.intersectsNode(item.node);}catch{return false;}});
      if(first)start=first.start;
    }
    if(end<0){const last=[...source.map].reverse().find(item=>{try{return range.intersectsNode(item.node);}catch{return false;}});if(last)end=last.end;}
    if(start<0)return location.hostname==='weread.qq.com'?canvasContext(fromTop):{text:''};
    let text=fromHere?source.text.slice(start):source.text.slice(start,end>start?end:start+range.toString().length);
    const leading=text.length-text.trimStart().length;start+=leading;text=text.trim().slice(0,50000);
    const id=crypto.randomUUID();current={id,map:source.map,base:start,text};
    return {id,text,kind:comment?'comments':'page',scope:location.hostname==='weread.qq.com'?'weread-body':undefined,fromHere:!!fromHere,followPage:location.hostname==='weread.qq.com'&&!!fromHere,pageKey:pageKey(source.text),canAutoTurn:location.hostname==='weread.qq.com'&&!!nextPageButton()};
  }
  function clearHighlight(){host?.remove();host=null;shadow=null;highlightRange=null;highlightRows=null;highlightKey='';if(paintFrame){cancelAnimationFrame(paintFrame);paintFrame=0;}}
  function canvasValid(){
    current.canvasNodes ||= new Map(current.map.map(g=>[g.node,g.generation||current.generation]));
    return Array.from(current.canvasNodes).every(([node,generation])=>node.isConnected&&(node.getAttribute('data-vd-generation')||'0')===generation);
  }
  function schedulePaint(){if(highlightRange&&!paintFrame)paintFrame=requestAnimationFrame(()=>{paintFrame=0;paint();});}
  function paint(){
    if(!highlightRange)return;
    if(current?.canvas&&!canvasValid()){
      clearHighlight();schedulePageCheck();return;
    }
    if(!host){host=document.createElement('div');host.id='vd-reading-highlight';
      host.style.cssText='position:fixed;inset:0;pointer-events:none;z-index:2147483000;';shadow=host.attachShadow({mode:'closed'});(document.fullscreenElement||document.documentElement).appendChild(host);}
    let rects;
    if(current?.canvas){
      if(!highlightRows){
        const canvases=new Map();
        for(const g of highlightRange){
          let lines=canvases.get(g.node);if(!lines){lines=new Map();canvases.set(g.node,lines);}
          const key=Math.round((Number.isFinite(g.lineY)?g.lineY:g.y)*10),old=lines.get(key);
          if(old){old.x=Math.min(old.x,g.x);old.y=Math.min(old.y,g.y);old.right=Math.max(old.right,g.x+g.w);old.bottom=Math.max(old.bottom,g.y+g.h);}
          else lines.set(key,{node:g.node,x:g.x,y:g.y,right:g.x+g.w,bottom:g.y+g.h});
        }
        highlightRows=Array.from(canvases.values()).flatMap(lines=>Array.from(lines.values()));
      }
      // Read layout once per canvas, before writing any marker styles.
      const boxes=new Map();for(const row of highlightRows)if(!boxes.has(row.node))boxes.set(row.node,row.node.getBoundingClientRect());
      rects=highlightRows.map(row=>{const r=boxes.get(row.node),sx=r.width/row.node.width,sy=r.height/row.node.height;return {left:r.left+row.x*sx,top:r.top+row.y*sy,width:(row.right-row.x)*sx,height:(row.bottom-row.y)*sy};});
    }else rects=Array.from(highlightRange.getClientRects());
    rects=rects.filter(r=>r.width>=1&&r.height>=1);
    while(shadow.childElementCount>rects.length)shadow.lastElementChild.remove();
    while(shadow.childElementCount<rects.length){const mark=document.createElement('div');mark.style.cssText='position:absolute;background:rgba(255,205,66,.34);border-bottom:2px solid #d49b00;border-radius:2px;';shadow.appendChild(mark);}
    for(let i=0;i<rects.length;i++){
      const rect=rects[i],mark=shadow.children[i];
      mark.style.left=rect.left+'px';mark.style.top=rect.top+'px';mark.style.width=rect.width+'px';mark.style.height=rect.height+'px';
    }
  }
  function applyState(state){
    const wasPaused=lastState?.isPaused;lastState=state;
    follow=state.pageFollow?.documentId===current?.id?state.pageFollow:null;
    if(wasPaused&&!state.isPaused&&follow)schedulePageCheck();
    if(!state?.isPlaying||state.highlight===false||!current||state.progress?.documentId!==current.id)return clearHighlight();
    if(state.progress?.phase!=='playing')return;
    if(!current.canvas&&current.map.some(g=>!g.node.isConnected||g.node.nodeValue!==g.original)){clearHighlight();schedulePageCheck();return;}
    const start=current.base+state.progress.start,end=current.base+state.progress.end;
    const key=current.id+':'+start+':'+end,shouldFollow=key!==lastFollowKey&&performance.now()>manualScrollUntil;lastFollowKey=key;
    if(current.canvas){
      if(highlightKey!==key){highlightRange=current.map.filter(g=>g.end>start&&g.start<end&&g.node.isConnected);highlightRows=null;highlightKey=key;}
      const first=highlightRange[0];if(first&&shouldFollow){const r=first.node.getBoundingClientRect(),y=r.top+first.y*r.height/first.node.height;if(y<60||y>innerHeight-70){autoScrollUntil=performance.now()+1200;scrollBy({top:y-innerHeight/2,behavior:'instant'});}}
      paint();return;}
    const a=current.map.find(item=>item.end>start&&item.node.isConnected);
    const b=[...current.map].reverse().find(item=>item.start<end&&item.node.isConnected);
    if(!a||!b)return clearHighlight();
    const range=document.createRange();range.setStart(a.node,Math.max(0,start-a.start));range.setEnd(b.node,Math.min(b.node.length,end-b.start));
    highlightRange=range;const bounds=range.getBoundingClientRect();
    if(shouldFollow&&(bounds.top<60||bounds.bottom>innerHeight-70)){autoScrollUntil=performance.now()+1200;a.node.parentElement.scrollIntoView({block:'center',behavior:'instant'});}
    paint();
  }
  addEventListener('scroll',schedulePaint,{capture:true,passive:true});addEventListener('resize',schedulePaint);
  function manualScroll(){manualScrollUntil=performance.now()+5000;}
  addEventListener('wheel',manualScroll,{capture:true,passive:true});addEventListener('touchmove',manualScroll,{capture:true,passive:true});
  addEventListener('keydown',e=>{if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(e.key))manualScroll();},true);
  document.addEventListener('fullscreenchange',()=>{if(host)(document.fullscreenElement||document.documentElement).appendChild(host);paint();});
  addEventListener('scroll',()=>{if(!lastState?.isPlaying&&performance.now()>autoScrollUntil)schedulePageCheck();},{capture:true,passive:true});
  new MutationObserver(mutations=>{
    if(mutations.some(m=>m.target.nodeType===Node.ELEMENT_NODE?m.target.closest(READER)||Array.from(m.addedNodes).some(n=>n.nodeType===1&&(n.matches(READER)||n.querySelector(READER))):m.target.parentElement?.closest(READER)))schedulePageCheck();
  }).observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['data-vd-generation','style','class']});
  chrome.runtime.onMessage.addListener((message,_sender,reply)=>{
    if(message.type==='reading-page-prefix'){
      if(!current||current.id!==message.id||typeof message.prefix!=='string'||message.prefix.length>1501){reply({ok:false});return;}
      current.base+=(current.prefix?.length||0)-message.prefix.length;
      current.text=message.prefix+current.text.slice(current.prefix?.length||0);current.prefix=message.prefix;reply({ok:true});return;
    }
    if(message.type==='continue-weread-page'){
      if(!current||current.id!==message.id||!follow||lastState?.isPaused){reply({ok:false});return;}
      const next=nextPageButton();
      if(next){next.click();reply({ok:true});}else reply({ok:false});return;
    }
    if(message.type==='validate-reading-document'){
      reply({ok:!!current&&current.id===message.id&&current.map.every(g=>g.node.isConnected&&(current.canvas||g.node.nodeValue===g.original))&&(!current.canvas||current.map.every(g=>(g.node.getAttribute('data-vd-generation')||'0')===(g.generation||current.generation)))});return;
    }
    if(message.type==='get-reading-context-1110a'||message.type==='get-reading-context'){Promise.resolve(readingContext(message.fromHere!==false,message.fromTop===true)).then(reply).catch(()=>reply({text:'',error:'正文读取失败，请刷新书页重试。'}));return true;}
    if(message.type==='playback-state')applyState(message.state);
  });
  globalThis.__vdReading={build:'1110-A',alive:()=>{try{return !!chrome.runtime.id;}catch{return false;}},readingContext,clearHighlight};
})();
