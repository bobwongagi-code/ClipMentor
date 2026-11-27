import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, Download, Film, Plus } from 'lucide-react'
import type { ClipMentorTaskStatus, ClipMentorTaskSummary, ClipMentorWorkspace } from '../../../shared/clipmentor-tasks'
import ClipMentorPage from './ClipMentorPage'
import { audienceTitleFor, productionEndpoint, readPanelState, resourceUrl, type Audience, type Task } from './ProductionPanel'
import { hasPlayablePreview } from './productionPanelState'
import { projectResource, taskPage, workspaceEndpoint } from './taskNavigation'

const statusLabels: Record<ClipMentorTaskStatus, string> = {
  materials:'待开始', running:'运行中', queued:'等待运行名额', waiting:'等待共用主体', blueprint:'待审蓝图',
  preview:'预览阶段', paused:'已暂停', completed:'已确认', cancelled:'已取消',
}
const stages: Record<string,string> = {
  analysis:'分析', blueprint:'准备蓝图', copy_review:'检查蓝图', audio:'配音', edit:'剪辑', export:'生成预览', self_check:'复核',
}

function readJson(url: string, signal: AbortSignal) {
  return fetch(url, { signal:AbortSignal.any([signal,AbortSignal.timeout(10_000)]), credentials:'same-origin', redirect:'error', cache:'no-store' })
}

function Status({ status, label }: { status: ClipMentorTaskStatus; label?:string }) {
  return <span className="cm-task-status" data-status={status}>{label??statusLabels[status]}</span>
}

function Slots({ workspace }: { workspace?: ClipMentorWorkspace }) {
  if (!workspace) return null
  return <div className="cm-task-slots" role="status">
    <span>运行名额</span><strong>{workspace.running} / {workspace.limit}</strong>
  </div>
}

function WorkspaceHome({ workspace }: { workspace?: ClipMentorWorkspace }) {
  const tasks = workspace?.tasks ?? []
  const needsReview = tasks.filter(task => task.status === 'blueprint' || task.status === 'preview')
  return <main className="cm-task-main">
    <div className="cm-task-title">
      <div><h1>任务</h1><p>只有运行中的任务占名额。</p></div>
      <div className="cm-task-actions"><Slots workspace={workspace}/><a className="cm-button" href={taskPage(undefined,'new')}><Plus size={17}/> 新建任务</a></div>
    </div>
    {needsReview.length>0&&<section className="cm-task-attention" aria-labelledby="cm-needs-you">
      <h2 id="cm-needs-you">待你处理 <span>{needsReview.length} 项</span></h2>
      <ul>{needsReview.map(task=><li key={task.id}>
        <strong>{task.name}</strong>
        <a href={taskPage(task.id)} aria-label={`${task.status==='blueprint'?'审核蓝图':'查看预览'} · ${task.name}`}>
          {task.status==='blueprint'?'审核蓝图':'查看预览'} <ArrowRight size={15}/>
        </a>
      </li>)}</ul>
    </section>}
    {workspace&&<section aria-label="全部任务">
      {tasks.length===0?<div className="cm-task-empty"><h2>还没有任务</h2><p>新建任务，上传四份素材开始制作。</p></div>
        :<ul className="cm-task-list">{tasks.map(task=><li className="cm-task-row" key={task.id}>
          <div className="cm-task-row-copy"><h2>{task.name}</h2>
            {task.outputs.length>0?<p>{task.outputs.map(output=>`${audienceTitleFor(output.audience)} ${statusLabels[output.status]}`).join(' · ')}</p>
              :task.stage&&<p>{stages[task.stage]}</p>}
          </div>
          <Status status={task.status} label={task.awaitingConfirmation?'待看预览':undefined}/>
          <a className="cm-button secondary" href={taskPage(task.id,task.status==='completed'?'downloads':undefined)} aria-label={`打开 ${task.name}`}>
            {task.status==='completed'?'下载页':'打开'}
          </a>
        </li>)}</ul>}
    </section>}
  </main>
}

function durationLabel(seconds?: number) {
  if (seconds===undefined||!Number.isFinite(seconds)||seconds<=0) return undefined
  const whole = Math.floor(seconds)
  return `${Math.floor(whole/60)}:${String(whole%60).padStart(2,'0')}`
}

type DownloadVersion={audience?:Audience;task?:Task;unavailable?:boolean;loading?:boolean}

