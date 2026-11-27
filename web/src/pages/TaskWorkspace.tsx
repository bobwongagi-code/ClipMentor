import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, Download, Film, Plus } from 'lucide-react'
import type { ClipMentorTaskStatus, ClipMentorTaskSummary, ClipMentorWorkspace } from '../../../shared/clipmentor-tasks'
import ClipMentorPage from './ClipMentorPage'
import { audienceTitleFor, matchesPanelOutput, productionEndpoint, readPanelState, resourceUrl, type Audience, type Task } from './ProductionPanel'
import { previewActions, previewStatus } from './productionPanelState'
import { projectResource, taskPage, workspaceEndpoint } from './taskNavigation'

type WorkspaceStatus=ClipMentorTaskStatus|'unavailable'
const statusLabels: Record<WorkspaceStatus, string> = {
  materials:'待开始', running:'运行中', queued:'等待运行名额', waiting:'等待另一版剪辑', blueprint:'待审蓝图',
  preview:'预览阶段', paused:'已暂停', completed:'已确认', cancelled:'已取消', unavailable:'暂不可用',
}
const stages: Record<string,string> = {
  analysis:'分析', blueprint:'准备蓝图', copy_review:'检查蓝图', audio:'配音', edit:'剪辑', export:'生成预览', self_check:'复核',
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
    <span>运行名额</span><strong>{workspace.running} / {workspace.limit}</strong>
  </div>
}

function WorkspaceHome({ workspace }: { workspace?: ClipMentorWorkspace }) {
  const tasks = workspace?.tasks ?? []
  const needsReview = tasks.filter(task => task.status === 'blueprint' || task.status === 'preview')
  return <main className="cm-task-main">
    <div className="cm-task-title">
      <h1>任务</h1>
      <div className="cm-task-actions"><Slots workspace={workspace}/><a className="cm-button" href={taskPage(undefined,'new')}><Plus size={17}/> 新建任务</a></div>
    </div>
    {needsReview.length>0&&<section className="cm-task-attention" aria-labelledby="cm-needs-you">
      <h2 id="cm-needs-you">待你处理 <span>{needsReview.length} 项</span></h2>
      <ul>{needsReview.map(task=>{
        const relevant=task.status==='preview'?(task.outputs.find(output=>output.status==='preview'&&output.awaitingConfirmation)
          ??task.outputs.find(output=>output.status==='preview')):undefined
        const label=task.status==='blueprint'?'审核蓝图':'查看预览'
        return <li key={task.id}>
          <div><strong>{task.name}</strong>{relevant&&<small>{audienceTitleFor(relevant.audience)}</small>}</div>
          <a href={taskPage(task.id,undefined,relevant?.audience)} aria-label={`${label} · ${task.name}${relevant?` · ${audienceTitleFor(relevant.audience)}`:''}`}>
            {label} <ArrowRight size={15}/>
          </a>
        </li>
      })}</ul>
    </section>}
    {workspace&&<section aria-label="全部任务">
      {tasks.length===0?<div className="cm-task-empty"><h2>还没有任务</h2><p>新建任务，上传四份素材开始制作。</p></div>
        :<ul className="cm-task-list">{tasks.map(task=>{
          const confirmed=task.outputs.find(output=>output.status==='completed')
          const download=task.status==='completed'||task.status==='paused'&&!!confirmed
          const action=download?'下载页':task.status==='paused'?'查看进度':'打开'
          const updated=taskUpdateTime(task.updatedAt)
          return <li className="cm-task-row" key={task.id}>
          <div className="cm-task-row-copy"><h2>{task.name}</h2>
            <Status status={task.status} label={task.status==='paused'&&confirmed?'部分已确认':undefined}/>
            {task.outputs.length>0?<p>{task.outputs.map(output=>`${audienceTitleFor(output.audience)} ${statusLabels[output.status]}`).join(' · ')}</p>
              :task.stage&&<p>{stages[task.stage]}</p>}
          </div>
          <div className="cm-task-row-actions">
            {updated&&<time dateTime={updated.toISOString()}>{taskTime.format(updated)} 更新</time>}
            <a className="cm-button secondary" href={taskPage(task.id,download?'downloads':undefined,download?confirmed?.audience:undefined)} aria-label={`${action} ${task.name}`}>{action}</a>
          </div>
        </li>})}</ul>}
    </section>}
  </main>
}

function durationLabel(seconds?: number) {
  if (seconds===undefined||!Number.isFinite(seconds)||seconds<=0) return undefined
  const whole = Math.floor(seconds)
  return `${Math.floor(whole/60)}:${String(whole%60).padStart(2,'0')}`
}

type DownloadVersion={audience?:Audience;task?:Task;unavailable?:boolean;loading?:boolean}

