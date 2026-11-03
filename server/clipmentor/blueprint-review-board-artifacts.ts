/** Local generated-artifact cache, shared by CLI and the existing read endpoint. */
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,rename,rm} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {runtimeProfile} from '../runtime-profile';
import {isSafeUploadName} from '../media-dir';
export function reviewBoardArtifactRoot(key:string){return join(runtimeProfile().rootDir,'blueprint-review-boards',createHash('sha256').update(key).digest('hex'));}
export function reviewBoardArtifactUrl(key:string,name:string){return '/api/clipmentor/production-task?'+new URLSearchParams({view:'review_board',projectId:key,artifact:name});}
export async function cacheHumanReviewArtifact(path:string,sha256:string){
 if(!/^[a-f0-9]{64}$/.test(sha256))throw Error('INPUT: 候选哈希无效');const name=basename(path);if(!isSafeUploadName(name)||!name.startsWith('审片板-')||!name.endsWith('.html'))throw Error('INPUT: 工件名无效');
 const bytes=await readFile(path);if(bytes.length>32_000_000)throw Error('INPUT: 工件超限');const key='local-board-'+createHash('sha256').update(bytes).digest('hex'),root=reviewBoardArtifactRoot(key);await mkdir(root,{recursive:true});const temp=join(root,name+'.tmp-'+createHash('sha256').update(String(Math.random())).digest('hex').slice(0,12));try{await writeFile(temp,bytes,{flag:'wx'});await rename(temp,join(root,name));}finally{await rm(temp,{force:true});}
 return{url:reviewBoardArtifactUrl(key,name),cached_sha256:createHash('sha256').update(bytes).digest('hex')};
}
