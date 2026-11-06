// Trusted harness: execute from the verified base revision, never the candidate tree.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,readdir,access} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
const root='/work/out', expected=process.env.CANDIDATE_SHA;
assert.match(expected??'',/^[a-f0-9]{40}$/);
const manifest=JSON.parse(await readFile(`${root}/health.json`,'utf8'));
assert.equal(manifest.revision,expected);
for(const file of ['index.html','style.css']) assert.equal(createHash('sha256').update(await readFile(`${root}/${file}`)).digest('hex'),manifest.files[file]);
const server=createServer(async(req,res)=>{
  const file=new URL(req.url,'http://localhost').pathname;
  const name={'/':'index.html','/style.css':'style.css','/health.json':'health.json'}[file];
  if(!name){res.writeHead(404).end();return;}
  try {res.setHeader('content-type',name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.css')?'text/css':'application/json');res.end(await readFile(`${root}/${name}`));}catch{res.writeHead(500).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let executable;
for(const dir of await readdir('/ms-playwright')) for(const suffix of ['chrome-linux64/chrome','chrome-linux/chrome']) {
  if(!dir.startsWith('chromium-'))continue;
  const file=`/ms-playwright/${dir}/${suffix}`;try{await access(file);executable=file;}catch{}
}
assert.ok(executable,'Pinned image must contain Chromium');
const browser=spawn(executable,['--headless','--no-sandbox','--disable-dev-shm-usage','--disable-background-networking','--remote-debugging-port=9222','--remote-debugging-address=127.0.0.1','--user-data-dir=/tmp/browser-profile','about:blank'],{stdio:'ignore'});
let socket,sequence=0;const pending=new Map();
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<100;i++){try{const value=await fn();if(value)return value;}catch{}await wait(100);}throw Error('BROWSER_DEADLINE');}
try {
  const tabs=await until(async()=>{const r=await fetch('http://127.0.0.1:9222/json/list',{signal:AbortSignal.timeout(500)});return r.ok?await r.json():null;});
  const tab=tabs.find(x=>x.type==='page');assert.ok(tab);
  socket=new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  socket.addEventListener('message',event=>{const m=JSON.parse(event.data);const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error('CDP_ERROR')):p.resolve(m.result);}});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP_TIMEOUT'));},5000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true});assert.ok(!r.exceptionDetails);return r.result.value;};
  await call('Page.enable');
  for(const width of [390,1280]){
    await call('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:false});
    await call('Page.navigate',{url:origin});
    await until(()=>evaluate('document.readyState === "complete" && !!document.querySelector("h1")'));
    const rendered=await evaluate(`(()=>{const h=document.querySelector('h1'),m=document.querySelector('main');return {title:document.title,heading:h.textContent,visible:h.getBoundingClientRect().height>0,styled:getComputedStyle(m).maxWidth!=='none',overflow:document.documentElement.scrollWidth>innerWidth+1,link:document.querySelector('a[href="health.json"]')?.href}})()`);
    assert.ok(rendered.title.trim()&&rendered.heading.trim()&&rendered.visible&&rendered.styled);
    assert.equal(rendered.overflow,false);assert.equal(rendered.link,`${origin}/health.json`);
    const screenshot=await call('Page.captureScreenshot',{format:'png'});assert.ok(Buffer.from(screenshot.data,'base64').length>1000);
    await evaluate('document.querySelector("a[href=\"health.json\"]").click()');
    await until(()=>evaluate('location.pathname === "/health.json" && document.readyState === "complete"'));
    const live=JSON.parse(await evaluate('document.querySelector("pre")?.textContent ?? document.body.innerText'));assert.deepEqual(live,manifest);
  }
  console.log(JSON.stringify({candidateSha:expected,browserPassed:true,viewports:[390,1280],identity:manifest.identity,scope:'isolated rendering and identity link; not live deployment recovery'}));
} finally {
  socket?.close();for(const p of pending.values())clearTimeout(p.timer);
  browser.kill('SIGKILL');await new Promise(resolve=>server.close(resolve));
}
