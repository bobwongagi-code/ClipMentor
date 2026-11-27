import { CLIPMENTOR_TASK_LIMIT } from '../../shared/clipmentor-tasks';

export class ProductionCapacityFull extends Error {
  readonly code = 'clipmentor_production_capacity_full';
  constructor() {
    super('当前已有五个任务在跑。名额空出后可以继续。');
  }
}
export function isProductionCapacityFull(error:unknown):error is ProductionCapacityFull {
  return error instanceof Error && 'code' in error && error.code==='clipmentor_production_capacity_full';
}

/** One slot per project, including overlapping work on its two endings. */
export function createProductionCapacity(limit = CLIPMENTOR_TASK_LIMIT) {
  const holders = new Map<string, number>();
  const waiting: Array<{ projectId: string; ready: (release: () => void) => void }> = [];

  function hold(projectId: string) {
    holders.set(projectId, (holders.get(projectId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = holders.get(projectId)!;
      if (count > 1) {
        holders.set(projectId, count - 1);
        return;
      }
      holders.delete(projectId);
      drain();
    };
  }

  function drain() {
    for (let index = 0; index < waiting.length;) {
      const next = waiting[index];
      if (!holders.has(next.projectId) && holders.size >= limit) {
        index++;
        continue;
      }
      waiting.splice(index, 1);
      next.ready(hold(next.projectId));
    }
  }

  return {
    get running() { return holders.size; },
    reserve(projectId: string) {
      if (!holders.has(projectId) && holders.size >= limit) throw new ProductionCapacityFull();
      const release = hold(projectId);
      drain();
      return release;
    },
    wait(projectId: string, signal?: AbortSignal) {
      return new Promise<(() => void)|undefined>(resolve => {
        if(signal?.aborted){resolve(undefined);return;}
        const cancel=()=>{
          const index=waiting.indexOf(ticket);
          if(index>=0)waiting.splice(index,1);
          resolve(undefined);
        };
        const ticket={projectId,ready:(release:()=>void)=>{
          signal?.removeEventListener('abort',cancel);
          resolve(release);
        }};
        signal?.addEventListener('abort',cancel,{once:true});
        waiting.push(ticket);
        drain();
      });
    },
  };
}
