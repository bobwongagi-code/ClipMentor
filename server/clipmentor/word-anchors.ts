import {createHash} from 'node:crypto';
import {open} from 'node:fs/promises';
import type {MediaAsset,Timeline} from '../../src/editor/types';
import type {MinimaxSubtitleBinding} from '../../shared/voice-word-timing';
import {resolveUploadFile} from '../media-dir';
import {voiceDigest} from '../plugins/voice-word-timing';

type Row=Record<string,unknown>;
const row=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const TOKEN=/[\p{L}\p{M}\p{N}]+(?:['’-][\p{L}\p{M}\p{N}]+)*|[^\s\p{P}]/gu;
const tokens=(text:string)=>text.normalize('NFC').match(TOKEN)??[];
const same=(a:string[],b:string[])=>a.length===b.length&&a.every((s,i)=>s===b[i]);
type Word={index:number;text:string;start_seconds:number;end_seconds:number;start_frame:number;end_frame:number};
type Unavailable={status:'unavailable'|'conflict';reason:string};
type Placement={item_id:string;status:'ready';words:Array<{index:number;start_frame:number;end_frame:number}>}
 |{item_id:string;status:'unavailable';reason:string};
export type SpeechAnchors=Unavailable|{
 status:'ready';basis:'minimax_reported_word_times';independently_listened:false;
 authority:'timing_only_not_picture_or_review_approval';binding:MinimaxSubtitleBinding;
 words:Word[];caption_anchors:Array<{text:string;status:'ready';start_word:number;end_word:number;start_seconds:number;end_seconds:number}
  |{text:string;status:'unavailable';reason:'phrase_missing_or_ambiguous'}>;
 placements:Placement[];
};
const fail=(reason:string):never=>{throw Error(reason);};
function boundary(value:unknown,limit:number):number{
 if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>limit)fail('word_time_outside_audio');
 return value as number;
}
function checkOffsets(value:Row,begin:string,end:string,text:string,expected:string,precedingWords:number,insideToken:ReadonlySet<number>){
 if(value[begin]===undefined&&value[end]===undefined)return;
 const a=value[begin],b=value[end];
 if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||Number(a)<0||Number(b)<=Number(a)||Number(b)>text.length
  ||insideToken.has(Number(a))||insideToken.has(Number(b))
  ||tokens(text.slice(0,Number(a))).length!==precedingWords
  ||!same(tokens(text.slice(Number(a),Number(b))),tokens(expected)))fail('subtitle_character_offset_conflict');
}
/** Some MiniMax responses label subword/space fragments as timestamped_words.
 * Merge only exact original-text spans with observed endpoints; never interpolate. */
