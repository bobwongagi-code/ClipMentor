import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Check, Download, Play, Send } from 'lucide-react'
import { BLUEPRINT_OPINION_MAX_LENGTH, BLUEPRINT_OPINION_TOTAL_MAX_LENGTH, type BlueprintOpinion, type BlueprintOpinionConfirmation, type BlueprintOpinionDifference, type BlueprintOpinionPlacement } from '../../../shared/clipmentor-blueprint-opinions'

import { ProgressNode } from '../components/processing/ProgressNode'
import { hasPlayablePreview, previewProgress, previewStatus, productionProgress, productionActivity, productionPageTitle, reviewableBlueprintRevision, showSharedBlueprint } from './productionPanelState'

export const productionEndpoint = `${__CLIPMENTOR_API_BASE_PATH__}/production`
type Task = {
  taskId?:string;sourceTaskId?:string
  status: string; stage: string; revision?: string; active: boolean; sequence: number
  stopReason?: 'materials' | 'limit' | 'service' | 'maintenance'; feedbackUsed: boolean; renderId?: string; hasBlueprintFeedback?:boolean; blueprintFeedbackSummary?:string[]; dualBlueprint?: boolean
  visualCriteria?: { digest: string }; downloadName?:string
  attachments?: {assetId:string;fileName:string}[]; deliveryUnavailable?:boolean
  boardIdentity?:string; blueprintRevision?: string; canApproveBlueprint?: boolean; blueprintMessage?: string
  blueprintOpinionDifferences?:{overall?:BlueprintOpinionDifference;groups:BlueprintOpinionDifference[]}
  productionDifferences?:Task['blueprintOpinionDifferences']
  reviewGroups?:Array<{id:string;label:string}>
  previewChapters?:Array<{id:string;label:string;seconds:number}>
  previewDuration?:number; previewReviewed?:boolean
  canAcceptPreview?:boolean; previewPending?:boolean; previewNeedsChanges?:boolean; deliveryHeld?:boolean; reviewIssue?:ReviewIssue
  canConfirmBlueprint?: boolean; audience?: 'new_contact' | 'existing_partner';blueprintConfirmed?:boolean
}
type Audience = 'new_contact' | 'existing_partner'
const audienceTitleFor=(audience:Audience)=>audience==='new_contact'?'新建联达人版':'已合作达人版'
const playbackTime=(seconds:number)=>`${Math.floor(seconds/60)}:${String(Math.floor(seconds%60)).padStart(2,'0')}`
type State = { task: Task | null; unavailable?: string; outputs?: {audience:Audience}[]; outputOwner?:{taskId:string;sequence:number} }
type ActionReceipt = { accepted?: boolean; reason?: string; issue?:ReviewIssue; notesSaved?:boolean;
  opinionConfirmation?:BlueprintOpinionConfirmation;opinionPlacements?:BlueprintOpinionPlacement[] }
type ReviewIssue = {kind:'content'|'gate'|'binding';message:string}
const issueLabel={content:'内容缺口',gate:'检查暂停',binding:'当前版本不可用'}
type FeedbackDraft = {key:string;text:string;target?:string;confirmed?:boolean;start?:string;end?:string;kind?:'content'|'execution'}
const noGroups:NonNullable<Task['reviewGroups']>=[]
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

function ProductionChanges({differences}:{differences:NonNullable<Task['productionDifferences']>}) {
  return <details><summary>制作调整</summary><BlueprintOpinionChanges differences={differences} /></details>
}

function PreviewSteps({task}:{task:Task}) {
  return <ol className="cm-preview-steps" aria-label="交付进度">
    {previewProgress(task).map(step=><li key={step.label} data-done={step.done} aria-current={step.current?'step':undefined}>{step.label}</li>)}
  </ol>
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
  if(data.task){
    const length=data.task.previewDuration
    const duration=typeof length==='number'&&Number.isFinite(length)&&length>0?length:undefined
    const ids=new Set<string>()
    const chapters=Array.isArray(data.task.previewChapters)?data.task.previewChapters.filter(chapter=>{
      if(typeof chapter?.id!=='string'||ids.has(chapter.id)||typeof chapter.label!=='string'
        ||!Number.isFinite(chapter.seconds)||chapter.seconds<0||duration!==undefined&&chapter.seconds>=duration)return false
      ids.add(chapter.id)
      return true
    }):undefined
    data.task={...data.task,previewDuration:duration,previewChapters:chapters}
  }
  return data
}

