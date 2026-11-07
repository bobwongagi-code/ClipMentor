import type {IncomingMessage,ServerResponse} from 'node:http';
import {randomBytes} from 'node:crypto';
import {TLSSocket} from 'node:tls';
import {editorCredentialAuthorized,configuredEditorOrigin} from '../editor-auth';
import {loadOfflineStoredProject} from '../external-agent/offline-project-store';
import {productionStoryboard} from './storyboard';
import {createStoryboardImages} from './storyboard-images';
import {storyboardPage} from './storyboard-page';

/** Read extension of the existing production endpoint; no task launch, claim, save or approval. */
export function createStoryboardHandler(){
 const images=createStoryboardImages();
 return async(req:IncomingMessage,res:ServerResponse)=>{
  const send=(status:number,body:unknown)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body));};
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  const site=req.headers['sec-fetch-site'];
  const readBrowser=editorCredentialAuthorized(req,false)&&(site==='same-origin'||site==='none'&&req.headers['sec-fetch-mode']==='navigate');
  if(req.method!=='GET'||!(editorCredentialAuthorized(req,true)||readBrowser)){send(403,{error:'storyboard_editor_origin_required'});return;}
  try{
   const url=new URL(req.url??'/', 'http://127.0.0.1'),projectId=url.searchParams.get('projectId'),part=url.searchParams.get('part')??'summary';
   if(!projectId||projectId.length>200||!['summary','source','actual'].includes(part))throw Error('storyboard_request_invalid');
   const snapshot=await loadOfflineStoredProject(projectId);if(!snapshot)throw Error('storyboard_project_missing');
   const board=await productionStoryboard(snapshot.doc,projectId);
   const expectedRevision=url.searchParams.get('expectedProjectRevision'),expected=url.searchParams.get('expectedDigest');
   if(expectedRevision&&expectedRevision!==board.project_revision||expected&&expected!==board.digest)throw Error('storyboard_snapshot_changed');
   if(part!=='summary'){
    if(!expected||!url.searchParams.get('cardId'))throw Error('storyboard_snapshot_required');
    const rawOffset=url.searchParams.get('offset')??'0';if(!/^\d+$/.test(rawOffset))throw Error('storyboard_offset_invalid');
    const data=await images(snapshot.doc,board,url.searchParams.get('cardId')!,part as 'source'|'actual',Number(rawOffset));
    const latest=await loadOfflineStoredProject(projectId);if(!latest||(await productionStoryboard(latest.doc,projectId)).digest!==board.digest)throw Error('storyboard_snapshot_changed');
    send(200,data);return;
   }
   // The request origin/host has already passed the original editor guard.
   const origin=configuredEditorOrigin()??`${req.socket instanceof TLSSocket?'https:':'http:'}//${req.headers.host}`;
   const data={...board,board_url:new URL('/api/clipmentor/production-task?'+new URLSearchParams({view:'storyboard',format:'html',projectId,expectedDigest:board.digest}),origin).href};
   if(Buffer.byteLength(JSON.stringify(data))>256_000)throw Error('storyboard_metadata_too_large');
   if(url.searchParams.get('format')==='html'){
    const nonce=randomBytes(18).toString('base64');res.statusCode=200;res.setHeader('Content-Type','text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy',`default-src 'none'; img-src data:; connect-src 'self'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'self'`);
    res.end(storyboardPage(board,nonce));return;
   }
   send(200,data);
  }catch(error){
   const known=['storyboard_request_invalid','storyboard_project_missing','storyboard_snapshot_changed','storyboard_snapshot_required','storyboard_offset_invalid','storyboard_card_missing','storyboard_metadata_too_large'];
   send(409,{error:error instanceof Error&&known.includes(error.message)?error.message:'storyboard_current_plan_unavailable',production_approved:false});
  }
 };
}
