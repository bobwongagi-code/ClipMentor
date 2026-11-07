import {createHash} from 'node:crypto';
import {readFile,stat} from 'node:fs/promises';
import {resolveUploadFile} from '../media-dir.ts';
import type {MinimaxSubtitleBinding} from '../../shared/voice-word-timing.ts';

export const voiceDigest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');

/** Bind only an actual file returned by this synthesis; old sidecars are not retroactively trusted. */
export async function bindMinimaxWordSubtitle(
 text:string,audio:{sha256:string;durationSeconds:number},subtitlePath:string,
):Promise<MinimaxSubtitleBinding>{
 const name=subtitlePath.slice('/media/uploads/'.length),file=resolveUploadFile(name);
 if(!subtitlePath.startsWith('/media/uploads/')||!file||!(await stat(file)).isFile())throw Error('MiniMax subtitle file unavailable');
 const bytes=await readFile(file);
 if(bytes.length===0||bytes.length>5_000_000)throw Error('MiniMax subtitle file size invalid');
 return{version:1,provider:'minimax',subtitleType:'word',subtitlePath,subtitleSha256:voiceDigest(bytes),
  audioSha256:audio.sha256,textSha256:voiceDigest(text),durationSeconds:audio.durationSeconds};
}

/** Optional timing failure must not discard paid, saved audio. */
export async function optionalVoiceSubtitle(work:()=>Promise<{subtitlePath?:string;subtitleBinding?:MinimaxSubtitleBinding}>){
 try{return await work();}catch{return{subtitleWarning:'subtitle_unavailable',subtitlePath:undefined,subtitleBinding:undefined};}
}
