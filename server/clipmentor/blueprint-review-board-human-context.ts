/** Human-only reading context. No translation, matching judgment or review input. */
import type {readBlueprint} from '../../src/clipmentor/blueprint-lint';
import type {ReviewBoardRow} from './blueprint-review-board';
import type {ProjectDoc} from '../../src/editor/types';
import {labelTranslationsShape} from '../../src/clipmentor/author-translations';
type Data=ReturnType<typeof readBlueprint>;
export const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
export const array=(v:unknown):unknown[]=>Array.isArray(v)?v:[];
export const string=(v:unknown)=>typeof v==='string'?v:'';
const range=(v:unknown):v is [number,number]=>Array.isArray(v)&&v.length===2&&v.every(n=>typeof n==='number'&&Number.isFinite(n))&&v[0]>=0&&v[1]>v[0];
export const overlaps=(a:[number,number],b:[number,number])=>a[0]===a[1]?b[0]<=a[0]&&a[0]<b[1]:b[0]===b[1]?a[0]<=b[0]&&b[0]<a[1]:a[0]<b[1]&&b[0]<a[1];
export function sourceSpeech(data:Data,rows:ReviewBoardRow[]){
 return array(data.analysis.evidence).map(object).filter(e=>e.kind==='original_claim'&&string(e.text)&&range(e.source_range_seconds)
  && rows.some(r=>r.range&&overlaps(r.range,e.source_range_seconds as [number,number])))
  .sort((a,b)=>(a.source_range_seconds as number[])[0]-(b.source_range_seconds as number[])[0])
  .map(e=>({id:string(e.evidence_id),range:e.source_range_seconds as [number,number],ms:string(e.text),zh:string(e.meaning_zh).trim()}));
}
export function unitUnknowns(data:Data,id:string){
 const breakdown=object(data.analysis.source_breakdown),unit=array(breakdown.units).map(object).find(u=>u.unit_id===id);
 const ids=new Set([...array(unit?.original_segment_ids),...array(unit?.explanation_segment_ids)]);
 return [...new Set(array(breakdown.segments).map(object).filter(s=>ids.has(s.segment_id)).flatMap(s=>array(s.unknowns)).map(string).filter(Boolean))];
}
export function translatedLabels(data:Data,lineId:string){
 const raw=data.lines.find(l=>l.id===lineId)?.raw??{},labels=array(raw.labels).map(v=>typeof v==='string'?v:string(object(v).text)),given=raw.labels_zh;
 // Validate original positions before hiding empty text in the presentation.
 const invalid=(raw.labels!==undefined&&!Array.isArray(raw.labels))||labels.some(v=>!v.trim())||!labelTranslationsShape(given,labels);
 return{invalid,pairs:labels.map((ms,i)=>({ms,zh:invalid?'':string(Array.isArray(given)?given[i]:undefined).trim()})).filter(p=>p.ms.trim())};
}
export function stageTranslations(data:Data,row:ReviewBoardRow){
 const selected=data.selectedPlans.find(p=>p.unit.unit_id===row.unit_id),plan=object(selected?.resolved?.operational??selected?.plan);
 const cues=object(plan.viewer_stage_cues??object(plan.execution_plan).viewer_stage_cues);
 return(row.stage==='original'?[object(cues.original)]:array(cues.revisit).map(object).filter(c=>array(c.line_ids).some(id=>row.line_ids.includes(string(id)))))
  .filter(c=>string(c.text)).map(c=>({ms:string(c.text),zh:string(c.zh)}));
}
export function deliveryFacts(row:ReviewBoardRow,materials:ProjectDoc[]){
 const facts:Array<{id:string;text:string;provenance:string}>=[];
 for(const doc of materials)for(const unit of doc.clipMentorAnalysis?.blueprint??[]){
  const internal=object(object(unit).internal_review),plan=object(internal[string(internal.current_picture_plan)]);
  for(const s of array(plan.delivery_sections).map(object))if(row.line_ids.includes(string(object(s.line).line_id)))
   for(const id of array(s.evidence_ids)){
    const e=doc.clipMentorAnalysis?.evidence.find(e=>e.evidence_id===id&&e.kind==='operator_supplied');
    if(e&&!facts.some(f=>f.id===id&&f.text===e.text))facts.push({id:e.evidence_id,text:e.text,provenance:e.provenance??''});
   }
 }
 return facts;
}
