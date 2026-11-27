import {panelReviewIssue} from '../clipmentor/production-panel-review';
import {blueprintRepairNotice} from '../clipmentor/production-decisions';
import {createProductionPanel,currentPanelTask,panelServiceUnavailable} from '../clipmentor/production-panel';
import {setTimeout as sleep} from 'node:timers/promises';
import {activateOfflineAgentRuntimeBackend} from '../external-agent/agent-runtime-persistence';
import {getStoredEntry} from './project-store';
import {createMaterialIntakeHandler} from '../clipmentor/material-intake';
import {productionFeedbackAnchor} from '../clipmentor/production-feedback';
import type {Plugin} from 'vite';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {editorCredentialAuthorized} from '../editor-auth';
import {createProductionTask,productionTaskStore,runProductionWithRecovery,productionFeedback,acceptProductionTask,cancelProductionTask,productionExecutionActive,saveProductionControl,requeuePanelAuthorCheck,ProductionCheckpointSuperseded,type ProductionInput,type ProductionTask,type StageWorker} from '../clipmentor/production-task';
import {productionStageWorker,reconcileBlockedBlueprint} from '../clipmentor/production-worker';
import {productionBlueprintReadiness} from '../clipmentor/production-readiness';
import {loadOfflineStoredProject} from '../external-agent/offline-project-store';
import {createStoryboardHandler} from '../clipmentor/storyboard-api';
import {createBlueprintReviewBoardHandler} from '../clipmentor/blueprint-review-board-api';
import {canSeedSharedProduction,prepareSharedProduction,publishedProductionParent,queueBlueprintContinuations,readProductionOutputs} from '../clipmentor/production-continuation';
import {authorizePreviewRetry} from '../clipmentor/production-preview-retry';
import {canLaunchSharedFollower} from '../clipmentor/production-shared-clock';
import {resolveUploadFile} from '../media-dir';
import {sha256File} from '../../shared/node-content-hash';
import {runtimeProfile} from '../runtime-profile';
import {createProductionCapacity,isProductionCapacityFull} from '../clipmentor/production-capacity';
import {createWorkspaceProject,readTaskWorkspace} from '../clipmentor/task-workspace';

type SharedLauncher=(task:ProductionTask,pausedProducer?:ProductionTask)=>Promise<boolean>;
const processWorkspaces=process as typeof process & {
 clipMentorCapacity?:Map<string,ReturnType<typeof createProductionCapacity>>;
 clipMentorSharedLaunchers?:Map<string,SharedLauncher>;
};
const workspaceCapacities:Map<string,ReturnType<typeof createProductionCapacity>>=processWorkspaces.clipMentorCapacity??=new Map();
const sharedLaunchers:Map<string,SharedLauncher>=processWorkspaces.clipMentorSharedLaunchers??=new Map();

