import { handoffAssetsOf, handoffDigest, parseHandoffPolicy } from './clipmentor-handoff';
import type { ProjectDoc } from '../src/editor/types';

/** Called under the SAME project-store lock as registration and document persistence. */
export async function assertHandoffProjectWrite(value: unknown, before: ProjectDoc | null, after: ProjectDoc): Promise<void> {
  if (value === undefined) return;
  const policy = parseHandoffPolicy(value);
  if (!before) throw new Error('handoff_project_missing');
  if (policy.brief.phase === 'execution') {
    const content = (doc: ProjectDoc) => {
      const { production_copy_review: _receipt, ...blueprint } = doc.clipMentorAnalysis ?? {};
      return blueprint;
    };
    if (await handoffDigest(content(before)) !== await handoffDigest(content(after))) {
      throw new Error('handoff_execution_cannot_change_blueprint');
    }
    if (after.activeTimelineId !== policy.brief.timelineId
      || await handoffDigest(handoffAssetsOf(after.assets, policy.assetBindings.map(a => String(a.id)))) !== await handoffDigest(policy.assetBindings)) {
      throw new Error('handoff_frozen_subject_changed');
    }
    return;
  }
  // Planning writes may register analysis; they cannot sneak timeline edits into a pending save.
  const old = { ...before }, next = { ...after };
  delete old.clipMentorAnalysis; delete next.clipMentorAnalysis;
  if (await handoffDigest(old) !== await handoffDigest(next)) throw new Error('handoff_planner_may_only_register_analysis');
}
