import { readFile } from 'node:fs/promises';
import { loadOfflineStoredProject } from '../external-agent/offline-project-store';
import { activateOfflineAgentRuntimeBackend } from '../external-agent/agent-runtime-persistence';
import { latestPanelProductionTask } from './production-task';
import { bindPanelSourceCriteria, frozenTeachingTopics } from './production-source-policy';
import { registerPanelSourceCriteria } from './production-panel-source-requirements';

const [file,reuse,...extra]=process.argv.slice(2);
if(!file||extra.length||reuse&&reuse!=='--reuse-same-materials')
 throw Error('Usage: tsx server/clipmentor/register-panel-source-requirements.mts <confirmed-project-requirements.json> [--reuse-same-materials]');
const {projectId,doneCriteria}=JSON.parse(await readFile(file,'utf8'));
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
await registerPanelSourceCriteria(projectId,bound,source,sales,{reuseSameMaterials:!!reuse});
console.log(JSON.stringify({projectId,reusable:!!reuse,registered:bound.map(criterion=>criterion.kind)}));
