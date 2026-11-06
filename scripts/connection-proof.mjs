import assert from 'node:assert/strict';
import {hkdfSync,randomUUID} from 'node:crypto';
import {createGitHubFactoryStateTransport} from './github-state.mjs';
import {createOpenAiFactoryTextProvider} from './openai-provider.mjs';

const repository='robertmanzanillag-jpg/software-factory-pilot';
const key=process.env.OPENAI_API_KEY, token=process.env.GITHUB_TOKEN;
if(process.env.GITHUB_REPOSITORY!==repository || process.env.GITHUB_REF!=='refs/heads/main' || !key || !token) throw Error('TRUSTED_PILOT_CONTEXT_REQUIRED');
const derived=new Uint8Array(hkdfSync('sha256',key,'factory-pilot-state-v1',repository,32));
const authRequest=async(url,init)=>{
 if(!url.startsWith(`https://api.github.com/repos/${repository}/`) && url!==`https://api.github.com/repos/${repository}`) throw Error('UNEXPECTED_GITHUB_DESTINATION');
 const headers=new Headers(init.headers);headers.set('Authorization',`Bearer ${token}`);
 return fetch(url,{...init,headers});
};
const transport=createGitHubFactoryStateTransport({repository,key:derived,request:authRequest,object:'transport-probe'});
async function snapshot() {
 const current=await transport.read();
 if(!current) throw Error('PROBE_STATE_MISSING');
 const data=JSON.parse(current.body);
 if(data.version!==1 || !Array.isArray(data.calls) || data.calls.length>64) throw Error('PROBE_STATE_INVALID');
 return {...current,data};
}
const mode=process.argv[2];
if(mode==='storage') {
 const current=await transport.read();
 if(!current) assert.equal((await transport.compareAndSwap(null,JSON.stringify({version:1,calls:[],proof:null}))).kind,'written');
 const s=await snapshot();
 const markers=[randomUUID(),randomUUID()];
 const attempts=await Promise.all(markers.map(marker=>transport.compareAndSwap(s.generation,JSON.stringify({...s.data,proof:marker}))));
 assert.equal(attempts.filter(x=>x.kind==='written').length,1);
 assert.equal(attempts.filter(x=>x.kind==='conflict').length,1);
 const winner=await snapshot(); assert.ok(markers.includes(winner.data.proof));
 assert.equal((await transport.compareAndSwap(s.generation,s.body)).kind,'conflict');
 const marker=randomUUID();
 const ambiguous=createGitHubFactoryStateTransport({repository,key:derived,object:'transport-probe',request:async(url,init)=>{
   const response=await authRequest(url,init);
   if(init.method==='PUT' && response.ok) {await response.body?.cancel();throw Error('simulated lost acknowledgement');}
   return response;
 }});
 await assert.rejects(ambiguous.compareAndSwap(winner.generation,JSON.stringify({...winner.data,proof:marker})),/UNCONFIRMED/);
 assert.equal((await snapshot()).data.proof,marker);
 console.log('PASS: encrypted persistence, concurrent CAS, stale write rejection and lost acknowledgement reconciliation.');
} else if(mode==='restart') {
 const s=await snapshot();assert.match(s.data.proof,/^[a-f0-9-]{36}$/);
 console.log('PASS: a new process decrypted the persisted state.');
} else if(mode==='model') {
 const id=process.env.GITHUB_RUN_ID;
 if(!/^[0-9]+$/.test(id||''))throw Error('RUN_ID_REQUIRED');
 const s=await snapshot();
 if(s.data.calls.some(c=>c.id===id) || s.data.calls.length>=64)throw Error('PROBE_ALREADY_RESERVED_OR_LIMIT_REACHED');
 if(s.data.calls.some(c=>c.status==='reserved'))throw Error('PRIOR_UNKNOWN_COST_REQUIRES_RECONCILIATION');
 const next={...s.data,calls:[...s.data.calls,{id,status:'reserved',reservedCents:1}]};
 const reserved=await transport.compareAndSwap(s.generation,JSON.stringify(next));
 if(reserved.kind!=='written')throw Error('RESERVATION_CONFLICT');
 const model=createOpenAiFactoryTextProvider({model:'gpt-4.1-mini-2025-04-14',inputNanoUsdPerToken:400,outputNanoUsdPerToken:1600,pricingValidUntil:'2026-11-07T00:00:00Z',maxInputTokens:256,now:()=>new Date(),timeoutMs:30000,request:async(url,init)=>{
   if(!['https://api.openai.com/v1/responses','https://api.openai.com/v1/responses/input_tokens'].includes(url))throw Error('UNEXPECTED_MODEL_DESTINATION');
   const headers=new Headers(init.headers);headers.set('Authorization',`Bearer ${key}`);return fetch(url,{...init,headers});
 }});
 const result=await model({instructions:'Reply exactly READY.',text:'Connectivity test.',maxOutputTokens:16,maxCostCents:1,signal:AbortSignal.timeout(40000)});
 if(result.status==='unknown')throw Error('UNKNOWN_MODEL_OUTCOME_RESERVATION_RETAINED');
 next.calls.at(-1).status=result.status;
 next.calls.at(-1).costCents=result.costCents;
 const settled=await transport.compareAndSwap(reserved.generation,JSON.stringify(next));
 if(settled.kind!=='written')throw Error('SETTLEMENT_UNCONFIRMED');
 if(result.status!=='completed' || result.text.trim()!=='READY')throw Error('MODEL_CONNECTION_NOT_VERIFIED');
 console.log('PASS: Responses completed from GitHub with durable pre-reservation; no retries or external billing setup.');
} else throw Error('UNKNOWN_PROBE_MODE');
