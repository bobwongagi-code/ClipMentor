export const uploadFeedback = {
  size: '四份素材合计不能超过 64 MiB。',
  missing: '请把需要的素材选齐，文件不能是空的。',
  name: '请缩短文件名或换个名字，再上传。',
  format: '文件格式不支持，请换成要求的格式。',
  source: '原片播放不了，或没有声音，请检查后再传。',
  image: '这张图打不开，请换一张。',
  sameImage: '商品图和合作海报不能用同一张图。',
  original: '这不是当初上传的那个文件，请选原文件。',
  alreadySaved: '这个任务已经有素材了。要换一套素材，请新建任务。',
  openEditor: '这个任务的编辑器还开着，请先关掉再上传。',
  saving: '素材正在保存，稍后再看。',
  busy: '现在上传较多，请稍后再试。',
  changed: '任务有更新，请刷新后再看素材。',
  unavailable: '素材暂时存不了，请稍后再试。',
} as const

export type UploadFeedbackCode = keyof typeof uploadFeedback

export function uploadFeedbackFor(code:unknown){
  return typeof code==='string'&&Object.prototype.hasOwnProperty.call(uploadFeedback,code)?uploadFeedback[code as UploadFeedbackCode]:uploadFeedback.unavailable
}
