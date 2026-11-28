import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, Plus } from 'lucide-react'
import type { ClipMentorTaskStatus, ClipMentorTaskSummary, ClipMentorWorkspace } from '../../../shared/clipmentor-tasks'
import ClipMentorPage from './ClipMentorPage'
import { audienceTitleFor, type Audience, type Task } from './ProductionPanel'
import { previewActions } from './productionPanelState'
import { taskPage, workspaceEndpoint, type TaskNavigation, type TaskView } from './taskNavigation'

type WorkspaceStatus=ClipMentorTaskStatus|'unavailable'
const statusLabels: Record<WorkspaceStatus, string> = {
  materials:'待开始', running:'制作中', queued:'等待空位', waiting:'等另一版剪完', blueprint:'待你审蓝图',
  preview:'待你看片', paused:'已暂停，进度已保存', completed:'已完成', cancelled:'已取消', unavailable:'暂不可用',
}
const stages: Record<string,string> = {
  analysis:'分析原片', blueprint:'生成蓝图', copy_review:'核对蓝图', audio:'配音', edit:'剪辑', export:'生成预览', self_check:'复核成片',
}
const taskTime=new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})

function taskUpdateTime(timestamp:number){
  const date=new Date(timestamp)
  return timestamp>0&&Number.isFinite(date.getTime())?date:undefined
}

function readJson(url: string, signal: AbortSignal) {
  return fetch(url, { signal:AbortSignal.any([signal,AbortSignal.timeout(10_000)]), credentials:'same-origin', redirect:'error', cache:'no-store' })
}

function Status({ status, label }: { status:WorkspaceStatus; label?:string }) {
  return <span className="cm-task-status" data-status={status}>{label??statusLabels[status]}</span>
}

function Slots({ workspace }: { workspace?: ClipMentorWorkspace }) {
  if (!workspace) return null
  return <div className="cm-task-slots" role="status">
    <span>同时制作</span>
    <span className="cm-slot-dots" aria-hidden="true">{Array.from({length:workspace.limit},(_,i)=><i key={i} data-used={i<workspace.running}/>)}</span>
    <strong>{workspace.running}/{workspace.limit}</strong>
  </div>
}

function WorkspaceBrand({withMark=false}:{withMark?:boolean}){
  return <a className="cm-brand cm-workspace-brand" href={taskPage()}>{withMark&&<img src="/clipmentor-mark.svg" alt=""/>}<strong>ClipMentor</strong></a>
}

function NewTask({workspace,secondary=false}:{workspace?:ClipMentorWorkspace;secondary?:boolean}){
  const disabled=!workspace||workspace.running>=workspace.limit
  const className=`cm-button${secondary?' secondary':''}`
  return disabled
    ?<button className={className} disabled><Plus size={16}/> 新建任务</button>
    :<a className={className} href={taskPage(undefined,'new')}><Plus size={16}/> 新建任务</a>
}

function TaskLinks({tasks,current}:{tasks:ClipMentorTaskSummary[];current?:string}){
  return <nav aria-label="切换任务"><ul>{tasks.map(item=><li key={item.id}>
    <a href={taskPage(item.id)} aria-current={item.id===current?'page':undefined}>
      <span className="cm-task-dot" data-status={item.status} aria-hidden="true"/>
      <span><strong>{item.name}</strong><small>{statusLabels[item.status]}</small></span>
    </a>
  </li>)}</ul></nav>
}

function TaskTimestamp({task}:{task:ClipMentorTaskSummary}){
  const updated=taskUpdateTime(task.updatedAt)
  return updated?<time dateTime={updated.toISOString()}>更新于 {taskTime.format(updated)}</time>:null
}

const stageOrder=['analysis','blueprint','copy_review','audio','edit','export','self_check']
const isBlueprintStage=(stage?:string)=>!!stage&&stageOrder.slice(0,3).includes(stage)
function reviewTarget(task:ClipMentorTaskSummary){
  const confirm=task.outputs.find(output=>output.status==='preview'&&output.awaitingConfirmation)
  const board=task.outputs.find(output=>output.status==='blueprint')
  const preview=task.outputs.find(output=>output.status==='preview')
  if(confirm)return {view:'film',audience:confirm.audience,urgency:0}
  if(board||task.status==='blueprint')return {view:'blueprint',audience:board?.audience,urgency:1}
  if(preview||task.status==='preview')return {view:'film',audience:preview?.audience,urgency:2}
  return undefined
}

