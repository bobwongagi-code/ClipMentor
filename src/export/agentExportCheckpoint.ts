import type { AgentContext } from '../agent/context';
import type { ProjectDoc } from '../editor/types';
import { loadProject, migrateProjectDoc } from '../persist/projectStore';

/** Export is an external side effect, never a commit of an Agent's draft.
 * The normal proposal/save path owns that commit (and its approval policy).
 */
export async function committedAgentExportBlock(ctx: AgentContext, project: ProjectDoc) {
  if (!ctx.getAgentRunId?.()) return null;
  const projectId = ctx.getProjectId?.();
  // Selection and active-tab navigation are not editing. All content, source
  // bindings and review receipts must still match the durable project.
  const content = (doc: ProjectDoc) => {
    const normalized = migrateProjectDoc(doc) ?? doc;
    return JSON.stringify({
      ...normalized,
      activeTimelineId: '',
      timelines: normalized.timelines.map((timeline) => ({ ...timeline, selectedId: null, selectedIds: [] })),
    });
  };
  const expected = content(project), selectedTimelineId = project.activeTimelineId;
  const saved = projectId ? await loadProject(projectId) : null;
  const live = ctx.getDoc();
  if (saved && saved.timelines.some((timeline) => timeline.id === selectedTimelineId)
    && content(saved) === expected && live.activeTimelineId === selectedTimelineId
    && content(live) === expected) return null;
  return {
    error: 'Export requires a separately committed project. Finish this editing proposal and save it first, then export in a new step. The saved project has not been changed.',
    code: 'export_requires_committed_project',
    retryable: false,
  };
}
