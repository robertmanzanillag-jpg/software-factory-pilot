import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const hash = data => createHash('sha256').update(data).digest('hex');
export async function build({source='site',output='out',revision,variant='baseline'}={}) {
  if(!/^[a-f0-9]{40}$/.test(revision||'') || !['baseline','rehearsal'].includes(variant)) throw Error('INVALID_RELEASE_IDENTITY');
  const names=(await readdir(source)).sort();
  if(JSON.stringify(names)!==JSON.stringify(['index.html','style.css'])) throw Error('UNEXPECTED_SITE_FILE');
  const files={};
  await mkdir(output,{recursive:true});
  if((await readdir(output)).length) throw Error('OUTPUT_MUST_BE_EMPTY');
  for(const name of names) {
    if(!(await lstat(`${source}/${name}`)).isFile()) throw Error('REGULAR_FILES_ONLY');
    let data=await readFile(`${source}/${name}`);
    if(data.length>100000) throw Error('SITE_SIZE_LIMIT');
    data=Buffer.from(new TextDecoder('utf8',{fatal:true,ignoreBOM:true}).decode(data).replace(/\r\n/g,'\n'));
    if(name==='index.html' && variant==='rehearsal') data=Buffer.from(data.toString('utf8').replace('<h1>','<h1>Ensayo de recuperación: '));
    files[name]=hash(data); await writeFile(`${output}/${name}`,data);
  }
  const identity=hash(JSON.stringify({revision,variant,files}));
  const manifest={version:1,revision,variant,files,identity};
  await writeFile(`${output}/health.json`,JSON.stringify(manifest));
  await writeFile(`${output}/.nojekyll`,'');
  return manifest;
}
export async function verify({base,manifest,request=fetch,attempts=18,wait=ms=>new Promise(r=>setTimeout(r,ms)),maxElapsedMs=90000,signal}) {
  if(!['https://robertmanzanillag-jpg.github.io/software-factory-pilot/','https://robertmanzanillag-jpg.github.io/software-factory-pilot/staging/'].includes(base)) throw Error('UNAUTHORIZED_PUBLISH_TARGET');
  if(!Number.isInteger(attempts)||attempts<1||attempts>18 || !Number.isInteger(maxElapsedMs)||maxElapsedMs<1||maxElapsedMs>90000) throw Error('INVALID_ATTEMPTS');
  const deadline=Date.now()+maxElapsedMs, timeoutSignal=AbortSignal.timeout(maxElapsedMs),deadlineSignal=signal?AbortSignal.any([signal,timeoutSignal]):timeoutSignal;
  const nonce=randomUUID(); let failure='UNKNOWN';
  for(let i=0;i<attempts;i++) {
    try {
      const get=async name=>{
        deadlineSignal.throwIfAborted();
        const r=await request(`${base}${name}?release=${manifest.identity}&probe=${nonce}&check=${i}`,{redirect:'error',cache:'no-store',signal:AbortSignal.any([deadlineSignal,AbortSignal.timeout(5000)])});
        if(r.status!==200) {await r.body?.cancel();throw Error('PUBLICATION_NOT_READY');}
        const reader=r.body?.getReader(); if(!reader) throw Error('EMPTY_PUBLICATION');
        const chunks=[]; let size=0;
        try {
          for(;;) {const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>100000)throw Error('UNEXPECTED_PUBLICATION');chunks.push(Buffer.from(chunk.value));}
        } finally {await reader.cancel();}
        return Buffer.concat(chunks);
      };
      const live=JSON.parse((await get('health.json')).toString('utf8'));
      if(JSON.stringify(live)!==JSON.stringify(manifest)) throw Error('WRONG_RELEASE');
      for(const name of ['index.html','style.css']) if(hash(await get(name))!==manifest.files[name]) throw Error('WRONG_FILE');
      return {verified:true,identity:manifest.identity,revision:manifest.revision,variant:manifest.variant,at:new Date().toISOString()};
    } catch(e) { failure=['PUBLICATION_NOT_READY','EMPTY_PUBLICATION','UNEXPECTED_PUBLICATION','WRONG_RELEASE','WRONG_FILE'].includes(e.message)?e.message:'REQUEST_FAILED'; if(i===attempts-1 || Date.now()>=deadline || deadlineSignal.aborted) throw Error(`LIVE_RELEASE_UNVERIFIED:${failure}`); await wait(Math.min(5000,Math.max(0,deadline-Date.now()))); }
  }
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  if(process.argv[2]==='build') console.log(JSON.stringify(await build({revision:process.env.GITHUB_SHA,variant:process.env.PILOT_VARIANT||'baseline',output:process.env.PILOT_OUTPUT||'out'})));
  else if(process.argv[2]==='verify') {
    const result=await verify({base:'https://robertmanzanillag-jpg.github.io/software-factory-pilot/',manifest:JSON.parse(await readFile(`${process.env.PILOT_OUTPUT||'out'}/health.json`,'utf8'))});
    console.log(JSON.stringify(result));
    if(process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY,`Verified ${result.variant}: ${result.identity}\n`,{flag:'a'});
  } else throw Error('UNKNOWN_COMMAND');
}