function DownloadCard({ projectId, task, audience, unavailable, loading }: DownloadVersion & { projectId:string }) {
  const render = task?.renderId
  const delivered = task?.status==='completed'&&!task.deliveryHeld&&!task.deliveryUnavailable&&!!render
  const draft = task?.previewPending&&!task.previewNeedsChanges&&!task.deliveryHeld&&!!render
  const ready = task?.status==='awaiting_review'&&task.canAcceptPreview===true&&!task.deliveryHeld&&!task.deliveryUnavailable&&!!render
  const watchable = hasPlayablePreview(task)
  const url = (view:string) => projectResource(resourceUrl(view,'renderId',render!,audience),projectId)
  const when = task?.confirmedAt ? new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(task.confirmedAt) : undefined
  const summary = loading ? '正在读取下载状态…'
    : delivered ? (when ? `${when} 确认` : '')
    : ready ? ''
    : draft ? '预览可播放'
    : watchable ? (task?.deliveryHeld||task?.previewNeedsChanges ? '可看片，需修改' : '可看片，暂不能确认')
    : unavailable||task?.deliveryUnavailable||task?.deliveryHeld ? '暂不可下载'
    : '预览就绪后可在这里查看'
  return <article className="cm-task-download">
    <header><Film size={19} aria-hidden="true"/><h2>{audience?audienceTitleFor(audience):'成片'}</h2>
      {delivered?<Status status="completed"/>:ready?<Status status="preview" label="待确认"/>:draft?<Status status="preview" label={task.status==='blocked'?'复核暂停':'待复核'}/>:!watchable&&task?.status==='blocked'?<Status status="paused"/>:null}
    </header>
    <div className="cm-download-body">
      {(delivered||watchable)&&render&&<img className="cm-download-poster" key={render} src={url('panel_poster')} alt=""
        width="144" height="256" loading="lazy" decoding="async" onError={event=>{event.currentTarget.hidden=true}}/>}
      <div>
        <p>{[durationLabel(task?.previewDuration),render?'MP4':undefined,summary].filter(Boolean).join(' · ')}</p>
        {(delivered||watchable||draft)&&<div className="cm-task-actions">
          {delivered&&<a className="cm-button" href={url('panel_download')} download={task?.downloadName}><Download size={17}/> 下载成片</a>}
          {watchable&&<a className="cm-button secondary" href={taskPage(projectId,undefined,audience)}>{delivered?'查看成片':ready?'去确认成片':'去看片'}</a>}
        </div>}
      </div>
    </div>
    {draft&&<details className="cm-draft-download"><summary>需要先下载一份？</summary>
      <p>这份预览还在等复核。下载的文件名会标明「未复核」。</p>
      <a href={url('panel_draft_download')} download>下载未复核版本</a>
    </details>}
    {render&&((task?.attachments?.length??0)>0||task?.materialAttachment)&&<ul className="cm-download-attachments">
      {task?.attachments?.map(file=><li key={file.assetId}><span>原片 Storyboard（PDF）</span><a
        href={`${url('panel_attachment')}&${new URLSearchParams({assetId:file.assetId})}`} aria-label="下载原片 Storyboard" download={file.fileName}>下载</a></li>)}
      {task?.materialAttachment&&<li><span>{task.materialAttachment.label}</span><a
        href={`${url('panel_material')}&${new URLSearchParams({assetId:task.materialAttachment.assetId})}`} aria-label={`下载${task.materialAttachment.label}`} download>下载</a></li>}
    </ul>}
    {audience==='new_contact'&&(draft||ready||delivered)&&<p className="cm-download-note">对外发送前，核对片尾里的佣金等合作数字。</p>}
  </article>
}

function TaskDownloads({ projectId }: { projectId:string }) {
  const [data,setData] = useState<DownloadVersion[]>()
  const [error,setError] = useState(false)
  useEffect(()=>{
    const controller=new AbortController()
    let timer:ReturnType<typeof setTimeout>
    let currentOwner:string|undefined
    const endpoint=projectResource(productionEndpoint,projectId)
    const refresh=async()=>{
      try {
        const panel=await readPanelState(await readJson(endpoint,controller.signal))
        if(!panel) throw Error('unavailable')
        if(controller.signal.aborted)return
        setError(false)
        if(!panel.outputs?.length){
          currentOwner=undefined
          setData([{audience:panel.task?.audience,task:panel.task??undefined}])
          return
        }
        const owner=panel.outputOwner?.taskId
        const preserve=currentOwner===owner
        currentOwner=owner
        setData(previous=>panel.outputs!.map(({audience})=>
          (preserve?previous?.find(item=>item.audience===audience):undefined)??{audience,loading:true}))
        await Promise.all(panel.outputs.map(async ({audience})=>{
          let result:DownloadVersion={audience,unavailable:true}
          try {
            const state=await readPanelState(await readJson(`${endpoint}&audience=${audience}`,controller.signal))
            if(state?.task)result={audience,task:state.task}
          } catch { /* A sibling may still publish its own card. */ }
          if(!controller.signal.aborted)setData(current=>current?.map(item=>item.audience===audience?result:item))
        }))
      }catch{if(!controller.signal.aborted){setData(undefined);setError(true)}}
      finally{if(!controller.signal.aborted)timer=setTimeout(refresh,8000)}
    }
    void refresh()
    return ()=>{controller.abort();clearTimeout(timer)}
  },[projectId])
  return <section className="cm-task-download-page" aria-labelledby="cm-download-title">
    <div className="cm-task-title"><h2 id="cm-download-title">下载</h2></div>
    {error?<p role="alert">暂时无法读取下载状态，稍后会自动刷新。</p>
      :!data?<p role="status">正在读取下载状态…</p>
        :<div className="cm-task-download-grid">{data.map(version=><DownloadCard key={version.audience??'single'} projectId={projectId} {...version}/>)}</div>}
  </section>
}

