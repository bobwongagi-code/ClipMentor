import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Check, Download, Play, Send } from 'lucide-react'
import { BLUEPRINT_OPINION_MAX_LENGTH, type BlueprintOpinion, type BlueprintOpinionConfirmation, type BlueprintOpinionDifference, type BlueprintOpinionPlacement } from '../../../shared/clipmentor-blueprint-opinions'

import { ProgressNode } from '../components/processing/ProgressNode'
import { productionProgress, productionActivity, productionPageTitle, reviewableBlueprintRevision, showSharedBlueprint } from './productionPanelState'

export const productionEndpoint = `${__CLIPMENTOR_API_BASE_PATH__}/production`
type Task = {
  taskId?:string;sourceTaskId?:string
  status: string; stage: string; revision?: string; active: boolean; sequence: number
  stopReason?: 'materials' | 'limit' | 'service' | 'maintenance'; feedbackUsed: boolean; renderId?: string; hasBlueprintFeedback?:boolean; blueprintFeedbackSummary?:string[]; dualBlueprint?: boolean
  visualCriteria?: { digest: string }; downloadName?:string
  attachments?: {assetId:string;fileName:string}[]; deliveryUnavailable?:boolean
  boardIdentity?:string; blueprintRevision?: string; canApproveBlueprint?: boolean; blueprintMessage?: string
  teachingDecisionChange?:string
  blueprintOpinionDifferences?:{overall?:BlueprintOpinionDifference;groups:BlueprintOpinionDifference[]}
  reviewGroups?:Array<{id:string;label:string}>
  reviewEndings?:Array<{id:string;label:string;materials:Array<{id:string;name:string}>}>
  savedReview?:{groups:GroupReview[];endings:Array<{id:string}>}
  canAcceptPreview?:boolean; reviewIssue?:ReviewIssue
  canConfirmBlueprint?: boolean; audience?: 'new_contact' | 'existing_partner';blueprintConfirmed?:boolean
}
type Audience = 'new_contact' | 'existing_partner'
type State = { task: Task | null; unavailable?: string; outputs?: {audience:Audience}[]; outputOwner?:{taskId:string;sequence:number} }
type ActionReceipt = { accepted?: boolean; reason?: string; issue?:ReviewIssue; notesSaved?:boolean;
  opinionConfirmation?:BlueprintOpinionConfirmation;opinionPlacements?:BlueprintOpinionPlacement[] }
type GroupReview = {id:string;decision:string;stance:'accepted'|'changes'|'pending'}
type ReviewIssue = {kind:'content'|'gate'|'binding';message:string}
const issueLabel={content:'内容缺口',gate:'疑似门禁误判',binding:'绑定或格式问题'}
type FeedbackDraft = {key:string;text:string;target?:string;confirmed?:boolean;start?:string;end?:string;kind?:'content'|'execution'}
const noGroups:NonNullable<Task['reviewGroups']>=[]
const noEndings:NonNullable<Task['reviewEndings']>=[]
const serviceUnavailable = '制作服务暂时不可用。'
const materialsUnavailable = '所需素材不齐全或无法读取，请重新核对上传素材。'

function BlueprintOpinionChanges({differences}:{differences:NonNullable<Task['blueprintOpinionDifferences']>}) {
  const sections=[...(differences.overall?[differences.overall]:[]),...differences.groups]
  return <div className="cm-feedback-summary">
    {sections.map(section=><details key={section.label}><summary>{section.label} · 修改对照</summary>
      {section.changes.length===0&&<p>本次未改动。</p>}
      {section.changes.map((change,index)=><div key={index}><del>{change.before}</del><p>{change.after}</p></div>)}
      {section.kept.length>0&&<ul>{section.kept.map((text,index)=><li key={index}>原样 {text}</li>)}</ul>}
    </details>)}
  </div>
}

function resourceUrl(view: string, key: string, value: string, audience?:Audience) {
  return `${productionEndpoint}?${new URLSearchParams({ view, [key]: value, ...(audience?{audience}:{}) })}`
}

