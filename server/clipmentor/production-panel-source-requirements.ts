import {readFile,mkdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {runtimeProfile} from '../runtime-profile';
import {atomicWriteFile} from '../plugins/project-store-durable';
import {bindPanelSourceCriteria} from './production-source-policy';

type MaterialBinding={id:string;sourceContentHash?:string};

function declarationPath(projectId:string){
 if(!/^[a-zA-Z0-9_-]{1,160}$/.test(projectId))throw Error('source_criteria_project_invalid');
 return join(runtimeProfile().rootDir,'clipmentor-source-requirements',projectId+'.json');
}

/** Host-owned intake data. The business client can only start the saved project. */
export async function readPanelSourceCriteria(projectId:string,source:MaterialBinding,sales:MaterialBinding){
 const bytes=await readFile(declarationPath(projectId),'utf8').catch((error:NodeJS.ErrnoException)=>{
  if(error.code==='ENOENT')return undefined;
  throw error;
 });
 if(bytes===undefined)return;
 const value=JSON.parse(bytes);
 if(value?.projectId!==projectId)throw Error('source_criteria_project_invalid');
 return bindPanelSourceCriteria(value.doneCriteria,source,sales);
}

export async function registerPanelSourceCriteria(projectId:string,value:unknown,source:MaterialBinding,sales:MaterialBinding){
 const doneCriteria=bindPanelSourceCriteria(value,source,sales);
 const file=declarationPath(projectId);
 await mkdir(dirname(file),{recursive:true,mode:0o700});
 await atomicWriteFile(file,JSON.stringify({projectId,doneCriteria}));
 return doneCriteria;
}