export default function ProductionPanel({ assets, onRecheck, requestApi, outputAudience, sharedTask, onTask, unifiedBlueprint = false, mediaRefresh, showPreview = true }: { assets: { id: string; title: string; name: string }[]; onRecheck: () => void; requestApi: (url: string, init?: RequestInit) => Promise<Response>; outputAudience?:Audience; sharedTask?:Task; onTask?:(task:Task)=>void; unifiedBlueprint?:boolean; mediaRefresh?:number; showPreview?:boolean }) {
  const endpoint = outputAudience ? `${productionEndpoint}?audience=${outputAudience}` : productionEndpoint
  const assetUrl=(view:string,key:string,value:string)=>resourceUrl(view,key,value,outputAudience)
  const audienceTitle=outputAudience?audienceTitleFor(outputAudience):undefined
  const tabsId=useId()
  const video=useRef<HTMLVideoElement>(null)
  const playback=useRef<{key:string;time:number}>()
  const queuedSeek=useRef<{key:string;time:number}>()
  const [videoFailure,setVideoFailure]=useState<string>()
  const [videoReload,setVideoReload]=useState(0)
  const [loadedVideo,setLoadedVideo]=useState<string>()
  const [state, setState] = useState<State>()
  const [error, setError] = useState('')
  const [readError, setReadError] = useState('')
  const [actionIssue,setActionIssue]=useState<{key:string;issue:ReviewIssue}>()
  const [pendingAction, setPendingAction] = useState<{key:string;controller:AbortController}>()
  const [board, setBoard] = useState<{ key:string; revision: string; identity?:string; html: string }>()
  const [boardError, setBoardError] = useState('')
  const [boardReload, setBoardReload] = useState(0)
  const [feedbackDraft, setFeedbackDraft] = useState<FeedbackDraft>()
  const [opinionDraft,setOpinionDraft]=useState<{key:string;entries:BlueprintOpinion[]}>()
  const [opinionReview,setOpinionReview]=useState<{key:string;entries:BlueprintOpinion[];confirmation?:BlueprintOpinionConfirmation;placement?:BlueprintOpinionPlacement}>()
  const [opinionNotice,setOpinionNotice]=useState<string>()
  const [confirmation, setConfirmation] = useState<{key:string;watched?:boolean;language?:boolean;acknowledged?:boolean}>()
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
  const owner=state?.outputOwner?.taskId??''
  const [outputs,setOutputs]=useState<Partial<Record<Audience,{owner:string;task:Task}>>>({})
  const [selected,setSelected]=useState<{owner:string;audience:Audience}>()
  const reportPartner=useCallback((task:Task)=>setOutputs(current=>({...current,existing_partner:{owner,task}})),[owner])
  const reportContact=useCallback((task:Task)=>setOutputs(current=>({...current,new_contact:{owner,task}})),[owner])
  const outputTask=(audience:Audience)=>outputs[audience]?.owner===owner?outputs[audience]?.task:undefined
  const sharedProgress=outputTask('existing_partner')
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
  const feedbackKey=JSON.stringify([endpoint,task?.taskId,task?.renderId])
  const videoKey=JSON.stringify([feedbackKey,videoReload])
  const draft:FeedbackDraft=feedbackDraft?.key===feedbackKey?feedbackDraft:{key:feedbackKey,text:''}
  const feedback=draft.text
  const groups=task?.reviewGroups??noGroups
  const opinionEntries=opinionDraft?.key===boardKey?opinionDraft.entries:undefined
  const pendingOpinion=opinionReview?.key===boardKey?opinionReview:undefined
  const hasOpinionDraft=opinionEntries?.some(entry=>entry.text.trim())===true
  const feedbackTarget=draft.target==='whole'&&draft.confirmed?{scope:'whole',confirmed:true}
    :draft.target==='range'&&draft.start?.trim()&&draft.end?.trim()&&Number(draft.start)>=0&&Number.isFinite(Number(draft.end))&&Number(draft.end)>Number(draft.start)
      &&(!task?.previewDuration||Number(draft.end)<=task.previewDuration)
      ?{scope:'range',start:Number(draft.start),end:Number(draft.end)}
      :groups.some(group=>group.id===draft.target?.slice(6))&&draft.target?.startsWith('group:')
        ?{scope:'group',unitId:draft.target.slice(6),kind:draft.kind??'content'}:undefined
  const reviewIssue=(actionIssue?.key===actionKey?actionIssue.issue:undefined)??task?.reviewIssue
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
          ...(['approve_blueprint','produce_versions'].includes(name)?{blueprintReview:{scope:'whole_blueprint'}}:{}),
          ...(name==='revise_preview'?{text:feedback,feedbackTarget}:{}),
          ...(name==='revise_blueprint'?{blueprintOpinions:opinions,opinionConfirmation}:{})}),
      })
      let response = await submit()
      let result = await readApiJson<ActionReceipt>(response)
      if(!stillCurrent())return
      if (response.status === 409 && result?.reason === 'review_board_reload' && revision
        && (['approve_blueprint','revise_blueprint','produce_versions'].includes(name))) {
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
      const confirmed = latest?.task?.status === 'completed' && !latest.task.deliveryUnavailable && !latest.task.deliveryHeld
        && !!task?.taskId && latest.task.taskId === task.taskId && latest.task.renderId === task.renderId
        && latest.task.sequence >= (currentAction.current.sequence ?? task.sequence)
      if(name==='revise_blueprint'||name==='revise_preview'){
        setFeedbackDraft(current=>current?.key===feedbackKey&&current.text===feedback?undefined:current)
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
    if (task?.status==='awaiting_review'&&!task.deliveryHeld&&!task.feedbackUsed&&task.renderId&&feedback.trim()&&feedbackTarget) void action('revise_preview')
  }

  function seek(seconds:number){
    const player=video.current
    if(!player||!Number.isFinite(seconds)||seconds<0)return
    if(!player.readyState||!Number.isFinite(player.duration)){
      queuedSeek.current={key:feedbackKey,time:seconds}
      return
    }
    if(seconds<player.duration)player.currentTime=seconds
  }

  function usePlaybackTime(field:'start'|'end'){
    const player=video.current
    if(!player?.readyState||!Number.isFinite(player.currentTime))return
    // Round inward at the end of the file so a prefilled value can be sent
    // as an exact boundary, without including footage beyond the render.
    setFeedbackDraft({...draft,target:'range',[field]:String(Math.floor(player.currentTime*100)/100)})
  }

  function submitBlueprintOpinions(event:FormEvent) {
    event.preventDefault()
    const entries=opinionEntries?.filter(entry=>entry.text.trim())
    if((entries?.reduce((total,entry)=>total+entry.text.length,0)??0)>BLUEPRINT_OPINION_TOTAL_MAX_LENGTH){
      setError('意见总字数太多，请缩短后再提交。')
      return
    }
    if(entries?.length&&!pendingOpinion)void action('revise_blueprint',entries)
  }

  const awaitingPreview = task?.status === 'awaiting_review'
  const pendingPreview = task?.previewPending === true
  const completed = task?.status === 'completed'
  const stopMessage = task?.stopReason === 'materials' ? '无法读取已上传的原片，需要核对素材。'
    : task?.stopReason === 'limit' ? '本次制作已达到处理上限，已保存的进度会保留。'
    : task?.stopReason === 'maintenance' ? '制作已暂停，已保存的进度会保留。无需重新上传。'
    : task?.stopReason === 'service' ? serviceUnavailable : undefined
  const canConfirm = !!task && (!!task.canConfirmBlueprint || !task.dualBlueprint && task.canApproveBlueprint===true)
  const reviewTitle = boardRevision ? '审核蓝图' : pendingPreview ? '视频预览' : awaitingPreview ? '预览与终审' : '成片已确认'
  const sharedBlueprint = showSharedBlueprint(sharedProgress)
  if(!state)return <p className="cm-caption" role="status">{readError || '正在读取制作状态…'}</p>
  if(state.outputs){
    const audiences=state.outputs.map(output=>output.audience)
    const tabbed=!sharedBlueprint&&audiences.some(audience=>hasPlayablePreview(outputTask(audience))||outputTask(audience)?.feedbackUsed===true)
    const choice=selected?.owner===owner?selected.audience:undefined
    const current=choice&&audiences.includes(choice)?choice
      :audiences.find(audience=>hasPlayablePreview(outputTask(audience)))??audiences[0]
    const currentTask=outputTask(current)
    function moveTab(event:KeyboardEvent<HTMLButtonElement>,index:number){
      const next=event.key==='Home'?0:event.key==='End'?audiences.length-1
        :event.key==='ArrowRight'?(index+1)%audiences.length:event.key==='ArrowLeft'?(index-1+audiences.length)%audiences.length:-1
      if(next<0)return
      event.preventDefault()
      const audience=audiences[next]
      setSelected({owner,audience})
      document.getElementById(`${tabsId}-${audience}`)?.focus()
    }
    return <div className={tabbed?'cm-preview-page':undefined}>
      <div className={tabbed?'cm-preview-heading':'cm-heading'}><h1>{tabbed?'视频预览':productionPageTitle(sharedProgress)}</h1></div>
      {tabbed&&currentTask&&<PreviewSteps task={currentTask} />}
      {tabbed&&<div className="cm-preview-tabs" role="tablist" aria-label="查看成片版本">
        {audiences.map((audience,index)=><button type="button" role="tab" key={audience} id={`${tabsId}-${audience}`}
          aria-selected={audience===current} aria-controls={`${tabsId}-panel-${audience}`} tabIndex={audience===current?0:-1}
          onClick={()=>setSelected({owner,audience})} onKeyDown={event=>moveTab(event,index)}>
          <strong>{audienceTitleFor(audience)}</strong><span>{previewStatus(outputTask(audience))}</span>
        </button>)}
      </div>}
      <div className="cm-output-list">
      {state.outputs.filter(output=>!sharedBlueprint || output.audience===(audiences.includes('existing_partner')?'existing_partner':audiences[0])).map(({audience})=><section
        key={`${owner}:${audience}`} id={`${tabsId}-panel-${audience}`} hidden={tabbed&&current!==audience}
        role={tabbed?'tabpanel':undefined} aria-label={sharedBlueprint?'共用蓝图':audienceTitleFor(audience)}>
        <ProductionPanel assets={assets} onRecheck={onRecheck} requestApi={requestApi} mediaRefresh={mediaRefresh} unifiedBlueprint={sharedBlueprint}
          outputAudience={audience} sharedTask={sharedProgress} showPreview={!tabbed||current===audience}
          onTask={audience==='existing_partner'?reportPartner:reportContact} />
      </section>)}
      </div>
    </div>
  }
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
    </> : boardRevision || awaitingPreview || completed || pendingPreview ? <>
      {!unifiedBlueprint && !outputAudience && <div className={boardRevision?'cm-heading':'cm-preview-heading'}><h1>{reviewTitle}</h1></div>}
      {!boardRevision&&!outputAudience&&<PreviewSteps task={task} />}
      {boardRevision&&<section className="cm-panel cm-work">
        {boardRevision && (currentBoard?.revision === boardRevision
          ? <iframe key={boardKey} ref={boardFrame} title="人审版蓝图" className="cm-review-board" sandbox="allow-scripts" srcDoc={currentBoard.html} onLoad={syncGroupOpinions} />
          : boardError ? <div className="cm-footer"><p role="status">{boardError}</p>
            <button className="cm-button secondary" onClick={() => setBoardReload(attempt => attempt + 1)}>重新加载审核板</button>
          </div> : <p role="status">正在生成审片板…</p>)}
        {task.productionDifferences&&<ProductionChanges differences={task.productionDifferences} />}
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
        <div className="cm-footer">
          <button className="cm-button" disabled={pending || !!pendingOpinion || hasOpinionDraft || currentBoard?.revision !== boardRevision || !canConfirm} onClick={() => void action(task.canConfirmBlueprint?'produce_versions':'approve_blueprint')}>确认蓝图，开始制作</button>
          {!canConfirm && (task.blueprintMessage ?? stopMessage) && <p>{task.blueprintMessage ?? stopMessage}</p>}
        </div>
      </section>}
      {!boardRevision&&showPreview&&<div className="cm-preview-layout">
        <div className="cm-preview-media">
          {task.renderId ? <>
            <video key={videoKey} ref={video} aria-label={audienceTitle??'成片预览'} className="cm-final-video" controls playsInline
              controlsList="nodownload" preload="metadata" src={assetUrl('panel_video','renderId',task.renderId)}
              onError={()=>setVideoFailure(videoKey)}
              onTimeUpdate={event=>{playback.current={key:feedbackKey,time:event.currentTarget.currentTime}}}
              onLoadedMetadata={event=>{
                const player=event.currentTarget
                const last=queuedSeek.current?.key===feedbackKey?queuedSeek.current:playback.current
                queuedSeek.current=undefined
                if(last?.key===feedbackKey&&last.time>0&&last.time<player.duration)player.currentTime=last.time
                setLoadedVideo(videoKey)
              }} />
            {videoFailure===videoKey&&<div className="cm-preview-media-error" role="alert">
              <p>预览暂时无法播放。</p><button type="button" className="cm-button secondary" onClick={()=>setVideoReload(n=>n+1)}>重新加载视频</button>
            </div>}
            {!!task.previewChapters?.length&&<nav className="cm-preview-chapters" aria-label="视频章节">
              {task.previewChapters.map(chapter=><button type="button" key={chapter.id} disabled={videoFailure===videoKey}
                onClick={()=>seek(chapter.seconds)}><span>{chapter.label}</span><time>{playbackTime(chapter.seconds)}</time></button>)}
            </nav>}
          </> : <p className="cm-preview-placeholder" role="status">预览暂时无法播放。</p>}
        </div>
        <div className="cm-preview-side">
          <section className="cm-preview-card" aria-label="预览状态">
            <strong className="cm-preview-status" data-state={task.previewNeedsChanges||task.deliveryHeld?'attention':undefined} role="status">{previewStatus(task)}</strong>
            <dl className="cm-preview-checks">
              <div><dt>视频文件</dt><dd>{videoFailure===videoKey||!task.renderId?'暂时无法播放':'可播放'}</dd></div>
              <div><dt>内容复核</dt><dd>{task.deliveryHeld||task.previewNeedsChanges?'需修改':task.previewReviewed?'已完成':pendingPreview?'未完成':'当前版本未确认'}</dd></div>
              <div><dt>马来语</dt><dd>{completed?'已确认':languageConfirmed?'已勾选':'待确认'}</dd></div>
            </dl>
          </section>
          {(awaitingPreview||pendingPreview)&&!task.feedbackUsed&&!task.deliveryHeld&&!task.previewNeedsChanges&&task.renderId&&
            <form className="cm-preview-card cm-preview-feedback" onSubmit={revise}>
              <h2><label htmlFor={`${tabsId}-feedback`}>修改意见</label></h2>
              <div className="cm-preview-feedback-tools">
                <label className="cm-preview-scope"><span>反馈位置</span><select disabled={pending} value={draft.target??''}
                  onChange={event=>setFeedbackDraft({...draft,target:event.target.value,confirmed:false})}>
                  <option value="" disabled>选择修改范围</option>
                  <option value="whole">整体</option>
                  {groups.map(group=><option key={group.id} value={`group:${group.id}`}>{group.label}</option>)}
                  <option value="range">成片时间段</option>
                </select></label>
                <button type="button" className="cm-button secondary" disabled={pending||loadedVideo!==videoKey||videoFailure===videoKey}
                  onClick={()=>usePlaybackTime('start')}>用当前时间</button>
              </div>
              {draft.target==='whole'&&<label className="cm-preview-check"><input type="checkbox" disabled={pending} checked={draft.confirmed===true}
                onChange={event=>setFeedbackDraft({...draft,confirmed:event.target.checked})} /> 确认这条意见作用于整体</label>}
              {draft.target==='range'&&<fieldset className="cm-review-field cm-preview-range" disabled={pending}><legend>成片时间段</legend>
                <label>开始秒数<input type="number" min={0} max={task.previewDuration} step="any" value={draft.start??''} onChange={event=>setFeedbackDraft({...draft,start:event.target.value})} /></label>
                <label>结束秒数<input type="number" min={0} max={task.previewDuration} step="any" value={draft.end??''} onChange={event=>setFeedbackDraft({...draft,end:event.target.value})} /></label>
                <button type="button" className="cm-button secondary" disabled={loadedVideo!==videoKey||videoFailure===videoKey} onClick={()=>usePlaybackTime('end')}>用当前时间作结束</button>
              </fieldset>}
              {draft.target?.startsWith('group:')&&<label className="cm-preview-scope"><span>修改内容</span><select disabled={pending} value={draft.kind??'content'}
                onChange={event=>setFeedbackDraft({...draft,kind:event.target.value as 'content'|'execution'})}>
                <option value="content">讲解稿与画面方案</option>
                <option value="execution">成片中的画面或短标</option>
              </select></label>}
              <textarea id={`${tabsId}-feedback`} disabled={pending} value={feedback} onChange={event=>setFeedbackDraft({...draft,text:event.target.value})}
                maxLength={8000} placeholder="写下哪里要改、希望看到什么" />
              <div className="cm-preview-actions">
                {pendingPreview&&<p>复核完成后可提交。</p>}
                <button className="cm-button secondary" disabled={pending||!awaitingPreview||!feedbackTarget||!feedback.trim()}><Send size={16} /> 提交修改</button>
              </div>
            </form>}
          {(task.feedbackUsed||task.productionDifferences)&&<section className="cm-preview-card" aria-label="修改记录">
            <h2>修改记录</h2>
            {task.feedbackUsed&&<><p>修改意见已提交。</p>{task.renderId&&<p>修改后预览已生成。<span>本版修改机会已用完。</span></p>}</>}
            {task.productionDifferences&&<ProductionChanges differences={task.productionDifferences} />}
          </section>}
          <section className="cm-preview-card" aria-label="确认成片">
            <h2>确认成片</h2>
            {awaitingPreview&&<>
              <fieldset className="cm-preview-confirm" disabled={pending||!task.renderId||task.deliveryHeld} aria-label="终审确认">
                <label className="cm-preview-check"><input type="checkbox" checked={previewWatched} onChange={event=>setPreviewConfirmation('watched',event.target.checked)} /> 看过成片</label>
                <label className="cm-preview-check"><input type="checkbox" checked={languageConfirmed} onChange={event=>setPreviewConfirmation('language',event.target.checked)} /> 核过马来语</label>
              </fieldset>
              {awaitingAcceptance&&<p role="status">操作已收到，正在核对最新状态。</p>}
            </>}
            <div className="cm-preview-actions">
              {!completed&&<button className="cm-button" disabled={!awaitingPreview||pending||task.canAcceptPreview===false||task.deliveryHeld||task.deliveryUnavailable||!task.renderId||!previewWatched||!languageConfirmed}
                onClick={()=>void action('accept')}>确认并下载成片</button>}
              {(awaitingPreview||completed)&&task.renderId&&task.attachments?.map(file=><a key={file.assetId} className="cm-button secondary"
                href={`${assetUrl('panel_attachment','renderId',task.renderId!)}&${new URLSearchParams({assetId:file.assetId})}`}
                download={file.fileName}><Download size={17} /> 下载 Storyboard</a>)}
              {completed&&task.renderId&&!task.deliveryHeld&&!task.deliveryUnavailable&&<a className="cm-button" href={assetUrl('panel_download','renderId',task.renderId)} download={task.downloadName}><Download size={17} /> 下载成片</a>}
            </div>
            {task.deliveryUnavailable&&<p role="alert">随片资料暂时无法下载。</p>}
          </section>
        </div>
      </div>}
    </> : <>
      <section className="cm-panel cm-production-progress" aria-label={outputAudience?audienceTitle:'制作进度'}>
        <div className="cm-output-heading"><h2>{unifiedBlueprint?'蓝图进度':outputAudience?audienceTitle:productionPageTitle(task)}</h2>
          <span role="status">{stopMessage || (task.status==='cancelled'?'制作已取消':task.status==='waiting'?(sharedTask?.stopReason?'共用主体暂未完成':`共用主体 · ${productionActivity(sharedTask)}`):productionActivity(task))}</span>
        </div>
        <div className="cm-production-track" aria-label="制作阶段">
          {productionProgress(task,sharedTask).map(({label,state})=><ProgressNode key={label} label={label} state={state} />)}
        </div>
        {task.feedbackUsed&&<p className="cm-caption">修改意见已提交。</p>}
        {task.productionDifferences&&<ProductionChanges differences={task.productionDifferences} />}
      </section>
    </>}
    {reviewIssue&&<p className="cm-caption cm-upload-error" role="alert"><strong>{issueLabel[reviewIssue.kind]}</strong> {reviewIssue.message}</p>}
    {(error || readError) && <p className="cm-caption cm-upload-error" role="alert">{error || readError}</p>}
  </>
}
