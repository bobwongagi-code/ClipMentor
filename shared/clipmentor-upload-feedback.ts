export const uploadFeedback = {
  size: '四份素材合计不能超过 64 MiB。',
  missing: '请选齐所需素材，文件不能为空。',
  name: '请缩短或更换文件名后再上传。',
  format: '文件格式不符合上传要求，请更换。',
  source: '原片无法播放或没有声音，请检查后再上传。',
  image: '这张图片无法读取，请换一张。',
  sameImage: '商品图和合作海报需要用不同的图片。',
  original: '这份文件与原来上传的不一致，请选原文件。',
  alreadySaved: '此任务已有素材。要使用另一套素材，请新建任务。',
  openEditor: '请先关闭此任务的编辑器，再上传素材。',
  saving: '素材正在保存，请稍后查看。',
  busy: '当前上传较多，请稍后再试。',
  changed: '任务已更新，请刷新后再查看素材。',
  unavailable: '暂时无法保存素材，请稍后再试。',
} as const

export type UploadFeedbackCode = keyof typeof uploadFeedback

export function uploadFeedbackFor(code:unknown){
  return typeof code==='string'&&Object.prototype.hasOwnProperty.call(uploadFeedback,code)?uploadFeedback[code as UploadFeedbackCode]:uploadFeedback.unavailable
}