function normalizeProviderFragments(raw:unknown,text:string):unknown{
 if(!Array.isArray(raw)||!raw.some(e=>row(e)&&'pronounce_text' in e))return raw;
 let lastOffset=0;
 return raw.map(entry=>{
  if(!row(entry)||Object.keys(entry).some(k=>!['text','pronounce_text','text_begin','text_end','pronounce_text_begin','pronounce_text_end','is_final_segment','time_begin','time_end','timestamped_words'].includes(k))
   ||typeof entry.text!=='string'||!Array.isArray(entry.timestamped_words))fail('word_subtitle_shape_unknown');
  const fragments=entry.timestamped_words as Row[];
  let previousEnd=Number(entry.time_begin);
  for(const f of fragments){
   if(!row(f)||Object.keys(f).some(k=>!['word','word_begin','word_end','pronounce_word','pronounce_word_begin','pronounce_word_end','time_begin','time_end'].includes(k))
    ||typeof f.word!=='string'||!Number.isSafeInteger(f.word_begin)||!Number.isSafeInteger(f.word_end))fail('subtitle_character_offset_conflict');
   const begin=Number(f.word_begin),end=Number(f.word_end);
   if(begin<lastOffset||end<=begin||end>text.length||text.slice(begin,end)!==f.word||text.slice(lastOffset,begin).trim())fail('subtitle_character_offset_conflict');
   if(typeof f.time_begin!=='number'||typeof f.time_end!=='number'||!Number.isFinite(f.time_begin)||!Number.isFinite(f.time_end)
    ||f.time_begin<previousEnd||f.time_end<=f.time_begin||f.time_end>Number(entry.time_end))fail('word_order_or_window_invalid');
   previousEnd=Number(f.time_end);lastOffset=end;
  }
  if(!fragments.length)fail('word_timestamps_missing');
  const begin=Number(fragments[0].word_begin),end=Number(fragments.at(-1)!.word_end);
  const segment=text.slice(begin,end);
  if(!same(tokens(segment),tokens(entry.text)))fail('subtitle_segment_text_conflict');
  let fragmentIndex=0;
  const words=Array.from(segment.matchAll(TOKEN)).map(match=>{
   const a=begin+match.index,b=a+match[0].length;
   while(fragmentIndex<fragments.length&&Number(fragments[fragmentIndex].word_end)<=a)fragmentIndex++;
   const parts:Row[]=[];
   while(fragmentIndex<fragments.length&&Number(fragments[fragmentIndex].word_begin)<b)parts.push(fragments[fragmentIndex++]);
   if(!parts.length||Number(parts[0].word_begin)!==a||Number(parts.at(-1)!.word_end)!==b)fail('word_granularity_invalid');
   let cursor=a;for(const f of parts){if(Number(f.word_begin)!==cursor)fail('subtitle_character_offset_conflict');cursor=Number(f.word_end);}
   return{word:match[0],word_begin:a,word_end:b,time_begin:parts[0].time_begin,time_end:parts.at(-1)!.time_end};
  });
  return{text:segment,time_begin:entry.time_begin,time_end:entry.time_end,timestamped_words:words};
 });
}
/** No ASR, fuzzy alignment, missing-word interpolation or invented point times. */
function wordTimes(raw:unknown,text:string,duration:number,fps:number):Word[]{
 raw=normalizeProviderFragments(raw,text);
 if(!Array.isArray(raw)||!raw.length)fail('word_subtitle_shape_unknown');
 const expected=tokens(text),actual:string[]=[],segmentText:string[]=[],words:Word[]=[];
 // Character offsets must fall between complete tokens. Merely counting a prefix's
 // tokens accepts e.g. the last 'a' of 'lama' as the next word 'a'. Punctuation may
 // still be included in the supplier's span, so do not require exact lexical ends.
 const insideToken=new Set<number>();
 for(const match of text.matchAll(TOKEN))for(let i=match.index+1;i<match.index+match[0].length;i++)insideToken.add(i);
 let lastSegmentEnd=0,lastWordEnd=0;
 for(const entry of raw as unknown[]){
  if(!row(entry)||Object.keys(entry).some(k=>!['text','text_begin','text_end','time_begin','time_end','timestamped_words'].includes(k))
   ||typeof entry.text!=='string')fail('word_subtitle_shape_unknown');
  const segment=entry as Row,segmentStart=boundary(segment.time_begin,duration*1000),segmentEnd=boundary(segment.time_end,duration*1000);
  if(segmentStart<lastSegmentEnd||segmentEnd<=segmentStart)fail('subtitle_segment_order_invalid');
  checkOffsets(segment,'text_begin','text_end',text,String(segment.text),actual.length,insideToken);
  if(!Array.isArray(segment.timestamped_words)||!segment.timestamped_words.length)fail('word_timestamps_missing');
  const thisText:string[]=[];
  for(const value of segment.timestamped_words as unknown[]){
   if(!row(value)||Object.keys(value).some(k=>!['word','word_begin','word_end','time_begin','time_end'].includes(k))
    ||typeof value.word!=='string')fail('word_subtitle_shape_unknown');
   const w=value as Row,lexical=tokens(String(w.word));
   if(lexical.length!==1)fail('word_granularity_invalid');
   const start=boundary(w.time_begin,duration*1000),end=boundary(w.time_end,duration*1000);
   if(start<segmentStart||end>segmentEnd||start<lastWordEnd||end<=start)fail('word_order_or_window_invalid');
   checkOffsets(w,'word_begin','word_end',text,String(w.word),actual.length,insideToken);
   actual.push(lexical[0]!);thisText.push(lexical[0]!);
   const startFrame=Math.floor(start*fps/1000),endFrame=Math.ceil(end*fps/1000);
   if(!Number.isSafeInteger(startFrame)||!Number.isSafeInteger(endFrame)||endFrame<=startFrame)fail('word_frame_domain_invalid');
   words.push({index:words.length,text:String(w.word),start_seconds:start/1000,end_seconds:end/1000,
    start_frame:startFrame,end_frame:endFrame});
   lastWordEnd=end;
  }
  if(!same(thisText,tokens(String(segment.text))))fail('subtitle_segment_text_conflict');
  segmentText.push(...tokens(String(segment.text)));lastSegmentEnd=segmentEnd;
 }
 if(!expected.length||!same(expected,actual)||!same(expected,segmentText))fail('subtitle_current_text_conflict');
 return words;
}

