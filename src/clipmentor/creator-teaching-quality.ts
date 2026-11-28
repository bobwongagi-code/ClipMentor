export const creatorQuestions = {
  decision: '她怎么拍？（20 字以内）',
  first_glance: '达人一眼得到什么？',
  omission_loss: '放弃这一组会少学什么？',
  next_decision: '达人看完下一条会改哪个拍摄决定？',
  narration_why: '用口播讲清哪个拍法为什么成立？',
  still_focus: '画面停着时观众该看哪里？动态承担时说明看哪个变化。',
  opening: '片头给观众什么继续看的理由？播放量、销量和成交额是否各有依据、各占一行？',
  evidence_boundary: '现行马来语的说法、素材与证据窗口对得上吗？指出核实不了或越界的说法。',
  copy_form: '现行马来语是否用两句以内的第三人称讲解取舍，并用 pembeli 指买家？',
  picture_support: '对应句的回看能承载读图任务吗？有定格时，哪条短标指出观众当时要看的对象？',
  stage_visual: '原片和讲解的阶段可否从各自的顶部阶段条区分？按提交画面计划核对。',
  balance: '原片保留什么才能看懂，讲解把什么教清？',
} as const;

export const creatorGroupQuestions = ['decision', 'first_glance', 'omission_loss', 'next_decision', 'narration_why', 'still_focus'] as const;
export const creatorFilmQuestions = ['opening', 'balance'] as const;

export interface CreatorGroupWorksheet {
  next_decision: string;
  narration_why: string;
  still_focus: string;
  analogy: { entry: string; evidence_ids: string[]; application: string; difference: string };
  confirmed_decision_id?: string;
}

export type CreatorFilmWorksheet = { opening: string; balance: string };

const row = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export const creatorAnswer = (value: unknown): value is string =>
  typeof value === 'string' && /[\p{L}\p{N}]/u.test(value) && value.length <= 500;

export function isCreatorGroupWorksheet(value: unknown): value is CreatorGroupWorksheet {
  if (!row(value) || !row(value.analogy)) return false;
  const { analogy } = value;
  return [value.next_decision, value.narration_why, value.still_focus, analogy.entry, analogy.application, analogy.difference].every(creatorAnswer)
    && Array.isArray(analogy.evidence_ids) && analogy.evidence_ids.length > 0 && analogy.evidence_ids.length <= 8
    && analogy.evidence_ids.every(creatorAnswer) && new Set(analogy.evidence_ids).size === analogy.evidence_ids.length
    && (value.confirmed_decision_id === undefined || creatorAnswer(value.confirmed_decision_id));
}

export function isCreatorFilmWorksheet(value: unknown): value is CreatorFilmWorksheet {
  return row(value) && creatorAnswer(value.opening) && creatorAnswer(value.balance);
}
