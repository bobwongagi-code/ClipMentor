import { CLIPMENTOR_TASK_LIMIT, type ClipMentorTaskStatus, type ClipMentorTaskSummary } from '../../shared/clipmentor-tasks';
import { emptyProject } from '../external-agent/projects';
import { getStoredEntry, withSerializedProjectStore } from '../plugins/project-store';
import { commitProjectEditRows } from '../plugins/project-store-edit-journal';
import { readProductionOutput } from './production-continuation';
import { latestPanelProductionTask, type ProductionTask } from './production-task';
import { pendingProductionPreview } from './production-playable-preview';
import { CLIPMENTOR_OUTPUT_CANVAS } from './production-format';

const validId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(id);
type Entry = { id: string; name?: string; taskName?: string; updatedAt?: number; deletedAt?: number; clipMentorTask?: true };
type IsActive = (taskId: string, projectId: string) => boolean;
type IsDeferred = (taskId: string) => boolean;

export async function createWorkspaceProject(id: unknown, name: unknown) {
  if (typeof id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)
    || (name !== undefined && (typeof name !== 'string' || name.trim().length > 80))) throw Error('invalid_workspace_project');
  return withSerializedProjectStore(async store => {
    const index = await store.readEntry('projects');
    const entries = Array.isArray(index.value) ? index.value as Entry[] : [];
    const key = 'project:' + id;
    const doc = await store.readEntry(key);
    const prior = entries.find(item => item?.id === id);
    if (prior || doc.found) {
      if (!prior?.clipMentorTask || prior.deletedAt || !doc.found) throw Error('workspace_project_conflict');
      return { id, name: prior.taskName ?? '未命名任务' };
    }
    const taskName = typeof name === 'string' ? name.trim() : '';
    const meta = { id, name: '未命名任务', ...(taskName ? {taskName} : {}), updatedAt: Date.now(), clipMentorTask: true };
    const { width, height } = CLIPMENTOR_OUTPUT_CANVAS;
    const draft = emptyProject({ compositionWidth: width, compositionHeight: height });
    const versionKey = 'versions:' + id;
    const ownershipKey = 'project-edit-ownership:' + id;
    const versions = await store.readEntry(versionKey);
    const ownership = await store.readEntry(ownershipKey);
    if (versions.found || ownership.found) throw Error('workspace_project_conflict');
    const committed = await commitProjectEditRows(store, {
      [key]: { found: true, value: draft },
      projects: { found: true, value: [meta, ...entries] },
      [versionKey]: versions,
      [ownershipKey]: ownership,
    }, { [key]: doc, projects: index, [versionKey]: versions, [ownershipKey]: ownership }, () => true);
    if (!committed) throw Error('workspace_project_conflict');
    return { id, name: taskName || meta.name };
  });
}

function displayStatus(task: ProductionTask, active: IsActive, deferred: IsDeferred): ClipMentorTaskStatus {
  if (task.status === 'completed' || task.status === 'cancelled') return task.status;
  if (task.status === 'awaiting_blueprint') return 'blueprint';
  if (task.status === 'awaiting_review' || pendingProductionPreview(task)) return 'preview';
  if (active(task.taskId, task.projectId)) return 'running';
  if (deferred(task.taskId)) return 'queued';
  if (task.status === 'queued' && task.sharedProduction && !task.sharedProduction.prepared) return 'waiting';
  return 'paused';
}

function displayName(entry: Entry, task?: ProductionTask) {
  if(entry.taskName?.trim())return entry.taskName;
  return [!entry.clipMentorTask?entry.name:undefined,task?.input.product.name].map(name=>name?.trim()).find(value=>value
    &&![entry.id,'当前商品','未命名任务'].includes(value)&&!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value))??'未命名任务';
}

async function projectSummary(entry: Entry, active: IsActive, deferred: IsDeferred) {
  const task = await latestPanelProductionTask(entry.id);
  if (task?.blueprintApproval || (!task && !entry.clipMentorTask)) return;
  const name = displayName(entry, task);
  const manifest=task?.productionChildren?.length?task.productionChildren:task?.productionChild?[task.productionChild]:[];
  const children = task ? await Promise.all(manifest.map(output=>readProductionOutput(task,output).catch(()=>undefined))) : [];
  const outputs: ClipMentorTaskSummary['outputs'] = manifest.map(({audience},index)=>{
    const child=children[index];
    return child?{audience,status:displayStatus(child,active,deferred),stage:child.stage,
      ...(child.status==='awaiting_review'?{awaitingConfirmation:true}:{})}:{audience,status:'unavailable'};
  });
  const statuses = outputs.map(output => output.status);
  const status = !task ? 'materials'
    : statuses.find(value => value === 'preview') ?? statuses.find(value => value === 'blueprint')
    ?? statuses.find(value => value === 'running') ?? statuses.find(value => value === 'queued')
    ?? statuses.find(value => value === 'paused') ?? statuses.find(value => value === 'waiting')
    ?? (statuses.includes('unavailable')?'paused':statuses.length && statuses.every(value => value === 'completed') ? 'completed'
      : statuses.length && statuses.every(value => value === 'cancelled' || value === 'completed') ? 'cancelled' : displayStatus(task, active, deferred));
  return {
    id: entry.id,
    name,
    status, stage: outputs.find(output=>output.status===status)?.stage??task?.stage,
    updatedAt: Math.max(entry.updatedAt ?? 0, task?.updatedAt ?? 0, ...children.map(child => child?.updatedAt ?? 0)),
    outputs,
  } satisfies ClipMentorTaskSummary;
}

export async function readTaskWorkspace(active: IsActive, running: () => number, deferred: IsDeferred) {
  const index = (await getStoredEntry('projects')).value;
  const entries = (Array.isArray(index) ? index as Entry[] : []).filter(item => item && !item.deletedAt && validId(item.id));
  const tasks: ClipMentorTaskSummary[] = [];
  for (let i = 0; i < entries.length; i += 8) {
    const batch = await Promise.all(entries.slice(i, i + 8).map(async entry => {
      try{return await projectSummary(entry, active, deferred);}
      catch{
        if(entry.clipMentorTask)return {id:entry.id,name:displayName(entry),status:'paused',updatedAt:entry.updatedAt??0,outputs:[]} satisfies ClipMentorTaskSummary;
      }
    }));
    for (const result of batch) if(result)tasks.push(result);
  }
  return { tasks: tasks.sort((a, b) => b.updatedAt - a.updatedAt), running: running(), limit: CLIPMENTOR_TASK_LIMIT };
}