function TaskSteps({ task }: { task:ClipMentorTaskSummary }) {
  const steps=['上传素材','蓝图确认','预览与修改','复核','确认成片','下载']
  const current=task.status==='cancelled'?-1
    :task.status==='completed'?5
    :task.awaitingConfirmation?4
    :task.status==='preview'||task.stage==='self_check'?3
    :!task.stage?0
    :['analysis','blueprint','copy_review'].includes(task.stage)&&!task.outputs.length?1:2
  return <ol className="cm-task-steps" aria-label="制作步骤">{steps.map((step,index)=><li
    key={step} data-done={index<current||undefined} aria-current={current===index?'step':undefined}>{step}</li>)}</ol>
}

function TaskDetails({ workspace, task, downloads }: { workspace:ClipMentorWorkspace; task:ClipMentorTaskSummary; downloads:boolean }) {
  const startState=new URLSearchParams(window.location.search).get('start')
  return <div className="cm-task-detail-layout">
    <aside className="cm-task-sidebar">
      <a className="cm-task-back" href={taskPage()}><ArrowLeft size={16}/> 全部任务</a>
      <nav aria-label="切换任务"><ul>{workspace.tasks.map(item=><li key={item.id}>
        <a href={taskPage(item.id)} aria-current={item.id===task.id?'page':undefined}>
          <span className="cm-task-dot" data-status={item.status} aria-hidden="true"/>
          <span><strong>{item.name}</strong><small>{statusLabels[item.status]}</small></span>
        </a>
      </li>)}</ul></nav>
      <a className="cm-button secondary cm-task-sidebar-new" aria-label="新建任务" href={taskPage(undefined,'new')}><Plus size={16}/> <span>新建任务</span></a>
      <select className="cm-task-switch" aria-label="切换任务" value={task.id}
        onChange={event=>window.location.assign(taskPage(event.target.value))}>
        {workspace.tasks.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
    </aside>
    <main className="cm-task-detail">
      <div className="cm-task-title">
        <div><h1>{task.name}</h1><Status status={task.status} label={task.awaitingConfirmation?'待看预览':undefined}/></div>
        <Slots workspace={workspace}/>
      </div>
      <TaskSteps task={task}/>
      <nav className="cm-task-detail-nav" aria-label="任务详情">
        <a href={taskPage(task.id)} aria-current={!downloads?'page':undefined}>任务进度</a>
        <a href={taskPage(task.id,'downloads')} aria-current={downloads?'page':undefined}>下载</a>
      </nav>
      {!downloads&&task.status==='materials'&&startState&&<p className="cm-workspace-error" role="status">
        {startState==='capacity'?'素材已保存。名额空出后，点「开始制作」。':'素材已保存，制作还未开始。请在下方查看。'}
      </p>}
      {downloads?<TaskDownloads projectId={task.id}/>
        :<ClipMentorPage key={task.id} projectId={task.id} embedded running={workspace.running} limit={workspace.limit}/>}
    </main>
  </div>
}

export default function TaskWorkspace() {
  const query = new URLSearchParams(window.location.search)
  const projectId=query.get('task')
  const view=query.get('view')
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
            setError('任务列表访问已失效，请刷新页面。')
          }
          return
        }
        const data=await response.json()
        if(!response.ok||!Array.isArray(data.tasks)||!Number.isSafeInteger(data.running)||!Number.isSafeInteger(data.limit))throw Error('unavailable')
        if(!controller.signal.aborted){setWorkspace(data);setError('');setAccessLost(false)}
      }catch{if(!controller.signal.aborted)setError('暂时无法更新任务列表，稍后会自动刷新。')}
      finally{if(!controller.signal.aborted)timer=setTimeout(read,5000)}
    }
    void read()
    return ()=>{controller.abort();clearTimeout(timer)}
  },[])
  const task=workspace?.tasks.find(item=>item.id===projectId)
  return <div className={projectId?'cm-shell cm-workspace-detail':'cm-shell'}>
    <header className="cm-header"><a className="cm-brand cm-workspace-brand" href={taskPage()}><img src="/clipmentor-mark.svg" alt=""/><strong>ClipMentor</strong></a></header>
    {error&&<p className="cm-workspace-error" role="alert">{error}</p>}
    {!accessLost&&(view==='new'?<main className="cm-task-main">
      <div className="cm-task-actions cm-task-new-top"><a className="cm-task-back" href={taskPage()}><ArrowLeft size={16}/> 全部任务</a><Slots workspace={workspace}/></div>
      <ClipMentorPage workspaceNew embedded running={workspace?.running} limit={workspace?.limit}/>
    </main>:projectId
      ? task&&workspace?<TaskDetails workspace={workspace} task={task} downloads={view==='downloads'}/>
        :<main className="cm-task-main">{workspace?<><h1>找不到这个任务</h1><a className="cm-task-back" href={taskPage()}><ArrowLeft size={16}/> 全部任务</a></>
          :!error&&<p role="status">正在打开任务…</p>}</main>
      :<WorkspaceHome workspace={workspace}/>)}
  </div>
}
