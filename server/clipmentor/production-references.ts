import type {ProjectDoc} from '../../src/editor/types';
import type {AgentToolSchema} from '../../src/agent/tool-schema';
import {segmentEvidenceKinds} from '../../src/clipmentor/source-breakdown';
import {digestValue} from '../agent-runs/store-values';

export const productionReferenceTool='read_clipmentor_references';
export const productionReferenceStop='production_reference_retry_no_progress';
export const productionReferenceKinds=['asset','evidence','frame','observation','source','item'] as const;
type Kind=(typeof productionReferenceKinds)[number];
type Row=Record<string,unknown>;
type Choice={id:string;label:string;kind:Kind;selection:number};

const row=(value:unknown):value is Row=>!!value&&typeof value==='object'&&!Array.isArray(value);
const selectionSchema={type:'integer',minimum:1,description:'Select the number from the current task reference list.'};
const pageSize=28;

export function resolveRegisteredId<T extends {id:string}>(value:unknown,rows:readonly T[]) {
 const exact=rows.find(entry=>entry.id===value);
 if(exact)return {entry:exact,completedPrefix:false};
 const candidates=typeof value==='string'&&value.length
  ?rows.filter(entry=>entry.id.startsWith(value)): [];
 if(candidates.length===1)return {entry:candidates[0],completedPrefix:true};
 return {code:candidates.length?'reference_ambiguous':'reference_not_registered',candidates:candidates.length?candidates:rows} as const;
}

const assetFields=new Set(['assetId','asset_id','sourceAssetId','source_asset_id','assetIds','asset_ids']);
function hostOwnedId(action:unknown,path:string[]){
 if(action!=='append'||path.length!==3||path[0]!=='records')return;
 return path[1]==='evidence'?'evidence_id':path[1]==='transcripts'?'source_id':undefined;
}
function referenceKind(field:string,value:Row,name:string,atRoot:boolean):Kind|undefined {
 if(assetFields.has(field))return 'asset';
 if(['source_id','source_ids','sourceId','sourceIds'].includes(field))return 'source';
 if(field==='observation_id')return 'observation';
 if(['frame_evidence_ids','frame_evidence_id'].includes(field)
  ||field==='source_frames'&&name==='edit_asset'&&typeof value.shot_ms==='string'
  ||field==='supporting_evidence_ids'&&value.kind==='visible_action')return 'frame';
 if(/^(?:[a-z]+_)*evidence_ids?$|^evidenceIds?$/.test(field))return 'evidence';
 if(atRoot&&name==='view_asset_frames'&&field==='itemId')return 'item';
 if(atRoot&&name==='revise_clipmentor_analysis'&&value.action==='revise'&&field==='id'){
  if(value.collection==='evidence')return 'evidence';
  if(value.collection==='transcripts')return 'source';
 }
}

