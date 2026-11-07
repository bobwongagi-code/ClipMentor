import {createProductionPanel,currentPanelTask,panelServiceUnavailable} from '../clipmentor/production-panel';
import {setTimeout as sleep} from 'node:timers/promises';
import {activateOfflineAgentRuntimeBackend} from '../external-agent/agent-runtime-persistence';
import {getStoredEntry} from './project-store';
import {createMaterialIntakeHandler} from '../clipmentor/material-intake';
import {productionFeedbackAnchor} from '../clipmentor/production-feedback';
import type {Plugin} from 'vite';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {editorCredentialAuthorized} from '../editor-auth';
import {createProductionTask,productionTaskStore,runProductionWithRecovery,productionFeedback,acceptProductionTask,cancelProductionTask,productionExecutionActive,type ProductionInput,type StageWorker} from '../clipmentor/production-task';
import {productionStageWorker,reconcileBlockedBlueprint} from '../clipmentor/production-worker';
import {productionBlueprintReadiness} from '../clipmentor/production-readiness';
import {loadOfflineStoredProject} from '../external-agent/offline-project-store';
import {createStoryboardHandler} from '../clipmentor/storyboard-api';
import {createBlueprintReviewBoardHandler} from '../clipmentor/blueprint-review-board-api';
import {prepareSharedProduction,queueBlueprintContinuations} from '../clipmentor/production-continuation';