function DownloadCard({ projectId, task, audience, unavailable, loading, current }: DownloadVersion & { projectId:string;current?:boolean }) {
  const render = task?.renderId
  const {canDownload:delivered,canDownloadDraft:draft,canConfirm:ready,watchable}=previewActions(task)
  const imageLabel=audience==='new_contact'?'合作海报':audience==='existing_partner'?'商品图':'随片图片'
  const url = (view:string) => projectResource(resourceUrl(view,'renderId',render!,audience),projectId)
  const when = task?.confirmedAt ? taskTime.format(task.confirmedAt) : undefined
  const version=audience?audienceTitleFor(audience):'成片'
  const watchLabel=delivered?'查看成片':ready?'去确认成片':'去看片'
  const summary = loading ? '正在读取下载状态…'
    : delivered ? (when ? `${when} 确认` : '')
    : ready ? ''
    : draft ? '预览可播放'
    : watchable ? (task?.deliveryHeld||task?.previewNeedsChanges ? '可看片，需修改' : '可看片，暂不能确认')
    : unavailable||task?.deliveryUnavailable||task?.deliveryHeld ? '暂不可下载'
    : '预览就绪后可在这里查看'
  return <article className="cm-task-download" data-current={current||undefined}>
    <header><Film size={19} aria-hidden="true"/><h3>{version}</h3>
      {delivered?<Status status="completed"/>:ready||draft?<Status status="preview" label={previewStatus(task)}/>:!watchable&&task?.status==='blocked'?<Status status="paused"/>:null}
    </header>
    <div className="cm-download-body">
      {(delivered||watchable)&&render&&<img className="cm-download-poster" key={render} src={url('panel_poster')} alt=""
        width="144" height="256" loading="lazy" decoding="async" onError={event=>{event.currentTarget.hidden=true}}/>}
      <div>
        <p>{[durationLabel(task?.previewDuration),render?'MP4':undefined,summary].filter(Boolean).join(' · ')}</p>
        {(delivered||watchable||draft)&&<div className="cm-task-actions">
          {delivered&&<a className="cm-button" href={url('panel_download')} download={task?.downloadName} aria-label={`下载成片 · ${version}`}><Download size={17}/> 下载成片</a>}
          {watchable&&<a className="cm-button secondary" href={taskPage(projectId,undefined,audience)} aria-label={`${watchLabel} · ${version}`}>{watchLabel}</a>}
        </div>}
      </div>
    </div>
    {draft&&<details className="cm-draft-download"><summary>需要先下载一份？</summary>
      <p>这份预览还在等复核。下载的文件名会标明「未复核」。</p>
      <a href={url('panel_draft_download')} download aria-label={`下载未复核版本 · ${version}`}>下载未复核版本</a>
    </details>}
    {render&&((task?.attachments?.length??0)>0||task?.materialAttachment)&&<ul className="cm-download-attachments">
      {task?.attachments?.map(file=><li key={file.assetId}><span>原片分镜（PDF）</span><a
        href={`${url('panel_attachment')}&${new URLSearchParams({assetId:file.assetId})}`} aria-label="下载原片分镜（PDF）" download={file.fileName}>下载</a></li>)}
      {task?.materialAttachment&&<li><span>{imageLabel}</span><a
        href={`${url('panel_material')}&${new URLSearchParams({assetId:task.materialAttachment.assetId})}`} aria-label={`下载${imageLabel}`} download>下载</a></li>}
    </ul>}
    {task?.materialAttachmentUnavailable&&<p>随片图片暂不可下载。</p>}
    {audience==='new_contact'&&(draft||ready||delivered)&&<p className="cm-download-note">对外发送前，核对片尾里的佣金等合作数字。</p>}
  </article>
}

function TaskDownloads({ projectId,audience,onPreviewTask }: { projectId:string;audience?:Audience;onPreviewTask:(task:Task|undefined)=>void }) {
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
          setData(panel.task&&(panel.task.renderId||panel.task.deliveryUnavailable)
            ?[{audience:panel.task.audience,task:panel.task}]:[])
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
            if(matchesPanelOutput(state?.task,audience,owner))result={audience,task:{...state.task,audience}}
          } catch { /* A sibling may still publish its own card. */ }
          if(!controller.signal.aborted)setData(current=>current?.map(item=>item.audience===audience?result:item))
        }))
      }catch{if(!controller.signal.aborted){setData(undefined);setError(true)}}
      finally{if(!controller.signal.aborted)timer=setTimeout(refresh,8000)}
    }
    void refresh()
    return ()=>{controller.abort();clearTimeout(timer)}
  },[projectId])
  useEffect(()=>{onPreviewTask(audience?data?.find(version=>version.audience===audience)?.task
    :data?.length===1?data[0].task:undefined)},[audience,data,onPreviewTask])
  const showCards=data?.some(({task,loading,unavailable})=>loading||unavailable||task?.renderId||task?.deliveryUnavailable)
  const selected=data?.find(version=>version.audience===audience)
  const cards=audience&&selected?[selected,...data!.filter(version=>version!==selected)]:data
  return <section className="cm-task-download-page" aria-labelledby="cm-download-title">
    <div className="cm-task-title"><h2 id="cm-download-title">下载</h2></div>
    {error?<p role="alert">暂时无法读取下载状态，稍后会自动刷新。</p>
      :!data?<p role="status">正在读取下载状态…</p>
        :showCards?<div className="cm-task-download-grid">{cards?.map(version=><DownloadCard key={version.audience??'single'}
          projectId={projectId} current={!!audience&&version.audience===audience} {...version}/>)}</div>
        :<p role="status">还没有可下载的版本。预览生成后可在这里查看。</p>}
  </section>
}

