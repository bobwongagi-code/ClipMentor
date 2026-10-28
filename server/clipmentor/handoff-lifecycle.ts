import { HANDOFF_RUN_PREFIX, handoffRecord } from '../../shared/clipmentor-handoff';
import { withSerializedProjectStore } from '../plugins/project-store';

/** Survives chat/session rotation and run retention, without releasing an unknown run. */
export async function archiveHandoffTerminal(run: { projectId: string; id: string }, status: string): Promise<void> {
  if (!['completed', 'failed', 'cancelled', 'awaiting-user'].includes(status)) return;
  await withSerializedProjectStore(async store => {
    const key = `${HANDOFF_RUN_PREFIX}${run.projectId}:${run.id}`;
    const entry = await store.readEntry(key);
    if (!entry.found) return;
    if (!handoffRecord(entry.value) || entry.value.projectId !== run.projectId || entry.value.runId !== run.id) {
      throw new Error('handoff_run_binding_corrupt');
    }
    await store.writeEntry(key, { ...entry.value, terminalStatus: status });
  });
}