async function json(req:IncomingMessage){const parts:Buffer[]=[];let size=0;for await(const part of req){size+=part.length;if(size>128000)throw new Error('Production request exceeds 128KB');parts.push(Buffer.from(part));}return JSON.parse(Buffer.concat(parts).toString('utf8'));}
/** Local service entry. Formal multi-user hosting remains a separate deployment task. */
export function clipMentorProductionPlugin(worker:StageWorker=productionStageWorker):Plugin{
 const storyboard=createStoryboardHandler();
 const reviewBoard=createBlueprintReviewBoardHandler();
 const active=new Map<string,Promise<unknown>>();
 const controls=new Set<string>();
 const launch=(task:Awaited<ReturnType<typeof createProductionTask>>,restoring=false)=>{
  if(active.has(task.taskId)||productionExecutionActive(task.projectId,task.taskId))throw new Error('Production task already running');
  const resumeWorker:StageWorker=async(item,context)=>{
   // A dead process can leave an unexpired edit lease. Wait for the normal
   // ownership claim instead of turning a recoverable conflict into a stop.
   let delay=1000;
   for(;;){
    context.signal.throwIfAborted();
    try{return await worker(item,context);}
    catch(error){
     if(!(error instanceof Error)||error.message!=='project_busy')throw error;
     try{await sleep(delay,undefined,{signal:context.signal});}
     catch(waitError){context.signal.throwIfAborted();throw waitError;}
     delay=Math.min(delay*2,5000);
    }
   }
  };
  const work=(async()=>{
   try{
    if(!await prepareSharedProduction(task))return;
    await runProductionWithRecovery(task,restoring?resumeWorker:worker,worker===productionStageWorker?reconcileBlockedBlueprint:async()=>{});
   }catch(error){task.status='blocked';task.error=String(error);await productionTaskStore.save(task);throw error;}
  })().finally(async()=>{
   active.delete(task.taskId);
   // The second output starts without another browser action, including after recovery.
   if(task.blueprintApproval&&['awaiting_review','completed'].includes(task.status)){
    const approval=task.blueprintApproval;
    const parent=await productionTaskStore.load(approval.sourceProjectId,approval.sourceTaskId);
    for(const entry of parent.productionChildren??[]){
     const sibling=await productionTaskStore.load(entry.projectId,entry.taskId);
     if(sibling.status==='queued'&&sibling.sharedProduction?.taskId===task.taskId&&!active.has(sibling.taskId))launch(sibling,true);
    }
   }
  });
  active.set(task.taskId,work);
  void work.catch(error=>console.error('ClipMentor production worker failed',task.taskId,error));
 };
 const isActive=(id:string,projectId:string)=>active.has(id)||productionExecutionActive(projectId,id);
 const panel=createProductionPanel(launch,isActive);
 return {name:'clipmentor-production-task',configureServer(server){
  let startup:Promise<void>|undefined;
  const recoverOnListen=()=>{
   const address=server.httpServer?.address();
   if(!address||typeof address!=='object')return;
   const origin=`http://127.0.0.1:${address.port}`;
   startup=(async()=>{
    activateOfflineAgentRuntimeBackend();
    const index=(await getStoredEntry('projects')).value;
    if(!Array.isArray(index))return;
    const projectIds=new Set(index.filter(row=>!row?.deletedAt&&typeof row?.id==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(row.id)).map(row=>row.id as string));
    for(const projectId of projectIds){
     try{
      const task=await currentPanelTask(projectId);
      if(task?.productionChildren?.length){
       for(const child of await queueBlueprintContinuations(task))if(['queued','running'].includes(child.status)&&!active.has(child.taskId)&&!productionExecutionActive(child.projectId,child.taskId)){
        child.input.author.origin=origin;child.input.reviewer.origin=origin;launch(child,true);
       }
       continue;
      }
      if(!task||!['queued','running'].includes(task.status)||active.has(task.taskId)||productionExecutionActive(task.projectId,task.taskId))continue;
      // Rebind only the local service address. The saved provider, budget,
      // stage and effect IDs remain authoritative after a port change.
      task.input.author.origin=origin;
      task.input.reviewer.origin=origin;
      launch(task,true);
     }catch(error){console.error('ClipMentor startup recovery failed',projectId,error);}
    }
   })().catch(error=>console.error('ClipMentor startup recovery unavailable',error));
  };
  if(server.httpServer?.listening)recoverOnListen();
  else server.httpServer?.once('listening',recoverOnListen);
  server.middlewares.use('/api/clipmentor/material-intake',createMaterialIntakeHandler());
  server.middlewares.use('/api/clipmentor/production-task',async(req:IncomingMessage,res:ServerResponse)=>{
   // The mounted path is not necessarily a valid standalone URL. Parse only
   // its query here; malformed paths must still reach the original auth/catch.
   const query=(req.url??'').split('?').slice(1).join('?');
   if(req.method==='GET'&&new URLSearchParams(query).get('view')==='review_board'){await reviewBoard(req,res);return;}
   if(req.method==='GET'&&new URLSearchParams(query).get('view')==='storyboard'){await storyboard(req,res);return;}
   const send=(status:number,body:unknown)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(body));};
   if(!editorCredentialAuthorized(req,true)){send(403,{error:'Editor origin required'});return;}
   let controlId:string|undefined,panelRequest=false;
   try{
    const address=server.httpServer?.address();const port=address&&typeof address==='object'?address.port:server.config.server.port;
    const origin=`http://127.0.0.1:${port}`;
    const params=new URLSearchParams(query);
    await startup;
    if(/^panel(?:_board|_video|_download|_reference)?$/.test(params.get('view')??'')){
     panelRequest=true;
     await panel(params.get('projectId')??'',origin,params,req,res,()=>json(req));return;
    }
    if(req.method==='GET'){
     const url=new URL(req.url??'/',origin),projectId=url.searchParams.get('projectId'),id=url.searchParams.get('taskId');
     if(!projectId||!id)throw new Error('Project and task ID required');
     const task=await productionTaskStore.load(projectId,id);
     const snapshot=await loadOfflineStoredProject(projectId);
     const blueprintReadiness=await productionBlueprintReadiness(snapshot?.doc,task.input.voice);
     let feedbackAnchor:unknown=null;
     if(task.status==='awaiting_review'&&snapshot)try{feedbackAnchor=await productionFeedbackAnchor(task,snapshot.doc);}catch(error){feedbackAnchor={available:false,reason:error instanceof Error?error.message:'feedback_binding_unavailable'};}
     const executionActive=isActive(id,projectId);
     send(200,{...task,blueprintReadiness,feedbackAnchor,executionActive,recoveryRequired:task.status==='running'&&!executionActive});return;
    }
    if(req.method!=='POST'){send(405,{error:'GET or POST required'});return;}
    const body=await json(req);
    if(body.action==='create'){
     const input={...body.input,author:{...body.input?.author,origin},reviewer:{...body.input?.reviewer,origin}} as ProductionInput;
     if(input.authorBackend!==undefined||input.reviewerBackend!==undefined||input.panelDelivery!==undefined)throw new Error('Panel production configuration is available only from the configured panel');
     const task=await createProductionTask(input);launch(task);send(202,{taskId:task.taskId,projectId:task.projectId,status:'queued'});return;
    }
    controlId=`${String(body.projectId)}:${String(body.taskId)}`;
    if(controls.has(controlId)){controlId=undefined;throw new Error('Task control request already pending');}
    controls.add(controlId);
    const task=await productionTaskStore.load(String(body.projectId),String(body.taskId));
    if(body.action==='cancel'){send(202,await cancelProductionTask(task));return;}
    if(isActive(task.taskId,task.projectId))throw new Error('Production task already running');
    if(body.action==='resume'){await reconcileBlockedBlueprint(task);launch(task);send(202,{taskId:task.taskId,status:'queued'});return;}
    if(body.action==='feedback'){const snapshot=await loadOfflineStoredProject(task.projectId);if(!snapshot)throw new Error('feedback_project_missing');await productionFeedback(task,body.feedback,productionTaskStore,snapshot.doc);launch(task);send(202,{taskId:task.taskId,status:'queued'});return;}
    if(body.action==='accept'){send(200,await acceptProductionTask(task,body.malayDeliveryConfirmed,undefined,
      {digest:body.visualCriteriaDigest,confirmed:body.confirmedVisualCriteria,renderId:body.renderId}));return;}
    throw new Error('Unknown production action');
   }catch(error){
    if(panelRequest)console.error('ClipMentor panel request failed',error);
    send(409,{error:panelRequest?panelServiceUnavailable:error instanceof Error?error.message:'Production request failed',production_approved:false});
   }finally{if(controlId)controls.delete(controlId);}
  });
 }};
}