function TaskSteps({ task,preview }: { task:{status:WorkspaceStatus;stage?:string};preview?:Task }) {
  const steps=['上传素材','蓝图确认','预览与修改','复核','确认成片','下载']
  const actions=previewActions(preview)
  const stage=preview?.stage??task.stage
  const status=preview?.status??task.status
  const current=actions.canDownload?5:actions.canConfirm?4
    :actions.watchable?3
    :status==='cancelled'||status==='unavailable'?-1
    :!preview&&status==='completed'?5
    :status==='preview'||stage==='self_check'?3
    :!stage?0
    :['analysis','blueprint','copy_review'].includes(stage)?1:2
  return <ol className="cm-task-steps" aria-label="制作步骤">{steps.map((step,index)=><li
    key={step} data-done={index<current||undefined} aria-current={current===index?'step':undefined}>{step}</li>)}</ol>
}

function TaskDetails({ workspace, task, downloads }: { workspace:ClipMentorWorkspace; task:ClipMentorTaskSummary; downloads:boolean }) {
  const startState=new URLSearchParams(window.location.search).get('start')
  const [switchTarget,setSwitchTarget]=useState(task.id)
  const [preview,setPreview]=useState<Task>()
  const [audience,setAudience]=useState<Audience|undefined>(()=>{
    const value=new URLSearchParams(window.location.search).get('audience')
    return value==='new_contact'||value==='existing_partner'?value:undefined
  })
  const changeAudience=useCallback((next:Audience)=>{
    setAudience(next)
    window.history.replaceState(window.history.state,'',taskPage(task.id,downloads?'downloads':undefined,next))
  },[task.id,downloads])
  const downloadVisible=downloads||['preview','completed'].includes(task.status)||task.outputs.some(output=>['preview','completed'].includes(output.status))
  const currentOutput=task.outputs.find(output=>output.audience===audience)
  const currentPreview=!audience||preview?.audience===audience?preview:undefined
  return <div className="cm-task-detail-layout">
    <aside className="cm-task-sidebar">
      <a className="cm-task-back" href={taskPage()}><ArrowLeft size={16}/> 全部任务</a>
      <nav aria-label="切换任务"><ul>{workspace.tasks.map(item=><li key={item.id}>
        <a href={taskPage(item.id)} aria-current={item.id===task.id?'page':undefined}>
          <span className="cm-task-dot" data-status={item.status} aria-hidden="true"/>
          <span><strong>{item.name}</strong><small>{statusLabels[item.status]}</small></span>
        </a>
      </li>)}</ul></nav>
      <form className="cm-task-switch-form" onSubmit={event=>{
        event.preventDefault()
        if(switchTarget!==task.id)window.location.assign(taskPage(switchTarget))
      }}>
        <select className="cm-task-switch" aria-label="切换任务" value={switchTarget} onChange={event=>setSwitchTarget(event.target.value)}>
          {workspace.tasks.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <button className="cm-button secondary" type="submit" aria-label="打开所选任务" disabled={switchTarget===task.id}><ArrowRight size={15}/></button>
      </form>
      <a className="cm-button secondary cm-task-sidebar-new" aria-label="新建任务" href={taskPage(undefined,'new')}><Plus size={16}/> <span>新建任务</span></a>
    </aside>
    <main className="cm-task-detail">
      <div className="cm-task-title">
        <div><h1>{task.name}</h1>{(downloads||!currentPreview||!currentOutput)&&<Status status={currentOutput?.status??task.status} label={currentPreview?previewStatus(currentPreview):undefined}/>}</div>
        <Slots workspace={workspace}/>
      </div>
      <TaskSteps task={currentOutput??task} preview={currentPreview}/>
      {downloadVisible&&<nav className="cm-task-detail-nav" aria-label="任务详情">
        <a href={taskPage(task.id,undefined,audience)} aria-current={!downloads?'page':undefined}>任务进度</a>
        <a href={taskPage(task.id,'downloads',audience)} aria-current={downloads?'page':undefined}>下载</a>
      </nav>}
      {!downloads&&task.status==='materials'&&startState&&<p className="cm-workspace-error" role="status">
        {startState==='capacity'?'素材已保存。名额空出后，点「开始制作」。':'素材已保存。请在下方查看制作状态。'}
      </p>}
      {downloads?<TaskDownloads projectId={task.id} audience={audience} onPreviewTask={setPreview}/>
        :<ClipMentorPage key={task.id} projectId={task.id} embedded running={workspace.running} limit={workspace.limit}
          requestedAudience={audience} onAudienceChange={changeAudience} onPreviewTask={setPreview}/>}
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
