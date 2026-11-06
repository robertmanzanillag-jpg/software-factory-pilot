import {openControl,owner,ownerKey,shouldPauseNewWork} from './control.mjs';
import {createPilotRuntime} from './runtime.mjs';
import {currentFactoryProductionDeployment} from './factory-core.mjs';
const control=await openControl();
const mode=process.argv[2];
if(!['activate','run','status'].includes(mode))throw Error('WORKER_MODE_INVALID');
if(mode==='activate')await control.bootstrap();
const state=await control.store.status(owner);
if(mode==='status')console.log(JSON.stringify({configured:state.configured,paused:state.paused,spentCents:state.spentCents,reservedCents:state.reservedCents,priorCostsCents:state.fixedCents}));
else {
  const runtime=await createPilotRuntime(control);
  if(mode==='activate') {
    if(shouldPauseNewWork(state,control.now()))throw Error('CREDIT_ADMISSION_BLOCKED');
    await control.store.configureProjectExecution(ownerKey,'static-pilot',{release:true,rollback:true,automaticRelease:false});
    await control.store.setPaused(owner,false);
  }
  const deadline=Date.now()+20*60*1000;
  let maintaining=false,maintenanceError=false;
  const timer=setInterval(async()=>{if(maintaining)return;maintaining=true;try{await runtime.worker.maintain();}catch{maintenanceError=true;runtime.worker.stop();}finally{maintaining=false;}},30000);
  try {
    for(let i=0;i<48 && Date.now()<deadline && !maintenanceError;i++) {
      if(control.remainingRequests()<350)break;
      const status=await control.store.status(owner);
      if(shouldPauseNewWork(status,control.now())&&!status.paused)await control.store.setPaused(owner,true);
      const projects=await control.store.projects(owner),project=projects.find(p=>p.id==='static-pilot');
      if(!project)throw Error('PILOT_PROJECT_REQUIRED');
      let jobs=await control.store.list(owner);
      const releases=await control.store.releaseHistory(owner,project.id);
      if(!status.paused && !shouldPauseNewWork(status,control.now()) && !jobs.some(j=>['pending','running','unknown'].includes(j.status))) {
        if(project.rehearsalRunIds.length>=3&&!project.automaticRelease)await control.store.configureProjectExecution(ownerKey,project.id,{release:true,rollback:true,automaticRelease:true});
        const everProduction=releases.some(j=>j.kind==='deploy'&&j.status==='completed'&&j.result?.evidence?.pipelineState?.target==='production');
        const key=everProduction?`daily:${project.id}:${control.now().toISOString().slice(0,10)}`:`activation:${project.id}:${project.rehearsalRunIds.length}`;
        if(!jobs.some(j=>j.key===key))await control.store.enqueue(owner,{key,projectId:project.id,kind:'discover',reservedCents:1,payload:{source:'trusted-controller'}});
        jobs=await control.store.list(owner);
      }
      jobs=await control.store.list(owner);
      if(status.configured&&!jobs.some(j=>['running','unknown'].includes(j.status)||(j.status==='pending'&&(!status.paused||['verify','rollback'].includes(j.kind))))) {
        const production=currentFactoryProductionDeployment(releases,project.id);
        if(production) {
          const healthKey=`${production.id}.health:${control.now().toISOString().slice(0,13)}`;
          if(!jobs.some(j=>j.key===healthKey))await control.store.enqueue(owner,{key:healthKey,projectId:project.id,kind:'verify',headSha:production.headSha,reservedCents:2,recoveryCents:1,payload:{previousJobId:production.id}});
        }
      }
      jobs=await control.store.list(owner);
      if(!jobs.some(j=>j.status==='pending'||j.status==='running'||j.status==='unknown'))break;
      const result=await runtime.tick();
      if(['quarantined','idle'].includes(result.kind))break;
      if(result.kind==='retry')break;
    }
  } finally {clearInterval(timer);runtime.worker.stop();}
  const result=await control.store.status(owner),jobs=await control.store.list(owner);
  console.log(JSON.stringify({paused:result.paused,spentCents:result.spentCents,reservedCents:result.reservedCents,priorCostsCents:result.fixedCents,jobs:jobs.slice(0,12).map(j=>({id:j.id,kind:j.kind,status:j.status,reason:j.result?.reason}))}));
  if(maintenanceError||jobs.some(j=>j.status==='unknown'))process.exitCode=1;
}
