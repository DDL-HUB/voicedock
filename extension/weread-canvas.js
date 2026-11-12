/* Page-world adapter: retain only text drawn on the currently rendered canvases.
 * No chapter APIs, cookies, storage or network access. */
(() => {
  if(globalThis.__vdCanvasInstalled)return;
  globalThis.__vdCanvasInstalled=true;
  const records=new WeakMap(),proto=CanvasRenderingContext2D.prototype;
  const fontCaches=new Map();
  document.fonts?.addEventListener('loadingdone',()=>fontCaches.clear());
  function metricsFor(context){
    const key=[context.font,context.textBaseline,context.fontKerning,context.fontStretch,context.fontVariantCaps,context.letterSpacing,context.wordSpacing,context.textRendering,context.direction].join('|');
    let cache=fontCaches.get(key);
    if(!cache){
      if(fontCaches.size>=16)fontCaches.delete(fontCaches.keys().next().value);
      cache={font:context.measureText('Mg'),characters:new Map()};fontCaches.set(key,cache);
    }
    return cache;
  }
  const invalidate=canvas=>{canvas.setAttribute('data-vd-generation',String(Number(canvas.getAttribute('data-vd-generation')||0)+1));};
  const fill=proto.fillText,clear=proto.clearRect;
  proto.fillText=function(text,x,y,...rest){
    const result=Reflect.apply(fill,this,[text,x,y,...rest]);
    try{
      const canvas=this.canvas;
      let data=records.get(canvas);if(!data){data=new Map();records.set(canvas,data);}
      if(data.size>60000)return result;
      const value=String(text),matrix=this.getTransform(),cache=metricsFor(this),fontMetrics=cache.font;
      const size=Number(this.font.match(/(\d+(?:\.\d+)?)px(?:\s|\/|$)/)?.[1])||16;
      let cursor=Number(x);
      if(this.textAlign==='center')cursor-=this.measureText(value).width/2;
      if(this.textAlign==='right'||this.textAlign==='end')cursor-=this.measureText(value).width;
      for(const char of value){
        let m=cache.characters.get(char);
        if(!m){if(cache.characters.size>=2048)cache.characters.clear();m=this.measureText(char);cache.characters.set(char,m);}
        const ascent=m.actualBoundingBoxAscent||fontMetrics.fontBoundingBoxAscent||fontMetrics.actualBoundingBoxAscent||size;
        const descent=m.actualBoundingBoxDescent||fontMetrics.fontBoundingBoxDescent||fontMetrics.actualBoundingBoxDescent||3;
        let baseline=Number(y);
        if(this.textBaseline==='top')baseline+=ascent;
        else if(this.textBaseline==='middle')baseline+=(ascent-descent)/2;
        // Avoid allocating six DOMPoint objects for every captured character.
        const left=matrix.a*cursor+matrix.c*(baseline-ascent)+matrix.e,top=matrix.b*cursor+matrix.d*(baseline-ascent)+matrix.f;
        const right=matrix.a*(cursor+m.width)+matrix.c*(baseline+descent)+matrix.e,bottom=matrix.b*(cursor+m.width)+matrix.d*(baseline+descent)+matrix.f;
        const glyph={text:char,x:left,y:top,w:right-left,h:bottom-top,lineY:matrix.b*cursor+matrix.d*Number(y)+matrix.f};
        // Repainting identical text at the same position must not duplicate it.
        data.set(`${glyph.x.toFixed(1)},${glyph.y.toFixed(1)}`,glyph);
        cursor+=m.width;
      }
    }catch(_){}return result;
  };
  proto.clearRect=function(x,y,w,h){
    const result=Reflect.apply(clear,this,[x,y,w,h]);
    invalidate(this.canvas);
    try{const m=this.getTransform(),a=new DOMPoint(x,y).matrixTransform(m),b=new DOMPoint(x+w,y+h).matrixTransform(m);
      const data=records.get(this.canvas);
      if(data&&a.x<=0&&a.y<=0&&b.x>=this.canvas.width&&b.y>=this.canvas.height)data.clear();
      else if(data)for(const [key,g] of data){if(!(g.x+g.w<=a.x||g.x>=b.x||g.y+g.h<=a.y||g.y>=b.y))data.delete(key);}}catch(_){}
    return result;
  };
  for(const key of ['width','height']){
    const descriptor=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,key);
    if(descriptor?.set)Object.defineProperty(HTMLCanvasElement.prototype,key,{...descriptor,set(value){records.delete(this);invalidate(this);return descriptor.set.call(this,value);}});
  }
  const setAttribute=HTMLCanvasElement.prototype.setAttribute;
  HTMLCanvasElement.prototype.setAttribute=function(name,value){
    if(['width','height'].includes(String(name).toLowerCase())){records.delete(this);invalidate(this);}
    return Reflect.apply(setAttribute,this,[name,value]);
  };
  if(proto.reset){const reset=proto.reset;proto.reset=function(){records.delete(this.canvas);invalidate(this.canvas);return Reflect.apply(reset,this,[]);};}
  addEventListener('message',event=>{
    if(event.source!==window||event.data?.type!=='vd-canvas-request'||typeof event.data.token!=='string')return;
    const canvases=[];
    for(const canvas of document.querySelectorAll('.readerChapterContent canvas,[data-reader-content] canvas')){
      const rect=canvas.getBoundingClientRect();if(!rect.width||!rect.height||getComputedStyle(canvas).visibility==='hidden')continue;
      // Hidden preloaded pages must not enter the reading queue.
      if(rect.right<=0||rect.left>=innerWidth||rect.bottom<=0||rect.top>=innerHeight)continue;
      let key=canvas.getAttribute('data-vd-canvas');if(!key){key=crypto.randomUUID();canvas.setAttribute('data-vd-canvas',key);}
      canvases.push({key,generation:canvas.getAttribute('data-vd-generation')||'0',width:canvas.width,height:canvas.height,glyphs:Array.from(records.get(canvas)?.values()||[])});
    }
    window.postMessage({type:'vd-canvas-response',token:event.data.token,canvases},location.origin);
  });
})();