async function readApiJson<T>(response: Response): Promise<T | undefined> {
  if (response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return undefined
  return response.json().catch(() => undefined)
}

async function readBoardPage(response: Response, expectedIdentity?: string) {
  const identity = response.headers.get('X-ClipMentor-Board-Identity') ?? undefined
  if (!response.ok || response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== 'text/html'
    || (expectedIdentity && identity !== expectedIdentity)) throw new Error('Board unavailable')
  const html = await response.text()
  if (!html.trim()) throw new Error('Board unavailable')
  return { identity, html }
}

export async function readPanelState(response: Response): Promise<State | undefined> {
  if (!response.ok) return
  const data = await readApiJson<State>(response)
  if (!data || typeof data !== 'object' || !('task' in data)) return
  if (data.task !== null && (typeof data.task?.status !== 'string' || !Number.isSafeInteger(data.task.sequence))) return
  if (data.outputs !== undefined && (!Array.isArray(data.outputs) ||
    data.outputs.some(output => output?.audience !== 'new_contact' && output?.audience !== 'existing_partner'))) return
  return data
}

export default function ProductionPanel({ assets, onRecheck, requestApi, outputAudience, sharedTask, onTask, unifiedBlueprint = false, mediaRefresh }: { assets: { id: string; title: string; name: string }[]; onRecheck: () => void; requestApi: (url: string, init?: RequestInit) => Promise<Response>; outputAudience?:Audience; sharedTask?:Task; onTask?:(task:Task)=>void; unifiedBlueprint?:boolean; mediaRefresh?:number }) {
  const endpoint = outputAudience ? `${productionEndpoint}?audience=${outputAudience}` : productionEndpoint
  const assetUrl=(view:string,key:string,value:string)=>resourceUrl(view,key,value,outputAudience)
  const audienceTitle=outputAudience==="new_contact"?"新建联达人版":"已合作达人版"
  const [state, setState] = useState<State>()
  const [error, setError] = useState('')
  const [readError, setReadError] = useState('')
  const [actionIssue,setActionIssue]=useState<{key:string;issue:ReviewIssue}>()
  const [savedGroupNotice,setSavedGroupNotice]=useState<string>()
  const [pendingAction, setPendingAction] = useState<{key:string;controller:AbortController}>()
  const [board, setBoard] = useState<{ key:string; revision: string; identity?:string; html: string }>()
  const [boardError, setBoardError] = useState('')
  const [boardReload, setBoardReload] = useState(0)
  const [feedbackDraft, setFeedbackDraft] = useState<FeedbackDraft>()
  const [opinionDraft,setOpinionDraft]=useState<{key:string;entries:BlueprintOpinion[]}>()
  const [opinionReview,setOpinionReview]=useState<{key:string;entries:BlueprintOpinion[];confirmation?:BlueprintOpinionConfirmation;placement?:BlueprintOpinionPlacement}>()
  const [opinionNotice,setOpinionNotice]=useState<string>()
  const [confirmation, setConfirmation] = useState<{key:string;watched?:boolean;language?:boolean;acknowledged?:boolean}>()
  const [groupDraft,setGroupDraft]=useState<{key:string;groups:GroupReview[];endingIds:string[]}>()
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
  const languageConfirmed = Boolean(confirmation?.key === visualKey && confirmation.language)
  const previewWatched = Boolean(confirmation?.key === visualKey && confirmation.watched)
  function setPreviewConfirmation(field:'watched'|'language',value:boolean){
    setConfirmation(current=>({...(current?.key===visualKey?current:{key:visualKey}),[field]:value}))
  }
  const awaitingAcceptance = Boolean(confirmation?.key === visualKey && confirmation.acknowledged)
  const pollingActive = task?.active === true
  const boardRevision = reviewableBlueprintRevision(task)
  const boardIdentity=task?.boardIdentity
  const boardKey=JSON.stringify([endpoint,task?.taskId,boardRevision,boardIdentity])
  const boardUrl=useCallback((revision:string,identity?:string)=>resourceUrl('panel_board','revision',revision,outputAudience)
    +(identity?`&${new URLSearchParams({boardIdentity:identity})}`:''),[outputAudience])
  const currentBoard=board?.key===boardKey?board:undefined
  const actionKey=JSON.stringify([boardKey,task?.renderId,visual?.digest,state?.outputOwner?.taskId])
  const draft:FeedbackDraft=feedbackDraft?.key===actionKey?feedbackDraft:{key:actionKey,text:''}
  const feedback=draft.text
  const groups=task?.reviewGroups??noGroups
  const endings=task?.reviewEndings??noEndings
  const review=groupDraft?.key===boardKey?groupDraft:{key:boardKey,groups:task?.savedReview?.groups??[],
    endingIds:task?.savedReview?.endings.map(ending=>ending.id)??[]}
  const opinionEntries=opinionDraft?.key===boardKey?opinionDraft.entries:undefined
  const pendingOpinion=opinionReview?.key===boardKey?opinionReview:undefined
  const hasOpinionDraft=opinionEntries?.some(entry=>entry.text.trim())===true
  const feedbackTarget=draft.target==='whole'&&draft.confirmed?{scope:'whole',confirmed:true}
    :draft.target==='range'&&draft.start?.trim()&&draft.end?.trim()&&Number(draft.start)>=0&&Number.isFinite(Number(draft.end))&&Number(draft.end)>Number(draft.start)
      ?{scope:'range',start:Number(draft.start),end:Number(draft.end)}
      :groups.some(group=>group.id===draft.target?.slice(6))&&draft.target?.startsWith('group:')
        ?{scope:'group',unitId:draft.target.slice(6),kind:draft.kind??'content'}:undefined
  const reviewIssue=(actionIssue?.key===actionKey?actionIssue.issue:undefined)??task?.reviewIssue
  function changeReview(id:string,change:Partial<Omit<GroupReview,'id'>>){
    const prior=review.groups.find(entry=>entry.id===id)??{id,decision:'',stance:'pending' as const}
    setSavedGroupNotice(undefined)
    setGroupDraft({...review,groups:[...review.groups.filter(entry=>entry.id!==id),{...prior,...change}]})
  }
  const currentAction=useRef({key:actionKey,sequence:task?.sequence})
  currentAction.current={key:actionKey,sequence:task?.sequence}
  const actionController=useRef<AbortController>()
  const pending=(pendingAction?.key===actionKey && !pendingAction.controller.signal.aborted) || awaitingAcceptance
  useEffect(()=>()=>{actionController.current?.abort();actionController.current=undefined},[actionKey])

  const writeOpinion=useCallback((unitId:string|null,text:string)=>{
    setOpinionDraft(current=>{
      const entries=current?.key===boardKey?current.entries:[]
      return {key:boardKey,entries:[...entries.filter(entry=>entry.unitId!==unitId),{unitId,text}]}
    })
    setOpinionReview(undefined)
    setOpinionNotice(undefined)
    setError('')
  },[boardKey])

  function syncGroupOpinions() {
    boardFrame.current?.contentWindow?.postMessage({type:'clipmentor:blueprint-opinion-draft',entries:opinionEntries??[],pending},'*')
  }

  useEffect(()=>{
    boardFrame.current?.contentWindow?.postMessage({type:'clipmentor:blueprint-opinion-draft',pending},'*')
  },[currentBoard,pending])

  function resolvePlacement(move:boolean){
    if(!pendingOpinion?.placement)return
    const {index,unitId}=pendingOpinion.placement
    const conflicting=pendingOpinion.entries[index]
    if(!conflicting)return
    const rest=pendingOpinion.entries.filter((_,position)=>position!==index)
    const target=rest.find(entry=>entry.unitId===unitId)
    const combined=[target?.text,conflicting.text].filter(Boolean).join('\n')
    if(move&&combined.length>BLUEPRINT_OPINION_MAX_LENGTH){
      setError('合并后意见太长，请缩短后再移动。')
      return
    }
    setError('')
    const entries=move?[...rest.filter(entry=>entry.unitId!==unitId),{unitId,text:combined}]:[...rest,{...conflicting,keepPlacement:true as const}]
    setOpinionDraft({key:boardKey,entries})
    setOpinionReview(undefined)
    boardFrame.current?.contentWindow?.postMessage({type:'clipmentor:blueprint-opinion-draft',entries,pending:false},'*')
  }

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
        const page = await readBoardPage(response, boardIdentity)
        if (!controller.signal.aborted) setBoard({ key:boardKey, revision, ...page })
      } catch {
        if (controller.signal.aborted) return
        if (attempt < 2) timer = setTimeout(() => void readBoard(revision, attempt + 1), 2000)
        else setBoardError('审核板暂时无法打开。')
      }
    }
    void readBoard(revision, 0)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [boardKey, boardRevision, boardIdentity, boardUrl, requestApi, boardReload, mediaRefresh])

  useEffect(() => {
    if (!currentBoard?.identity) return
    const frame = boardFrame.current
    const revision = currentBoard.revision
    const identity = currentBoard.identity
    const controller = new AbortController()
    let pending = false
    const receive = async (event: MessageEvent) => {
      if (!frame?.contentWindow || event.source !== frame.contentWindow || event.origin !== 'null') return
      if(event.data?.type==='clipmentor:blueprint-opinion'){
        const {unitId,text}=event.data
        if(!actionController.current&&typeof text==='string'&&text.length<=BLUEPRINT_OPINION_MAX_LENGTH&&groups.some(group=>group.id===unitId))writeOpinion(unitId,text)
        return
      }
      if (event.data?.type !== 'clipmentor:request-teaching-excerpt' || pending) return
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
  }, [currentBoard, boardUrl, requestApi, groups, writeOpinion])

  async function action(name: string, opinions?:BlueprintOpinion[], opinionConfirmation?:string) {
    if (actionController.current || awaitingAcceptance) return
    const controller=new AbortController()
    actionController.current=controller
    const signal=controller.signal
    const stillCurrent=()=>currentAction.current.key===actionKey&&!signal.aborted
    setPendingAction({key:actionKey,controller})
    setError('')
    setActionIssue(undefined)
    try {
      const revision = currentBoard?.revision
      const identity = currentBoard?.identity
      const subjectKey=boardKey
      const submit = () => requestApi(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
        body: JSON.stringify({action:name,revision,boardIdentity:identity,renderId:task?.renderId,
          ...(name==='accept'?{previewWatched,languageConfirmed,visualCriteriaDigest:visual?.digest}:{}),
          ...(name==='save_blueprint_review'?{blueprintReview:{groups:review.groups,endingIds:review.endingIds}}:{}),
          ...(['approve_blueprint','produce_versions'].includes(name)?{blueprintReview:{scope:'whole_blueprint',groups:review.groups}}:{}),
          ...(name==='revise_preview'?{text:feedback,feedbackTarget}:{}),
          ...(name==='revise_blueprint'?{blueprintOpinions:opinions,opinionConfirmation}:{})}),
      })
      let response = await submit()
      let result = await readApiJson<ActionReceipt>(response)
      if(!stillCurrent())return
      if (response.status === 409 && result?.reason === 'review_board_reload' && revision
        && (['approve_blueprint','revise_blueprint','produce_versions','save_blueprint_review'].includes(name))) {
        // This response is returned before any mutation. Restore exactly the
        // board the reviewer acted on before sending the same action once.
        if(!stillCurrent())return
        const refreshed = await requestApi(boardUrl(revision,identity),{signal})
        if (refreshed.ok) {
          const page = await readBoardPage(refreshed, identity)
          if(!stillCurrent())return
          setBoard({ key:subjectKey, revision, ...page })
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
        if(result?.issue)setActionIssue({key:actionKey,issue:result.issue})
        else if(result?.reason==='review_board_changed')setActionIssue({key:actionKey,issue:{kind:'binding',message:messages.review_board_changed}})
        else setError(messages[result?.reason ?? ''] ?? '操作暂未完成，请稍后查看。')

        return
      }
      if(name==='revise_blueprint'&&opinions&&(result?.opinionConfirmation||result?.opinionPlacements?.length)){
        setOpinionReview({key:boardKey,entries:opinions,confirmation:result.opinionConfirmation,placement:result.opinionPlacements?.[0]})
        return
      }
      if (result?.accepted !== true) throw new Error('Missing production acknowledgement')
      if(name==='revise_blueprint'){
        setOpinionDraft(undefined)
        setOpinionReview(undefined)
        // The board must stay locked until the readback releases the current action.
        boardFrame.current?.contentWindow?.postMessage({type:'clipmentor:blueprint-opinion-draft',entries:[],pending:true},'*')
        if(result.notesSaved)setOpinionNotice(boardKey)
      }
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
      if(name==='save_blueprint_review'&&latest?.task?.savedReview)setSavedGroupNotice(boardKey)
      if(name==='revise_blueprint'||name==='revise_preview'){
        setFeedbackDraft(current=>current?.key===actionKey&&current.text===feedback?undefined:current)
        setConfirmation(current=>current?.key===visualKey?undefined:current)
      }
      if (name==='accept' && confirmed) {
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
    if (feedback.trim()&&feedbackTarget) void action('revise_preview')
  }

  function submitBlueprintOpinions(event:FormEvent) {
    event.preventDefault()
    const entries=opinionEntries?.filter(entry=>entry.text.trim())
    if(entries?.length&&!pendingOpinion)void action('revise_blueprint',entries)
  }

  const awaitingPreview = task?.status === 'awaiting_review'
  const completed = task?.status === 'completed'
  const stopMessage = task?.stopReason === 'materials' ? '无法读取已上传的原片，需要核对素材。'
    : task?.stopReason === 'limit' ? '本次制作已达到处理上限，已保存的进度会保留。'
    : task?.stopReason === 'maintenance' ? '制作已暂停，已保存的进度会保留。无需重新上传。'
    : task?.stopReason === 'service' ? serviceUnavailable : undefined
  const canConfirm = !!task && (!!task.canConfirmBlueprint || !task.dualBlueprint && task.canApproveBlueprint===true)
  const reviewTitle = boardRevision ? '审核蓝图' : awaitingPreview ? '预览与终审' : '成片已确认'
  const sharedBlueprint = showSharedBlueprint(sharedProgress)
  if(!state)return <p className="cm-caption" role="status">{readError || '正在读取制作状态…'}</p>
  if(state.outputs)return <>
    <div className="cm-heading"><h1>{productionPageTitle(sharedProgress)}</h1><p>{sharedBlueprint?'共用片头与教学主体，片尾分别面向新建联和已合作达人。':'共用主体只制作一次，再生成两个片尾版本。'}</p></div>
    <div className="cm-output-list">
    {state.outputs.filter(output=>!sharedBlueprint || output.audience==='existing_partner').map(output=><section key={output.audience} aria-label={sharedBlueprint?'共用蓝图':output.audience==='new_contact'?'新建联达人版':'已合作达人版'}>
      <ProductionPanel assets={assets} onRecheck={onRecheck} requestApi={requestApi} mediaRefresh={mediaRefresh} unifiedBlueprint={sharedBlueprint} outputAudience={output.audience} sharedTask={sharedProgress} onTask={output.audience==='existing_partner'?reportSharedProgress:undefined} />
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
        {boardRevision && currentBoard?.revision === boardRevision && task.teachingDecisionChange && <p>{task.teachingDecisionChange}</p>}
        {boardRevision && (currentBoard?.revision === boardRevision
          ? <iframe key={boardKey} ref={boardFrame} title="人审版蓝图" className="cm-review-board" sandbox="allow-scripts" srcDoc={currentBoard.html} onLoad={syncGroupOpinions} />
          : boardError ? <div className="cm-footer"><p role="status">{boardError}</p>
            <button className="cm-button secondary" onClick={() => setBoardReload(attempt => attempt + 1)}>重新加载审核板</button>
          </div> : <p role="status">正在生成审片板…</p>)}
        {boardRevision && currentBoard?.revision===boardRevision && groups.length>0 && <section className="cm-feedback" aria-label="逐组人审">
          <h2>逐组确认</h2>
          {groups.map(group=>{
            const entry=review.groups.find(row=>row.id===group.id)
            return <fieldset key={group.id} className="cm-review-field" disabled={pending}>
              <legend>{group.label}</legend>
              <label>{group.label}教达人改哪个决定<input type="text" maxLength={500} value={entry?.decision??''} onChange={event=>changeReview(group.id,{decision:event.target.value})} /></label>
              <label>{group.label}表态<select value={entry?.stance??''} onChange={event=>changeReview(group.id,{stance:event.target.value as GroupReview['stance']})}>
                <option value="" disabled>选择表态</option><option value="accepted">认可</option><option value="changes">不认可</option><option value="pending">待定</option>
              </select></label>
            </fieldset>
          })}
          {endings.length>0&&<fieldset className="cm-review-field" disabled={pending}><legend>两种片尾</legend>
            {endings.map(ending=><label key={ending.id}><input type="checkbox" checked={review.endingIds.includes(ending.id)} onChange={event=>{
              setSavedGroupNotice(undefined)
              setGroupDraft({...review,endingIds:event.target.checked?[...review.endingIds,ending.id]:review.endingIds.filter(id=>id!==ending.id)})
            }} /> 已核对{ending.label} · {ending.materials.map(asset=>asset.name).join('、')}</label>)}
          </fieldset>}
          <button type="button" className="cm-button secondary" disabled={pending || !groupDraft || groupDraft.key!==boardKey} onClick={()=>void action('save_blueprint_review')}>保存表态</button>
          {savedGroupNotice===boardKey&&<p role="status">表态已保存。</p>}
        </section>}
        {(awaitingPreview || completed) && (task.renderId
          ? <video className="cm-final-video" controls preload="metadata" src={assetUrl('panel_video', 'renderId', task.renderId)} />
          : <p role="alert">预览暂时无法播放。</p>)}
        {boardRevision&&<form className="cm-feedback" onSubmit={submitBlueprintOpinions}>
          {task.hasBlueprintFeedback && <section className="cm-feedback-summary" aria-label="上次修改要点">
            <h3>上次修改要点</h3>
            {task.blueprintFeedbackSummary?.length
              ?<ul>{task.blueprintFeedbackSummary.map((point,index)=><li key={index}>{point}</li>)}</ul>
              :<p>修改意见已保存，整理后显示要点。</p>}
          </section>}
          {task.blueprintOpinionDifferences && <BlueprintOpinionChanges differences={task.blueprintOpinionDifferences} />}
          <label htmlFor="cm-blueprint-overall-opinion">整体意见</label>
          <textarea id="cm-blueprint-overall-opinion" disabled={pending} maxLength={BLUEPRINT_OPINION_MAX_LENGTH} placeholder="不属于某一组的意见"
            value={opinionEntries?.find(entry=>entry.unitId===null)?.text??''} onChange={event=>writeOpinion(null,event.target.value)} />
          {pendingOpinion?.placement&&<div role="status" className="cm-opinion-action">
            <span>{pendingOpinion.placement.multiple?'这条意见提到多个位置，可分别填写。':`要把这条意见移到${pendingOpinion.placement.label}吗？`}</span>
            {!pendingOpinion.placement.multiple&&<button type="button" className="cm-button secondary" disabled={pending} onClick={()=>resolvePlacement(true)}>移动</button>}
            <button type="button" className="cm-button secondary" disabled={pending} onClick={()=>resolvePlacement(false)}>留在原处</button>
          </div>}
          {pendingOpinion?.confirmation&&<div className="cm-opinion-confirmation">
            {pendingOpinion.confirmation.rows.map(item=><div key={item.label}>
              <strong>{item.label}</strong>
              <ul>{item.keep.map(text=><li key={text}>保留 {text}</li>)}<li>修改 {item.change}</li></ul>
            </div>)}
            <button type="button" className="cm-button secondary" disabled={pending} onClick={()=>void action('revise_blueprint',pendingOpinion.entries,pendingOpinion.confirmation?.token)}>确认并修改</button>
          </div>}
          {opinionNotice===boardKey&&<p role="status">意见已记录。</p>}
          <button className="cm-button secondary" disabled={pending || !!pendingOpinion || !hasOpinionDraft || currentBoard?.revision!==boardRevision}><Send size={16} /> 提交意见</button>
        </form>}
        {awaitingPreview && !task.feedbackUsed && <form className="cm-feedback" onSubmit={revise}>
          <label htmlFor={`cm-production-feedback-${outputAudience??"source"}`}>修改意见</label>
          <textarea id={`cm-production-feedback-${outputAudience??"source"}`} disabled={pending} value={feedback} onChange={event => setFeedbackDraft({...draft,text:event.target.value})} maxLength={8000} placeholder="写下希望看到的修改效果" />
          <>
            <label>反馈位置<select disabled={pending} value={draft.target??''} onChange={event=>setFeedbackDraft({...draft,target:event.target.value,confirmed:false})}>
              <option value="" disabled>选择修改范围</option>
              {groups.map(group=><option key={group.id} value={`group:${group.id}`}>{group.label}</option>)}
              <option value="range">成片时间段</option>
              <option value="whole">整体</option>
            </select></label>
            {draft.target==='whole'&&<label><input type="checkbox" disabled={pending} checked={draft.confirmed===true} onChange={event=>setFeedbackDraft({...draft,confirmed:event.target.checked})} /> 确认这条意见作用于整体</label>}
            {draft.target==='range'&&<fieldset className="cm-review-field" disabled={pending}><legend>成片时间段</legend>
              <label>开始秒数<input type="number" min={0} step="any" value={draft.start??''} onChange={event=>setFeedbackDraft({...draft,start:event.target.value})} /></label>
              <label>结束秒数<input type="number" min={0} step="any" value={draft.end??''} onChange={event=>setFeedbackDraft({...draft,end:event.target.value})} /></label>
            </fieldset>}
            {draft.target?.startsWith('group:')&&<label>修改内容<select disabled={pending} value={draft.kind??'content'} onChange={event=>setFeedbackDraft({...draft,kind:event.target.value as 'content'|'execution'})}>
              <option value="content">讲解稿与画面方案</option><option value="execution">成片中的画面或短标</option>
            </select></label>}
          </>
          <button className="cm-button secondary" disabled={pending || !feedbackTarget || !feedback.trim() || !task.renderId}><Send size={16} /> 提交修改</button>
        </form>}
        {awaitingPreview&&task.feedbackUsed&&<p role="status">本次成片的集中返修已提交。如仍需修改，请联系维护侧或另开制作。</p>}
        <div className="cm-footer">
          {boardRevision && <button className="cm-button" disabled={pending || !!pendingOpinion || hasOpinionDraft || currentBoard?.revision !== boardRevision || !canConfirm} onClick={() => void action(task.canConfirmBlueprint?'produce_versions':'approve_blueprint')}>确认蓝图，开始制作</button>}
          {boardRevision && !canConfirm && <p>{task.blueprintMessage ?? stopMessage ?? '蓝图检查尚未完成，暂不能开始制作。'}</p>}
          {awaitingPreview && <>
            <fieldset className="cm-review-field" disabled={pending||!task.renderId}>
              <legend>终审确认</legend>
              <p>系统已核对当前预览与审核回执。请实际看完并听审马来语后确认。</p>
              <label><input type="checkbox" checked={previewWatched} onChange={event => setPreviewConfirmation('watched',event.target.checked)} /> 看过成片</label>
              <label><input type="checkbox" checked={languageConfirmed} onChange={event => setPreviewConfirmation('language',event.target.checked)} /> 核过马来语</label>
            </fieldset>
            <button className="cm-button" disabled={pending || task.canAcceptPreview===false || task.deliveryUnavailable || !task.renderId || !previewWatched || !languageConfirmed} onClick={() => void action('accept')}>确认并下载成片</button>
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
    {reviewIssue&&<p className="cm-caption cm-upload-error" role="alert"><strong>{issueLabel[reviewIssue.kind]}</strong> {reviewIssue.message}</p>}
    {(error || readError) && <p className="cm-caption cm-upload-error" role="alert">{error || readError}</p>}
  </>
}
