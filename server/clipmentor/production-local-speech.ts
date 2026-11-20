import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import type {ProjectDoc} from '../../src/editor/types';
import type {ClipMentorAnalysis} from '../../src/clipmentor/analysis';
import {sha256File} from '../../shared/node-content-hash';
import {ffmpegBin,whisperCliBin} from '../media-binaries';
import {resolveUploadFile} from '../media-dir';
import {atomicWriteFile} from '../plugins/project-store-durable';
import {runtimeProfile} from '../runtime-profile';

const run=promisify(execFile);
type SpeechLine={start_seconds:number;end_seconds:number;text:string};
type LocalSpeechCandidate={status:'machine_transcript_candidate';source_hash:string;segments:SpeechLine[];note:string};
type LocalSpeech=LocalSpeechCandidate|{status:'unavailable';reason:string};

export function registerProductionLocalSpeech(a:ClipMentorAnalysis,speech:LocalSpeech):ClipMentorAnalysis|null{
 if(speech.status!=='machine_transcript_candidate'||!speech.segments.length||speech.source_hash!==a.source.sourceContentHash)return null;
 const source_id=`local-asr:${speech.source_hash}`;
 if(a.transcripts.some(entry=>entry.source_id===source_id))return null;
 const revision=a.revision+1;
 return {...a,revision,transcripts:[...a.transcripts,{
  source_id,provider:'whisper.cpp',origin:'local_source_segments',status:'machine_transcript_not_independently_listened',words:speech.segments,
 }],audit:[...a.audit,{revision,action:'register_local_source_speech',target_id:source_id,at:Date.now(),reason:speech.note,
  actor:{operator:'task_operator',executor:'production_host',instruction:'register machine transcript as a source candidate',identity:'local_declared_not_authenticated'}}]};
}

function candidateLines(value:unknown,duration:number):SpeechLine[]{
 if(!Array.isArray(value))return [];
 return value.flatMap(row=>{
  const start=row?.offsets?.from/1000,end=Math.min(row?.offsets?.to/1000,duration);
  const text=typeof row?.text==='string'?row.text.trim():'';
  return Number.isFinite(start)&&Number.isFinite(end)&&start>=0&&end>start&&text&&text.length<=600
   ?[{start_seconds:start,end_seconds:end,text}]:[];
 });
}

/** Optional offline evidence. Cache only for this task, original bytes and model. */
export async function productionLocalSpeech(doc:ProjectDoc,taskId:string,signal:AbortSignal):Promise<LocalSpeech>{
 const source=doc.clipMentorAnalysis?.source;
 const asset=source&&doc.assets.find(asset=>asset.id===source.asset_id&&asset.kind==='video');
 const model=process.env.OPENCHATCUT_LOCAL_ASR_MODEL?.trim();
 if(!model)return {status:'unavailable',reason:'local_model_not_configured'} as const;
 if(!source?.sourceContentHash||!asset||source.sourceContentHash!==asset.sourceContentHash)
  return {status:'unavailable',reason:'source_binding_missing'} as const;
 const file=resolveUploadFile(asset.src.replace(/^\/media\/uploads\//,''));
 if(!file)return {status:'unavailable',reason:'source_file_missing'} as const;
 try{
  const deadline=AbortSignal.any([signal,AbortSignal.timeout(120_000)]);
  const modelInfo=await stat(model);
  const key=createHash('sha256').update(JSON.stringify([taskId,source.sourceContentHash,source.duration_seconds,model,modelInfo.size,modelInfo.mtimeMs,1])).digest('hex');
  const directory=join(runtimeProfile().rootDir,'clipmentor-local-speech');
  const target=join(directory,`${key}.json`);
  if(await sha256File(file)!==source.sourceContentHash)throw Error('source_changed');
  const saved=await readFile(target,'utf8').then(JSON.parse,()=>null);
  if(saved?.status==='machine_transcript_candidate'&&saved.source_hash===source.sourceContentHash&&Array.isArray(saved.segments)
   &&saved.segments.every((line:SpeechLine)=>Number.isFinite(line?.start_seconds)&&Number.isFinite(line?.end_seconds)
    &&line.start_seconds>=0&&line.end_seconds>line.start_seconds&&line.end_seconds<=source.duration_seconds
    &&typeof line.text==='string'&&!!line.text.trim()&&line.text.length<=600)&&typeof saved.note==='string')return saved;
  if(!Number.isFinite(source.duration_seconds)||source.duration_seconds<=0||source.duration_seconds>180)return {status:'unavailable',reason:'source_duration_outside_local_scope'} as const;
  deadline.throwIfAborted();
  const scratch=await mkdtemp(join(tmpdir(),'clipmentor-local-speech-'));
  try{
   const wav=join(scratch,'source.wav'),output=join(scratch,'speech');
   await run(ffmpegBin(),['-nostdin','-v','error','-i',file,'-map','0:a:0','-vn','-ac','1','-ar','16000','-c:a','pcm_s16le',wav],{signal:deadline});
   await run(whisperCliBin(),['-m',model,'-l','ms','-ng','-oj','-of',output,'-np','-f',wav],{signal:deadline,maxBuffer:1024*1024});
   const raw=JSON.parse(await readFile(`${output}.json`,'utf8'));
   const lines=candidateLines(raw.transcription,source.duration_seconds);
   if(await sha256File(file)!==source.sourceContentHash)throw Error('source_changed');
   deadline.throwIfAborted();
   const result={status:'machine_transcript_candidate',source_hash:source.sourceContentHash,
    segments:lines,note:'本机马来语自动听写，含可能误听与不准确词界，未经人工听审。没有听写结果不能证明原片没有说过。'} as const;
   await mkdir(directory,{recursive:true});
   await atomicWriteFile(target,JSON.stringify(result));
   return result;
  }finally{await rm(scratch,{recursive:true,force:true});}
 }catch{
  signal.throwIfAborted();
  return {status:'unavailable',reason:'local_transcript_unavailable'} as const;
 }
}