/** Reference numbers are issued per author run and remain stable when earlier rows change. */
export function productionReferenceSelection(getDoc:()=>ProjectDoc,sourceId:string,stop:AbortController){
 const numbers=new Map<string,number>();
 const published=new Set<number>();
 const pending=new Map<number,{operation:string;shape:string;field:string;choices:readonly Choice[];boundChoices:Map<string,Set<string>>;selected:Map<string,string>;used:boolean}>();
 const failures=new Map<string,number>();
 const badTickets=new Map<string,string>();
 let nextRetry=1;
 function catalogue(kind:Kind,doc=getDoc(),timelineId=doc.activeTimelineId):Choice[]{
  const analysis=doc.clipMentorAnalysis;
  const assetRows=doc.assets.map(a=>({id:a.id,label:a.name}));
  let rows: Array<{id:string;label:string}>;
  switch(kind){
  case 'asset':rows=assetRows;break;
  case 'evidence':
  case 'frame':
   rows=(analysis?.evidence??[]).filter(e=>kind==='evidence'||e.kind==='source_frame')
    .filter(e=>e.call_status!=='failed').map(e=>({id:e.evidence_id,label:kind==='frame'?e.time_seconds+' 秒 · '+e.text:e.text}));
   break;
  case 'observation':rows=(analysis?.observations??[]).filter(o=>o.status==='images_returned')
   .map(o=>({id:o.observation_id,label:o.requested_times_seconds.join('、')+' 秒'}));break;
  case 'source':rows=[...assetRows,...(analysis?.transcripts??[]).map(t=>({id:t.source_id,label:t.origin})),
   ...(analysis?.audit??[]).filter(a=>a.action==='import_source_video_evidence'&&a.actor.executor==='production_host')
    .map(a=>({id:a.target_id,label:'已保存的原片视听回执'}))];break;
  case 'item':rows=(doc.timelines.find(t=>t.id===timelineId)?.items??[])
   .filter(i=>doc.assets.some(a=>a.id===i.sourceAssetId&&['image','video'].includes(a.kind)))
   .map(i=>({id:i.id,label:assetRows.find(a=>a.id===i.sourceAssetId)?.label??i.id}));break;
  }
  return [...new Map(rows.map(entry=>[entry.id,entry])).values()].map(({id,label})=>{
   const key=kind+'\0'+id;
   let selection=numbers.get(key);
   if(selection===undefined){selection=numbers.size+1;numbers.set(key,selection);}
   return {id,label:label.slice(0,100),kind,selection};
  });
 }
 function eligible(kind:Kind,name:string,field:string,args:Row,doc:ProjectDoc,record:Row={}):Choice[]{
  const timelineId=typeof args.timelineId==='string'?args.timelineId:doc.activeTimelineId;
  const choices=catalogue(kind,doc,timelineId);
  const assets=doc.assets;
  if(kind==='asset'){
   if(name==='view_asset_frames'&&field==='assetId'){
    const items=catalogue('item',doc,timelineId);
    const item=typeof args.itemId==='string'?resolveRegisteredId(args.itemId,items).entry:items.find(entry=>entry.selection===args.itemId);
    const bound=item&&doc.timelines.find(t=>t.id===timelineId)?.items.find(i=>i.id===item.id)?.sourceAssetId;
    return choices.filter(c=>bound?c.id===bound:assets.some(a=>a.id===c.id&&['image','video'].includes(a.kind)));
   }
   if(field==='assetId'&&['save_clipmentor_source_frame','read_clipmentor_analysis','revise_clipmentor_analysis','transcribe_clipmentor_source'].includes(name))
    return choices.filter(c=>c.id===sourceId&&assets.some(a=>a.id===c.id&&a.kind==='video'));
  }
  if(kind==='source'&&args.action==='revise'&&field==='id'){
   return choices.filter(c=>doc.clipMentorAnalysis?.transcripts.some(t=>t.source_id===c.id));
  }
  if(kind==='source'&&name==='revise_clipmentor_analysis'&&args.action==='revise'&&args.collection==='evidence'){
   const target=catalogue('evidence',doc).find(c=>c.selection===args.id&&published.has(c.selection));
   const existing=doc.clipMentorAnalysis?.evidence.find(e=>e.evidence_id===target?.id);
   if(existing?.observation_method==='saved_source_video_model_receipt')
    return choices.filter(c=>existing.source_ids.includes(c.id));
  }
  if(kind==='source'&&name==='revise_clipmentor_analysis'&&Array.isArray(record.source_ids)&&typeof record.kind==='string'){
   return choices.filter(c=>doc.clipMentorAnalysis?.transcripts.some(t=>t.source_id===c.id)
    ||record.kind==='operator_supplied'&&assets.some(a=>a.kind==='image'&&a.id===c.id));
  }
  if(kind==='frame'&&record.kind==='visible_action'){
   const observation=catalogue('observation',doc).find(c=>c.selection===record.observation_id&&published.has(c.selection));
   const frames=new Set(doc.clipMentorAnalysis?.observations?.find(o=>o.observation_id===observation?.id)?.frame_evidence_ids);
   return choices.filter(c=>frames.has(c.id));
  }
  const analysis=doc.clipMentorAnalysis;
  const range=record.source_range_seconds;
  if(analysis&&Array.isArray(range)&&range.length===2){
   if(kind==='frame'&&field==='source_frames')return choices.filter(c=>{
    const frame=analysis.evidence.find(e=>e.evidence_id===c.id)?.source_frame;
    return frame!==undefined&&frame/analysis.source.fps>=range[0]&&frame/analysis.source.fps<range[1];
   });
   const kinds=segmentEvidenceKinds[field as keyof typeof segmentEvidenceKinds] as readonly string[]|undefined;
   if(kind==='evidence'&&kinds)return choices.filter(c=>{
    const evidence=analysis.evidence.find(e=>e.evidence_id===c.id);
    if(!evidence||!kinds.includes(evidence.kind))return false;
    const window=evidence.source_range_seconds??(evidence.time_seconds===undefined?undefined:[evidence.time_seconds,evidence.time_seconds]);
    if(name==='edit_asset')return evidence.kind!=='source_frame'&&!!window&&window[0]<range[1]&&window[1]>range[0];
    return !window||window[1]>=range[0]&&window[0]<=range[1];
   });
  }
  return choices;
 }
 function list(kind:Kind,offset=0,timelineId?:string,retry?:number) {
  const choices=retry===undefined?catalogue(kind,getDoc(),timelineId):pending.get(retry)?.choices.filter(c=>c.kind===kind)??[];
  const page=choices.slice(offset,offset+pageSize);
  page.forEach(choice=>published.add(choice.selection));
  return {kind,choices:page,nextOffset:offset+pageSize<choices.length?offset+pageSize:null};
 }
 function assetChoices(){
  const choices=catalogue('asset');
  choices.forEach(choice=>published.add(choice.selection));
  return choices;
 }
 function modelSchema(schema:AgentToolSchema):AgentToolSchema {
  if(schema.name===productionReferenceTool)return schema;
  const properties={...schema.input_schema.properties};
  let hasReferences=false;
  for(const [field,value] of Object.entries(properties)){
   const kind=referenceKind(field,{},schema.name,true);
   if(kind&&row(value)) {
    hasReferences=true;
    const fixedSource=field==='assetId'&&['save_clipmentor_source_frame','read_clipmentor_analysis','revise_clipmentor_analysis'].includes(schema.name);
    const available=fixedSource?eligible(kind,schema.name,field,{},getDoc()).map(c=>c.selection):[];
    const selection=available.length?{...selectionSchema,enum:available}:selectionSchema;
    properties[field]=schema.name==='read_project'&&field==='assetId'
     ?{anyOf:[selection,{type:'array',items:selection,minItems:1}]}:value.type==='array'?{...value,items:selection}:selection;
   }
  }
  const nested=schema.name==='revise_clipmentor_analysis'||schema.name==='edit_item'||schema.name==='edit_asset';
  if(!hasReferences&&!nested)return schema;
  if(nested&&schema.name==='revise_clipmentor_analysis'){
   // The record is action-dependent. The host also enforces selected reference
   // values at every nested reference field before the original tool sees it.
   const keys=['asset_id','source_asset_id','evidence_id','observation_id','source_id'];
   const arrayKeys=['evidence_ids','source_ids','frame_evidence_ids','supporting_evidence_ids','visible_evidence_ids','claim_evidence_ids','interpretation_evidence_ids'];
   const references=Object.fromEntries([...keys.map(key=>[key,selectionSchema]),...arrayKeys.map(key=>[key,{type:'array',items:selectionSchema}])]);
   const record={type:'object',properties:references};
   const recordArray={type:'array',items:record};
   const point={type:'object',properties:{...references,teaching_basis:record}};
   const unit={type:'object',properties:{teaching_selection:{type:'object',properties:{
    creator_quality:{type:'object',properties:{analogy:{type:'object',properties:{evidence_ids:references.evidence_ids}}}},
   }}}};
   const {properties:recordsProperties,...records}=properties.records as {properties:Row}&Row;
   properties.record={...properties.record as Row,properties:{...references,segments:recordArray,points:{type:'array',items:point},units:{type:'array',items:unit},
    plan:{type:'object',properties:{...references,phases:recordArray,delivery_sections:{type:'array',items:{
     type:'object',properties:{...references,picture:record}}}}}}};
   properties.records={...records,properties:{...recordsProperties,
    evidence:{type:'array',items:{...record,not:{required:['evidence_id']}}},points:{type:'array',items:record},
    transcripts:{type:'array',items:{...record,not:{required:['source_id']}}}}};
   properties.id={anyOf:[properties.id,selectionSchema],
    description:'For an evidence or transcript revision choose the registered numeric reference. For a teaching unit use its existing record ID.'};
  }
  if(schema.name==='edit_asset'&&row(properties.props)){
   const references={type:'array',items:selectionSchema};
   properties.props={...properties.props,properties:{...properties.props.properties as Row,clipmentorCreatorStoryboard:{
    type:'object',properties:{rows:{type:'array',items:{type:'object',properties:{
     source_frames:references,visible_evidence_ids:references,claim_evidence_ids:references}}}},
   }}};
  }
  properties.referenceRetry={type:'integer',minimum:1,description:'Only reuse the issued number for a correction of the same failed operation.'};
  const referenceRevision=schema.name==='revise_clipmentor_analysis'?{allOf:[{
   if:{required:['action','collection'],properties:{action:{const:'revise'},collection:{enum:['evidence','transcripts']}}},
   then:{properties:{id:selectionSchema}},
  }]}:{};
  return {...schema,input_schema:{...schema.input_schema,properties,...referenceRevision}};
 }
 function resolveReferences(name:string,input:Row,callId:string) {
  if(name===productionReferenceTool)return {args:input};
  const {referenceRetry,...args}=input;
  const doc=getDoc();
  type Issue={field:string;code:string;value:unknown;choices:readonly Choice[];kind:Kind;boundChoices?:true};
  const issues:Issue[]=[];
  const selected=new Map<string,string>();
  const lookups=new Map<string,Choice[]>();
  const lookup=(kind:Kind,field:string,record:Row={})=>{
   const key=JSON.stringify([kind,field,record.kind,record.observation_id,record.source_range_seconds]);
   let choices=lookups.get(key);
   if(!choices){choices=eligible(kind,name,field,args,doc,record);lookups.set(key,choices);}
   return choices;
  };
  const shape=(entry:unknown,path:string[]=[]):unknown=>{
   if(Array.isArray(entry))return entry.map((item,index)=>shape(item,[...path,String(index)]));
   if(!row(entry))return entry;
   return Object.fromEntries(Object.entries(entry).flatMap(([field,value])=>{
    const kind=referenceKind(field,entry,name,path.length===0);
    if(name==='revise_clipmentor_analysis'&&field===hostOwnedId(args.action,path))return [];
    return [[field,kind?(Array.isArray(value)?value.map(()=>null):null):shape(value,[...path,field])]];
   }));
  };
  const convert=(entry:unknown,path:string[]=[]):unknown=>{
   if(Array.isArray(entry))return entry.map((value,index)=>convert(value,[...path,String(index)]));
   if(!row(entry))return entry;
   const newId=name==='revise_clipmentor_analysis'?hostOwnedId(args.action,path):undefined;
   const result=Object.fromEntries(Object.entries(entry).map(([field,value])=>{
    if(newId===field){
     issues.push({field:[...path,field].join('.'),code:'reference_host_owned',value,choices:[],kind:newId==='evidence_id'?'evidence':'source'});
     return [field,value];
    }
    const kind=referenceKind(field,entry,name,path.length===0);
    if(!kind)return [field,convert(value,[...path,field])];
    const choices=lookup(kind,field,entry);
    const choose=(provided:unknown,index?:number)=>{
     const target=[...path,field,...(index!==undefined?[String(index)]:[])].join('.');
     const choice=typeof provided==='number'&&published.has(provided)?choices.find(c=>c.selection===provided):undefined;
     if(choice){
      selected.set(target,choice.id);
      if(field==='source_frames')return doc.clipMentorAnalysis!.evidence.find(e=>e.evidence_id===choice.id)!.source_frame;
      return choice.id;
     }
     // Read-only diagnosis of legacy strings. Only the low-level compatibility
     // tool may execute them. A hosted author must choose a number.
     const legacy=name==='view_asset_frames'&&typeof provided==='string'
      ?resolveRegisteredId(provided,choices):undefined;
     issues.push({field:target,code:legacy?.code??(typeof provided==='number'?'reference_not_registered':'reference_selection_required'),value:provided,
      choices:legacy?.entry?[legacy.entry]:legacy?.candidates??choices,kind,
      ...(legacy?.entry||legacy?.code==='reference_ambiguous'?{boundChoices:true as const}:{})});
     return provided;
    };
    const converted=Array.isArray(value)?value.map((v,i)=>choose(v,i)):choose(value);
    return [field,name==='read_project'&&field==='assetId'&&Array.isArray(converted)?converted.join(','):converted];
   }));
   if(newId)result[newId]='author-'+path[1]+'-'+digestValue([callId,path]).slice(0,24);
   return result;
  };
  const normalized=convert(args) as Row;
  const missingAsset=name==='view_asset_frames'&&args.assetId===undefined&&args.itemId===undefined;
  if(missingAsset){
   issues.push({field:'assetId',code:'reference_selection_required',value:undefined,
    choices:lookup('asset','assetId'),kind:'asset'});
  }
  if(referenceRetry===undefined&&!issues.length)return {args:normalized};
  const operationShape=digestValue([name,shape(missingAsset?{...args,assetId:null}:args)]);
  const issued=typeof referenceRetry==='number'?pending.get(referenceRetry):undefined;
  const stopRetry=()=>stop.abort(new Error(productionReferenceStop));
  const diagnostic=(issue:Issue,operation:string,number:number|undefined,halt=false)=>{
   const candidates=issue.choices.slice(0,pageSize);
   candidates.forEach(choice=>published.add(choice.selection));
   return ({
   args,operation,
   failure:{error:issue.code,field:issue.field,referenceKind:issue.kind,
    ...(issue.value!==undefined?{provided:issue.value}:{}),
    candidates,candidateCount:issue.choices.length,
    ...(issues.length>1?{otherFields:issues.filter(other=>other!==issue).slice(0,pageSize).map(({field,kind,code})=>({field,kind,code}))}:{}),
    ...(number!==undefined&&issue.choices.length>pageSize?{next_read:{tool:productionReferenceTool,kind:issue.kind,offset:pageSize,referenceRetry:number}}:{}),
    ...(number!==undefined&&!halt?{referenceRetry:number}:{}),
    next_step:halt?'同一引用补调仍未通过，保留回执并停在当前检查点。':issue.code==='reference_host_owned'
     ?'新登记条目省略标识字段，由代码登记。用 referenceRetry 补调同一操作一次。'
     :'选择清单中的编号，保留同一操作的其余参数，并用 referenceRetry 补调一次。'},
   ...(halt?{stop:stopRetry}:{}),
   });
  };
  if(referenceRetry!==undefined){
   const mismatch={field:issued?.field??'referenceRetry',code:'reference_retry_binding_changed',value:referenceRetry,choices:[],kind:'asset' as const};
   if(!issued||issued.shape!==operationShape){
    const key=digestValue([name,input]);
    const prior=badTickets.get(key);
    badTickets.set(key,prior??callId);
    return diagnostic(mismatch,prior??callId,undefined,!!prior);
   }
   if(issued.used)return diagnostic(issues[0]??mismatch,issued.operation,undefined,true);
   issued.used=true;
   if(issues.length)return diagnostic(issues[0],issued.operation,undefined,true);
   if([...issued.selected].some(([field,id])=>selected.get(field)!==id)
    ||[...issued.boundChoices].some(([field,candidates])=>!candidates.has(selected.get(field)??'')))
    return diagnostic(mismatch,issued.operation,undefined,true);
   return {args:normalized,operation:issued.operation};
  }
  const issue=issues[0];
  const raw=digestValue([name,args,issue.field,issue.code]);
  const previous=failures.get(raw);
  if(previous!==undefined)return diagnostic(issue,pending.get(previous)!.operation,undefined,true);
  const retry=nextRetry++;
  const operation=callId;
  const boundChoices=new Map(issues.filter(item=>item.boundChoices)
   .map(item=>[item.field,new Set(item.choices.map(c=>c.id))]));
  pending.set(retry,{operation,shape:operationShape,field:issue.field,choices:issue.choices,boundChoices,selected,used:false});
  failures.set(raw,retry);
  return diagnostic(issue,operation,retry);
 }
 return {assetChoices,list,modelSchema,resolveReferences};
}
