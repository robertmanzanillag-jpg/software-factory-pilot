import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const fail=()=>{throw Error('ASISTENTE_CLOUD_CONFIGURATION_UNVERIFIED');};
const json=(value)=>{if(typeof value!=='string'||Buffer.byteLength(value)>65536)fail();try{return JSON.parse(value);}catch{fail();}};
export function validateCloudInputs(env,now=Date.now()){
  if(env.GITHUB_REPOSITORY!=='robertmanzanillag-jpg/software-factory-pilot'||env.GITHUB_REF!=='refs/heads/main'||!['schedule','workflow_dispatch'].includes(env.GITHUB_EVENT_NAME))fail();
  const operator=json(env.ASISTENTE_OPERATOR_JSON),credit=json(env.ASISTENTE_CREDIT_JSON);
  if(operator.projectId!=='asistente'||operator.baseBranch!=='codex/office-integrated-repair-20261106'||typeof operator.owner!=='string'||!operator.owner.trim()||operator.owner.length>200||/[\r\n\0]/.test(operator.owner))fail();
  if(JSON.stringify([...operator.sourcePaths||[]].sort())!==JSON.stringify(['server/office-role-work.ts','tests/office-role-work.test.ts']))fail();
  if(!credit.grant||!Number.isFinite(Date.parse(credit.grant.expiresAt))||Date.parse(credit.grant.expiresAt)<=now)fail();
  for(const name of ['ASISTENTE_DATABASE_URL','ASISTENTE_OPENAI_API_KEY','ASISTENTE_GITHUB_TOKEN'])if(typeof env[name]!=='string'||!env[name]||/[\r\n\0]/.test(env[name]))fail();
  if(!/^sk-\S{20,300}$/.test(env.ASISTENTE_OPENAI_API_KEY)||!/^github_pat_\S{20,300}$/.test(env.ASISTENTE_GITHUB_TOKEN))fail();
  let db;try{db=new URL(env.ASISTENTE_DATABASE_URL);}catch{fail();}
  if(!['postgres:','postgresql:'].includes(db.protocol)||!db.hostname||!db.username||!db.password||!['require','verify-ca','verify-full'].includes(db.searchParams.get('sslmode')))fail();
  return {operator,credit};
}
export async function writeCloudConfig(env){
  const {operator,credit}=validateCloudInputs(env);
  if(!path.isAbsolute(env.RUNNER_TEMP||''))fail();
  const root=await fs.realpath(env.RUNNER_TEMP),directory=await fs.mkdtemp(path.join(root,'asistente-cloud-'));
  try {
  await fs.chmod(directory,0o700);
  const runtime={NODE_ENV:'production',SOFTWARE_FACTORY_ENABLED:'true',SOFTWARE_FACTORY_STORAGE_BACKEND:'postgres',AGENT_COUNCIL_STORAGE:'postgres',OPENAI_SHARED_CREDITS_REQUIRED:'true',
    DATABASE_URL:env.ASISTENTE_DATABASE_URL,DEFAULT_USER_ID:operator.owner,SOFTWARE_FACTORY_OWNER_ID:operator.owner,OPENAI_API_KEY:env.ASISTENTE_OPENAI_API_KEY,SOFTWARE_FACTORY_GITHUB_TOKEN:env.ASISTENTE_GITHUB_TOKEN,
    OPENAI_SHARED_CREDIT_CONFIG:'/run/factory-secrets/credit.json',SOFTWARE_FACTORY_OPERATOR_CONFIG:'/run/factory-secrets/operator.json'};
  await fs.writeFile(path.join(directory,'operator.json'),JSON.stringify(operator),{flag:'wx',mode:0o600});
  await fs.writeFile(path.join(directory,'credit.json'),JSON.stringify(credit),{flag:'wx',mode:0o600});
  await fs.writeFile(path.join(directory,'runtime.env'),Object.entries(runtime).map(([k,v])=>`${k}=${v}`).join('\n')+'\n',{flag:'wx',mode:0o600});
  if(env.GITHUB_ENV) await fs.appendFile(env.GITHUB_ENV,`ASISTENTE_PRIVATE_DIR=${directory}\n`);
  return directory;
  } catch(error) { await fs.rm(directory,{recursive:true,force:true}); throw error; }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{if(!process.env.GITHUB_ENV)fail();await writeCloudConfig(process.env);console.log('Private configuration prepared; no grants initialized or jobs admitted.');}
  catch{console.error('Private cloud configuration rejected. No credential values logged.');process.exitCode=1;}
}
