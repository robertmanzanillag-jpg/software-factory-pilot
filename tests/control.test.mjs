import test from 'node:test';
import assert from 'node:assert/strict';
import {shouldPauseNewWork,openControl} from '../scripts/control.mjs';
test('credit envelope counts spent, reserved and prior costs; expiry blocks new work',()=>{
  const s={configured:true,fixedCents:1,spentCents:0,reservedCents:0},now=new Date('2026-11-06T12:00:00Z');
  assert.equal(shouldPauseNewWork(s,now),false);
  assert.equal(shouldPauseNewWork({...s,reservedCents:94},now),true);
  assert.equal(shouldPauseNewWork({...s,spentCents:94},now),true);
  assert.equal(shouldPauseNewWork({...s,reservedCents:NaN},now),true);
  assert.equal(shouldPauseNewWork(s,new Date('2026-11-20T00:00:00Z')),true);
});
test('controller refuses other repositories before any request',async()=>{
  let calls=0;await assert.rejects(openControl({env:{GITHUB_REPOSITORY:'owner/kong'},request:async()=>{calls++;throw Error();}}));assert.equal(calls,0);
});