function WorkspaceHome({ workspace, error }: { workspace?: ClipMentorWorkspace;error:string }) {
  const tasks = workspace?.tasks ?? []
  const needsReview=tasks.flatMap(task=>{
    const target=reviewTarget(task)
    return target?[{task,target}]:[]
  }).sort((a,b)=>a.target.urgency-b.target.urgency)
  const running=tasks.filter(task=>['running','queued','waiting'].includes(task.status))
  const saved=tasks.filter(task=>task.status==='materials')
  const inactive=tasks.filter(task=>['paused','completed','cancelled'].includes(task.status))
  const full=workspace&&workspace.running>=workspace.limit
  return <div className="cm-task-detail-layout cm-workspace-home">
    <aside className="cm-task-sidebar">
      <WorkspaceBrand/>
      <a className="cm-task-back" href={taskPage()} aria-current="page">全部任务</a>
      <TaskLinks tasks={[...needsReview.map(({task})=>task),...running,...saved,...inactive]}/>
    </aside>
    <main className="cm-task-main">
      <div className="cm-task-title">
        <div><h1>任务</h1><p className="cm-home-intro">待你处理的排在最前，点一下直接进入。</p></div>
        <div className="cm-task-actions"><Slots workspace={workspace}/><NewTask workspace={workspace}/></div>
      </div>
      {full&&<p className="cm-capacity-notice" role="status">同时制作已满 {workspace.limit} 个。可以<a href={taskPage(undefined,'new')}>先选素材</a>，有空位后再开始制作。</p>}
      {!workspace?(!error&&<p role="status">正在获取任务…</p>):tasks.length===0
        ?<div className="cm-task-empty"><h2>还没有任务</h2><p>上传四份素材，开始第一个任务。</p></div>:<>
        {needsReview.length>0&&<section className="cm-task-attention" aria-labelledby="cm-needs-you">
          <h2 id="cm-needs-you">待你处理 · {needsReview.length}</h2>
          <ul>{needsReview.map(({task,target})=>{
            const label=target.view==='blueprint'?'去审蓝图':'去看片'
            const audience=target.audience&&audienceTitleFor(target.audience)
            const state=target.view==='blueprint'?'蓝图待审核':target.urgency===0?'请查看确认状态':'请查看预览'
            return <li key={task.id}>
              <div><strong>{task.name}</strong><small>{audience&&`${audience} · `}{state} · <TaskTimestamp task={task}/></small></div>
              <a className="cm-button" href={taskPage(task.id,undefined,target.audience)} aria-label={`${label} · ${task.name}${audience?` · ${audience}`:''}`}>{label}</a>
            </li>
          })}</ul>
        </section>}
        {running.length>0&&<section className="cm-task-section" aria-labelledby="cm-running-tasks">
          <h2 id="cm-running-tasks">制作中 · {running.length} <small>无需操作</small></h2>
          <ul className="cm-task-list">{running.map(task=>{
            const stage=task.stage&&stages[task.stage]
            const index=stageOrder.indexOf(task.stage??'')
            return <li className="cm-task-row cm-task-running" key={task.id}>
              <h3><a href={taskPage(task.id)}>{task.name}</a></h3>
              <Status status={task.status} label={task.status==='running'?stage:undefined}/>
              {index>=0&&<progress aria-label="制作阶段" aria-valuetext={stage} max={stageOrder.length} value={index+1}/>}
              <TaskTimestamp task={task}/>
            </li>
          })}</ul>
        </section>}
        {saved.length>0&&<section className="cm-task-section" aria-labelledby="cm-saved-tasks">
          <h2 id="cm-saved-tasks">待开始 · {saved.length}</h2>
          <ul className="cm-task-list">{saved.map(task=><li className="cm-task-row" key={task.id}>
            <h3>{task.name}</h3><TaskTimestamp task={task}/>
            <a className="cm-button secondary" href={taskPage(task.id,'materials')}>查看素材</a>
          </li>)}</ul>
        </section>}
        {inactive.length>0&&<details className="cm-task-inactive">
          <summary>已暂停与已完成 · {inactive.length}</summary>
          <ul className="cm-task-list">{inactive.map(task=>{
            const confirmed=task.outputs.find(output=>output.status==='completed')
            const paused=task.status==='paused'
            const pausedOutput=task.outputs.find(output=>output.status==='paused')??task.outputs.find(output=>output.status==='unavailable')
            const pausedStage=pausedOutput?.stage??task.stage
            const stage=stages[pausedStage??'']
            const actionView=task.status==='completed'?'film':pausedOutput?(isBlueprintStage(pausedStage)?'blueprint':'film'):undefined
            return <li className="cm-task-row" key={task.id}>
              <h3>{task.name}</h3><Status status={task.status}/>
              {paused&&<p>{stage?`停在「${stage}」`:'暂时无法确认停在哪一步'} · <TaskTimestamp task={task}/></p>}
              {!paused&&<TaskTimestamp task={task}/>}
              <div className="cm-task-actions">
                <a className="cm-button secondary" href={taskPage(task.id,actionView,task.status==='completed'?confirmed?.audience:pausedOutput?.audience)}>{paused?'查看原因':task.status==='completed'?'去下载':'查看任务'}</a>
                {task.status!=='completed'&&confirmed&&<a href={taskPage(task.id,'film',confirmed.audience)}>去下载已确认版</a>}
              </div>
            </li>
          })}</ul>
        </details>}
      </>}
    </main>
  </div>
}

