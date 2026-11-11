import {createHash} from 'node:crypto';
import {externalCall, ExternalHttpError, ExternalCallError, readExternalCapability, recordExternalCapability, type ExternalKind} from './external-call.ts';

/** Private raw response archive. No authorization headers or input text are persisted.
 * Account identity is hashed to prevent replay across credentials sharing an endpoint. */
export async function externalFetch(o:{directory:string;kind:ExternalKind;purpose:string;scope:unknown;requestId?:string;
  endpoint:string;init:RequestInit;fetch:typeof fetch;readOnly?:boolean;maxResponseBytes?:number;timeoutMs?:number}):Promise<Response>{
  const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
  if(o.init.body!==undefined&&typeof o.init.body!=='string')throw Error('external_body_must_be_frozen_string');
  const headers=new Headers(o.init.headers);
  const account=sha(headers.get('authorization')??'');
  const capability={endpoint:o.endpoint,account,scope:o.scope,protocol:headers.get('content-type')};
  let fresh=false;
  const value=await externalCall({directory:o.directory,kind:o.kind,purpose:o.purpose,requestId:o.requestId,
    identity:{capability,method:o.init.method??'GET',body:sha(o.init.body??''),headers:[...headers].map(([k,v])=>[k,sha(v)])},
    capability,readOnly:o.readOnly,signal:o.init.signal??undefined,timeoutMs:o.timeoutMs,maxResponseBytes:o.maxResponseBytes,
    preflight:async()=>{
      const prior=await readExternalCapability(o.directory,capability);
      if(prior?.transport_status==='unsupported')throw new ExternalCallError('external_capability_unsupported','configuration','');
    },execute:async signal=>{
      const response=await o.fetch(o.endpoint,{...o.init,signal});
      const reader=response.body?.getReader();const chunks:Uint8Array[]=[];let total=0;
      const limit=o.maxResponseBytes??2_000_000;
      if(reader)try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>limit){void reader.cancel().catch(()=>undefined);throw new ExternalCallError('external_response_size_invalid','local_validation','');}chunks.push(value);}}finally{reader.releaseLock();}
      const text=Buffer.concat(chunks).toString('utf8');
      const credential=headers.get('authorization')?.replace(/^Bearer\s+/i,'');
      if(credential&&text.includes(credential))throw new ExternalCallError('external_credential_echo_rejected','local_validation','');
      // Body is persisted by externalCall before any status/JSON validation.
      fresh=true;
      return {status:response.status,text,contentType:response.headers.get('content-type')};
    },consume:async raw=>{
      if(fresh)await recordExternalCapability(o.directory,capability,raw.status).catch(()=>{console.warn('[clipmentor] external capability cache unavailable');});
      if(raw.status<200||raw.status>=300)throw new ExternalHttpError(raw.status);
      return raw;
    }});
  return new Response([204,205,304].includes(value.status)?null:value.text,{status:value.status,headers:value.contentType?{'Content-Type':value.contentType}:{}});
}
