import {api} from './github-api.mjs';
import {owner,ownerKey,repository,shouldPauseNewWork} from './control.mjs';
// Operator-reviewed evidence for the single lost dispatch acknowledgment.
// This never retries a write or treats the failed candidate as releasable.
export async function reconcileActivation(control) {
  const id='cadac609-5815-42b6-bb70-554c196f708e';
  const job=(await control.store.list(owner)).find(j=>j.id===id);
  if(job?.status==='failed'&&job.result?.reconciled===true)return;
  if(job?.status!=='unknown'||job.kind!=='build'||job.projectId!=='static-pilot'||job.reservedCents!==2)throw Error('RECONCILIATION_JOB_MISMATCH');
  const previous=await control.store.getCompletedJob(ownerKey,job.payload?.previousJobId);
  if(previous?.kind!=='discover'||previous.projectId!=='static-pilot'||previous.result?.evidence?.pipelineState?.finding?.baseSha!=='b3c8545ee38743dac7cdfdc268e436797d042f71')throw Error('RECONCILIATION_LINEAGE_MISMATCH');
  const worker=await api(control,'/actions/runs/42293467947');
  const candidate=await api(control,'/actions/runs/42293565576');
  for(const run of [worker,candidate])if(run.status!=='completed'||run.conclusion!=='failure'||run.run_attempt!==1||run.event!=='workflow_dispatch'||run.repository?.full_name!==repository||run.head_repository?.full_name!==repository)throw Error('RECONCILIATION_RUN_NOT_TERMINAL');
  if(worker.id!==42293467947||candidate.id!==42293565576||worker.head_branch!=='main'||worker.path!=='.github/workflows/worker.yml'||worker.head_sha!=='b3c8545ee38743dac7cdfdc268e436797d042f71'||candidate.path!=='.github/workflows/candidate.yml'||candidate.head_sha!=='b0ff3933083d82efbbd6c502cf6aa9b3b1e27b2a'||candidate.head_branch!=='factory/b3c8545ee38743dac7cdfdc268e436797d042f71-b4a34c1cb9c00ba4784e9ddd24fc5b5e51ad1d5cf52ca5434a04d0316a070f19')throw Error('RECONCILIATION_IDENTITY_MISMATCH');
  const releases=await api(control,`/actions/workflows/release.yml/runs?per_page=100&created=${encodeURIComponent('>='+job.createdAt)}`);
  if(releases.total_count!==0||releases.workflow_runs.length!==0)throw Error('RECONCILIATION_RELEASE_MUST_BE_ABSENT');
  // Model returned before this immutable candidate existed. Both workers are
  // stopped. Charge the full reserved upper bound, never an invented zero.
  await control.store.reconcile(owner,id,{actualCostCents:2,executionStopped:true,reason:'Operator verified stopped worker 42293467947 and failed candidate checks 42293565576; no publication. Conservative charge of full two-cent reservation.'});
  const state=await control.store.status(owner);
  if(!shouldPauseNewWork(state,control.now()))await control.store.setPaused(owner,false);
}
