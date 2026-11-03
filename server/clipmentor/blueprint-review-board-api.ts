import type {IncomingMessage,ServerResponse} from 'node:http';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {editorCredentialAuthorized} from '../editor-auth';
import {reviewBoardArtifactRoot,reviewBoardArtifactUrl,cacheHumanReviewArtifact} from './blueprint-review-board-artifacts';
import {loadOfflineStoredProject} from '../external-agent/offline-project-store';
import {revisionOf} from '../../src/agent/external-edit-session';
import {isSafeUploadName} from '../media-dir';
import {loadReviewBoardInput,renderReviewBoards} from './blueprint-review-board';
/** Original production service read extension. Only artifacts are written. */
export function createBlueprintReviewBoardHandler(){
 const pending=new Set<string>();
 return async(req:IncomingMessage,res:ServerResponse)=>{
  const send=(status:number,body:unknown)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body));};
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  const site=req.headers['sec-fetch-site'],browser=editorCredentialAuthorized(req,false)&&(site==='same-origin'||site==='none'&&req.headers['sec-fetch-mode']==='navigate');
  if(req.method!=='GET'||!(editorCredentialAuthorized(req,true)||browser)){send(403,{error:'Editor origin required'});return;}
  let held:string|undefined;
  try{
   const url=new URL(req.url??'/','http://127.0.0.1'),projectId=url.searchParams.get('projectId');
   if(!projectId||projectId.length>200)throw Error('INPUT: 工程ID缺失');
   const root=reviewBoardArtifactRoot(projectId);
   const artifact=url.searchParams.get('artifact');
   if(artifact){if(!isSafeUploadName(artifact)||!artifact.startsWith('审片板-')||!artifact.endsWith('.html'))throw Error('INPUT: 非法审片板文件');const bytes=await readFile(join(root,artifact));res.setHeader('Content-Type','text/html; charset=utf-8');res.end(bytes);return;}
   const snapshot=await loadOfflineStoredProject(projectId);if(!snapshot)throw Error('INPUT: 工程不存在');
   if(url.searchParams.get('expectedRevision')!==revisionOf(snapshot.doc))throw Error('INPUT: 请等待宿主自动保存后重新读取');
   if(pending.has(projectId))throw Error('INPUT: 本工程审片板正在生成，不自动重试');pending.add(projectId);held=projectId;
   const input=await loadReviewBoardInput(projectId);
   if(input.sha256!==createHash('sha256').update(JSON.stringify(snapshot.doc)).digest('hex'))throw Error('INPUT: 生成前工程已变化，请重新读取');
   const view=url.searchParams.get('boardView')??'planner';if(view!=='human'&&view!=='planner')throw Error('INPUT: 未知审片板视图');
   const result=await renderReviewBoards(input,root,undefined,view);
   const artifacts=await Promise.all(result.artifacts.map(async a=>({...a,...(view==='human'?await cacheHumanReviewArtifact(a.path,a.candidate_sha256):{url:reviewBoardArtifactUrl(projectId,a.path.split('/').at(-1)!)} )})));
   send(200,{...result,project_id:projectId,project_revision:revisionOf(snapshot.doc),artifacts});
  }catch(e){send(409,{error:e instanceof Error&&e.message.startsWith('INPUT:')?e.message:'INPUT: 审片板生成或读取失败',review_approved:false});}finally{if(held)pending.delete(held);}
 };
}