function TaskSteps({ task,preview }: { task:{status:WorkspaceStatus;stage?:string};preview?:Task }) {
  const steps=['交素材','审蓝图','看片提意见','拿成片']
  const actions=previewActions(preview)
  const stage=preview?.stage??task.stage
  const status=preview?.status??task.status
  const current=actions.canDownload||!preview&&status==='completed'?3:actions.watchable||status==='preview'?2
    :status==='materials'?0:!stage?-1:isBlueprintStage(stage)?1:2
  const paused=(status==='paused'||status==='blocked')&&!actions.watchable
  return <ol className="cm-task-steps" aria-label="制作步骤">{steps.map((step,index)=><li
    key={step} data-done={index<current||undefined} data-paused={paused&&current===index||undefined}
    aria-current={current===index?'step':undefined}><i aria-hidden="true">{index<current?<Check size={13}/>:index+1}</i><span>{step}</span></li>)}</ol>
}

const taskTabs=[['materials','素材'],['blueprint','蓝图'],['film','成片']] as const

function defaultTaskView(task:ClipMentorTaskSummary,audience?:Audience):TaskView{
  if(task.status==='materials')return 'materials'
  const selectedOutput=task.outputs.find(output=>output.audience===audience)
  if(selectedOutput?.status==='blueprint')return 'blueprint'
  if(selectedOutput&&['preview','completed'].includes(selectedOutput.status))return 'film'
  if(task.status==='blueprint'||reviewTarget(task)?.view==='blueprint')return 'blueprint'
  if(task.status==='preview'||task.status==='completed'||task.outputs.some(output=>['preview','completed'].includes(output.status)))return 'film'
  if(task.stage&&!isBlueprintStage(task.stage))return 'film'
  return 'blueprint'
}

