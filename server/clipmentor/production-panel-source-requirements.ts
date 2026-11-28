import {digestValue} from '../agent-runs/store-values';
import {sourceTeachingCriterion} from '../../shared/clipmentor-handoff';
import {isCreatorConfirmedReference,type CreatorConfirmedReference} from './production-creator-quality';
import {readFile,mkdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {runtimeProfile} from '../runtime-profile';
import {atomicWriteFile} from '../plugins/project-store-durable';
import {bindPanelSourceCriteria} from './production-source-policy';

type MaterialBinding={id:string;sourceContentHash?:string};

function reusableDeclarationPath(source:MaterialBinding,sales:MaterialBinding){
 const original=source.sourceContentHash,performance=sales.sourceContentHash;
 const sha=/^[a-f0-9]{64}$/u;
 if(!original||!performance||!sha.test(original)||!sha.test(performance))return;
 return join(runtimeProfile().rootDir,'clipmentor-source-requirements','same-materials',original+'-'+performance+'.json');
}

async function readDeclaration(file:string){
 return readFile(file,'utf8').then(bytes=>JSON.parse(bytes)).catch((error:NodeJS.ErrnoException)=>{
  if(error.code==='ENOENT')return undefined;
  throw error;
 });
}

function declarationPath(projectId:string){
 if(!/^[a-zA-Z0-9_-]{1,160}$/.test(projectId))throw Error('source_criteria_project_invalid');
 return join(runtimeProfile().rootDir,'clipmentor-source-requirements',projectId+'.json');
}

/** Host-owned intake data. The business client can only start the saved project. */
export async function readPanelSourceRegistration(projectId:string,source:MaterialBinding,sales:MaterialBinding){
 const value=await readDeclaration(declarationPath(projectId));
 if(value!==undefined){
  if(value?.projectId!==projectId)throw Error('source_criteria_project_invalid');
  return {doneCriteria:bindPanelSourceCriteria(value.doneCriteria,source,sales)};
 }
 const reusableFile=reusableDeclarationPath(source,sales);
 if(!reusableFile)return;
 const reusable=await readDeclaration(reusableFile);
 if(reusable===undefined)return;
 if(reusable?.version!==1||reusable.originalSha256!==source.sourceContentHash||reusable.salesSha256!==sales.sourceContentHash)
  throw Error('source_criteria_reuse_binding_changed');
 const doneCriteria=bindPanelSourceCriteria(reusable.doneCriteria,source,sales);
 const reference=validateReference(reusable.creatorReference,doneCriteria,source,sales);
 return {doneCriteria,...(reference?{creatorReference:reference}:{})};
}

export async function readPanelSourceCriteria(projectId:string,source:MaterialBinding,sales:MaterialBinding){
 return (await readPanelSourceRegistration(projectId,source,sales))?.doneCriteria;
}

function validateReference(value:unknown,criteria:ReturnType<typeof bindPanelSourceCriteria>,source:MaterialBinding,sales:MaterialBinding){
 if(value===undefined)return;
 const teaching=sourceTeachingCriterion(criteria);
 const ids=teaching&&'guidance' in teaching?teaching.guidance.flatMap(item=>item.confirmedDecisionId?[item.confirmedDecisionId]:[]):[];
 if(!isCreatorConfirmedReference(value)||value.originalSha256!==source.sourceContentHash||value.salesSha256!==sales.sourceContentHash
  ||ids.length!==value.groups.length||ids.some((id,index)=>id!==value.groups[index]?.id))
  throw Error('creator_reference_declaration_changed');
 return value;
}

export async function registerPanelSourceCriteria(projectId:string,value:unknown,source:MaterialBinding,sales:MaterialBinding,options:{reuseSameMaterials?:boolean;creatorReference?:CreatorConfirmedReference}={}){
 const doneCriteria=bindPanelSourceCriteria(value,source,sales);
 const file=declarationPath(projectId);
 const reusableFile=options.reuseSameMaterials?reusableDeclarationPath(source,sales):undefined;
 let reference=validateReference(options.creatorReference,doneCriteria,source,sales);
 if(reference&&!reusableFile)throw Error('creator_reference_requires_same_materials');
 if(options.reuseSameMaterials&&!reusableFile)throw Error('source_criteria_reuse_binding_changed');
 if(reusableFile){
  if(!reference){
   const previous=await readDeclaration(reusableFile);
   if(previous?.creatorReference!==undefined&&previous.version===1&&previous.originalSha256===source.sourceContentHash
    &&previous.salesSha256===sales.sourceContentHash&&digestValue(bindPanelSourceCriteria(previous.doneCriteria,source,sales))===digestValue(doneCriteria))
    reference=validateReference(previous.creatorReference,doneCriteria,source,sales);
  }
  await mkdir(dirname(reusableFile),{recursive:true,mode:0o700});
  await atomicWriteFile(reusableFile,JSON.stringify({version:1,projectId,originalSha256:source.sourceContentHash,
   salesSha256:sales.sourceContentHash,doneCriteria,...(reference?{creatorReference:reference}:{})}));
 }else{
  await mkdir(dirname(file),{recursive:true,mode:0o700});
  await atomicWriteFile(file,JSON.stringify({projectId,doneCriteria}));
 }
 return doneCriteria;
}
