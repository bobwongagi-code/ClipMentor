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
 if(!task?.active)return '等待继续'
 if(task.blueprintConfirmed&&['blueprint','copy_review'].includes(task.stage))return '调整画面安排'
 const labels:Record<string,string>={analysis:'分析原片',blueprint:'生成剪辑蓝图',copy_review:'生成剪辑蓝图',audio:'准备配音',edit:'剪辑',export:'生成预览',self_check:'检查预览'}
 return labels[task.stage]??'处理中'
}
