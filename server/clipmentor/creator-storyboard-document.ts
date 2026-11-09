import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {ProjectDoc} from '../../src/editor/types';
import {runtimeProfile} from '../runtime-profile';

/** Content of the separate creator-facing document, never an editable timeline. */
export interface CreatorStoryboardDocument {
 source_sha256:string;
 rows:Array<{source_range_seconds:[number,number];source_frames:number[];shot_ms:string;information_ms:string;
  visible_evidence_ids:string[];claim_evidence_ids:string[]}>;
}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function validateCreatorDocument(doc:ProjectDoc,value:unknown):CreatorStoryboardDocument{
 const a=doc.clipMentorAnalysis,v=value as CreatorStoryboardDocument;
 if(!a?.source.sourceContentHash||!v||v.source_sha256!==a.source.sourceContentHash||!Array.isArray(v.rows)||!v.rows.length||v.rows.length>24)
  throw Error('storyboard_document_missing_or_wrong_source');
 let end=0;
 for(const row of v.rows){
  const range=row.source_range_seconds;
  if(!Array.isArray(range)||range.length!==2||range.some(n=>!Number.isFinite(n))||Math.abs(range[0]-end)>.01
   ||range[1]<=range[0]||range[1]>a.source.duration_seconds+.01||!Array.isArray(row.source_frames)||!row.source_frames.length||row.source_frames.length>2||new Set(row.source_frames).size!==row.source_frames.length
   ||row.source_frames.some(f=>!Number.isSafeInteger(f)||f<0||f/a.source.fps<range[0]||f/a.source.fps>=range[1]))
   throw Error('storyboard_document_range_or_frame_invalid');
  for(const key of ['shot_ms','information_ms'] as const)if(typeof row[key]!=='string'||!row[key].trim()||row[key].length>1200)
   throw Error('storyboard_document_copy_missing:'+key);
  for(const [key,kind]of [['visible_evidence_ids','visible_action'],['claim_evidence_ids','original_claim']] as const){
   if(!Array.isArray(row[key])||(kind==='visible_action'&&!row[key].length)||new Set(row[key]).size!==row[key].length)throw Error('storyboard_document_evidence_missing');
   for(const id of row[key]){
    const e=a.evidence.find(e=>e.evidence_id===id),r=e?.source_range_seconds;
    if(!e||e.kind!==kind||e.call_status==='failed'||!r||r.length!==2||!r.every(Number.isFinite)||r[1]<=range[0]||r[0]>=range[1])throw Error('storyboard_document_evidence_invalid:'+id);
   }
  }
  end=range[1];
 }
 if(Math.abs(end-a.source.duration_seconds)>.01)throw Error('storyboard_document_coverage_incomplete');
 return structuredClone(v);
}
function evidenceDigest(doc:ProjectDoc,content:CreatorStoryboardDocument){
 const ids=[...new Set(content.rows.flatMap(r=>[...r.visible_evidence_ids,...r.claim_evidence_ids]))].sort();
 return hash(ids.map(id=>{const e=doc.clipMentorAnalysis!.evidence.find(e=>e.evidence_id===id)!;
  return [id,e.kind,e.text,e.source_range_seconds,e.source_ids,e.call_status];}));
}
export const creatorDocumentHash=(content:CreatorStoryboardDocument)=>hash(content);
function documentFromSourceAsset(doc:ProjectDoc){
 return doc.assets.find(a=>a.id===doc.clipMentorAnalysis?.source.asset_id)?.props?.clipmentorCreatorStoryboard;
}
export function creatorDocumentHashFromAssets(doc:ProjectDoc){
 const value=documentFromSourceAsset(doc);return value?hash(validateCreatorDocument(doc,value)):undefined;
}
export function creatorDocumentFromSourceAsset(doc:ProjectDoc){
 const value=documentFromSourceAsset(doc);return value?validateCreatorDocument(doc,value):undefined;
}
export async function currentCreatorDocument(doc:ProjectDoc){
 try{return await loadCreatorStoryboardDocument(doc);}
 catch(error){if(isCreatorDocumentIssue(error))return null;throw error;}
}
export const isCreatorDocumentIssue=(error:unknown)=>error instanceof Error&&/^(?:storyboard_document_|storyboard_pdf_|storyboard_original_excerpt_changed)/.test(error.message);
function documentFile(sourceHash:string){
 if(!/^[a-f0-9]{64}$/.test(sourceHash))throw Error('storyboard_source_hash_invalid');
 return join(runtimeProfile().rootDir,'clipmentor-creator-storyboards',sourceHash+'.json');
}
/** Persist authored copy with the original evidence identity; never rewrites project/review state. */
export async function saveCreatorStoryboardDocument(doc:ProjectDoc,value:unknown){
 const content=validateCreatorDocument(doc,value),file=documentFile(content.source_sha256),temp=file+'.'+randomUUID()+'.tmp';
 await mkdir(join(runtimeProfile().rootDir,'clipmentor-creator-storyboards'),{recursive:true});
 try{await writeFile(temp,JSON.stringify({content,evidence_sha256:evidenceDigest(doc,content)}),{flag:'wx'});await rename(temp,file);}
 finally{await rm(temp,{force:true});}
 return hash(content);
}
export async function loadCreatorStoryboardDocument(doc:ProjectDoc){
 // Existing asset props are the authoring surface. No new blueprint field or author tool.
 const supplied=creatorDocumentFromSourceAsset(doc);
 if(supplied)return supplied;
 let saved:{content:unknown;evidence_sha256:string};
 try{saved=JSON.parse(await readFile(documentFile(doc.clipMentorAnalysis!.source.sourceContentHash!),'utf8'));}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw Error('storyboard_document_authoring_required');throw error;}
 const content=validateCreatorDocument(doc,saved.content);
 if(evidenceDigest(doc,content)!==saved.evidence_sha256)throw Error('storyboard_document_evidence_changed');
 return content;
}

/** Existing edit_asset is restricted to document copy during blueprint authoring. */
export function assertCreatorDocumentEdit(doc:ProjectDoc,args:Record<string,unknown>){
 const props=args.props as Record<string,unknown>|undefined;
 if(args.action!=='update'||args.assetId!==doc.clipMentorAnalysis?.source.asset_id
  ||Object.keys(args).some(k=>!['action','assetId','props'].includes(k))||!props
  ||Object.keys(props).length!==1||!('clipmentorCreatorStoryboard'in props))throw Error('blueprint_asset_edit_only_creator_document');
 return validateCreatorDocument(doc,props.clipmentorCreatorStoryboard);
}
