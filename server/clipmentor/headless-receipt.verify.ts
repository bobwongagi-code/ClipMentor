import assert from 'node:assert/strict';
import {openHeadlessEditor} from './headless-editor';
import {MemoryPersistence,projectDoc,projectId} from '../external-agent/offline-runtime.verify-fixtures';
let effects=0,recover=false,receiptStatus='completed';const requests:Array<{path:string;body:Record<string,unknown>}>=[];
const transport:typeof fetch=async(url,init)=>{const path=new URL(String(url)).pathname,body=JSON.parse(String(init?.body));requests.push({path,body});
 if(path==='/api/clipmentor/observe-video')assert.equal(body.action,'read_receipt','recovery must use the source route read contract');
 return Response.json({projectId,operationId:body.operationId,status:receiptStatus,result:receiptStatus==='completed'?{operationId:body.operationId,scope:'source_windows_and_planned_capacity_only'}:undefined,requestsSent:0,actual_handoff_verified:false,complete_film_accepted:false});};
const editor=await openHeadlessEditor({projectId,runId:'receipt-fixture',origin:'http://127.0.0.1:5199',review:{provider:'openai',model:'fixture',origin:'http://127.0.0.1:5199',apiMode:'responses'},persistence:new MemoryPersistence(projectDoc()),browserConnected:()=>false,fetch:transport,
 effect:async(_kind,_key,work,recovery)=>{effects++;return recover?recovery!('saved-operation'):work('saved-operation');}});
try{
 const source={action:'read_receipt',projectId,operationId:'saved-operation'};
 const response=await editor.context.hostFetch!('/api/clipmentor/observe-video',{method:'POST',body:JSON.stringify(source)});
 assert.equal(effects,0,'reading source observation must never reserve a paid effect');
 assert.equal((await response.json()).requestsSent,0);assert.deepEqual(requests.at(-1)?.body,source);
 recover=true;
 const restored=await editor.context.hostFetch!('/api/clipmentor/observe-video',{method:'POST',body:JSON.stringify({projectId,operationId:'saved-operation'})});
 assert.equal((await restored.json()).scope,'source_windows_and_planned_capacity_only','resume returns the original result rather than receipt envelope');
 receiptStatus='failed';
 const failed=await editor.context.hostFetch!('/api/clipmentor/observe-video',{method:'POST',body:JSON.stringify({projectId,operationId:'saved-operation'})});
 assert.equal(failed.status,409);assert.equal((await failed.json()).receipt.status,'failed','failure retained, never promoted or resubmitted');
 assert.equal(effects,2);assert.deepEqual(requests.at(-1)?.body,source,'unknown observation recovers only original receipt, never resubmits');
 for(const path of ['/api/clipmentor/review-preview','/api/clipmentor/transcribe-source']){
  const before=effects;
  await editor.context.hostFetch!(path,{method:'POST',body:JSON.stringify({action:'read',projectId,operationId:'saved-operation'})});
  assert.equal(effects,before,'existing zero-effect read behavior preserved');
 }
 console.log('headless source receipt: direct read bypasses effects, recovery uses read_receipt, other read paths preserved; zero provider calls');
}finally{await editor.close();}