/** Cache only within one preparation; a new snapshot/read rechecks the actual files. No network hydration. */
export function createSpeechAnchorReader(){
 const cache=new Map<string,Promise<{sha256:string;bytes?:Buffer}>>();
 const local=(src:string,subtitle:boolean)=>{
  const key=`${subtitle}:${src}`;
  if(!cache.has(key))cache.set(key,(async()=>{
   if(!src.startsWith('/media/uploads/'))fail('timing_local_file_required');
   const file=resolveUploadFile(src.slice('/media/uploads/'.length))??fail('timing_file_missing');
   const handle=await open(file,'r');
   try{
    const info=await handle.stat(),limit=subtitle?5_000_000:256_000_000;
    if(!info.isFile()||!info.size||info.size>limit)fail('timing_file_size_invalid');
    if(subtitle){const bytes=await handle.readFile();if(!bytes.length||bytes.length>limit)fail('timing_file_size_invalid');return{sha256:voiceDigest(bytes),bytes};}
    const digest=createHash('sha256');let bytes=0;
    for await(const chunk of handle.createReadStream({autoClose:false})){
     bytes+=chunk.length;if(bytes>limit)fail('timing_file_size_invalid');digest.update(chunk);
    }
    if(bytes!==info.size)fail('timing_file_size_invalid');
    return{sha256:digest.digest('hex')};
   }finally{await handle.close();}
  })());
  return cache.get(key)!;
 };
 return async(asset:MediaAsset,text:string,duration:number,timeline:Timeline,captions:readonly string[]):Promise<SpeechAnchors|undefined>=>{
  const props=asset.props;
  // Keep legacy handoffs byte-compatible. Absent speech_anchors is explicitly unavailable, never measured.
  if(!props?.minimaxSubtitlePath&&!props?.minimaxSubtitleBinding)return undefined;
  if(!row(props.minimaxSubtitleBinding))return{status:'unavailable',reason:'word_subtitle_provenance_missing'};
  const b=props.minimaxSubtitleBinding,g=props.generation as Row|undefined;
  if(Object.keys(b).some(k=>!['version','provider','subtitleType','subtitlePath','subtitleSha256','audioSha256','textSha256','durationSeconds'].includes(k))
   ||asset.kind!=='audio'||b.version!==1||b.provider!=='minimax'||b.subtitleType!=='word'||props.minimaxSubtitleType!=='word'
   ||b.subtitlePath!==props.minimaxSubtitlePath||typeof b.subtitlePath!=='string'
   ||!hash(b.subtitleSha256)||!hash(b.audioSha256)||!hash(b.textSha256)
   ||b.textSha256!==voiceDigest(text)||b.durationSeconds!==duration||!Number.isFinite(duration)||duration<=0
   ||!Number.isFinite(timeline.fps)||timeline.fps<=0||g?.provider!=='minimax'||g.text!==text||g.speed!==1
   ||g.durationSeconds!==duration||asset.sourceContentHash!==b.audioSha256
   ||!Number.isSafeInteger(asset.durationInFrames)||Math.abs(asset.durationInFrames-duration*timeline.fps)>1)
   return{status:'conflict',reason:'word_subtitle_binding_conflict'};
  try{
   const [sound,subtitle]=await Promise.all([local(asset.src,false),local(b.subtitlePath,true)]);
   if(sound.sha256!==b.audioSha256||subtitle.sha256!==b.subtitleSha256)return{status:'conflict',reason:'word_subtitle_file_changed'};
   const words=wordTimes(JSON.parse(subtitle.bytes!.toString('utf8')),text,duration,timeline.fps);
   const lexical=words.map(w=>tokens(w.text)[0]!);
   const caption_anchors:Extract<SpeechAnchors,{status:'ready'}>['caption_anchors']=captions.map(caption=>{
    const phrase=tokens(caption),starts=lexical.flatMap((_,i)=>phrase.length&&same(lexical.slice(i,i+phrase.length),phrase)?[i]:[]);
    if(starts.length!==1)return{text:caption,status:'unavailable',reason:'phrase_missing_or_ambiguous'};
    const start=starts[0],end=start+phrase.length-1;
    return{text:caption,status:'ready',start_word:start,end_word:end,start_seconds:words[start].start_seconds,end_seconds:words[end].end_seconds};
   });
   const placements:Placement[]=timeline.items.filter(i=>i.kind==='audio'&&i.sourceAssetId===asset.id).map(item=>{
    const track=timeline.tracks?.[item.track];
    if(item.src!==asset.src||(item.playbackRate??1)!==1||(item.srcInFrame??0)!==0
     ||item.sourceContentHash&&item.sourceContentHash!==b.audioSha256
     ||item.deletedWordIdx?.length||item.silenceFrames!==undefined||Object.keys(item.gapCapsMs??{}).length
     ||item.transcriptPlayOrder!==undefined||item.denoisedSrc&&item.denoisedSrc!==asset.src||item.keyframes?.volume?.length
     ||!Number.isSafeInteger(item.startFrame)||item.startFrame<0||!Number.isSafeInteger(item.durationInFrames)
     ||!Number.isSafeInteger(item.startFrame+words.at(-1)!.end_frame)
     ||item.durationInFrames<words.at(-1)!.end_frame||track?.muted||track?.hidden
     ||!Number.isFinite(item.volume??1)||(item.volume??1)<=0)return{item_id:item.id,status:'unavailable',reason:'audio_instance_trimmed_retimed_or_inaudible'};
    return{item_id:item.id,status:'ready',words:words.map(w=>({index:w.index,start_frame:item.startFrame+w.start_frame,end_frame:item.startFrame+w.end_frame}))};
   });
   return{status:'ready',basis:'minimax_reported_word_times',independently_listened:false,authority:'timing_only_not_picture_or_review_approval',
    binding:b as unknown as MinimaxSubtitleBinding,words,caption_anchors,placements};
  }catch(error){
   // Closed diagnostics only. Raw provider content and file paths are not executor instructions.
   const known=['timing_local_file_required','timing_file_missing','timing_file_size_invalid','word_subtitle_shape_unknown','word_time_outside_audio',
    'subtitle_segment_order_invalid','subtitle_character_offset_conflict','word_timestamps_missing','word_granularity_invalid',
    'word_order_or_window_invalid','word_frame_domain_invalid','subtitle_segment_text_conflict','subtitle_current_text_conflict'];
   return{status:'unavailable',reason:error instanceof Error&&known.includes(error.message)?error.message:'word_subtitle_unreadable'};
  }
 };
}