function TaskDetails({ workspace, task, initialView }: { workspace:ClipMentorWorkspace; task:ClipMentorTaskSummary; initialView?:TaskView }) {
  const startState=new URLSearchParams(window.location.search).get('start')
  const [switchTarget,setSwitchTarget]=useState(task.id)
  const [preview,setPreview]=useState<Task>()
  const [view,setView]=useState(initialView)
  const [audience,setAudience]=useState<Audience|undefined>(()=>{
    const value=new URLSearchParams(window.location.search).get('audience')
    return value==='new_contact'||value==='existing_partner'?value:undefined
  })
  const preferredView=defaultTaskView(task,audience)
  const activeView=view??preferredView
  const activeNavigation=useRef({view:activeView,audience})
  activeNavigation.current={view:activeView,audience}
  const navigateTask:TaskNavigation=useCallback((from,to,nextAudience)=>{
    const current=activeNavigation.current
    if(current.view!==from)return
    const selected=nextAudience??current.audience
    setView(to)
    setAudience(selected)
    window.history.replaceState(window.history.state,'',taskPage(task.id,to,selected))
  },[task.id])
  const previousPreference=useRef({view:preferredView,audience})
  useEffect(()=>{
    const previous=previousPreference.current
    previousPreference.current={view:preferredView,audience}
    // Readback can publish the next step before the action is acknowledged.
    if(previous.audience===audience&&previous.view!==preferredView)navigateTask(previous.view)
  },[audience,preferredView,navigateTask])
  const changeAudience=useCallback((next:Audience)=>{
    setAudience(next)
    window.history.replaceState(window.history.state,'',taskPage(task.id,view,next))
  },[task.id,view])
  function changeView(next:TaskView){
    setView(next)
    window.history.replaceState(window.history.state,'',taskPage(task.id,next,audience))
  }
  const currentOutput=task.outputs.find(output=>output.audience===audience)
  const currentPreview=activeView==='film'&&(!audience||preview?.audience===audience)?preview:undefined
  const stepTask=activeView==='blueprint'
    ?task.outputs.find(output=>output.status==='blueprint')??(currentOutput&&isBlueprintStage(currentOutput.stage)?currentOutput:task)
    :currentOutput??task
  return <div className="cm-task-detail-layout">
    <aside className="cm-task-sidebar">
      <WorkspaceBrand/>
      <a className="cm-task-back" href={taskPage()}><ArrowLeft size={16}/> 全部任务</a>
      <TaskLinks tasks={workspace.tasks} current={task.id}/>
      <form className="cm-task-switch-form" onSubmit={event=>{
        event.preventDefault()
        if(switchTarget!==task.id)window.location.assign(taskPage(switchTarget))
      }}>
        <select className="cm-task-switch" aria-label="切换任务" value={switchTarget} onChange={event=>setSwitchTarget(event.target.value)}>
          {workspace.tasks.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <button className="cm-button secondary" type="submit" aria-label="打开所选任务" disabled={switchTarget===task.id}><ArrowRight size={15}/></button>
      </form>
      <div className="cm-task-sidebar-new"><NewTask workspace={workspace} secondary/></div>
    </aside>
    <main className="cm-task-detail">
      <div className="cm-task-title">
        <div><h1>{task.name}</h1>{activeView==='film'
          ?<p className="cm-detail-intro">复核由系统完成，进度在「成片」里查看。</p>
          :<Status status={task.status}/>}</div>
        {activeView!=='film'&&<Slots workspace={workspace}/>}
      </div>
      <TaskSteps task={stepTask} preview={currentPreview}/>
      <nav className="cm-task-detail-nav" aria-label="任务详情">
        {taskTabs.map(([key,label])=><button key={key} type="button" onClick={()=>changeView(key)} aria-current={activeView===key?'page':undefined}>{label}</button>)}
      </nav>
      {task.status==='materials'&&startState&&activeView==='materials'&&<p className="cm-workspace-error" role="status">
        {startState==='capacity'?'素材已保存。有空位后，点「开始制作」。':'素材已保存，制作进度见下方。'}
      </p>}
      <ClipMentorPage key={task.id} projectId={task.id} embedded running={workspace.running} limit={workspace.limit}
        workspaceView={activeView} taskStarted={task.status!=='materials'} requestedAudience={audience} onAudienceChange={changeAudience} onPreviewTask={setPreview} navigateTask={navigateTask}/>
    </main>
  </div>
}

function isWorkspace(value:unknown):value is ClipMentorWorkspace{
  if(!value||typeof value!=='object')return false
  const {tasks,running,limit}=value as ClipMentorWorkspace
  return Number.isSafeInteger(running)&&running>=0&&Number.isSafeInteger(limit)&&limit>=1&&limit<=100
    &&Array.isArray(tasks)&&tasks.every(task=>task&&typeof task.id==='string'&&typeof task.name==='string'
      &&Object.prototype.hasOwnProperty.call(statusLabels,task.status)&&Array.isArray(task.outputs)&&task.outputs.every(output=>
        output&&['new_contact','existing_partner'].includes(output.audience)&&Object.prototype.hasOwnProperty.call(statusLabels,output.status)))
}

export default function TaskWorkspace() {
  const query = new URLSearchParams(window.location.search)
  const projectId=query.get('task')
  const view=query.get('view')
  const initialView=view==='downloads'||view==='film'?'film':view==='materials'||view==='blueprint'?view:undefined
  const [workspace,setWorkspace]=useState<ClipMentorWorkspace>()
  const [error,setError]=useState('')
  const [accessLost,setAccessLost]=useState(false)
  useEffect(()=>{
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function read(){
      try{
        const response = await readJson(workspaceEndpoint,controller.signal)
        if(response.status===401||response.status===403){
          if(!controller.signal.aborted){
            setWorkspace(undefined)
            setAccessLost(true)
            setError('登录已失效，请刷新页面。')
          }
          return
        }
        const data:unknown=await response.json()
        if(!response.ok||!isWorkspace(data))throw Error('unavailable')
        if(!controller.signal.aborted){setWorkspace(data);setError('');setAccessLost(false)}
      }catch{if(!controller.signal.aborted)setError('列表暂时没更新，稍后自动重试。')}
      finally{if(!controller.signal.aborted)timer=setTimeout(read,5000)}
    }
    void read()
    return ()=>{controller.abort();clearTimeout(timer)}
  },[])
  const task=workspace?.tasks.find(item=>item.id===projectId)
  return <div className={`cm-shell cm-workspace-v2${projectId?' cm-workspace-detail':''}`}>
    {view==='new'&&<header className="cm-header"><WorkspaceBrand withMark/></header>}
    {error&&<p className="cm-workspace-error" role="alert">{error}</p>}
    {!accessLost&&(view==='new'?<main className="cm-task-main">
      <div className="cm-task-actions cm-task-new-top"><a className="cm-task-back" href={taskPage()}><ArrowLeft size={16}/> 全部任务</a><Slots workspace={workspace}/></div>
      <ClipMentorPage workspaceNew embedded running={workspace?.running} limit={workspace?.limit}/>
    </main>:projectId
      ? task&&workspace?<TaskDetails workspace={workspace} task={task} initialView={initialView}/>
        :<main className="cm-task-main">{workspace?<><h1>找不到这个任务，可能已被删除</h1><a className="cm-task-back" href={taskPage()}><ArrowLeft size={16}/> 全部任务</a></>
          :!error&&<p role="status">正在打开…</p>}</main>
      :<WorkspaceHome workspace={workspace} error={error}/>)}
  </div>
}
