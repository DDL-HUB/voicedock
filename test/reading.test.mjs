import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import vm from 'node:vm';
const ctx=vm.createContext({});vm.runInContext(fs.readFileSync(new URL('../extension/reading.js',import.meta.url),'utf8'),ctx);
const {readingUnits}=ctx.VDReading;

test('unfinished page tail is held and joined with the next page, including split words',()=>{
 const first=ctx.VDReading.pageSpeechParts('A complete sentence. I know I');
 assert.equal(first.text,'A complete sentence.');assert.equal(first.tail,'I know I');
 assert.equal(ctx.VDReading.joinPageSpeech(first.tail,'can pin down the answer.'),'I know I can pin down the answer.');
 assert.equal(ctx.VDReading.joinPageSpeech('an extraor-','dinary sight.'),'an extraordinary sight.');
 assert.equal(ctx.VDReading.pageSpeechParts('She paused . . .').tail,'She paused . . .');
 assert.equal(ctx.VDReading.pageSpeechParts('A finished sentence!”').tail,'');
});
test('whole fragments can wait for next page but long unpunctuated tails remain bounded',()=>{
 assert.equal(ctx.VDReading.pageSpeechParts('I know I').text,'');
 assert.equal(ctx.VDReading.pageSpeechParts('x'.repeat(1600)).tail,'');
});

test('canvas paragraphs use actual line spacing, not small glyph height',()=>{
 const node={};const glyphs=[0,50,100,150,250,300].map(y=>({node,y,h:18,x:20,w:100,text:'Line'}));
 const spacing=ctx.VDReading.canvasLineSpacing(glyphs);
 assert.equal(spacing.get(node),50);
 assert.equal(ctx.VDReading.canvasParagraphBreak(glyphs[0],glyphs[1],spacing),false);
 assert.equal(ctx.VDReading.canvasParagraphBreak(glyphs[3],glyphs[4],spacing),true);
 for(let i=1;i<4;i++)assert.equal(ctx.VDReading.canvasParagraphBreak(glyphs[i-1],glyphs[i],spacing),false);
});
test('a single ambiguous canvas line break stays continuous',()=>{
 const node={};const glyphs=[{node,y:0,h:15},{node,y:60,h:15}];
 assert.equal(ctx.VDReading.canvasParagraphBreak(glyphs[0],glyphs[1],ctx.VDReading.canvasLineSpacing(glyphs)),false);
});

test('natural paragraphs keep sentence context and exact source offsets',()=>{
 const text='  First thought. Second thought!\nNext paragraph. More context?';
 const units=ctx.VDReading.readingAudioUnits(text,5000,'paragraph');
 assert.equal(units.length,2);assert.equal(units[0].text,'First thought. Second thought!');
 for(const u of units)assert.equal(text.slice(u.start,u.end),u.text);
 assert.equal(ctx.VDReading.readingAudioUnits(text,5000,'sentence').length,4);
});
test('natural paragraphs are bounded without losing words or sending punctuation',()=>{
 const text='Long sentence. '.repeat(80).trim()+'\n...\nEnd.';
 const units=ctx.VDReading.readingAudioUnits(text,120,'paragraph');
 assert(units.every(u=>u.text.length<=120&&/[\p{L}\p{N}]/u.test(u.text)));
 assert.equal(units.map(u=>u.text).join(' '),'Long sentence. '.repeat(80)+'End.');
});

test('cloud sentence retains a long clause and Dr abbreviation',()=>{
 const text='Dr Packard '+ 'carefully examined the report, '.repeat(8)+'and closed the book.';
 const units=readingUnits(text,5000);
 assert.equal(units.length,1);assert.equal(units[0].text,text);
});
test('sentences preserve character offsets and Chinese punctuation',()=>{
 const text='  Hello world.\n你好，世界！ Next sentence?';const units=readingUnits(text);
 assert.equal(units.length,3);for(const u of units)assert.equal(text.slice(u.start,u.end),u.text);
});
test('long text has no loss and no oversized segments',()=>{
 const text='word '.repeat(300).trim();const units=readingUnits(text);
 assert(units.every(u=>u.text.length<=240));assert.equal(units.map(u=>u.text).join(' '),text);
});

test('spaced ellipsis stays with the sentence instead of becoming punctuation requests',()=>{
 const text='I didn’t really see anything . . . but it’s still happening. I’m awake.';
 const units=readingUnits(text,5000);
 assert.equal(units.length,2);assert.equal(units[0].text,text.slice(0,text.indexOf(' I’m')));
 for(const u of units)assert.equal(text.slice(u.start,u.end),u.text);
});
test('ellipsis variants and standalone punctuation never create unspeakable requests',()=>{
 for(const dots of ['...', '. . .', '.  .  .', '…', '……']){
  const text=`Wait ${dots} I’m here.`;
  assert.equal(readingUnits(text,5000).length,1);
 }
 for(const text of ['.',' . . . ','！？？','— … “ ”','\n...\n'])assert.equal(readingUnits(text,5000).length,0);
});