async function json(req:IncomingMessage){const parts:Buffer[]=[];let size=0;for await(const part of req){size+=part.length;if(size>128000)throw new Error('Production request exceeds 128KB');parts.push(Buffer.from(part));}return JSON.parse(Buffer.concat(parts).toString('utf8'));}
/** Local service entry. Formal multi-user hosting remains a separate deployment task. */
export function clipMentorProductionPlugin(worker:StageWorker=productionStageWorker):Plugin{
 const storyboard=createStoryboardHandler();
 const reviewBoard=createBlueprintReviewBoardHandler();
 const active=new Map<string,Promise<unknown>>();
 const preparing=new Map<string,Promise<boolean>>();
 const deferred=new Map<string,Promise<boolean>>();
 const scheduling=new AbortController();
 const controls=new Set<string>();
 const root=runtimeProfile().rootDir;
 const capacity=workspaceCapacities.get(root)??createProductionCapacity();
 workspaceCapacities.set(root,capacity);
 const slotFor=(task:ProductionTask)=>task.blueprintApproval?.sourceProjectId??task.projectId;
 const launch=(task:ProductionTask,restoring=false,pausedProducer?:ProductionTask):Promise<boolean>=>{
  if(scheduling.signal.aborted)return Promise.resolve(false);
  const queued=deferred.get(task.taskId);
  if(queued)return queued;
  let release:()=>void;
  try{release=capacity.reserve(slotFor(task));}
  catch(error){
   if(!isProductionCapacityFull(error))throw error;
   const next=capacity.wait(slotFor(task),scheduling.signal).then(releaseSlot=>{
    deferred.delete(task.taskId);
    if(!releaseSlot)return false;
    if(scheduling.signal.aborted){releaseSlot();return false;}
    return startExecution(task,true,undefined,releaseSlot);
   });
   deferred.set(task.taskId,next);
   void next.catch(error=>console.error('ClipMentor queued task unavailable',task.taskId,error));
   return next;
  }
  return startExecution(task,restoring,pausedProducer,release);
 };
 const startExecution=(task:ProductionTask,restoring:boolean,pausedProducer:ProductionTask|undefined,releaseSlot:()=>void)=>{
  if(active.has(task.taskId)||productionExecutionActive(task.projectId,task.taskId)){
   releaseSlot();
   return preparing.get(task.taskId)??Promise.resolve(false);
  }
  const ready=Promise.withResolvers<boolean>();
  preparing.set(task.taskId,ready.promise);
  const finishPreparation=(prepared:boolean)=>{preparing.delete(task.taskId);ready.resolve(prepared);};
  const resumeWorker:StageWorker=async(item,context)=>{
   // A dead process can leave an unexpired edit lease. Wait for the normal
   // ownership claim instead of turning a recoverable conflict into a stop.
   let delay=1000;
   let retryContext=context;
   const assertCheckpoint=async()=>{
    const latest=await productionTaskStore.load(item.projectId,item.taskId);
    if(latest.sequence!==item.sequence||latest.updatedAt!==item.updatedAt)
     throw new ProductionCheckpointSuperseded('production_checkpoint_superseded');
   };
   for(;;){
    context.signal.throwIfAborted();
    try{return await worker(item,retryContext);}
    catch(error){
     if(!(error instanceof Error)||error.message!=='project_busy')throw error;
     try{await sleep(delay,undefined,{signal:context.signal});}
     catch(waitError){context.signal.throwIfAborted();throw waitError;}
     await assertCheckpoint();
     // Keep the fence through the lease acquisition and the first resumed effect.
     retryContext={...context,
      async assertCurrent(){await context.assertCurrent?.();await assertCheckpoint();},
      async effect(kind,key,work,recover){await assertCheckpoint();return context.effect(kind,key,work,recover);},
     };
     delay=Math.min(delay*2,5000);
    }
   }
  };
  const localAuthorOrigin=task.input.author.origin,localReviewerOrigin=task.input.reviewer.origin;
  let batchValidated=false;
  const work=(async()=>{
   try{
    await runProductionWithRecovery(task,restoring?resumeWorker:worker,worker===productionStageWorker?reconcileBlockedBlueprint:async()=>{},
     productionTaskStore,async signal=>{
      const latest=await productionTaskStore.load(task.projectId,task.taskId);
      if(latest.sequence!==task.sequence||latest.updatedAt!==task.updatedAt)Object.assign(task,latest);
      // Only the local service address is rebound; durable attempts, approvals,
      // terminal states and saved effects win over a late dispatch snapshot.
      task.input.author.origin=localAuthorOrigin;task.input.reviewer.origin=localReviewerOrigin;
      signal.throwIfAborted();
      if(['completed','cancelled','awaiting_blueprint','awaiting_review'].includes(task.status))return false;
      if(task.blueprintApproval){
       // A separately indexed child is not an independent production request.
       await publishedProductionParent(task);
       signal.throwIfAborted();
       batchValidated=true;
      }
      const prepared=await prepareSharedProduction(task,signal,pausedProducer);
      if(prepared)finishPreparation(true);
      return prepared;
     },async published=>{
      try{await launchSharedFollower(published,true);}
      catch(error){console.error('ClipMentor shared preview continuation unavailable',published.taskId,error);}
     });
   }catch(error){
    // Failure to read the authoritative checkpoint does not turn a stale launch
    // snapshot into the authority for recording a failure.
    const current=await productionTaskStore.load(task.projectId,task.taskId).catch(()=>undefined);
    if(current){
     const sameCheckpoint=current.sequence===task.sequence&&current.updatedAt===task.updatedAt;
     Object.assign(task,current);
     if(error instanceof ProductionCheckpointSuperseded)return;
     if(sameCheckpoint&&(!current.blueprintApproval||batchValidated)&&['queued','running','blocked'].includes(current.status)){
      const next={...structuredClone(current),status:'blocked' as const,error:String(error).slice(0,1600)};
      await saveProductionControl(current,next,productionTaskStore);
      Object.assign(task,next);
     }
    }
    throw error;
   }
  })().finally(async()=>{
   active.delete(task.taskId);
   finishPreparation(false);
   // The second output starts without another browser action, including after recovery.
   try{await launchSharedFollower(task,false);}finally{releaseSlot();}
  });
  active.set(task.taskId,work);
  void work.catch(error=>console.error('ClipMentor production worker failed',task.taskId,error));
  return ready.promise;
 };
 async function launchSharedFollower(task:ProductionTask,waitForBinding:boolean){
  const pausedProducer=waitForBinding?task:undefined;
  if(!task.blueprintApproval||task.input.panelDelivery?.audience!=='existing_partner'||!canSeedSharedProduction(task,pausedProducer))return;
  const parent=await publishedProductionParent(task);
  if(!parent?.productionChildren?.length)return;
  const siblings=await queueBlueprintContinuations(parent);
  for(let sibling of siblings){
   if(sibling.sharedProduction?.taskId!==task.taskId)continue;
   // Startup can already be preparing the follower from the durable export.
   // Wait for that same preparation before the producer enters review.
   const pending=preparing.get(sibling.taskId);
   if(pending){
    if(!waitForBinding||await pending)continue;
    // The old run could have seen the producer just before export. Its
    // deferred result releases execution before we try the new checkpoint.
    sibling=await productionTaskStore.load(sibling.projectId,sibling.taskId);
   }
   if(!canLaunchSharedFollower(sibling)||active.has(sibling.taskId)||productionExecutionActive(sibling.projectId,sibling.taskId))continue;
   const dispatcher=sharedLaunchers.get(root);
   if(!dispatcher)continue;
   const ready=dispatcher(sibling,pausedProducer);
   if(waitForBinding)await ready;
  }
 }
 const isActive=(id:string,projectId:string)=>active.has(id)||productionExecutionActive(projectId,id);
 const isDeferred=(id:string)=>deferred.has(id);
 const panel=createProductionPanel(launch,isActive,controls,undefined,projectId=>capacity.reserve(projectId),isDeferred);
 return {name:'clipmentor-production-task',configureServer(server){
  const dispatchShared:SharedLauncher=(task,pausedProducer)=>{
   const address=server.httpServer?.address();
   if(!address||typeof address!=='object')return Promise.resolve(false);
   const origin=`http://127.0.0.1:${address.port}`;
   task.input.author.origin=origin;task.input.reviewer.origin=origin;
   return launch(task,true,pausedProducer);
  };
  server.httpServer?.once('close',()=>{
   if(sharedLaunchers.get(root)===dispatchShared)sharedLaunchers.delete(root);
   scheduling.abort();
  });
  let startup:Promise<void>|undefined;
  const recoverOnListen=()=>{
   const address=server.httpServer?.address();
   if(!address||typeof address!=='object')return;
   const origin=`http://127.0.0.1:${address.port}`;
   sharedLaunchers.set(root,dispatchShared);
   startup=(async()=>{
    activateOfflineAgentRuntimeBackend();
    const index=(await getStoredEntry('projects')).value;
    if(!Array.isArray(index))return;
    const projectIds=new Set(index.filter(row=>!row?.deletedAt&&typeof row?.id==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(row.id)).map(row=>row.id as string));
    for(const projectId of projectIds){
     try{
      const task=await currentPanelTask(projectId);
      if(task?.blueprintApproval)continue;
      if(task&&(task.productionChildren?.length||task.productionChild)){
       const children=task.productionChildren?.length?await queueBlueprintContinuations(task):await readProductionOutputs(task);
       for(const child of children)if(projectIds.has(child.projectId)&&(child.status==='running'||canLaunchSharedFollower(child))&&!active.has(child.taskId)&&!productionExecutionActive(child.projectId,child.taskId)){
        child.input.author.origin=origin;child.input.reviewer.origin=origin;launch(child,true);
       }
       continue;
      }
      if(!task||active.has(task.taskId)||productionExecutionActive(task.projectId,task.taskId))continue;
      if(!['queued','running'].includes(task.status)&&!await requeuePanelAuthorCheck(task))continue;
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
  let taskList: { until:number; result:ReturnType<typeof readTaskWorkspace> }|undefined;
  server.middlewares.use('/api/clipmentor/task-workspace',async(req:IncomingMessage,res:ServerResponse)=>{
   const send=(status:number,body:unknown)=>res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}).end(JSON.stringify(body));
   if(!editorCredentialAuthorized(req,true)||req.headers['sec-fetch-site']!=='same-origin'){
    send(403,{error:'无法访问任务列表。'});return;
   }
   try{
    await startup;
    if(req.method==='GET'){
     if(!taskList||Date.now()>=taskList.until){
      taskList={until:Date.now()+2500,result:readTaskWorkspace(isActive,()=>capacity.running,isDeferred)};
     }
     send(200,{...await taskList.result,running:capacity.running});return;
    }
    if(req.method==='POST'){
     const body=await json(req);
     const project=await createWorkspaceProject(body.id,body.name);
     taskList=undefined;
     send(201,project);return;
    }
    send(405,{error:'不支持此操作。'});
   }catch(error){
    if(error instanceof Error&&error.message==='invalid_workspace_project'){send(400,{error:'请核对任务名称。'});return;}
    if(req.method==='GET')taskList=undefined;
    send(409,{error:req.method==='GET'?'暂时无法读取任务。':'暂时无法新建任务，请重试。'});
   }
  });
  server.middlewares.use('/api/clipmentor/production-task',async(req:IncomingMessage,res:ServerResponse)=>{
   // The mounted path is not necessarily a valid standalone URL. Parse only
   // its query here; malformed paths must still reach the original auth/catch.
   const query=(req.url??'').split('?').slice(1).join('?');
   if(req.method==='GET'&&new URLSearchParams(query).get('view')==='review_board'){await reviewBoard(req,res);return;}
   if(req.method==='GET'&&new URLSearchParams(query).get('view')==='storyboard'){await storyboard(req,res);return;}
   const send=(status:number,body:unknown)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(body));};
   if(!editorCredentialAuthorized(req,true)){send(403,{error:'Editor origin required'});return;}
   let controlId:string|undefined,panelRequest=false,releaseSlot:(()=>void)|undefined;
   try{
    const address=server.httpServer?.address();const port=address&&typeof address==='object'?address.port:server.config.server.port;
    const origin=`http://127.0.0.1:${port}`;
    const params=new URLSearchParams(query);
    await startup;
    if(/^panel(?:_board|_video|_poster|_download|_draft_download|_reference|_attachment|_material)?$/.test(params.get('view')??'')){
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
     releaseSlot=capacity.reserve(input.projectId);
     const task=await createProductionTask(input);launch(task);send(202,{taskId:task.taskId,projectId:task.projectId,status:'queued'});return;
    }
    controlId=String(body.projectId);
    if(controls.has(controlId)){controlId=undefined;throw new Error('Task control request already pending');}
    controls.add(controlId);
    const task=await productionTaskStore.load(String(body.projectId),String(body.taskId));
    if(body.action==='cancel'){send(202,await cancelProductionTask(task));return;}
    if(isActive(task.taskId,task.projectId))throw new Error('Production task already running');
    if(['resume','feedback','accept'].includes(String(body.action)))await publishedProductionParent(task);
    if(['resume','feedback','retry_preview_review'].includes(body.action))releaseSlot=capacity.reserve(slotFor(task));
    if(body.action==='retry_preview_review'){
     await publishedProductionParent(task);
     const snapshot=await loadOfflineStoredProject(task.projectId);
     const src=task.completed.export?.artifact.path??task.completed.export?.artifact.downloadUrl;
     const file=typeof src==='string'&&/^\/media\/uploads\/[^/?#]+\.mp4$/.test(src)?resolveUploadFile(src.slice('/media/uploads/'.length)):null;
     if(!file||!snapshot||snapshot.revision!==task.projectRevision)throw Error('preview_retry_export_changed');
     const next=authorizePreviewRetry(task,body,await sha256File(file));
     await saveProductionControl(task,next,productionTaskStore,undefined,snapshot.doc,task.sequence);
     launch(next);send(202,{taskId:task.taskId,projectId:task.projectId,status:'queued'});return;
    }
    if(body.action==='resume'){
     const blocked=blueprintRepairNotice(task);
     if(blocked)throw Error(blocked);
     if(!await requeuePanelAuthorCheck(task)){
      if(task.status==='awaiting_blueprint')throw Error('蓝图没有可恢复的自检任务');
      await reconcileBlockedBlueprint(task);
     }
     task.input.author.origin=origin;task.input.reviewer.origin=origin;
     launch(task);send(202,{taskId:task.taskId,status:'queued'});return;
    }
    if(body.action==='feedback'){const snapshot=await loadOfflineStoredProject(task.projectId);if(!snapshot)throw new Error('feedback_project_missing');await productionFeedback(task,body.feedback,productionTaskStore,snapshot.doc);launch(task);send(202,{taskId:task.taskId,status:'queued'});return;}
    if(body.action==='accept'){send(200,await acceptProductionTask(task,body.malayDeliveryConfirmed,undefined,
      {digest:body.visualCriteriaDigest,confirmed:body.confirmedVisualCriteria,renderId:body.renderId,watched:body.previewWatched}));return;}
    throw new Error('Unknown production action');
   }catch(error){
    if(isProductionCapacityFull(error)){send(409,{reason:'capacity',error:error.message});return;}
    if(panelRequest)console.error('ClipMentor panel request failed',error);
    const code=error instanceof Error?error.message:'';
    const issue=panelRequest?panelReviewIssue(error):undefined;
    send(409,{error:issue?.message??(panelRequest?panelServiceUnavailable:code||'Production request failed'),...(issue?{issue}:{}),production_approved:false});
   }finally{releaseSlot?.();if(controlId)controls.delete(controlId);}
  });
 }};
}
