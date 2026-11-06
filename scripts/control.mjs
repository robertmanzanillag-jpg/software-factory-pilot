import {hkdfSync,createHash,randomUUID} from 'node:crypto';
import {createGitHubFactoryStateTransport,createSoftwareFactoryObjectStore,createFactoryPilotGitHubClient} from './factory-core.mjs';
export const repository='robertmanzanillag-jpg/software-factory-pilot';
export const owner='software-factory-pilot-v1';
export const ownerKey=createHash('sha256').update(owner).digest('hex');
export const creditPolicy=Object.freeze({ceilingCents:100,stopNewWorkAtCents:95,validUntil:'2026-11-20T00:00:00Z'});
export function shouldPauseNewWork(status,now=new Date()) {
  if(!status.configured || ![status.fixedCents,status.spentCents,status.reservedCents].every(x=>Number.isSafeInteger(x)&&x>=0))return true;
  return now.getTime()>=Date.parse(creditPolicy.validUntil) || status.fixedCents+status.spentCents+status.reservedCents>=creditPolicy.stopNewWorkAtCents;
}
export async function openControl({env=process.env,request=fetch,now=()=>new Date()}={}) {
  if(env.GITHUB_REPOSITORY!==repository || env.GITHUB_REF!=='refs/heads/main' || !env.OPENAI_API_KEY || !env.GITHUB_TOKEN)throw Error('TRUSTED_CONTROLLER_REQUIRED');
  const key=env.OPENAI_API_KEY,token=env.GITHUB_TOKEN;
  let remaining=Infinity;
  let stageDeadline=Infinity;
  let stageSignal;
  const github=async(url,init={})=>{
    const root=`https://api.github.com/repos/${repository}`;
    if(url!==root && !url.startsWith(root+'/') && !url.startsWith(root+'?'))throw Error('UNAUTHORIZED_GITHUB_TARGET');
    const headers=new Headers(init.headers);headers.set('Authorization',`Bearer ${token}`);
    const response=await request(url,{...init,headers,redirect:'error'});
    const quota=response.headers.get('x-ratelimit-remaining');
    if(quota!==null&&/^[0-9]+$/.test(quota))remaining=Number(quota);
    return response;
  };
  const before=now().getTime();
  const clock=await github(`https://api.github.com/repos/${repository}?clock=${randomUUID()}`,{signal:AbortSignal.timeout(10000),cache:'no-store'});
  const server=Date.parse(clock.headers.get('date')??'');await clock.body?.cancel();
  const after=now().getTime();
  if(clock.status!==200 || !Number.isFinite(server) || after-before>10000 || Math.abs(after-server)>10000)throw Error('CLOCK_NOT_VERIFIED');
  const derived=new Uint8Array(hkdfSync('sha256',key,'factory-pilot-state-v1',repository,32));
  const transport=createGitHubFactoryStateTransport({repository,key:derived,request:github});
  const probe=createGitHubFactoryStateTransport({repository,key:derived,request:github,object:'transport-probe'});
  const store=createSoftwareFactoryObjectStore({transport,ledgerId:'github-pilot-ledger-v1',now,maxClockSkewMs:10000});
  const bounded=(init={})=>{
    if(!Number.isFinite(stageDeadline))return init;
    const remaining=stageDeadline-now().getTime();if(remaining<=0)throw Error('STAGE_DEADLINE');
    const signal=AbortSignal.timeout(Math.ceil(remaining));
    return {...init,signal:init.signal?AbortSignal.any([init.signal,signal]):signal};
  };
  const boundedGithub=(url,init)=>github(url,bounded(init));
  const client=createFactoryPilotGitHubClient({request:boundedGithub,allowDispatch:true});
  const modelRequest=async(url,init)=>{
    if(!['https://api.openai.com/v1/responses','https://api.openai.com/v1/responses/input_tokens'].includes(url))throw Error('UNAUTHORIZED_MODEL_TARGET');
    const headers=new Headers(init.headers);headers.set('Authorization',`Bearer ${key}`);
    return request(url,{...bounded(init),headers,redirect:'error'});
  };
  const publicRequest=(url,init)=>{
    const target=new URL(url);
    if(target.origin!=='https://robertmanzanillag-jpg.github.io'||!target.pathname.startsWith('/software-factory-pilot/'))throw Error('PUBLIC_TARGET_NOT_ALLOWED');
    return request(url,{...bounded(init),redirect:'error'});
  };
  return {store,client,github:boundedGithub,modelRequest,publicRequest,now,remainingRequests:()=>remaining,stageSignal:()=>stageSignal,setStageDeadline:milliseconds=>{stageDeadline=now().getTime()+milliseconds;stageSignal=AbortSignal.timeout(milliseconds);},clearStageDeadline:()=>{stageDeadline=Infinity;stageSignal=undefined;},async bootstrap(){
    const record=await probe.read();if(!record)throw Error('PROBE_ACCOUNTING_REQUIRED');
    const data=JSON.parse(record.body);
    if(data.version!==1||!Array.isArray(data.calls)||data.calls.some(c=>!['completed','failed','blocked'].includes(c.status)||!Number.isSafeInteger(c.costCents)||c.costCents<0))throw Error('PRIOR_COST_UNKNOWN');
    const prior=data.calls.reduce((n,c)=>n+c.costCents,0);if(prior>=creditPolicy.stopNewWorkAtCents)throw Error('CREDIT_ALLOWANCE_EXHAUSTED');
    await store.initializeStore();
    await store.initializeMonth(owner,now().toISOString().slice(0,7),prior);
    if(!(await store.projects(owner)).length)await store.saveProject(owner,{id:'static-pilot',repo:repository,testCommand:'isolated candidate tests',buildCommand:'trusted static artifact build',stagingUrl:'https://robertmanzanillag-jpg.github.io/software-factory-pilot/staging/',productionUrl:'https://robertmanzanillag-jpg.github.io/software-factory-pilot/',healthUrl:'https://robertmanzanillag-jpg.github.io/software-factory-pilot/health.json',rollbackCommand:'restore exact immutable baseline',journeys:['page-render','identity-link'],automaticRelease:false,providerSupportsRelease:false,providerSupportsRollback:false,rehearsalRunIds:[]});
    return store.status(owner);
  }};
}
