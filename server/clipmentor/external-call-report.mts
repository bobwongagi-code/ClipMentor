import {join,resolve} from 'node:path';
import {readdir} from 'node:fs/promises';
import {runtimeProfile} from '../runtime-profile.ts';
import {summarizeExternalCalls} from './external-call.ts';
const args=process.argv.slice(2);
if(args.length>1)throw Error('Use report:clipmentor-calls [runtime-directory]');
const root=args[0]?resolve(args[0]):runtimeProfile().rootDir;
const dirs=[root,...['clipmentor-asr','clipmentor-copy-review','clipmentor-source-video'].map(d=>join(root,d))];
// Only the existing preview operation layout; never traverse uploads or other products.
const preview=join(root,'clipmentor-preview-reviews');
for(const project of await readdir(preview,{withFileTypes:true}).catch(()=>[]))if(project.isDirectory())
 for(const operation of await readdir(join(preview,project.name),{withFileTypes:true}))if(operation.isDirectory())dirs.push(join(preview,project.name,operation.name));
const result=[];
for(const directory of dirs){const report=await summarizeExternalCalls(directory);if(report.records||report.unreadable_records)result.push({directory,...report});}
console.log(JSON.stringify({scope:'internal_external_call_records',read_only:true,network_calls:0,records:result,
 note:'Only governed requests are included. Reserved attempts are not proof of billing; observed waiting is not all avoidable waste.'},null,2));
