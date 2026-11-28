import { readFile } from 'node:fs/promises';
import { loadOfflineStoredProject } from '../external-agent/offline-project-store';
import { activateOfflineAgentRuntimeBackend } from '../external-agent/agent-runtime-persistence';
import { latestPanelProductionTask } from './production-task';
import { bindPanelSourceCriteria, frozenTeachingTopics } from './production-source-policy';
import { readProductionOutputs, selectProductionAudience } from './production-continuation';
import { copyReviewSubject } from '../../src/clipmentor/production-gate';
import { captureCreatorReference } from './production-creator-quality';
import { registerPanelSourceCriteria } from './production-panel-source-requirements';

const [file,reuse,...extra]=process.argv.slice(2);
if(!file||extra.length||reuse&&reuse!=='--reuse-same-materials')
 throw Error('Usage: tsx server/clipmentor/register-panel-source-requirements.mts <confirmed-project-requirements.json> [--reuse-same-materials]');
const {projectId,doneCriteria,confirmedBlueprint}=JSON.parse(await readFile(file,'utf8'));
if(typeof projectId!=='string'||!/^[a-zA-Z0-9_-]{1,160}$/.test(projectId))throw Error('source_criteria_project_invalid');
activateOfflineAgentRuntimeBackend();
const saved=await loadOfflineStoredProject(projectId);
if(!saved)throw Error('source_criteria_project_missing');
const task=await latestPanelProductionTask(projectId);
const source=task?saved.doc.assets.find(asset=>asset.id===task.input.sourceAssetId):saved.doc.assets[0];
const sales=task?saved.doc.assets.find(asset=>asset.id===task.input.panelDelivery?.salesAssetId):saved.doc.assets[2];
if(source?.kind!=='video'||sales?.kind!=='image')throw Error('source_criteria_materials_missing');
const bound=bindPanelSourceCriteria(doneCriteria,source,sales);
frozenTeachingTopics(saved.doc,{input:{sourceAssetId:source.id,doneCriteria:bound}});
let creatorReference:ReturnType<typeof captureCreatorReference>|undefined;
if(confirmedBlueprint!==undefined){
 const {revision,units}=confirmedBlueprint??{};
 if(!reuse||!task||saved.revision!==revision||!units||typeof units!=='object'||Array.isArray(units)||!sales.sourceContentHash)
  throw Error('creator_reference_requires_current_confirmed_revision');
 const children=await readProductionOutputs(task);
 let approved=false;
 for(const child of children){
  const approval=child.blueprintApproval, audience=child.input.panelDelivery?.audience;
  if(approval?.sourceRevision===revision&&audience
   &&(await copyReviewSubject(selectProductionAudience(saved.doc,audience))).digest===approval.digest)approved=true;
 }
 if(!approved)throw Error('creator_reference_human_approval_missing');
 creatorReference=captureCreatorReference(saved.doc,revision,sales.sourceContentHash,units);
}
await registerPanelSourceCriteria(projectId,bound,source,sales,{reuseSameMaterials:!!reuse,creatorReference});
console.log(JSON.stringify({projectId,reusable:!!reuse,...(creatorReference?{confirmedRevision:creatorReference.revision}:{}),registered:bound.map(criterion=>criterion.kind)}));
