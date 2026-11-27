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
 const labels=preparing?['分析原片','整理蓝图','检查蓝图']:['准备制作','配音','主体剪辑','片尾与预览']
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
 if(task?.previewPending)return '视频预览'
 if(task?.status==='awaiting_review'||task?.status==='completed')return '预览与下载'
 if(task?.status==='awaiting_blueprint'||reviewableBlueprintRevision(task))return '审核蓝图'
 return task?.blueprintConfirmed?'视频制作':'准备蓝图'
}

export function productionActivity(task?:ProgressTask){
 if(task?.status==='queued')return '等待运行名额'
 if(!task?.active)return '等待继续'
 if(task.blueprintConfirmed&&['blueprint','copy_review'].includes(task.stage))return '调整画面安排'
 const labels:Record<string,string>={analysis:'分析原片',blueprint:'生成剪辑蓝图',copy_review:'生成剪辑蓝图',audio:'准备配音',edit:'剪辑',export:'生成预览',self_check:'检查预览'}
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
 if(!task)return readFailed?'读取状态失败':'正在读取'
 if(task?.deliveryHeld||task?.previewNeedsChanges)return '需修改'
 if(task&&(task.previewPending||['awaiting_review','completed'].includes(task.status))&&!hasPlayablePreview(task))return '预览暂不可用'
 if(task?.status==='completed')return previewActions(task).canDownload?'可下载':'暂不可下载'
 if(task?.status==='awaiting_review')return previewActions(task).canConfirm?'待确认':'暂不能确认'
 if(task?.previewPending)return task.status==='blocked'?'复核已暂停':task.active&&task.stage==='self_check'?'复核中':'待复核'
 if(task?.status==='cancelled')return '已取消'
 if(task?.status==='blocked')return '制作已暂停'
 if(task?.status==='queued')return '等待运行名额'
 if(task?.status==='waiting')return '等待共用主体'
 return '制作中'
}

export function previewProgress(task?:PreviewTask){
 const actions=previewActions(task)
 const stage=actions.canDownload?4:actions.canConfirm?3:actions.watchable||actions.held||task?.stage==='self_check'?2:1
 return ['蓝图确认','预览与修改','复核','确认成片','下载'].map((label,index)=>({
  label, done:index<stage&&(index!==2||task?.previewReviewed===true), current:index===stage,
 }))
}
