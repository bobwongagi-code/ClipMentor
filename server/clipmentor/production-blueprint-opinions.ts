import type {ProjectDoc} from '../../src/editor/types';
import type {BlueprintOpinion,BlueprintOpinionConfirmation,BlueprintOpinionDifference,BlueprintOpinionPlacement} from '../../shared/clipmentor-blueprint-opinions';
import {BLUEPRINT_OPINION_MAX_LENGTH} from '../../shared/clipmentor-blueprint-opinions';
import {picturePhaseLineIds} from '../../src/clipmentor/blueprint-picture-notices';
import {readBlueprint} from '../../src/clipmentor/blueprint-lint';
import {deliverySectionsFromDoc} from '../../src/clipmentor/delivery-bindings';
import {sourceSpeech} from './blueprint-review-board-human-context';
import {digestValue} from '../agent-runs/store-values';

const row=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const segmenter=new Intl.Segmenter('ms',{granularity:'sentence'});
const sentences=(value:unknown)=>typeof value==='string'?[...segmenter.segment(value)].map(entry=>entry.segment.trim()).filter(Boolean):[];
const spokenWithMeaning=(lines:Array<{narration_ms?:unknown;zh?:unknown;meaning_zh?:unknown}>)=>lines.flatMap((line,block)=>{
 const rawMeaning=line.zh??line.meaning_zh;
 const spoken=sentences(line.narration_ms),meaning=sentences(rawMeaning);
 return spoken.map((text,index)=>({text,block,meaning:spoken.length===meaning.length?meaning[index]:undefined,
  blockMeaning:spoken.length!==meaning.length&&typeof rawMeaning==='string'?rawMeaning:undefined}));
});
const basicNumber='[0-9０-９一二三四五六七八九十两]+';
const ordinal=(value:string)=>{
 const normalized=value.normalize('NFKC');
 if(/^\d+$/.test(normalized))return Number(normalized);
 const digits='一二三四五六七八九';
 const digit=(letter:string)=>letter==='两'?2:digits.indexOf(letter)+1;
 if(!value.includes('十'))return value.length===1?digit(value):NaN;
 const [left,right,...rest]=value.split('十');
 return rest.length||left.length>1||right.length>1?NaN:10*(left?digit(left):1)+(right?digit(right):0);
};
const namedGroups=new RegExp(`第\\s*(${basicNumber})\\s*组`,'gu');
const namedSentences=new RegExp(`第\\s*(${basicNumber})\\s*句`,'gu');
const wholeWords=/(?:整体|全片|整份蓝图)/u;
const negativeChange=/不(?:要|用)?(?:改|动|删|换|重写|调整)|别(?:动|改|删|换|重写|调整)/gu;
const keepWords=/(?<!不要)(?<!别)(?<!不)保留|不(?:要|用)?(?:改|动|删|换|重写|调整)|别(?:动|改|删|换|重写|调整)|原样|不变|维持/u;
const praiseWords=/很好|挺好|不错|好极了|很棒|真棒|赞|👍|👏|(?<!不)认可|喜欢|满意|可以|没问题|通过|还行|^好[。！!]?$/u;
const praiseOnly=/^(?:(?:这|本)组|整体|全片|整份蓝图|第?\s*[0-9０-９一二三四五六七八九十两]+\s*[组句]|片头|片尾|这句|这个|做得|写得|讲得|都|的|很|真|我|讲解|口播|节奏|画面|字幕|理解|没问题|通过|可以|认可|喜欢|满意|好极了|好|不错|棒|赞|挺|还行|啊|呀|呢|👍|👏|，|、|。|！|!|,|\s)+$/u;
const changeWords=/改|重做|重写|调整|删|去掉|去除|补|换|增加|缩短|压短|精简|简化|润色|有点绕|太绕|过长|太长|短一点|短点|啰[唆嗦]|不顺/u;
const mentions=(pattern:RegExp,text:string)=>[...text.matchAll(pattern)].map(m=>ordinal(m[1]));
const wantsChange=(text:string)=>changeWords.test(text.replace(negativeChange,''));
const isPraise=(text:string)=>praiseWords.test(text)&&praiseOnly.test(text);
const deletesSentence=new RegExp(`^(?:请)?(?:删掉|删除|去掉|去除)\\s*第\\s*${basicNumber}\\s*句$|^第\\s*${basicNumber}\\s*句\\s*(?:删掉|删除|去掉|去除)$`,'u');

