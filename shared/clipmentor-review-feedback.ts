export type ReviewIssue={kind:'content'|'gate'|'binding';message:string}

export const reviewMessages={
  analysisPaused:'原片分析暂停了，素材都在，无需重传。',
  paused:'已暂停，进度已保存，无需重新上传。',
  choicesRetained:'现有讲解先保留。要不要换讲解的角度，由你来定。',
  openingPaused:'片头画面不够长，制作暂停了，需要调整片头。',
  bothPreviews:'两个版本共用的片段，改一处两边都会变，请一起核对。',
  reviewPaused:'复核还没完成。',
  updated:'请刷新页面，查看最新版本。',
  sameIssue:'这次修改暂停了，当前版本仍可查看。',
  checkBoard:'请看一下当前蓝图，有意见就提交。',
  refreshBoard:'蓝图有更新，请刷新后再确认。',
  emptyBoard:'当前蓝图里还没有讲解内容可审。',
  feedbackTarget:'请选择意见针对某一段、某一组，还是整支视频。',
  endingMissing:'片尾素材暂时显示不出来。',
  previewUnavailable:'预览或随片资料暂时用不了，稍后再试。',
  deliveryCheckUnavailable:'成片可以观看，暂时不能确认或下载。',
  commission:'请核对片尾里的佣金等合作数字是否正确。',
  feedbackLength:'意见太长，请删减后再提交。',
  invalidGroup:'蓝图里没有这一组，请核对组号。',
  finalChecks:'请分别勾选「我已看过成片」和「我已核对马来语口播和字幕」。',
  feedbackUsed:'这一版的修改次数已用完，可联系维护人员。',
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

export function reviewIssueDisplayText(issue:ReviewIssue):string {
  const {message}=issue
  if(issue.kind!=='content')return message
  // Stored rejection messages keep their identity. Rephrase only validated public text.
  if(opinionClarificationText.test(message))return message
    .replace(/^整体意见，/u,'整体，')
    .replace('，请写清希望保留和修改的内容。','，请写清哪些要保留、哪些要改。')
    .replace('，请写清要改的是第几句。','，请写清要改第几句。')
  if(!opinionScopeText.test(message))return message
  return message
    .replace('已确认保留。','按你的意思保留，没有改动。')
    .replace('只可修改已确认的句子。','这次只能改你点名要改的句子。')
    .replace('本次意见的讲解组顺序或数量被改动。','这次修改改变了讲解组的数量或顺序，未生效。请重新提交意见。')
    .replace('整体、片头或片尾未收到修改意见。','整体、片头、片尾没有收到修改意见，所以不会动它们。')
    .replace('组未收到修改意见。','组没有收到修改意见，所以不会动它。')
    .replace(' 同一问题再次出现，修改已暂停。',' 同一个问题又出现了，已暂停修改，可联系维护人员。')
}

export const blueprintNotices={
  saved:'意见已保存，正在改蓝图，无需操作。',
  paused:'意见已保存，但这次修改暂停了，当前版本仍可查看。',
  service:'制作暂时不可用，蓝图仍可查看，已有内容不受影响。',
  checkStopped:'核对蓝图暂停了，当前版本仍可查看。',
  checking:'蓝图还没核对完，暂时不能开始制作。',
} as const
