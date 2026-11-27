import type {ProductionTask} from './production-task';

/** Waiting for the producer must not spend the follower's execution window. */
export function unstartedSharedFollower(task:ProductionTask){
 return task.input.panelDelivery?.audience==='new_contact'&&!!task.sharedProduction&&!task.sharedProduction.prepared
  &&task.stage==='copy_review'&&!task.completed.copy_review&&Object.values(task.attempts).every(n=>n===0)
  &&Object.keys(task.effects).length===0;
}

export function canLaunchSharedFollower(task:ProductionTask){
 return task.status==='queued'||task.status==='blocked'&&unstartedSharedFollower(task)
  &&/^(?:Error: )?Production deadline exceeded$/.test(task.error??'');
}

export function productionWorkDeadline(task:ProductionTask,now=Date.now()){
 const startedAt=task.sharedProduction?.prepared?task.sharedProduction.workStartedAt:undefined;
 return (startedAt??(unstartedSharedFollower(task)?now:task.createdAt))+task.input.budget.maxElapsedMs;
}
