import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultProfile,migrateSettings,engineBaseUrl} from '../extension/src/shared.js';
test('fresh install starts with browser speech',()=>{
  assert.equal(defaultProfile().engine,'browser');
  assert.equal(defaultProfile().voice,'');
  assert.equal(engineBaseUrl('piper'),'http://127.0.0.1:8766/voicedock');
});
test('fresh install never silently switches to another voice',()=>{
  assert.equal(migrateSettings({}).set.fallback,false);
  assert.equal(migrateSettings({fallback:true}).set.fallback,undefined);
});
