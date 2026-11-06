import {mkdir,writeFile,readFile,cp} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {openControl,owner,ownerKey} from './control.mjs';
import {releaseGate,rehearsalGate} from './factory-core.mjs';
import {prepareReleaseArtifacts} from './release.mjs';
import {api} from './github-api.mjs';

export async function authorizeRelease(control,input,minimumLeaseMs=180000) {
  const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  if(!Number.isSafeInteger(minimumLeaseMs)||minimumLeaseMs<180000||minimumLeaseMs>480000||!uuid.test(input.jobId)||!/^[a-f0-9]{40}$/.test(input.baseSha)||!/^[a-f0-9]{40}$/.test(input.headSha)||!['staging','production'].includes(input.target)||!['deploy','rollback'].includes(input.operation))throw Error('RELEASE_INPUT_INVALID');
  const job=(await control.store.list(owner)).find(j=>j.id===input.jobId);
  const lease=Date.parse(job?.leaseExpiresAt),now=control.now().getTime();
  if(!job||job.status!=='running'||job.kind!==input.operation||job.headSha!==input.headSha||job.projectId!=='static-pilot'||job.ownerKey!==ownerKey||!uuid.test(job.fence??'')||!Number.isFinite(lease)||!Number.isFinite(now)||lease-now<minimumLeaseMs)throw Error('RELEASE_JOB_NOT_AUTHORIZED');
  const previous=await control.store.getCompletedJob(ownerKey,job.payload.previousJobId);
  const state=previous?.result?.evidence?.pipelineState;
  if(!previous||job.key!==`${previous.id}.next`||previous.projectId!==job.projectId||previous.kind!==(input.operation==='deploy'?'review':'verify')||!state||state.projectId!==job.projectId||state.candidate?.baseSha!==input.baseSha||state.candidate?.headSha!==input.headSha||state.target!==input.target)throw Error('RELEASE_LINEAGE_INVALID');
  const project=await control.store.projectByOwnerKey(ownerKey,job.projectId);
  if(project?.repo!=='robertmanzanillag-jpg/software-factory-pilot')throw Error('RELEASE_PROJECT_INVALID');
  if(input.operation==='deploy') {
    if(job.recoveryCents<2)throw Error('RECOVERY_RESERVATION_REQUIRED');
    const gate=(input.target==='staging'?rehearsalGate:releaseGate)(project,state.candidate,state.evidence,control.now().getTime());
    if(!gate.allowed)throw Error('RELEASE_GATE_BLOCKED');
  } else if(!state.deployment||state.deployment.headSha!==input.headSha||!state.verification)throw Error('RECOVERY_LINEAGE_INVALID');
  return {fence:job.fence,jobId:job.id,leaseExpiresAt:job.leaseExpiresAt};
}
export async function syncAuthorizedProductionRef(control,input) {
  await authorizeRelease(control,input);
    if(input.target==='production') {
      const ref=await api(control,'/git/ref/heads/main');
      if(ref.ref!=='refs/heads/main'||ref.object?.type!=='commit')throw Error('MAIN_IDENTITY_INVALID');
      let desired=input.headSha;
      if(input.operation==='deploy' && ![input.baseSha,input.headSha].includes(ref.object.sha))throw Error('MAIN_MOVED_OUTSIDE_RELEASE');
      if(input.operation==='rollback') {
        const base=await api(control,`/git/commits/${input.baseSha}`);
        if(ref.object.sha===input.baseSha)desired=input.baseSha;
        else if(ref.object.sha===input.headSha) {
          const recovery=await api(control,'/git/commits',{method:'POST',expected:201,body:{tree:base.tree.sha,parents:[input.headSha],message:`Factory recovery ${input.jobId}`}});
          if(!/^[a-f0-9]{40}$/.test(recovery.sha)||recovery.tree?.sha!==base.tree.sha||recovery.parents?.length!==1||recovery.parents[0].sha!==input.headSha)throw Error('RECOVERY_COMMIT_UNCONFIRMED');
          desired=recovery.sha;
        } else {
          const existing=await api(control,`/git/commits/${ref.object.sha}`);
          if(existing.message!==`Factory recovery ${input.jobId}`||existing.tree?.sha!==base.tree.sha||existing.parents?.length!==1||existing.parents[0].sha!==input.headSha)throw Error('MAIN_MOVED_OUTSIDE_RELEASE');
          desired=existing.sha;
        }
      }
      if(ref.object.sha!==desired) {
        // Fast-forward only: concurrent unrelated changes cannot be overwritten.
        const result=await api(control,'/git/refs/heads/main',{method:'PATCH',body:{sha:desired,force:false}});
        if(result.ref!=='refs/heads/main'||result.object?.sha!==desired)throw Error('MAIN_UPDATE_UNCONFIRMED');
      }
    }
}
async function main() {
  const control=await openControl();
  const input={baseSha:process.env.RELEASE_BASE,headSha:process.env.RELEASE_HEAD,target:process.env.RELEASE_TARGET,operation:process.env.RELEASE_OPERATION,jobId:process.env.RELEASE_JOB};
  if(process.argv[2]==='build') {
    const authority=await authorizeRelease(control,input,480000);
    const artifact=await prepareReleaseArtifacts({...input,request:control.github});
    try {
      await mkdir('out',{recursive:true});await cp(artifact.directory,'out/release',{recursive:true,errorOnExist:true,force:false});
      await writeFile('out/release-authority.json',JSON.stringify({input,authority,rootManifest:artifact.rootManifest,stagingManifest:artifact.stagingManifest}),{flag:'wx'});
    } finally {await artifact.cleanup();}
  } else if(process.argv[2]==='authorize') {
    const saved=JSON.parse(await readFile('out/release-authority.json','utf8'));
    if(JSON.stringify(saved.input)!==JSON.stringify(input))throw Error('RELEASE_PLAN_CHANGED');
    const current=await authorizeRelease(control,input);
    if(current.fence!==saved.authority.fence||current.leaseExpiresAt!==saved.authority.leaseExpiresAt)throw Error('RELEASE_AUTHORITY_CHANGED');
    await syncAuthorizedProductionRef(control,input);
  } else throw Error('UNKNOWN_RELEASE_COMMAND');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
