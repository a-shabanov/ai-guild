import {test} from 'node:test';
import assert from 'node:assert/strict';
// The PWA module registers browser install listeners at import time.
globalThis.addEventListener ??= (()=>{}) as typeof addEventListener;
const {isNewerRelease}=await import('../public/pwa.js');

test('release comparison handles version boundaries and rebuilds without false downgrade notices',()=>{
 const current={version:'0.3.8',build:16};
 for(const [latest,expected] of [
  [{version:'0.3.8',build:16},false], [{version:'0.3.8',build:17},true],
  [{version:'0.3.8',build:15},false], [{version:'0.3.9',build:1},true],
  [{version:'0.3.7',build:999},false], [{version:'0.10.0',build:1},true],
  [{version:'1.0.0',build:1},true], [{version:'broken',build:99},false],
  [{version:'0.3.9',build:null},false],
 ] as const) assert.equal(isNewerRelease(latest,current),expected,JSON.stringify(latest));
});