function captureBlueprintOpinions(doc:ProjectDoc){
 const analysis=doc.clipMentorAnalysis;
 const breakdown=analysis?.source_breakdown;
 const data=readBlueprint(doc);
 const units=data.selectedPlans.flatMap(({unit,plan,candidate_id,resolved})=>{
  if(typeof unit.unit_id!=='string')return [];
  const saved=analysis?.blueprint.find(value=>value.unit_id===unit.unit_id);
  const internal=row(unit.internal_review)?unit.internal_review:undefined;
  const candidate=internal?.[candidate_id];
  const lines=row(candidate)&&Array.isArray(candidate.lines)?candidate.lines.filter(row):[];
  const phases=resolved?.phases??[];
  const lineById=new Map(lines.map(line=>[line.id??line.line_id,line]));
  const playbackIds=new Set(phases.filter(phase=>phase.mode==='explanation'||phase.mode===undefined&&typeof phase.line_id==='string')
   .flatMap(picturePhaseLineIds));
  const playback=[...playbackIds].map(id=>lineById.get(id)).filter(row);
  const speech=sourceSpeech(data,phases.map(phase=>{
   const range=phase.source_range_seconds??phase.source_seconds;
   return {range:Array.isArray(range)&&range.length===2?range as [number,number]:null};
  }));
  const base=breakdown?.units.find(value=>value.unit_id===unit.unit_id);
  const points=breakdown?.points.filter(point=>base?.coverage.some(item=>item.point_id===point.point_id)
   ||Array.isArray(unit.point_ids)&&unit.point_ids.includes(point.point_id))??[];
  const segments=breakdown?.segments.filter(segment=>base?.original_segment_ids.includes(segment.segment_id)
   ||base?.explanation_segment_ids.includes(segment.segment_id)||points.some(point=>point.segment_ids.includes(segment.segment_id)))??[];
  const evidence=analysis?.evidence.filter(item=>points.some(point=>point.teaching_basis?.evidence_ids.includes(item.evidence_id))
   ||segments.some(segment=>[...segment.visible_evidence_ids,...segment.claim_evidence_ids,...segment.interpretation_evidence_ids].includes(item.evidence_id)));
  const {delivery_sections:_delivery,script_candidate_id:_candidate,status:_status,review_status:_review,production_allowed:_allowed,base_analysis_revision:_rev,...picture}=plan;
  return [{id:unit.unit_id,topic:saved?.intent_zh,lines:spokenWithMeaning(playback),
   digest:digestValue({intent:saved?.intent_zh,guidance:saved?.line_guidance,base,points,segments,evidence,lines,picture,phases,speech,pointIds:unit.point_ids})}];
 });
 const sections=deliverySectionsFromDoc(doc).sort((a,b)=>Number(b.kind==='performance_opening')-Number(a.kind==='performance_opening'));
 return {units,overall:{title:analysis?.product?.name,
  lines:spokenWithMeaning(sections.map(section=>section.line)),
  digest:digestValue({sections,order:units.map(unit=>unit.id),product:analysis?.product,source:analysis?.source,scope:breakdown?.review_scope}),
 }};
}
type Snapshot=ReturnType<typeof captureBlueprintOpinions>;
type Compiled=BlueprintOpinion&{label:string;edits:boolean;change:string;keep:Array<{number:number;text:string;meaning?:string;blockMeaning?:string}>;remove?:number[]};
export type BlueprintOpinionRecord={
 revision:string;boardIdentity:string;token:string;opinions:Compiled[];confirmed:boolean;before:Snapshot;
 rejectedWrites?:string[];
 differences?:{overall?:BlueprintOpinionDifference;groups:BlueprintOpinionDifference[]};
};

