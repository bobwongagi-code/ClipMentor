import type {Plugin} from 'vite';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {editorCredentialAuthorized} from '../editor-auth';
import {createProductionTask,productionTaskStore,advanceProductionTask,productionFeedback,acceptProductionTask,cancelProductionTask,type ProductionInput,type StageWorker} from '../clipmentor/production-task';
import {productionStageWorker} from '../clipmentor/production-worker';

async function json(req:IncomingMessage){const parts:Buffer[]=[];let size=0;for await(const part of req){size+=part.length;if(size>128000)throw new Error('Production request exceeds 128KB');parts.push(Buffer.from(part));}return JSON.parse(Buffer.concat(parts).toString('utf8'));}
/** Local service entry. Formal multi-user hosting remains a separate deployment task. */
export function clipMentorProductionPlugin(worker:StageWorker=productionStageWorker):Plugin{
 const active=new Map<string,Promise<unknown>>();
 const controls=new Set<string>();
 const launch=(task:Awaited<ReturnType<typeof createProductionTask>>)=>{
  if(active.has(task.taskId))throw new Error('Production task already running');
  const work=advanceProductionTask(task,worker).finally(()=>active.delete(task.taskId));active.set(task.taskId,work);void work.catch(()=>undefined);
 };
 return {name:'clipmentor-production-task',configureServer(server){
  server.middlewares.use('/api/clipmentor/production-task',async(req:IncomingMessage,res:ServerResponse)=>{
   const send=(status:number,body:unknown)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(body));};
   if(!editorCredentialAuthorized(req,true)){send(403,{error:'Editor origin required'});return;}
   let controlId:string|undefined;
   try{
    const address=server.httpServer?.address();const port=address&&typeof address==='object'?address.port:server.config.server.port;
    const origin=`http://127.0.0.1:${port}`;
    if(req.method==='GET'){
     const url=new URL(req.url??'/',origin),projectId=url.searchParams.get('projectId'),id=url.searchParams.get('taskId');
     if(!projectId||!id)throw new Error('Project and task ID required');
     const task=await productionTaskStore.load(projectId,id);send(200,{...task,executionActive:active.has(id),recoveryRequired:task.status==='running'&&!active.has(id)});return;
    }
    if(req.method!=='POST'){send(405,{error:'GET or POST required'});return;}
    const body=await json(req);
    if(body.action==='create'){
     const input={...body.input,author:{...body.input?.author,origin},reviewer:{...body.input?.reviewer,origin}} as ProductionInput;
     const task=await createProductionTask(input);launch(task);send(202,{taskId:task.taskId,projectId:task.projectId,status:'queued'});return;
    }
    controlId=`${String(body.projectId)}:${String(body.taskId)}`;
    if(controls.has(controlId)){controlId=undefined;throw new Error('Task control request already pending');}
    controls.add(controlId);
    const task=await productionTaskStore.load(String(body.projectId),String(body.taskId));
    if(body.action==='cancel'){send(202,await cancelProductionTask(task));return;}
    if(active.has(task.taskId))throw new Error('Production task already running');
    if(body.action==='resume'){launch(task);send(202,{taskId:task.taskId,status:'queued'});return;}
    if(body.action==='feedback'){await productionFeedback(task,String(body.feedback??''));launch(task);send(202,{taskId:task.taskId,status:'queued'});return;}
    if(body.action==='accept'){send(200,await acceptProductionTask(task,body.malayDeliveryConfirmed));return;}
    throw new Error('Unknown production action');
   }catch(error){send(409,{error:error instanceof Error?error.message:'Production request failed',production_approved:false});}finally{if(controlId)controls.delete(controlId);}
  });
 }};
}
