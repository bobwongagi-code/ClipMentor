export type ReviewIssue={kind:'content'|'gate'|'binding';message:string}

export const reviewMessages={
  analysisPaused:'原片分析已暂停，已上传素材仍在。',
  paused:'制作已暂停，进度已保存。',
  choicesRetained:'现有讲解已保留。选题变更需由你决定。',
  openingPaused:'片头画面时长不够，制作已暂停。',
  bothPreviews:'两个版本中相同的片段需要一起核对。',
  reviewPaused:'成片复核暂未完成。',
  updated:'请刷新后查看当前版本。',
  sameIssue:'本次修改已暂停，当前版本仍可查看。',
  checkBoard:'请查看当前蓝图，按需提交修改意见。',
  refreshBoard:'请刷新蓝图后重新确认。',
  emptyBoard:'当前蓝图暂无讲解可供审核。',
  feedbackTarget:'请选择意见针对的片段、讲解组或整部成片。',
  feedbackRangeEmpty:'这段时间没有包含完整片段，请扩大时间段，或改选一组。',
  endingMissing:'片尾素材暂时无法显示。',
  previewUnavailable:'当前预览或随片资料暂不可用。',
  deliveryCheckUnavailable:'成片可以观看，暂时不能确认或下载。',
  commission:'请核对片尾的佣金等合作数字。',
  feedbackLength:'意见总字数太多，请缩短后再提交。',
  invalidGroup:'当前蓝图没有这个讲解组，请核对组号。',
  finalChecks:'请分别确认已看过成片和已核过马来语。',
  feedbackUsed:'本版修改机会已用完。',
} as const

export const opinionScopeText=/^(?:(?:(?:第 [1-9]\d* 组|整体意见)(?:第 [1-9]\d* 句已确认保留。|只可修改已确认的句子。))|本次意见的讲解组顺序或数量被改动。|第 [1-9]\d* 组未收到修改意见。|整体、片头或片尾未收到修改意见。)(?: 同一问题再次出现，修改已暂停。)?$/u
export const opinionClarificationText=/^(?:第 [1-9]\d* 组|整体意见)，请写清(?:希望保留和修改的内容|要改的是第几句)。$/u

const publishedMessages=new Set<string>(Object.values(reviewMessages))
const fallback={content:reviewMessages.checkBoard,gate:reviewMessages.paused,binding:reviewMessages.updated}

export function readReviewIssue(value:unknown):ReviewIssue|undefined {
  if(!value||typeof value!=='object'||!('kind' in value))return
  const {kind}=value
  if(kind!=='content'&&kind!=='gate'&&kind!=='binding')return
  const text='message' in value?value.message:undefined
  return {kind,message:typeof text==='string'&&(publishedMessages.has(text)||kind==='content'&&(opinionScopeText.test(text)||opinionClarificationText.test(text)))?text:fallback[kind]}
}

export const blueprintNotices={
  saved:'意见已保存，正在修改蓝图。',
  paused:'意见已保存，本次修改已暂停。',
  service:'制作服务暂时不可用，蓝图仍可查看。',
  checkStopped:'蓝图检查已暂停，仍可查看当前版本。',
  checking:'蓝图检查尚未完成，暂不能开始制作。',
} as const
