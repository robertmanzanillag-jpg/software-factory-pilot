import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {validateCloudInputs,writeCloudConfig} from '../scripts/asistente-cloud-config.mjs';
const fixture=()=>({GITHUB_REPOSITORY:'robertmanzanillag-jpg/software-factory-pilot',GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'schedule',ASISTENTE_DATABASE_URL:'postgresql://test:test@db.example/test?sslmode=require',ASISTENTE_OPENAI_API_KEY:'sk-'+ 'x'.repeat(30),ASISTENTE_GITHUB_TOKEN:'github_pat_'+ 'x'.repeat(30),ASISTENTE_OPERATOR_JSON:JSON.stringify({owner:'fixture-owner',projectId:'asistente',baseBranch:'codex/office-integrated-repair-20261106',sourcePaths:['server/office-role-work.ts','tests/office-role-work.test.ts'],orders:[],reservations:{build:100}}),ASISTENTE_CREDIT_JSON:JSON.stringify({grant:{expiresAt:'2099-01-01T00:00:00Z',availableMicroUsd:123}})});
test('cloud admission rejects another repo, fork/PR context, altered scope, expiry and unsafe credential serialization',()=>{
 for(const change of [e=>e.GITHUB_REPOSITORY='someone/fork',e=>e.GITHUB_REF='refs/pull/1/merge',e=>e.GITHUB_EVENT_NAME='pull_request',e=>e.ASISTENTE_DATABASE_URL+='\nOTHER=1',e=>e.ASISTENTE_DATABASE_URL=e.ASISTENTE_DATABASE_URL.replace('require','disable'),e=>e.ASISTENTE_OPENAI_API_KEY='invalid',e=>e.ASISTENTE_CREDIT_JSON='{"grant":{"expiresAt":"invalid"}}',e=>e.ASISTENTE_CREDIT_JSON='{"grant":{"expiresAt":"2000-01-01T00:00:00Z"}}',e=>e.ASISTENTE_OPERATOR_JSON=e.ASISTENTE_OPERATOR_JSON.replace('codex/office-integrated-repair-20261106','main'),e=>e.ASISTENTE_OPERATOR_JSON=e.ASISTENTE_OPERATOR_JSON.replace('server/office-role-work.ts','server/routes.ts')]){
  const e=fixture();change(e);assert.throws(()=>validateCloudInputs(e),/UNVERIFIED/);
 }
});
test('private runtime preserves grant/orders and contains only reviewed environment variables',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'asistente-cloud-test-'));
 try{
  const e={...fixture(),RUNNER_TEMP:root,NODE_OPTIONS:'untrusted inherited option',UNRELATED_SECRET:'not forwarded'};
  const directory=await writeCloudConfig(e);
  assert.equal(path.dirname(directory),await fs.realpath(root));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory,'operator.json'),'utf8')),JSON.parse(e.ASISTENTE_OPERATOR_JSON));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory,'credit.json'),'utf8')),JSON.parse(e.ASISTENTE_CREDIT_JSON));
  const runtime=await fs.readFile(path.join(directory,'runtime.env'),'utf8');
  assert.ok(runtime.includes('OPENAI_SHARED_CREDITS_REQUIRED=true\n'));
  assert.ok(runtime.includes('SOFTWARE_FACTORY_OWNER_ID=fixture-owner\n'));
  assert.ok(!runtime.includes('NODE_OPTIONS')&&!runtime.includes('UNRELATED_SECRET'));
  if(process.platform!=='win32'){assert.equal((await fs.stat(directory)).mode&0o777,0o700);for(const f of ['operator.json','credit.json','runtime.env'])assert.equal((await fs.stat(path.join(directory,f))).mode&0o777,0o600);}
 }finally{const resolved=await fs.realpath(root);assert.ok(resolved.startsWith(await fs.realpath(os.tmpdir())+path.sep));await fs.rm(resolved,{recursive:true,force:true});}
});
test('failed environment publication removes every temporary credential file',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'asistente-cloud-cleanup-'));
 try{
  await assert.rejects(writeCloudConfig({...fixture(),RUNNER_TEMP:root,GITHUB_ENV:path.join(root,'missing','environment')}));
  assert.deepEqual(await fs.readdir(root),[]);
 }finally{const resolved=await fs.realpath(root);assert.ok(resolved.startsWith(await fs.realpath(os.tmpdir())+path.sep));await fs.rm(resolved,{recursive:true,force:true});}
});
