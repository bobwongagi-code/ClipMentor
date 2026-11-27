type BoardTask={status:string;stage:string;revision?:string;blueprintRevision?:string;blueprintConfirmed?:boolean;previewPending?:boolean}
export function reviewableBlueprintRevision(task?:BoardTask|null){
 if(!task || !['blueprint','copy_review'].includes(task.stage))return undefined
 if(task.status!=='awaiting_blueprint' && (task.blueprintConfirmed || task.status!=='blocked'))return undefined
 return task.blueprintRevision ?? (task.status==='awaiting_blueprint'?task.revision:undefined)
}

type ProgressTask={stage:string;status:string;active:boolean;stopReason?:string;blueprintConfirmed?:boolean}
export function productionProgress(task:ProgressTask,sharedTask?:ProgressTask){
 const source=task.status==='waiting'&&sharedTask?sharedTask:task
 const preparing=!source.blueprintConfirmed&&['analysis','blueprint','copy_review'].includes(source.stage)
 const labels=preparing?['分析原片','生成蓝图','核对蓝图']:['准备','配音','剪辑','片尾与预览']
 const current=preparing?['analysis','blueprint','copy_review'].indexOf(source.stage):source.stage==='audio'?1:source.stage==='edit'?2:['export','self_check'].includes(source.stage)?3:0
 const waiting=task.status==='cancelled'||task.status==='waiting'&&(!sharedTask?.active||current===3)
 return labels.map((label,index)=>({label,
  state:(index<current?'done':waiting?'pending':index===current?(source.stopReason==='maintenance'?'pending':source.stopReason?'failed':source.active?'active':'pending'):'pending') as 'done'|'pending'|'failed'|'active'
 }))
}

export function showSharedBlueprint(task?:BoardTask){
 return !task || task.status==='awaiting_blueprint' || !!reviewableBlueprintRevision(task) || !task.blueprintConfirmed && ['analysis','blueprint','copy_review'].includes(task.stage) && !['awaiting_review','completed','cancelled'].includes(task.status)
}

export function productionPageTitle(task?:BoardTask){
 if(task?.previewPending)return '看片'
 if(task?.status==='awaiting_review'||task?.status==='completed')return '预览与下载'
 if(task?.status==='awaiting_blueprint'||reviewableBlueprintRevision(task))return '审蓝图'
 return task?.blueprintConfirmed?'制作视频':'生成蓝图'
}

export function productionActivity(task?:ProgressTask){
 if(task?.status==='queued')return '等待空位'
 if(!task?.active)return '待继续'
 if(task.blueprintConfirmed&&['blueprint','copy_review'].includes(task.stage))return '正在调整画面'
 const labels:Record<string,string>={analysis:'正在分析原片',blueprint:'正在生成蓝图',copy_review:'正在生成蓝图',audio:'正在准备配音',edit:'正在剪辑',export:'正在生成预览',self_check:'正在复核成片'}
 return labels[task.stage]??'处理中'
}

type PreviewTask=ProgressTask&{renderId?:string;previewPending?:boolean;previewNeedsChanges?:boolean;previewReviewed?:boolean;deliveryHeld?:boolean;
 deliveryUnavailable?:boolean;canAcceptPreview?:boolean}

export function hasPlayablePreview(task?:PreviewTask){
 return !!task?.renderId&&(task.previewPending===true||task.status==='awaiting_review'||task.status==='completed')
}

export function previewActions(task?:PreviewTask) {
 const watchable=hasPlayablePreview(task)
 const held=!!(task?.deliveryHeld||task?.previewNeedsChanges)
 const available=watchable&&!held&&!task?.deliveryUnavailable
 return {watchable,held,canConfirm:available&&task?.status==='awaiting_review'&&task.canAcceptPreview===true,
  canDownload:available&&task?.status==='completed',canDownloadDraft:available&&task?.previewPending===true}
}

export function previewStatus(task?:PreviewTask,readFailed=false){
 if(!task)return readFailed?'暂时获取不到状态':'正在获取…'
 if(task?.deliveryHeld||task?.previewNeedsChanges)return '需要修改'
 if(task&&(task.previewPending||['awaiting_review','completed'].includes(task.status))&&!hasPlayablePreview(task))return '暂时看不了'
 if(task?.status==='completed')return previewActions(task).canDownload?'可下载':'暂时不能下载'
 if(task?.status==='awaiting_review')return previewActions(task).canConfirm?'待你确认':'暂时不能确认'
 if(task?.previewPending)return task.status==='blocked'?'复核暂停，可先看片':task.active&&task.stage==='self_check'?'复核中':'待复核'
 if(task?.status==='cancelled')return '已取消'
 if(task?.status==='blocked')return '已暂停，进度已保存'
 if(task?.status==='queued')return '等待空位'
 if(task?.status==='waiting')return '等另一版剪完'
 return '制作中'
}

export function previewProgress(task?:PreviewTask){
 const actions=previewActions(task)
 const stage=actions.canDownload?4:actions.canConfirm?3:actions.watchable||actions.held||task?.stage==='self_check'?2:1
 return ['审蓝图','看片改片','复核','确认成片','下载'].map((label,index)=>({
  label, done:index<stage&&(index!==2||task?.previewReviewed===true), current:index===stage,
 }))
}
