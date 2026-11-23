import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Check, Download, Play, Send } from 'lucide-react'

import { ProgressNode } from '../components/processing/ProgressNode'
import { productionProgress, productionActivity, productionPageTitle, reviewableBlueprintRevision, showSharedBlueprint } from './productionPanelState'

const productionEndpoint = `${__CLIPMENTOR_API_BASE_PATH__}/production`
type Task = {
  taskId?:string;sourceTaskId?:string
  status: string; stage: string; revision?: string; active: boolean; sequence: number
  stopReason?: 'materials' | 'limit' | 'service' | 'maintenance'; feedbackUsed: boolean; renderId?: string; hasBlueprintFeedback?:boolean; blueprintFeedbackSummary?:string[]; dualBlueprint?: boolean
  visualCriteria?: { digest: string }; downloadName?:string
  attachments?: {assetId:string;fileName:string}[]; deliveryUnavailable?:boolean
  boardIdentity?:string; blueprintRevision?: string; canApproveBlueprint?: boolean; blueprintMessage?: string
  canConfirmBlueprint?: boolean; audience?: 'new_contact' | 'existing_partner';blueprintConfirmed?:boolean
}
type Audience = 'new_contact' | 'existing_partner'
type State = { task: Task | null; unavailable?: string; outputs?: {audience:Audience}[]; outputOwner?:{taskId:string;sequence:number} }
type ActionReceipt = { accepted?: boolean; reason?: string }
const serviceUnavailable = '制作服务暂时不可用。'
const materialsUnavailable = '所需素材不齐全或无法读取，请重新核对上传素材。'

function resourceUrl(view: string, key: string, value: string, audience?:Audience) {
  return `${productionEndpoint}?${new URLSearchParams({ view, [key]: value, ...(audience?{audience}:{}) })}`
}