export function prepareBlueprintOpinions(doc:ProjectDoc,input:unknown,revision:string,boardIdentity:string){
 const before=captureBlueprintOpinions(doc);
 if(!Array.isArray(input)||!input.length||input.length>before.units.length+1)throw Error('blueprint_opinion_binding_invalid');
 const labels=before.units.map(({id,topic},index)=>({id,label:`第 ${index+1} 组${topic?' · '+topic:''}`}));
 const seen=new Set<string|null>();
 let total=0;
 for(const entry of input){
  if(!row(entry)||typeof entry.text!=='string'||!entry.text.trim()||entry.text.length>BLUEPRINT_OPINION_MAX_LENGTH||(total+=entry.text.length)>7200
   ||Object.keys(entry).some(key=>key!=='unitId'&&key!=='text'&&key!=='keepPlacement')
   ||entry.unitId!==null&&(typeof entry.unitId!=='string'||!labels.some(unit=>unit.id===entry.unitId))
   ||seen.has(entry.unitId as string|null)||entry.keepPlacement!==undefined&&entry.keepPlacement!==true)
   throw Error('blueprint_opinion_binding_invalid');
  seen.add(entry.unitId as string|null);
 }
 const opinions=input as BlueprintOpinion[];
 const placements=opinions.flatMap<BlueprintOpinionPlacement>((entry,index)=>{
  const targets=[...new Set(mentions(namedGroups,entry.text))];
  if(targets.some(number=>!labels[number-1]))throw Error('意见提到的组号不在当前蓝图。');
  if(entry.keepPlacement)return [];
  const other=targets.find(number=>labels[number-1]?.id!==entry.unitId);
  if(other!==undefined){
   if(targets.length>1||wholeWords.test(entry.text))return [{index,unitId:entry.unitId,label:'多个位置',multiple:true}];
   const target=labels[other-1];
   return [{index,unitId:target.id,label:target.label}];
  }
  return entry.unitId!==null&&wholeWords.test(entry.text)?[{index,unitId:null,label:'整体意见'}]:[];
 });
 if(placements.length)return {placements};
 const compiled:Compiled[]=opinions.map(entry=>{
  const label=labels.find(unit=>unit.id===entry.unitId)?.label??'整体意见';
  const clauses=entry.text.split(/[，,。；;\n]+|但是|不过|但(?=第)/u).map(text=>text.trim()).filter(Boolean);
  const changes=clauses.filter(wantsChange);
  const retained=(text:string)=>keepWords.test(text)||isPraise(text);
  const saysKeep=clauses.some(retained);
  const mixed=saysKeep&&changes.length>0;
  if(saysKeep&&clauses.some(text=>wantsChange(text)?retained(text):!retained(text)))
   throw Error(`${label}，请写清希望保留和修改的内容。`);
  const edits=changes.length>0||!saysKeep;
  const actual=before.units.find(unit=>unit.id===entry.unitId)?.lines??before.overall.lines;
  const change=changes.join('，')||entry.text;
  if(!mixed)return {...entry,label,edits,change,keep:[]};
  const revise=[...new Set(changes.flatMap(text=>mentions(namedSentences,text)))];
  const explicitKeep=clauses.filter(text=>retained(text)&&!wantsChange(text)).flatMap(text=>mentions(namedSentences,text));
  if(!revise.length||changes.some(text=>!mentions(namedSentences,text).length)||[...revise,...explicitKeep].some(number=>!actual[number-1])
   ||explicitKeep.some(number=>revise.includes(number))||revise.length>=actual.length)
   throw Error(`${label}，请写清要改的是第几句。`);
  const remove=[...new Set(changes.filter(text=>deletesSentence.test(text)).flatMap(text=>mentions(namedSentences,text)))];
  const changedBlocks=new Set(revise.map(number=>actual[number-1].block));
  const keep=actual.flatMap(({block,text,meaning,blockMeaning},index)=>revise.includes(index+1)?[]:[
   {number:index+1,text,meaning,blockMeaning:changedBlocks.has(block)?undefined:blockMeaning},
  ]);
  return {...entry,label,edits:true,change,keep,...(remove.length?{remove}:{})};
 });
 const token=digestValue({revision,boardIdentity,compiled,before});
 const confirmationRows=compiled.filter(entry=>entry.keep.length).map(entry=>({
  label:entry.label,keep:entry.keep.map(({number,text,meaning,blockMeaning},index)=>{
   const shownMeaning=meaning??(blockMeaning!==entry.keep[index-1]?.blockMeaning?blockMeaning:undefined);
   return `第 ${number} 句 ${text}${shownMeaning?'（'+shownMeaning+'）':''}`;
  }),change:entry.change,
 }));
 const confirmation:BlueprintOpinionConfirmation|undefined=confirmationRows.length?{token,rows:confirmationRows}:undefined;
 const record:BlueprintOpinionRecord={revision,boardIdentity,token,opinions:compiled,confirmed:false,before};
 return {record,confirmation,placements:[]};
}

