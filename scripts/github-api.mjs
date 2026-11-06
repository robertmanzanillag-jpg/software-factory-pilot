import {repository} from './control.mjs';
export async function api(control,route,{method='GET',body,signal,expected=200}={}) {
  if(!route.startsWith('/')||route.includes('..'))throw Error('API_ROUTE_INVALID');
  const response=await control.github(`https://api.github.com/repos/${repository}${route}`,{method,body:body===undefined?undefined:JSON.stringify(body),headers:{Accept:'application/vnd.github+json','Content-Type':'application/json','X-GitHub-Api-Version':'2026-03-10'},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});
  if(response.status!==expected){await response.body?.cancel();throw Error(`GITHUB_REQUEST_UNCONFIRMED_${response.status}`);}
  if(expected===204){await response.body?.cancel();return;}
  const reader=response.body?.getReader();if(!reader)throw Error('API_BODY_MISSING');
  const chunks=[];let size=0;
  try{for(;;){const c=await reader.read();if(c.done)break;size+=c.value.length;if(size>2*1024*1024)throw Error('API_BODY_TOO_LARGE');chunks.push(c.value);}}finally{await reader.cancel();}
  return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks)));
}
