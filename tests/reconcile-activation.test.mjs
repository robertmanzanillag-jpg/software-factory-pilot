import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileActivation} from '../scripts/reconcile-activation.mjs';
import {owner,ownerKey,repository} from '../scripts/control.mjs';
const id='cadac609-5815-42b6-bb70-554c196f708e';
const base='b3c8545ee38743dac7cdfdc268e436797d042f71';
function fixture(){
  const writes=[],reads=[];
  const job={id,ownerKey,projectId:'static-pilot',status:'unknown',kind:'build',reservedCents:2,createdAt:'2026-11-06T12:00:00Z',payload:{previousJobId:'discovery-fixture'}};
  const common={status:'completed',conclusion:'failure',run_attempt:1,event:'workflow_dispatch',repository:{full_name:repository},head_repository:{full_name:repository}};
  const worker={...common,id:42293467947,path:'.github/workflows/worker.yml',head_branch:'main',head_sha:base};
  const candidate={...common,id:42293565576,path:'.github/workflows/candidate.yml',head_sha:'b0ff3933083d82efbbd6c502cf6aa9b3b1e27b2a',head_branch:`factory/${base}-b4a34c1cb9c00ba4784e9ddd24fc5b5e51ad1d5cf52ca5434a04d0316a070f19`};
  const releases={total_count:0,workflow_runs:[]};
  const predecessor={id:'discovery-fixture',ownerKey,projectId:'static-pilot',kind:'discover',status:'completed',result:{evidence:{pipelineState:{version:1,projectId:'static-pilot',finding:{baseSha:base}}}}};
  const state={configured:true,fixedCents:0,spentCents:5,reservedCents:0};
  const control={now:()=>new Date('2026-11-06T15:00:00Z'),store:{
    list:async who=>{assert.equal(who,owner);return [job];},
    getCompletedJob:async()=>predecessor,
    reconcile:async(...args)=>writes.push(['reconcile',...args]),status:async()=>state,setPaused:async(...args)=>writes.push(['pause',...args]),
  },github:async(url,init)=>{assert.equal(init.method,'GET');reads.push(url);const value=url.endsWith('/42293467947')?worker:url.endsWith('/42293565576')?candidate:releases;return new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});}};
  return {job,worker,candidate,releases,predecessor,state,writes,reads,control};
}
test('exact stopped worker and failed candidate settle full reservation once, then respect credit pause',async()=>{
 for(const spent of [5,95]){
  const f=fixture();f.state.spentCents=spent;await reconcileActivation(f.control);
  const settlement=f.writes[0];assert.deepEqual(settlement.slice(0,3),['reconcile',owner,id]);
  assert.equal(settlement[3].actualCostCents,2);assert.equal(settlement[3].executionStopped,true);
  assert.equal(f.writes.length,spent===5?2:1);
  if(spent===5)assert.deepEqual(f.writes[1],['pause',owner,false]);
  f.job.status='failed';f.job.result={reconciled:true};f.writes.length=0;f.reads.length=0;
  await reconcileActivation(f.control);assert.deepEqual(f.writes,[]);assert.deepEqual(f.reads,[]);
 }
});
test('unproven execution or any publication blocks settlement and unpause',async()=>{
 const mutations=[f=>f.job.projectId="other",f=>f.worker.id=1,f=>f.candidate.id=1,f=>f.worker.event="push",f=>f.candidate.event="push",f=>f.worker.head_branch="other",f=>f.predecessor.kind="build",f=>f.predecessor.projectId="other",f=>f.predecessor.result.evidence.pipelineState.finding.baseSha="a".repeat(40),f=>f.job.reservedCents=1,f=>f.job.status='running',f=>f.worker.status='in_progress',f=>f.candidate.conclusion='success',f=>f.candidate.run_attempt=2,f=>f.worker.repository={full_name:'other/repo'},f=>f.candidate.head_sha='a'.repeat(40),f=>f.candidate.head_branch='main',f=>f.releases.total_count=1,f=>f.releases.workflow_runs=[{id:1}]];
 for(const mutate of mutations){const f=fixture();mutate(f);await assert.rejects(reconcileActivation(f.control));assert.deepEqual(f.writes,[]);}
});
