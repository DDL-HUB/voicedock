import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../extension/src/popup.jsx',import.meta.url),'utf8');
test('stop during popup version check prevents a delayed read',async()=>{
  const functions=source.slice(source.indexOf('  function stopReading()'),source.indexOf('  function openSettings()'));
  let resolveVersion;const messages=[];
  const chrome={runtime:{sendMessage(message){messages.push(message.type);if(message.type==='reader-runtime-version')return new Promise(resolve=>resolveVersion=resolve);return Promise.resolve({ok:true});}}};
  const {readSelected,stopReading}=new Function('chrome','setPlayback','readAttempt','showError','setTimeout',functions+';return {readSelected,stopReading};')(chrome,()=>{},{current:0},()=>{},()=>{});
  const pending=readSelected();stopReading();resolveVersion({build:'1110-A'});await pending;
  assert.deepEqual(messages,['reader-runtime-version','stop-all']);
});