export function assertBlueprintOpinionScope(record:BlueprintOpinionRecord,doc:ProjectDoc){
 const after=captureBlueprintOpinions(doc);
 const allowed=record.opinions.filter(entry=>entry.edits);
 for(const entry of allowed){
  if(!entry.keep.length)continue;
  if(!record.confirmed)throw Error('blueprint_opinion_confirmation_required');
  const actual=after.units.find(unit=>unit.id===entry.unitId)?.lines??(entry.unitId===null?after.overall.lines:[]);
  const before=record.before.units.find(unit=>unit.id===entry.unitId)?.lines??record.before.overall.lines;
  const remove=entry.remove??[];
  const changed=entry.keep.find(sentence=>{
   const line=actual[sentence.number-1-remove.filter(number=>number<sentence.number).length];
   return line?.text!==sentence.text||sentence.meaning!==undefined&&line.meaning!==sentence.meaning
    ||sentence.blockMeaning!==undefined&&line.blockMeaning!==sentence.blockMeaning;
  });
  if(changed)throw Error(`blueprint_opinion_scope_locked: ${entry.label}第 ${changed.number} 句已确认保留。`);
  if(actual.length!==before.length-remove.length)throw Error(`blueprint_opinion_scope_locked: ${entry.label}只可修改已确认的句子。`);
 }
 if(digestValue(after.units.map(unit=>unit.id))!==digestValue(record.before.units.map(unit=>unit.id)))
  throw Error('blueprint_opinion_scope_groups: 本次意见的讲解组顺序或数量被改动。');
 for(const [index,unit] of record.before.units.entries()){
  if(!allowed.some(entry=>entry.unitId===unit.id)&&unit.digest!==after.units[index].digest)
   throw Error(`blueprint_opinion_scope_group: 第 ${index+1} 组未收到修改意见。`);
 }
 if(!allowed.some(entry=>entry.unitId===null)&&after.overall.digest!==record.before.overall.digest)
  throw Error('blueprint_opinion_scope_overall: 整体、片头或片尾未收到修改意见。');
 return after;
}

export function guardBlueprintOpinionWrite(record:BlueprintOpinionRecord,doc:ProjectDoc){
 try{assertBlueprintOpinionScope(record,doc);}
 catch(error){
  if(!(error instanceof Error))throw error;
  if(record.rejectedWrites?.includes(error.message))throw Error('blueprint_repair_no_progress '+error.message);
  record.rejectedWrites=[...(record.rejectedWrites??[]),error.message];
  throw error;
 }
}

export function blueprintOpinionDifferences(record:BlueprintOpinionRecord,doc:ProjectDoc){
 const after=assertBlueprintOpinionScope(record,doc);
 const readable=(line:Snapshot['overall']['lines'][number]|undefined)=>line?line.text+((line.meaning??line.blockMeaning)?'（'+(line.meaning??line.blockMeaning)+'）':''):'';
 const difference=(label:string,before:Snapshot['overall']['lines'],next:Snapshot['overall']['lines'],structural:boolean,remove:number[]=[]):BlueprintOpinionDifference=>{
  const afterAt=(index:number)=>remove.includes(index+1)?undefined:next[index-remove.filter(number=>number<=index).length];
  const changes=Array.from({length:Math.max(before.length,next.length)},(_,index)=>({
   before:readable(before[index]),after:readable(afterAt(index)),
  })).filter(line=>line.before!==line.after);
  if(!changes.length&&structural)changes.push({before:'原画面或安排',after:'已更新画面或安排'});
  return {label,changes,kept:before.flatMap((line,index)=>readable(line)===readable(afterAt(index))?[readable(line)]:[])};
 };
 const groups=record.before.units.flatMap((unit,index)=>{
  const next=after.units[index];
  const entry=record.opinions.find(opinion=>opinion.unitId===unit.id&&opinion.edits);
  return entry?[difference(entry.label,unit.lines,next.lines,unit.digest!==next.digest,entry.remove)]:[];
 });
 if(!record.opinions.some(entry=>entry.unitId===null&&entry.edits))return {groups};
 const titleChanged=record.before.overall.title!==after.overall.title;
 const overall=difference('整体意见',record.before.overall.lines,after.overall.lines,
  !titleChanged&&record.before.overall.digest!==after.overall.digest,record.opinions.find(entry=>entry.unitId===null)?.remove);
 if(titleChanged)overall.changes.unshift({before:record.before.overall.title??'',after:after.overall.title??''});
 return {overall,groups};
}
