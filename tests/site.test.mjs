import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build,verify} from '../scripts/site.mjs';
test('baseline and rehearsal are different reproducible publications',async()=>{
 const root=await mkdtemp(join(tmpdir(),'factory-pilot-'));
 try {
  const a=await build({output:join(root,'a'),revision:'a'.repeat(40)});
  const b=await build({output:join(root,'b'),revision:'a'.repeat(40),variant:'rehearsal'});
  assert.notEqual(a.identity,b.identity); assert.notEqual(a.files['index.html'],b.files['index.html']);
  const c=await build({output:join(root,'c'),revision:'a'.repeat(40)}); assert.deepEqual(a,c);
  const probes=new Set();
  const request=async url=>{probes.add(new URL(url).searchParams.get('probe'));return new Response(await readFile(join(root,'a',new URL(url).pathname.split('/').at(-1))));};
  assert.equal((await verify({base:'https://robertmanzanillag-jpg.github.io/software-factory-pilot/',manifest:a,request,attempts:1})).verified,true);
  await verify({base:'https://robertmanzanillag-jpg.github.io/software-factory-pilot/',manifest:a,request,attempts:1});
  assert.equal(probes.size,2);
  await mkdir(join(root,'windows'));
  for(const name of ['index.html','style.css'])await writeFile(join(root,'windows',name),(await readFile(`site/${name}`,'utf8')).replace(/\r?\n/g,'\r\n'));
  assert.deepEqual(await build({source:join(root,'windows'),output:join(root,'d'),revision:'a'.repeat(40)}),a);
  await assert.rejects(verify({base:'https://robertmanzanillag-jpg.github.io/software-factory-pilot/',manifest:b,request,attempts:1}),/UNVERIFIED/);
  await assert.rejects(verify({base:'https://kongnightlife.com/',manifest:a,request}),/UNAUTHORIZED/);
  await assert.rejects(build({output:join(root,'a'),revision:'a'.repeat(40)}),/EMPTY/);
 } finally {await rm(root,{recursive:true,force:true});}
});
test('oversized live content is cancelled before buffering the full response',async()=>{
 let cancelled=false;
 const request=async()=>new Response(new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(100001));},cancel(){cancelled=true;}}));
 await assert.rejects(verify({base:'https://robertmanzanillag-jpg.github.io/software-factory-pilot/',manifest:{identity:'x'},request,attempts:1}),/UNVERIFIED/);
 assert.equal(cancelled,true);
});
test('a stalled request cannot consume the restoration time reserve',async()=>{
 const request=async(url,{signal})=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(Error('timeout')),{once:true});});
 const keepAlive=setTimeout(()=>{},2000),started=Date.now();
 try {await assert.rejects(verify({base:'https://robertmanzanillag-jpg.github.io/software-factory-pilot/',manifest:{identity:'x'},request,maxElapsedMs:25}),/UNVERIFIED/);assert.ok(Date.now()-started<1500);}
 finally{clearTimeout(keepAlive);}
});

test('parent stage cancellation stops public verification before any request', async () => {
  let calls=0;
  await assert.rejects(verify({base:'https://robertmanzanillag-jpg.github.io/software-factory-pilot/',manifest:{identity:'test'},signal:AbortSignal.abort(),request:async()=>{calls++;throw Error('must not fetch');}}));
  assert.equal(calls,0);
});