async function readApiJson<T>(response: Response): Promise<T | undefined> {
  if (response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return undefined
  return response.json().catch(() => undefined)
}

async function readPanelState(response: Response): Promise<State | undefined> {
  if (!response.ok) return
  const data = await readApiJson<State>(response)
  if (!data || typeof data !== 'object' || !('task' in data)) return
  if (data.task !== null && (typeof data.task?.status !== 'string' || !Number.isSafeInteger(data.task.sequence))) return
  if (data.outputs !== undefined && (!Array.isArray(data.outputs) ||
    data.outputs.some(output => output?.audience !== 'new_contact' && output?.audience !== 'existing_partner'))) return
  return data
}

export default function ProductionPanel({ assets, onRecheck, requestApi, outputAudience, sharedTask, onTask, unifiedBlueprint = false }: { assets: { id: string; title: string; name: string }[]; onRecheck: () => void; requestApi: (url: string, init?: RequestInit) => Promise<Response>; outputAudience?:Audience; sharedTask?:Task; onTask?:(task:Task)=>void; unifiedBlueprint?:boolean }) {
  const endpoint = outputAudience ? `${productionEndpoint}?audience=${outputAudience}` : productionEndpoint
  const assetUrl=(view:string,key:string,value:string)=>resourceUrl(view,key,value,outputAudience)
  const audienceTitle=outputAudience==="new_contact"?"新建联达人版":"已合作达人版"
  const [state, setState] = useState<State>()
  const [error, setError] = useState('')
  const [readError, setReadError] = useState('')
  const [pendingAction, setPendingAction] = useState<{key:string;controller:AbortController}>()
  const [board, setBoard] = useState<{ key:string; revision: string; identity?:string; html: string }>()
  const [boardError, setBoardError] = useState('')
  const [feedbackDraft, setFeedbackDraft] = useState<{key:string;text:string}>()
  const [confirmation, setConfirmation] = useState<{key:string;checked:boolean;acknowledged?:boolean}>()
  const boardFrame = useRef<HTMLIFrameElement>(null)
  const nextRead = useRef(0)
  const latestRead = useRef(0)
  function remember(next: State, read: number) {
    if(read < latestRead.current)return
    latestRead.current=read
    setState(current => {
      const previousOwner=current?.outputOwner??current?.task
      const nextOwner=next.outputOwner??next.task
      if(previousOwner?.taskId&&previousOwner.taskId===nextOwner?.taskId
        &&previousOwner.sequence>nextOwner.sequence)return current
      if(next.outputs)return next
      if(current?.outputs&&!next.task)return current
      if(current?.outputs&&current.outputOwner?.taskId===next.task?.taskId)return current
      if(!current?.task)return next
      if(!next.task)return current
      if(current.task.taskId&&next.task.taskId&&current.task.taskId!==next.task.taskId){
        if(current.task.sourceTaskId===next.task.taskId)return current
        return next
      }
      return current.task.sequence>next.task.sequence?current:next
    })
  }
  const [sharedProgress, setSharedProgress] = useState<Task>()
  const reportSharedProgress=useCallback((next:Task)=>setSharedProgress(next),[])
  const task = state?.task
  useEffect(()=>{if(task)onTask?.(task)},[task,onTask])
  const visual = task?.visualCriteria
  const visualKey = `${task?.taskId}:${task?.renderId}:${visual?.digest}`
  const languageConfirmed = Boolean(confirmation?.key === visualKey && confirmation.checked)
  const awaitingAcceptance = Boolean(confirmation?.key === visualKey && confirmation.acknowledged)
  const pollingActive = task?.active === true
  const boardRevision = reviewableBlueprintRevision(task)
  const boardIdentity=task?.boardIdentity
  const boardKey=JSON.stringify([endpoint,task?.taskId,boardRevision,boardIdentity])
  const boardUrl=(revision:string,identity?:string)=>assetUrl('panel_board','revision',revision)+(identity?`&${new URLSearchParams({boardIdentity:identity})}`:'')
  const currentBoard=board?.key===boardKey?board:undefined
  const actionKey=JSON.stringify([boardKey,task?.renderId,visual?.digest,state?.outputOwner?.taskId])
  const feedback=feedbackDraft?.key===actionKey?feedbackDraft.text:''
  const currentAction=useRef({key:actionKey,sequence:task?.sequence})
  currentAction.current={key:actionKey,sequence:task?.sequence}
  const actionController=useRef<AbortController>()
  const pending=(pendingAction?.key===actionKey && !pendingAction.controller.signal.aborted) || awaitingAcceptance
  useEffect(()=>()=>{actionController.current?.abort();actionController.current=undefined},[actionKey])

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    let failures = 0
    async function read() {
      const readId=++nextRead.current
      try {
        const response = await requestApi(endpoint, { signal: controller.signal })
        const data = await readPanelState(response)
        if (!data) throw new Error('暂时无法读取制作状态')
        if (!controller.signal.aborted) {
          remember(data,readId)
          failures = 0
          setReadError('')
          if(!data.outputs)timer = setTimeout(read, data.task?.active ? 2000 : 8000)
        }
      } catch {
        if (!controller.signal.aborted) {
          if (++failures === 3) setReadError('制作状态暂时无法更新，正在重新连接。请稍后核对最新状态。')
          timer = setTimeout(read, 8000)
        }
      }
    }
    void read()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [pollingActive, endpoint, requestApi])

  useEffect(() => {
    setBoard(undefined)
    setBoardError('')
    const revision = boardRevision
    if (!revision) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function readBoard(revision: string, attempt: number) {
      try {
        const response = await requestApi(boardUrl(revision,boardIdentity), { signal: controller.signal })
        if (!response.ok) throw new Error('Board unavailable')
        const identity=response.headers.get('X-ClipMentor-Board-Identity')??undefined
        if(boardIdentity&&identity!==boardIdentity)throw new Error('Board changed')
        const html = await response.text()
        if (!controller.signal.aborted) setBoard({ key:boardKey, revision, identity, html })
      } catch {
        if (controller.signal.aborted) return
        if (attempt < 2) timer = setTimeout(() => void readBoard(revision, attempt + 1), 2000)
        else setBoardError('审核板暂时无法打开。')
      }
    }
    void readBoard(revision, 0)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [boardKey, requestApi])

  useEffect(() => {
    if (!currentBoard?.identity) return
    const frame = boardFrame.current
    const revision = currentBoard.revision
    const identity = currentBoard.identity
    const controller = new AbortController()
    let pending = false
    const receive = async (event: MessageEvent) => {
      if (!frame?.contentWindow || event.source !== frame.contentWindow || event.origin !== 'null'
        || event.data?.type !== 'clipmentor:request-teaching-excerpt' || pending) return
      pending = true
      const source = frame.contentWindow
      let bytes: ArrayBuffer | undefined
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(50_000)])
        const response = await requestApi(boardUrl(revision, identity) + '&excerpt=1', { signal })
        if (!response.ok || response.headers.get('Content-Type') !== 'video/mp4'
          || response.headers.get('X-ClipMentor-Board-Identity') !== identity) throw new Error('Excerpt unavailable')
        bytes = await response.arrayBuffer()
        if (!bytes.byteLength || bytes.byteLength > 2 * 1024 * 1024) bytes = undefined
      } catch {
        bytes = undefined
      } finally {
        pending = false
      }
      if (!controller.signal.aborted && frame === boardFrame.current && frame.contentWindow === source) {
        source.postMessage({ type: 'clipmentor:teaching-excerpt', bytes }, '*', bytes ? [bytes] : [])
      }
    }
    window.addEventListener('message', receive)
    return () => { controller.abort(); window.removeEventListener('message', receive) }
  }, [currentBoard, endpoint, requestApi])

  async function action(name: string) {
    if (actionController.current || awaitingAcceptance) return
    const controller=new AbortController()
    actionController.current=controller
    const signal=controller.signal
    const stillCurrent=()=>currentAction.current.key===actionKey&&!signal.aborted
    setPendingAction({key:actionKey,controller})
    setError('')
    try {
      const revision = currentBoard?.revision
      const identity = currentBoard?.identity
      const subjectKey=boardKey
      const submit = () => requestApi(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
        body: JSON.stringify({ action: name, revision, boardIdentity:identity, renderId: task?.renderId, text: feedback, languageConfirmed,
          ...(name === 'accept' && visual ? { visualCriteriaDigest: visual.digest, wholePreviewConfirmed: languageConfirmed } : {}) }),
      })
      let response = await submit()
      let result = await readApiJson<ActionReceipt>(response)
      if(!stillCurrent())return
      if (response.status === 409 && result?.reason === 'review_board_reload' && revision
        && (name === 'approve_blueprint' || name === 'revise_blueprint' || name === 'produce_versions')) {
        // This response is returned before any mutation. Restore exactly the
        // board the reviewer acted on before sending the same action once.
        if(!stillCurrent())return
        const refreshed = await requestApi(boardUrl(revision,identity),{signal})
        if (refreshed.ok) {
          const refreshedIdentity=refreshed.headers.get('X-ClipMentor-Board-Identity')??undefined
          const html=await refreshed.text()
          if(!stillCurrent())return
          if(identity&&refreshedIdentity!==identity)throw new Error('Board changed')
          setBoard({ key:subjectKey, revision, identity:refreshedIdentity, html })
          response = await submit()
          result = await readApiJson<ActionReceipt>(response)
        }
      }
      if(!stillCurrent())return
      if (!response.ok) {
        const messages: Record<string,string> = {
          materials:materialsUnavailable,
          review_board_changed:'蓝图已更新，请核对当前版本后再确认。',
        }
        setError(messages[result?.reason ?? ''] ?? '操作暂未完成，请稍后查看。')

        return
      }
      if (result?.accepted !== true) throw new Error('Missing production acknowledgement')
      if (name === 'accept') {
        setConfirmation(current => current?.key === visualKey ? { ...current, acknowledged: true } : current)
      }
      const readId=++nextRead.current
      const next = await requestApi(endpoint,{signal}).catch(() => undefined)
      const latest = next ? await readPanelState(next) : undefined
      if(!stillCurrent()||readId<latestRead.current)return
      const confirmed = latest?.task?.status === 'completed' && !latest.task.deliveryUnavailable
        && !!task?.taskId && latest.task.taskId === task.taskId && latest.task.renderId === task.renderId
        && latest.task.sequence >= (currentAction.current.sequence ?? task.sequence)
      setFeedbackDraft(current=>current?.key===actionKey&&current.text===feedback?undefined:current)
      if (name !== 'accept' || confirmed) {
        setConfirmation(current => current?.key === visualKey ? undefined : current)
      }
      if (name === 'accept' && task?.renderId && confirmed) {
        const link=document.createElement('a')
        link.href=assetUrl('panel_download','renderId',task.renderId)
        link.download=task.downloadName ?? ''
        document.body.appendChild(link);link.click();link.remove()
      }
      if(latest)remember(latest,readId)
    } catch {
      if(stillCurrent())setError('操作暂未确认，页面会自动刷新状态。')
    } finally {
      if(actionController.current===controller){
        actionController.current=undefined
        setPendingAction(undefined)
      }
    }
  }

  function revise(event: FormEvent) {
    event.preventDefault()
    if (feedback.trim()) void action(boardRevision ? 'revise_blueprint' : 'revise_preview')
  }

  const awaitingPreview = task?.status === 'awaiting_review'
  const completed = task?.status === 'completed'
  const stopMessage = task?.stopReason === 'materials' ? '无法读取已上传的原片，需要核对素材。'
    : task?.stopReason === 'limit' ? '本次制作已达到处理上限，已保存的进度会保留。'
    : task?.stopReason === 'maintenance' ? '制作已暂停，已保存的进度会保留。无需重新上传。'
    : task?.stopReason === 'service' ? serviceUnavailable : undefined
  const canConfirm = !!task && (!!task.canConfirmBlueprint || !task.dualBlueprint && task.canApproveBlueprint !== false)
  const reviewTitle = boardRevision ? '审核蓝图' : awaitingPreview ? '预览与终审' : '成片已确认'
  const sharedBlueprint = showSharedBlueprint(sharedProgress)
  if(state?.outputs)return <>
    <div className="cm-heading"><h1>{productionPageTitle(sharedProgress)}</h1><p>{sharedBlueprint?'共用片头与教学主体，片尾分别面向新建联和已合作达人。':'共用主体只制作一次，再生成两个片尾版本。'}</p></div>
    <div className="cm-output-list">
    {state.outputs.filter(output=>!sharedBlueprint || output.audience==='existing_partner').map(output=><section key={output.audience} aria-label={sharedBlueprint?'共用蓝图':output.audience==='new_contact'?'新建联达人版':'已合作达人版'}>
      <ProductionPanel assets={assets} onRecheck={onRecheck} requestApi={requestApi} unifiedBlueprint={sharedBlueprint} outputAudience={output.audience} sharedTask={sharedProgress} onTask={output.audience==='existing_partner'?reportSharedProgress:undefined} />
    </section>)}
    </div>
  </>
  return <>
    {!task ? <>
      <div className="cm-heading"><h1>素材已上传</h1><p>四份素材均已保存到当前工程。</p></div>
      <section className="cm-panel">
        <ul className="cm-saved-assets">{assets.map(asset => <li key={asset.id}>
          <Check size={17} aria-hidden="true" /> <strong>{asset.title}</strong><span>{asset.name}</span>
        </li>)}</ul>
        <div className="cm-footer">
          <p>{state?.unavailable ? serviceUnavailable : state ? '自动检查和修订蓝图，交你确认后再剪辑。' : '正在检查制作服务…'}</p>
          {state && <button className="cm-button secondary" disabled={pending} onClick={onRecheck}>从上传开始</button>}
          <button className="cm-button" disabled={!state || !!state.unavailable || pending} onClick={() => void action('start')}><Play size={17} /> 开始制作</button>
        </div>
      </section>
    </> : boardRevision || awaitingPreview || completed ? <>
      {!unifiedBlueprint && <div className={outputAudience?"cm-output-heading":"cm-heading"}><h1>{outputAudience?audienceTitle:reviewTitle}</h1></div>}
      <section className="cm-panel cm-work">
        {boardRevision && (currentBoard?.revision === boardRevision
          ? <iframe key={boardKey} ref={boardFrame} title="人审版蓝图" className="cm-review-board" sandbox="allow-scripts" srcDoc={currentBoard.html} />
          : <p role="status">{boardError || '正在生成审片板…'}</p>)}
        {(awaitingPreview || completed) && (task.renderId
          ? <video className="cm-final-video" controls preload="metadata" src={assetUrl('panel_video', 'renderId', task.renderId)} />
          : <p role="alert">预览暂时无法播放。</p>)}
        {(boardRevision || awaitingPreview && !task.feedbackUsed) && <form className="cm-feedback" onSubmit={revise}>
          {task.hasBlueprintFeedback && boardRevision && <section className="cm-feedback-summary" aria-label="上次修改要点">
            <h3>上次修改要点</h3>
            {task.blueprintFeedbackSummary?.length
              ?<ul>{task.blueprintFeedbackSummary.map((point,index)=><li key={index}>{point}</li>)}</ul>
              :<p>修改意见已保存，整理后显示要点。</p>}
          </section>}
          <label htmlFor={`cm-production-feedback-${outputAudience??"source"}`}>修改意见</label>
          <textarea id={`cm-production-feedback-${outputAudience??"source"}`} disabled={pending} value={feedback} onChange={event => setFeedbackDraft({key:actionKey,text:event.target.value})} maxLength={8000} placeholder="写下要改的位置和希望看到的效果" />
          <button className="cm-button secondary" disabled={pending || !feedback.trim() || (boardRevision ? currentBoard?.revision !== boardRevision : !task.renderId)}><Send size={16} /> 提交修改</button>
        </form>}
        <div className="cm-footer">
          {boardRevision && <button className="cm-button" disabled={pending || currentBoard?.revision !== boardRevision || !canConfirm} onClick={() => void action(task.canConfirmBlueprint?'produce_versions':'approve_blueprint')}>确认蓝图，开始制作</button>}
          {boardRevision && !canConfirm && <p>{task.blueprintMessage ?? stopMessage ?? '蓝图检查尚未完成，暂不能开始制作。'}</p>}
          {awaitingPreview && <>
            <label><input type="checkbox" checked={languageConfirmed} disabled={pending} onChange={event => setConfirmation({key:visualKey,checked:event.target.checked})} /> 已核对成片及马来语，确认可交付</label>
            <button className="cm-button" disabled={pending || task.deliveryUnavailable || !task.renderId || !languageConfirmed} onClick={() => void action('accept')}>确认并下载成片</button>
            {awaitingAcceptance && <p role="status">操作已收到，正在核对最新状态。</p>}
          </>}
          {(awaitingPreview || completed) && task.renderId && task.attachments?.map(file => <a key={file.assetId} className="cm-button secondary" href={`${assetUrl('panel_attachment', 'renderId', task.renderId!)}&${new URLSearchParams({assetId:file.assetId})}`} download={file.fileName}><Download size={17} /> 下载 Storyboard</a>)}
          {task.deliveryUnavailable && <p role="alert">随片资料暂时无法下载。</p>}
          {completed && task.renderId && <a className="cm-button" href={assetUrl('panel_download', 'renderId', task.renderId)} download={task.downloadName}><Download size={17} /> 下载成片</a>}
        </div>
      </section>
    </> : <>
      <section className="cm-panel cm-production-progress" aria-label={outputAudience?audienceTitle:'制作进度'}>
        <div className="cm-output-heading"><h2>{unifiedBlueprint?'蓝图进度':outputAudience?audienceTitle:productionPageTitle(task)}</h2>
          <span role="status">{stopMessage || (task.status==='cancelled'?'制作已取消':task.status==='waiting'?(sharedTask?.stopReason?'共用主体暂未完成':`共用主体 · ${productionActivity(sharedTask)}`):productionActivity(task))}</span>
        </div>
        <div className="cm-production-track" aria-label="制作阶段">
          {productionProgress(task,sharedTask).map(({label,state})=><ProgressNode key={label} label={label} state={state} />)}
        </div>
      </section>
    </>}
    {(error || readError) && <p className="cm-caption cm-upload-error" role="alert">{error || readError}</p>}
  </>
}
