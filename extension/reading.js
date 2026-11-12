(function(root){
  function readingUnits(text,maxLength=240){
    text=String(text||'');const spans=[];let begin=0;
    function add(end){
      let a=begin,b=end;while(a<b&&/\s/u.test(text[a]))a++;while(b>a&&/\s/u.test(text[b-1]))b--;
      while(b-a>maxLength){let cut=text.lastIndexOf(' ',a+maxLength);if(cut<a+maxLength*.35)cut=a+maxLength;
        if(/[\p{L}\p{N}]/u.test(text.slice(a,cut)))spans.push({text:text.slice(a,cut),start:a,end:cut});a=cut;while(a<b&&/\s/u.test(text[a]))a++;}
      if(b>a&&/[\p{L}\p{N}]/u.test(text.slice(a,b)))spans.push({text:text.slice(a,b),start:a,end:b});begin=end;
    }
    for(let i=0;i<text.length;i++){
      const ch=text[i];if(!/[.!?。！？\n]/u.test(ch))continue;
      // A rendered line wrap is not a spoken sentence boundary.
      if(ch==='\n'&&text[i-1]!=='\n'&&text[i+1]!=='\n')continue;
      // Book typography uses both "..." and ". . ." inside sentences.
      // Consume the whole run so none of its dots becomes a standalone request.
      if(ch==='.'){
        const ellipsis=/^\.(?:[^\S\r\n]*\.)+/u.exec(text.slice(i));
        if(ellipsis){i+=ellipsis[0].length-1;continue;}
      }
      if(ch==='.' && ((/\d/.test(text[i-1]||'')&&/\d/.test(text[i+1]||'')) || /\b(?:Mr|Mrs|Ms|Dr|Prof|St|vs|etc)\.$/i.test(text.slice(begin,i+1))))continue;
      if(ch==='.' && text[i+1] && !/[\s"'”’]/u.test(text[i+1]))continue;
      let end=i+1;while(/[.!?。！？"'”’]/u.test(text[end]||'')&&end<text.length)end++;
      add(end);i=end-1;
    }
    add(text.length);return spans;
  }
  function readingAudioUnits(text,maxLength=5000,mode='paragraph'){
    if(mode!=='paragraph')return readingUnits(text,maxLength);
    text=String(text||'');maxLength=Math.min(maxLength,1500);const result=[];
    for(const match of text.matchAll(/[^\r\n]+/gu)){
      const sentences=readingUnits(match[0],maxLength);let pending=null;
      for(const sentence of sentences){
        const start=match.index+sentence.start,end=match.index+sentence.end;
        if(pending&&end-pending.start<=maxLength){pending.end=end;pending.text=text.slice(pending.start,end);}
        else{pending={text:text.slice(start,end),start,end};result.push(pending);}
      }
    }
    return result;
  }
  const canvasLineY=g=>Number.isFinite(g.lineY)?g.lineY:g.y;
  function canvasLineSpacing(glyphs){
    const gaps=new Map();let previous=null;
    for(const g of glyphs){
      if(previous&&g.node===previous.node){
        const gap=canvasLineY(g)-canvasLineY(previous);
        if(gap>Math.max(g.h,previous.h)*.65){if(!gaps.has(g.node))gaps.set(g.node,[]);gaps.get(g.node).push(gap);}
      }
      previous=g;
    }
    return new Map(Array.from(gaps,([node,values])=>{values.sort((a,b)=>a-b);return [node,values[Math.floor((values.length-1)/2)]];}));
  }
  function canvasParagraphBreak(previous,g,spacing){
    if(g.node!==previous.node)return true;
    const normal=spacing.get(g.node);
    return Number.isFinite(normal)&&canvasLineY(g)-canvasLineY(previous)>normal*1.6;
  }
  function pageSpeechParts(text){
    text=String(text||'').trimEnd();
    const units=readingUnits(text,5000),last=units.at(-1);
    if(!last||/[!?。！？]["'”’»）)]*$/u.test(last.text)||/(?<!\.)\.["'”’»）)]*$/u.test(last.text)&&!/(?:\.\s*){2,}["'”’»）)]*$/u.test(last.text))return {text,tail:''};
    if(last.text.length>1500)return {text,tail:''};
    return {text:text.slice(0,last.start).trimEnd(),tail:last.text};
  }
  function joinPageSpeech(tail,next){
    tail=String(tail||'').trimEnd();next=String(next||'').trimStart();
    if(!tail)return next;
    return /[\p{L}]-$/u.test(tail)&&/^\p{L}/u.test(next)?tail.slice(0,-1)+next:tail+' '+next;
  }
  root.VDReading={readingUnits,readingAudioUnits,canvasLineSpacing,canvasParagraphBreak,pageSpeechParts,joinPageSpeech};
})(globalThis);
