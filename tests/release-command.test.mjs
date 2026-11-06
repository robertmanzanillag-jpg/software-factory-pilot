import test from 'node:test';
import assert from 'node:assert/strict';
import {authorizeRelease,syncAuthorizedProductionRef} from '../scripts/release-command.mjs';
import {ownerKey,repository} from '../scripts/control.mjs';
function fixture(operation='deploy') {
  const baseSha='a'.repeat(40),headSha='b'.repeat(40),jobId='11111111-1111-4111-8111-111111111111',priorId='22222222-2222-4222-8222-222222222222';
  const project={id:'static-pilot',repo:repository,testCommand:'tests',buildCommand:'build',rollbackCommand:'restore',stagingUrl:'https://example.test/staging',productionUrl:'https://example.test/',healthUrl:'https://example.test/health',journeys:['page-render'],automaticRelease:false,providerSupportsRelease:true,providerSupportsRollback:true,rehearsalRunIds:[]};
  const candidate={projectId:project.id,baseSha,headSha,prUrl:`https://github.com/${repository}/pull/1`,builderId:'builder',risk:'low',reversible:true,changedFiles:['site/index.html'],affectsContracts:false,affectsData:false};
  const evidence=['tests','simulation','review'].map(kind=>({projectId:project.id,baseSha,headSha,kind,passed:true,warnings:[],createdAt:'2026-11-06T12:00:00Z',actorId:'checker',artifactIds:['proof'],journeyIds:['page-render'],baselineJourneyIds:['page-render'],viewports:['mobile','desktop'],syntheticData:true,externalServicesMocked:true}));
  const state={projectId:project.id,candidate,evidence,target:'staging',deployment:{id:'run',headSha,target:'staging'},verification:{healthy:false,headSha}};
  const prior={id:priorId,status:'completed',kind:operation==='deploy'?'review':'verify',projectId:project.id,result:{evidence:{pipelineState:state}}};
  const job={id:jobId,status:'running',kind:operation,headSha,projectId:project.id,ownerKey,fence:jobId,leaseExpiresAt:'2026-11-06T12:10:00Z',key:`${priorId}.next`,payload:{previousJobId:priorId},recoveryCents:2};
  const control={now:()=>new Date('2026-11-06T12:01:00Z'),store:{list:async()=>[job],getCompletedJob:async()=>prior,projectByOwnerKey:async()=>project}};
  return {control,job,prior,state,project,input:{baseSha,headSha,target:'staging',operation,jobId}};
}
test('deployment requires exact active lineage, review gate and recovery budget',async()=>{
  const f=fixture();assert.equal((await authorizeRelease(f.control,f.input)).fence,f.job.fence);
  for(const change of [f=>f.job.leaseExpiresAt='invalid',f=>f.job.status='completed',f=>f.job.recoveryCents=0,f=>f.state.evidence[2].passed=false,f=>f.project.repo='owner/kong',f=>f.job.headSha='c'.repeat(40)]){
    const x=fixture();change(x);await assert.rejects(authorizeRelease(x.control,x.input));
  }
});
test('rollback remains available without fresh release permission but needs deployment lineage',async()=>{
  const f=fixture('rollback');f.state.evidence=[];f.project.automaticRelease=false;
  assert.ok(await authorizeRelease(f.control,f.input));
  delete f.state.deployment;await assert.rejects(authorizeRelease(f.control,f.input));
});

function production(operation='deploy',main) {
 const f=fixture(operation),calls=[];f.input.target=f.state.target=f.state.deployment.target='production';
 f.project.automaticRelease=true;f.project.rehearsalRunIds=['r1','r2','r3'];f.project.rollbackVerifiedAt='2026-11-06T12:00:00Z';
 const tree='c'.repeat(40),recovery='d'.repeat(40);
 f.control.github=async(url,init)=>{
   const route=new URL(url).pathname.split('/software-factory-pilot')[1],body=init.body?JSON.parse(init.body):undefined;
   calls.push({route,method:init.method,body});
   if(route==='/git/ref/heads/main')return Response.json({ref:'refs/heads/main',object:{type:'commit',sha:main??f.input.baseSha}});
   if(route===`/git/commits/${f.input.baseSha}`)return Response.json({sha:f.input.baseSha,tree:{sha:tree}});
   if(route==='/git/commits'&&init.method==='POST')return Response.json({sha:recovery,tree:{sha:tree},parents:[{sha:f.input.headSha}]},{status:201});
   if(route==='/git/refs/heads/main')return Response.json({ref:'refs/heads/main',object:{sha:body.sha}});
   return Response.json({sha:main,message:'unrelated',tree:{sha:tree},parents:[]});
 };
 return {...f,calls,tree,recovery};
}
test('authorized production deploy advances main only by non-forced fast-forward',async()=>{
 const f=production();await syncAuthorizedProductionRef(f.control,f.input);
 assert.deepEqual(f.calls.map(x=>x.method),['GET','PATCH']);
 assert.deepEqual(f.calls[1].body,{sha:f.input.headSha,force:false});
});
test('rollback creates the exact baseline tree atop candidate and fast-forwards once',async()=>{
 const f=production('rollback','b'.repeat(40));await syncAuthorizedProductionRef(f.control,f.input);
 assert.deepEqual(f.calls.map(x=>x.method),['GET','GET','POST','PATCH']);
 assert.deepEqual(f.calls[2].body,{tree:f.tree,parents:[f.input.headSha],message:`Factory recovery ${f.input.jobId}`});
 assert.deepEqual(f.calls[3].body,{sha:f.recovery,force:false});
});
test('unrelated main changes reject without mutation and invalid ledger rejects before API',async()=>{
 for(const operation of ['deploy','rollback']){
   const f=production(operation,'e'.repeat(40));await assert.rejects(syncAuthorizedProductionRef(f.control,f.input),/MAIN_MOVED_OUTSIDE_RELEASE/);
   assert.ok(f.calls.every(x=>x.method==='GET'));
 }
 for(const change of [f=>f.job.leaseExpiresAt='2026-11-06T12:02:00Z',f=>f.job.status='completed',f=>f.job.key='spoof',f=>f.state.evidence[2].passed=false]){
   const f=production();change(f);await assert.rejects(syncAuthorizedProductionRef(f.control,f.input));assert.equal(f.calls.length,0);
 }
});
test('uncertain main update is not retried or forced',async()=>{
 const f=production(),request=f.control.github;
 f.control.github=async(url,init)=>{const result=await request(url,init);if(init.method==='PATCH')throw Error('connection lost');return result;};
 await assert.rejects(syncAuthorizedProductionRef(f.control,f.input),/connection lost/);
 assert.equal(f.calls.filter(x=>x.method==='PATCH').length,1);assert.equal(f.calls.at(-1).body.force,false);
});
