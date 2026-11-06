import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createFactoryPilotGitHubSourceExporter,createResponsesFactoryWorker,createOpenAiFactoryTextProvider,createPilotIndependentReview,classifyPilotTextChange,createGitHubFactoryChecks} from './factory-core.mjs';
import {owner,ownerKey,repository,shouldPauseNewWork} from './control.mjs';
import {prepareReleaseArtifacts} from './release.mjs';
import {verify} from './site.mjs';
import {api} from './github-api.mjs';
const scope={owner:'robertmanzanillag-jpg',repo:'software-factory-pilot'};
const root='https://robertmanzanillag-jpg.github.io/software-factory-pilot/';
const wait=(ms,signal)=>new Promise((resolve,reject)=>{signal.throwIfAborted();const abort=()=>{clearTimeout(timer);reject(Error('ABORTED'));};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);signal.addEventListener('abort',abort,{once:true});});

export async function createPilotRuntime(control) {
  const {store,client,now}=control;
  const workflow=await api(control,'/actions/workflows/candidate.yml');
  if(workflow.path!=='.github/workflows/candidate.yml'||workflow.state!=='active'||!Number.isSafeInteger(workflow.id))throw Error('CANDIDATE_WORKFLOW_REQUIRED');
  const profile={trigger:'workflow_dispatch',workflowId:workflow.id,workflowPath:workflow.path,workflowSha256:createHash('sha256').update(await readFile('.github/workflows/candidate.yml')).digest('hex'),jobName:'isolated-checks',testStep:'Isolated tests',buildStep:'Isolated build',browserStep:'Isolated browser recovery tests'};
  const checks=createGitHubFactoryChecks({client,repositories:{[repository]:profile},now,maxPolls:25});
  const model={model:'gpt-4.1-mini-2025-04-14',inputNanoUsdPerToken:400,outputNanoUsdPerToken:1600,pricingValidUntil:'2026-11-20T00:00:00Z',maxInputTokens:12000,now,timeoutMs:90000,request:control.modelRequest};
  const generate=createOpenAiFactoryTextProvider(model);
  async function textAt(sha) {
    const m=(await client.repos.getContent({...scope,ref:sha,path:'site/index.html'})).data;
    if(m.encoding!=='base64'||typeof m.content!=='string'||m.size>100000)throw Error('REVIEW_BLOB_INVALID');
    const encoded=m.content.replace(/\n/g,''),bytes=Buffer.from(encoded,'base64');
    if(bytes.toString('base64')!==encoded||bytes.length!==m.size||createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')!==m.sha)throw Error('REVIEW_BLOB_MISMATCH');
    return new TextDecoder('utf8',{fatal:true}).decode(bytes);
  }
  async function source(candidate) {return {repository,baseSha:candidate.baseSha,headSha:candidate.headSha,changedFiles:candidate.changedFiles,baseline:await textAt(candidate.baseSha),candidate:await textAt(candidate.headSha)};}
  async function artifact(state,operation,jobId,signal) {return prepareReleaseArtifacts({baseSha:state.candidate.baseSha,headSha:state.candidate.headSha,target:state.target,operation,jobId,request:control.github,signal});}
  async function currentJob(kind,headSha) {
    const jobs=(await store.list(owner)).filter(j=>j.status==='running'&&j.kind===kind&&j.headSha===headSha);
    if(jobs.length!==1)throw Error('ACTIVE_STAGE_REQUIRED');return jobs[0];
  }
  async function publish(state,operation,signal) {
    const job=await currentJob(operation,state.candidate.headSha);
    const runName=`${operation}:${job.id}`;
    let dispatched=false;
    const workflowHash=createHash('sha256').update(await readFile('.github/workflows/release.yml')).digest('hex');
    for(let i=0;i<54;i++) {
      const data=await api(control,`/actions/workflows/release.yml/runs?event=workflow_dispatch&per_page=100&created=${encodeURIComponent('>='+job.createdAt)}`,{signal});
      if(!Array.isArray(data.workflow_runs)||data.total_count!==data.workflow_runs.length)throw Error('RELEASE_RUNS_INVALID');
      const matching=data.workflow_runs.filter(r=>r.display_title===runName);
      if(matching.length>1)throw Error('DUPLICATE_RELEASE_RUN');
      const run=matching[0];
      if(run) {
        if(!/^[a-f0-9]{40}$/.test(run.head_sha)||!Number.isSafeInteger(run.id)||run.html_url!==`https://github.com/${repository}/actions/runs/${run.id}`||run.head_branch!=='main'||run.event!=='workflow_dispatch'||run.run_attempt!==1||run.repository?.full_name!==repository||run.head_repository?.full_name!==repository||!['.github/workflows/release.yml','.github/workflows/release.yml@refs/heads/main'].includes(run.path))throw Error('RELEASE_RUN_IDENTITY_INVALID');
        const source=(await client.repos.getContent({...scope,ref:run.head_sha,path:'.github/workflows/release.yml'})).data;
        if(source.encoding!=='base64'||createHash('sha256').update(Buffer.from(source.content,'base64')).digest('hex')!==workflowHash)throw Error('RELEASE_WORKFLOW_CHANGED');
        if(run.status==='completed') {if(run.conclusion!=='success')throw Error('RELEASE_EXECUTION_UNCONFIRMED');return run.html_url;}
      } else if(!dispatched) {
        dispatched=true;
        await api(control,'/actions/workflows/release.yml/dispatches',{method:'POST',expected:204,signal,body:{ref:'main',inputs:{base_sha:state.candidate.baseSha,head_sha:state.candidate.headSha,target:state.target,operation,job_id:job.id}}});
      }
      await wait(10000,signal);
    }
    throw Error('RELEASE_EXECUTION_UNCONFIRMED');
  }
  const stages={
    async discover(project,context) {
      const baseSha=(await client.git.getRef({...scope,ref:'heads/main'})).data.object.sha;
      const count=project.rehearsalRunIds.length;
      const prior=(await store.releaseHistory(owner,project.id)).some(j=>j.kind==='deploy'&&j.status==='completed'&&j.result?.evidence?.pipelineState?.target==='production');
      if(count<3||!prior)return {costCents:0,finding:{id:count<3?`activation-rehearsal-${count+1}`:'activation-release',kind:'improvement',request:'Make exactly one small wording improvement in the existing h1 of site/index.html: replace "probar cada cambio" with "verificar cada cambio". Keep every HTML tag, attribute, warning and all other text unchanged. The pilot is not evidence of a complete general-purpose software factory. Return a minimal unified diff.',baseSha,artifactIds:[`https://github.com/${repository}/commit/${baseSha}`]}};
      const issues=await api(control,'/issues?state=open&labels=factory-approved&per_page=100',{signal:context.signal});
      const selected=issues.filter(i=>!i.pull_request&&i.user?.login==='robertmanzanillag-jpg'&&typeof i.body==='string'&&i.body.length<=4000);
      const job=await currentJob('discover',undefined);
      for(const issue of selected) {
        if(!Number.isSafeInteger(issue.number)||issue.number<1||issue.html_url!==`https://github.com/${repository}/issues/${issue.number}`)throw Error('ISSUE_IDENTITY_INVALID');
        // A task is admitted once across later revisions; the pipeline owns its
        // bounded repair attempts. Skip prior tasks without starving the next one.
        if(await store.claimFinding(ownerKey,project.id,`approved-issue:${issue.number}`,job.id))return {costCents:0,finding:{id:`issue-${issue.number}`,kind:'improvement',request:`Only plain text within existing HTML may change. Preserve tags, attributes and the pilot limitation notice.\n${issue.title}\n${issue.body}`,baseSha,artifactIds:[issue.html_url]}};
      }
      return {costCents:0};
    },
    async simulate(project,state,context) {
      const c=(await client.git.getCommit({...scope,commit_sha:state.candidate.headSha})).data;
      const match=/^Factory candidate ([a-f0-9]{64})$/.exec(c.message);
      if(!match)throw Error('CANDIDATE_COMMIT_REQUIRED');
      const result=await checks.verifyCandidate(project,{repository,baseSha:state.candidate.baseSha,headSha:state.candidate.headSha,patchSha256:match[1],branch:`factory/${state.candidate.baseSha}-${match[1]}`},context);
      if(result.status!=='passed')throw Error('SIMULATION_UNCONFIRMED');
      return {costCents:0,evidence:{kind:'simulation',projectId:project.id,baseSha:state.candidate.baseSha,headSha:state.candidate.headSha,passed:true,warnings:[],createdAt:result.createdAt,actorId:'github-isolated-baseline-candidate-browser',artifactIds:result.artifactIds,journeyIds:['page-render','identity-link'],baselineJourneyIds:['page-render','identity-link'],viewports:['mobile','desktop'],syntheticData:true,externalServicesMocked:true}};
    },
    review:createPilotIndependentReview({load:source,generate,now}),
    async deploy(project,state,context) {return {costCents:0,deployment:{id:await publish(state,'deploy',context.signal),headSha:state.candidate.headSha,target:state.target}};},
    async verify(project,state,context) {
      const job=await currentJob('verify',state.candidate.headSha),a=await artifact(state,'deploy',job.id,context.signal);
      try {await verify({base:root,manifest:a.rootManifest,request:control.publicRequest,signal:AbortSignal.any([context.signal,control.stageSignal()].filter(Boolean))});await verify({base:root+'staging/',manifest:a.stagingManifest,request:control.publicRequest,signal:AbortSignal.any([context.signal,control.stageSignal()].filter(Boolean))});return {costCents:0,verification:{healthy:true,headSha:state.candidate.headSha}};}
      catch {return {costCents:0,verification:{healthy:false,headSha:state.candidate.headSha}};}finally{await a.cleanup();}
    },
    async rollback(project,state,context) {
      const job=await currentJob('rollback',state.candidate.headSha);await publish(state,'rollback',context.signal);
      const a=await artifact(state,'rollback',job.id,context.signal);
      try {await verify({base:root,manifest:a.rootManifest,request:control.publicRequest,signal:AbortSignal.any([context.signal,control.stageSignal()].filter(Boolean))});await verify({base:root+'staging/',manifest:a.stagingManifest,request:control.publicRequest,signal:AbortSignal.any([context.signal,control.stageSignal()].filter(Boolean))});return {costCents:0,rollback:{healthy:true,restoredSha:state.candidate.baseSha}};}finally{await a.cleanup();}
    },
    async evaluate() {return {costCents:0,changesPolicy:false,cases:[]};},
  };
  const worker=await createResponsesFactoryWorker({model,sourcePaths:{[repository]:['site/index.html']},maxOutputTokens:2048,github:{exportSource:createFactoryPilotGitHubSourceExporter(client),publisherClient:client,actionsClient:client,repositories:{[repository]:{baseBranch:'main',checks:profile}},publicationCostCents:0,now,maxPolls:25,classifyCandidate:async candidate=>{
    const a=await prepareReleaseArtifacts({baseSha:candidate.baseSha,headSha:candidate.headSha,target:'staging',operation:'rollback',jobId:randomUUID(),request:control.github});
    try{return classifyPilotTextChange(await source(candidate),{baseSha:candidate.baseSha,artifactSha256:a.rootManifest.identity,verified:true});}finally{await a.cleanup();}
  }},runtime:{owner,store,now,reservations:{discover:1,build:2,simulate:1,review:2,deploy:1,verify:1,rollback:1,evaluate:1},stages}});
  return {worker,async tick(){
    if(shouldPauseNewWork(await store.status(owner),now()))await store.setPaused(owner,true);
    control.setStageDeadline(540000);
    try{return await worker.tick();}finally{control.clearStageDeadline();}
  }};
}


