import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { Check, Download, Film, Image, Send, Upload } from 'lucide-react'
import { uploadFeedback, uploadFeedbackFor } from '../../../shared/clipmentor-upload-feedback'
import './clipmentor.css'
import ProductionPanel, { productionEndpoint, readPanelState, type Audience, type Task } from './ProductionPanel'
import { projectResource, taskPage, workspaceEndpoint } from './taskNavigation'

const slots = [
  { key: 'source', title: '爆款原片', accept: 'video/mp4,video/webm,video/quicktime', icon: Film, formats: ['.mp4', '.webm', '.mov'] },
  { key: 'product', title: '商品图', accept: 'image/png,image/jpeg,image/webp', icon: Image, formats: ['.png', '.jpg', '.jpeg', '.webp'] },
  { key: 'sales', title: '销量截图', accept: 'image/png,image/jpeg,image/webp', icon: Image, formats: ['.png', '.jpg', '.jpeg', '.webp'] },
  { key: 'cta', title: '合作海报', accept: 'image/png,image/jpeg,image/webp', icon: Image, formats: ['.png', '.jpg', '.jpeg', '.webp'] },
] as const

type Slot = typeof slots[number]['key']
type Material = { file: File; url: string; status: 'checking' | 'ready' | 'error'; detail: string; frame?: string }
type IntakeReceipt = { projectId: string; assets: { id: string; name: string; sourceContentHash?: string }[] }
type IntakeRepair = IntakeReceipt & { missingSlots: Slot[] }
type Message = { role: '你' | '系统'; text: string }
const stages = ['上传素材', '审核蓝图', '预览与下载'] as const

class UploadNotice extends Error {}

async function fileHash(file: File) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')
}

async function inspectRepair(file: File, expectedHash?: string) {
  if (file.size > 64 * 1024 * 1024) throw new UploadNotice('文件超过 64 MiB')
  if (await fileHash(file) !== expectedHash) throw new UploadNotice(uploadFeedback.original)
  return { detail: '与原文件一致', frame: undefined }
}

function inspect(file: File, url: string, slot: Slot): Promise<{ detail: string; frame?: string }> {
  const formats: readonly string[] = slots.find(entry => entry.key === slot)!.formats
  if (!formats.some(extension => file.name.toLowerCase().endsWith(extension))) {
    return Promise.reject(new UploadNotice(slot === 'source' ? '支持 MP4、MOV、WebM' : '支持 PNG、JPG、WebP'))
  }
  if (file.size === 0) return Promise.reject(new UploadNotice('文件为空，请更换'))
  return new Promise((resolve, reject) => {
    const media = slot === 'source' ? document.createElement('video') : document.createElement('img')
    const finish = (detail?: string, frame?: string) => {
      window.clearTimeout(timeout)
      media.onload = media.onerror = null
      if (media instanceof HTMLVideoElement) {
        media.onloadeddata = null
        media.removeAttribute('src')
        media.load()
      }
      if (detail) resolve({ detail, frame })
      else reject(new UploadNotice('文件无法读取，请更换'))
    }
    const timeout = window.setTimeout(() => finish(), 8000)
    media.onerror = () => finish()
    if (media instanceof HTMLVideoElement) {
      media.preload = 'auto'
      media.onloadeddata = () => {
        if (!media.videoWidth || !media.videoHeight || !Number.isFinite(media.duration) || media.duration <= 0) {
          finish()
          return
        }
        const canvas = document.createElement('canvas')
        const scale = Math.min(1, 420 / Math.max(media.videoWidth, media.videoHeight))
        canvas.width = Math.max(1, Math.round(media.videoWidth * scale))
        canvas.height = Math.max(1, Math.round(media.videoHeight * scale))
        const context = canvas.getContext('2d')
        context?.drawImage(media, 0, 0, canvas.width, canvas.height)
        finish(`${media.duration.toFixed(1)} 秒 · ${media.videoWidth} × ${media.videoHeight}`, context ? canvas.toDataURL('image/jpeg', 0.8) : undefined)
      }
    } else {
      media.onload = () => finish(media.naturalWidth ? `${media.naturalWidth} × ${media.naturalHeight}` : undefined)
    }
    media.src = url
  })
}

function Feedback({ label, messages, onSend }: {
  label: string
  messages: Message[]
  onSend: (message: string) => void
}) {
  const [message, setMessage] = useState('')
  function submit(event: FormEvent) {
    event.preventDefault()
    if (!message.trim()) return
    onSend(message.trim())
    setMessage('')
  }
  return <section className="cm-feedback">
    <h3>{label}</h3>
    {messages.length > 0 && <ol className="cm-messages" aria-live="polite">
      {messages.map((entry, index) => <li key={index}><strong>{entry.role}</strong><p>{entry.text}</p></li>)}
    </ol>}
    <form onSubmit={submit}>
      <textarea aria-label={label} placeholder="写下要改的位置和希望看到的效果" value={message} onChange={event => setMessage(event.target.value)} />
      <button className="cm-button secondary" disabled={!message.trim()}><Send size={16} /> 发送修改意见</button>
    </form>
  </section>
}

const intakeEndpoint = `${__CLIPMENTOR_API_BASE_PATH__}/intake`

export default function ClipMentorPage({ projectId, workspaceNew = false, embedded = false, running, limit, requestedAudience,onAudienceChange,onPreviewTask }: {
  projectId?: string; workspaceNew?: boolean; embedded?: boolean; running?: number; limit?: number
  requestedAudience?:Audience; onAudienceChange?:(audience:Audience)=>void; onPreviewTask?:(task:Task|undefined)=>void
} = {}) {
  const [materials, setMaterials] = useState<Partial<Record<Slot, Material>>>({})
  const urls = useRef<Partial<Record<Slot, string>>>({})
  const demo = !__CLIPMENTOR_API_BASE_PATH__ || new URLSearchParams(window.location.search).get('demo') === '1'
  const [receipt, setReceipt] = useState<IntakeReceipt>()
  const [repair, setRepair] = useState<IntakeRepair>()
  const [hasSavedProduction, setHasSavedProduction] = useState(false)
  const [mediaRefresh, setMediaRefresh] = useState(0)
  const [accessLost, setAccessLost] = useState(false)
  const [checkingReceipt, setCheckingReceipt] = useState(!demo && !workspaceNew)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const uploadActive = useRef(false)
  const creationId = useRef<string>()
  const [taskName, setTaskName] = useState('')
  const [registeredName, setRegisteredName] = useState<string>()
  const [step, setStep] = useState(0)
  const [dragSlot, setDragSlot] = useState<Slot>()
  const [blueprintNotes, setBlueprintNotes] = useState<Message[]>([])
  const [previewNotes, setPreviewNotes] = useState<Message[]>([])
  const [confirmed, setConfirmed] = useState(false)
  const requestedSlots = repair ? slots.filter(({ key }) => repair.missingSlots.includes(key)) : slots
  const size = [...requestedSlots].reduce((sum, { key }) => sum + (materials[key]?.file.size ?? 0), 0)
  // Leave headroom for the multipart headers within the server's request limit.
  const sizeExceeded = size > 64 * 1024 * 1024 - 4096
  const ready = !sizeExceeded && requestedSlots.every(({ key }) => materials[key]?.status === 'ready')
  const slotsFull = running !== undefined && limit !== undefined && running >= limit
  const slotsLoading = workspaceNew && (running === undefined || limit === undefined)
  const readyCount=slots.filter(({key})=>materials[key]?.status==='ready').length
  const IntakeTitle=embedded&&!workspaceNew?'h2':'h1'

  const requestApi = useCallback(async (url: string, init?: RequestInit) => {
    const response = await fetch(url, { ...init, mode: 'same-origin', redirect: 'error', cache: 'no-store' })
    if (!init?.signal?.aborted && (response.status === 401 || response.status === 403)) setAccessLost(true)
    return response
  }, [])

  useEffect(() => () => {
    Object.values(urls.current).forEach(URL.revokeObjectURL)
    urls.current = {}
  }, [])

  useEffect(() => {
    if (demo || workspaceNew) return
    const controller = new AbortController()
    void (async () => {
      try {
        try {
          const response = await requestApi(projectResource(intakeEndpoint, projectId), { signal: AbortSignal.any([controller.signal,AbortSignal.timeout(15_000)]) })
          if (!response.ok) {
            if (!controller.signal.aborted) setUploadError('无法读取上传记录，请稍后刷新。')
            if (response.status === 404 || response.status === 401 || response.status === 403) return
          } else {
            const { receipt: saved, repair: candidate } = await response.json() as { receipt: IntakeReceipt | null; repair?: IntakeRepair }
            if (controller.signal.aborted) return
            if (saved?.assets.length === slots.length) {
              setReceipt(saved)
              return
            }
            if (candidate?.assets.length === slots.length && candidate.missingSlots?.length
              && candidate.missingSlots.every(key => slots.some(slot => slot.key === key))) setRepair(candidate)
          }
        } catch {
          if (!controller.signal.aborted) setUploadError('无法读取上传记录，请稍后刷新。')
        }
        if (!controller.signal.aborted) {
          // A missing upload receipt cannot hide a previously saved task.
          const response = await requestApi(projectResource(productionEndpoint, projectId), { signal: AbortSignal.any([controller.signal,AbortSignal.timeout(15_000)]) })
          const saved = await readPanelState(response)
          if (!controller.signal.aborted && (saved?.task || saved?.outputs?.length)) setHasSavedProduction(true)
        }
      } catch {
        // The task and upload checks have separate failure modes. Leave the
        // upload entry usable when neither can show a saved task.
      } finally {
        if (!controller.signal.aborted) setCheckingReceipt(false)
      }
    })()
    return () => controller.abort()
  }, [demo, workspaceNew, projectId, requestApi])

  function addFile(slot: Slot, file?: File) {
    if (!file || uploadActive.current || receipt) return
    setUploadError('')
    setBlueprintNotes([])
    setPreviewNotes([])
    setConfirmed(false)
    const previous = urls.current[slot]
    if (previous) URL.revokeObjectURL(previous)
    const url = URL.createObjectURL(file)
    urls.current[slot] = url
    function setMaterial(status: Material['status'], detail: string, frame?: string) {
      if (urls.current[slot] === url) setMaterials(current => ({ ...current, [slot]: { file, url, status, detail, frame } }))
    }
    setMaterial('checking', '检查中…')
    const inspection = repair
      ? inspectRepair(file, repair.assets[slots.findIndex(entry => entry.key === slot)]?.sourceContentHash)
      : inspect(file, url, slot)
    void inspection.then(
      ({ detail, frame }) => setMaterial('ready', detail, frame),
      error => setMaterial('error',error instanceof UploadNotice?error.message:'文件无法读取，请更换'),
    )
  }

  function selectFile(slot: Slot, event: ChangeEvent<HTMLInputElement>) {
    addFile(slot, event.currentTarget.files?.[0])
    event.currentTarget.value = ''
  }

  function recordFeedback(setNotes: typeof setBlueprintNotes, message: string) {
    setNotes(notes => [...notes, { role: '你', text: message }, { role: '系统', text: '已记录在本次演示。接入制作服务后，这条意见才会用于修改。' }])
  }

  async function uploadMaterials() {
    if (demo) {
      setStep(1)
      return
    }
    if (!ready || uploadActive.current || receipt || slotsLoading || (workspaceNew && slotsFull)) return
    const body = new FormData()
    const files = requestedSlots.map(({ key }) => materials[key]!.file)
    requestedSlots.forEach(({ key },index) => body.append(key,files[index]))
    const finish = (saved: IntakeReceipt) => {
      if (repair && !repair.assets.every((asset, index) => asset.id === saved.assets[index]?.id
        && !!asset.sourceContentHash && asset.sourceContentHash === saved.assets[index]?.sourceContentHash)) {
        throw new UploadNotice(uploadFeedback.changed)
      }
      setReceipt(saved)
      if (repair) {
        setRepair(undefined)
        setMediaRefresh(count => count + 1)
      }
    }
    uploadActive.current = true
    setUploading(true)
    setUploadError('')
    try {
      let target = projectId
      if (workspaceNew) {
        creationId.current ??= crypto.randomUUID()
        const response = await requestApi(workspaceEndpoint, {method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify({id:creationId.current,name:taskName.trim()})})
        const saved = await response.json().catch(() => undefined)
        if (!response.ok || saved?.id !== creationId.current) throw new UploadNotice(response.status===400?'请核对任务名称。':'暂时无法新建任务，请稍后再试。')
        target = saved.id
        setRegisteredName(typeof saved.name==='string'?saved.name:taskName.trim())
      }
      const targetIntake = projectResource(intakeEndpoint,target)
      const complete = async (uploaded: IntakeReceipt) => {
        if (target && uploaded.projectId !== target) throw new UploadNotice(uploadFeedback.changed)
        if (workspaceNew) {
          // Still open the saved task if another task took the slot during upload.
          const started = await requestApi(projectResource(productionEndpoint,target), {method:'POST',
            headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'start'})}).catch(() => undefined)
          const result = await started?.json().catch(() => undefined)
          const url = taskPage(target)
          if (started?.ok && result?.accepted === true) window.location.assign(url)
          else window.location.assign(`${url}&start=${result?.reason==='capacity'?'capacity':'check'}`)
        } else finish(uploaded)
      }
      const response = await requestApi(targetIntake, { method: 'POST', body }).catch(() => undefined)
      const result = await response?.json().catch(() => undefined)
      if (response?.ok && result?.projectId && result.assets?.length === slots.length
        && (!repair || result.projectId === repair.projectId)) {
        await complete(result)
        return
      }
      if (response && !response.ok && response.status < 500 && !result?.commitUncertain) {
        throw new UploadNotice(uploadFeedbackFor(response.status===413?'size':result?.reason))
      }
      // A disconnected response can follow a successful commit. Read the
      // receipt once and bind each submitted entry before moving on.
      const readback = await requestApi(targetIntake).catch(() => undefined)
      const saved: IntakeReceipt | undefined = readback?.ok
        ? (await readback.json().catch(() => undefined))?.receipt
        : undefined
      if (!saved?.projectId || saved.assets?.length !== slots.length || repair && repair.projectId !== saved.projectId) {
        throw new UploadNotice('暂未确认素材已保存，请稍后刷新查看。')
      }
      for (const [index,file] of files.entries()) {
        const position = slots.findIndex(slot => slot.key === requestedSlots[index].key)
        const asset = saved.assets[position]
        const hash = await fileHash(file)
        if (asset?.sourceContentHash !== hash || (repair ? asset.id !== repair.assets[position].id : asset.name !== file.name)) {
          throw new UploadNotice('已保存的素材与本次上传不一致，请刷新查看。')
        }
      }
      await complete(saved)
    } catch (error) {
      setUploadError(error instanceof UploadNotice?error.message:uploadFeedback.unavailable)
    } finally {
      uploadActive.current = false
      setUploading(false)
    }
  }

  const source = materials.source
  const showProduction = !demo && (receipt || hasSavedProduction)
  return <div className={embedded?'cm-embedded-task':'cm-shell'}>
    {!embedded&&<header className="cm-header">
      <div className="cm-brand"><img src="/clipmentor-mark.svg" alt="" /><strong>ClipMentor</strong></div>
      {demo && <span className="cm-demo">流程演示</span>}
    </header>}
    <div className={embedded?'cm-task-surface':'cm-main page-enter'}>
      {accessLost ? <p className="cm-caption cm-upload-error" role="alert">制作服务访问已失效，请刷新页面。</p> : <>
      {!showProduction && !embedded && <nav aria-label="制作步骤"><ol className="cm-steps">
        {stages.map((label, index) => <li key={label} aria-current={index === step ? 'step' : undefined}>
          <span>{index < step ? <Check size={15} /> : index + 1}</span>{label}
        </li>)}
      </ol></nav>}
      {showProduction && <ProductionPanel assets={(receipt ?? repair)?.assets.map((asset, index) => ({ ...asset, title: slots[index].title })) ?? []} requestApi={requestApi}
        projectId={projectId} reviewProjectId={projectId??receipt?.projectId??repair?.projectId} intakeReady={!!receipt}
        slotsFull={slotsFull} mediaRefresh={mediaRefresh} requestedAudience={requestedAudience} onAudienceChange={onAudienceChange} onPreviewTask={onPreviewTask} />}
      {checkingReceipt ? <p className="cm-caption" role="status">正在检查上传记录…</p> : step === 0 && (!showProduction || repair) && <>
        {repair
          ? <div className="cm-heading"><h2>补传缺失素材</h2><p>请选择工程里登记的原文件，补传后即可继续。</p></div>
          : <div className="cm-heading"><IntakeTitle>{workspaceNew?'新建任务':'上传制作素材'}</IntakeTitle><p>{workspaceNew?'选好四份素材。开始制作后，可以回任务列表看进度。':'上传原片、商品图、销量截图和合作海报。'}</p></div>}
        <section className="cm-panel">
          {workspaceNew&&<label className="cm-task-name">{registeredName===undefined?'任务名称（选填）':'已登记的任务名称'}
            <input maxLength={80} value={registeredName??taskName} onChange={event=>setTaskName(event.target.value)} disabled={uploading||registeredName!==undefined}/>
          </label>}
          <div className="cm-materials">
            {requestedSlots.map(({ key, title, accept, icon: Icon }) => {
              const material = materials[key]
              return <label className="cm-upload" data-dragging={dragSlot === key} data-state={material?.status} key={key}
                onDragOver={event => { event.preventDefault(); setDragSlot(key) }}
                onDragLeave={() => setDragSlot(undefined)}
                onDrop={event => { event.preventDefault(); setDragSlot(undefined); addFile(key, event.dataTransfer.files[0]) }}>
                <input type="file" aria-label={title} accept={accept} disabled={uploading || !!receipt} onChange={event => selectFile(key, event)} />
                <span className="cm-slot-icon">{material?.status === 'ready' ? <Check size={22} /> : <Icon size={22} />}</span>
                <strong>{title}</strong>
                {material && <span className="cm-filename">{material.file.name}</span>}
                <span className="cm-material-state" role="status" data-error={material?.status === 'error'}>
                  {material?.detail ?? (repair ? repair.assets[slots.findIndex(slot => slot.key === key)].name
                    : (key === 'source' ? 'MP4、MOV、WebM · 需有音轨' : 'PNG、JPG、WebP')+(workspaceNew?' · 拖入或选择':''))}
                </span>
              </label>
            })}
          </div>
          <div className="cm-footer">
            {workspaceNew&&<div className="cm-upload-count" role="status">
              <p>{readyCount===4&&!sizeExceeded?'四份素材已就绪':`已选 ${readyCount} / 4 份`} · 合计上限 64 MiB</p>
              {slotsLoading?<p>正在读取运行名额。</p>:slotsFull&&<p>{readyCount===4?'名额空出后可以开始制作。':'名额已满，可以先选好素材。'}</p>}
            </div>}
            <button className="cm-button" disabled={!ready || uploading || slotsLoading || workspaceNew && slotsFull} onClick={() => void uploadMaterials()}><Upload size={17} /> {uploading ? '正在上传素材…' : workspaceNew && slotsFull ? '等待运行名额' : demo || workspaceNew ? '开始制作' : repair ? '补传素材' : '上传素材'}</button>
          </div>
        </section>
        {(sizeExceeded || uploadError) && <p className="cm-caption cm-upload-error" role="alert">
          {sizeExceeded ? '素材合计接近或超过 64 MiB，请减小文件后再上传。' : uploadError}
        </p>}
        {!repair && !workspaceNew && <p className="cm-caption" role="status">{demo ? '本地检查文件能否打开，素材留在当前浏览器。演示流程尚未连接制作服务。'
          : '合计上限 64 MiB。原片须有音轨，上传后会核对工程中的四份素材。'}</p>}
      </>}
      {showProduction && !receipt && !repair && uploadError && <p className="cm-caption cm-upload-error" role="alert">{uploadError}</p>}
      {step === 1 && <>
        <div className="cm-heading"><h1>审核蓝图</h1><p>对照原片、口播和讲解。修改后确认蓝图，才进入剪辑。</p></div>
        <section className="cm-panel cm-work">
          <div className="cm-board">
            <div className="cm-board-source">
              <h2>蓝图示例</h2>
              {source?.frame && <img src={source.frame} className="cm-board-frame" alt="上传原片的首帧" />}
            </div>
            <div className="cm-board-copy">
              <h3>原片口播</h3><p>真实制作后显示原话中文，马来语可展开。</p>
              <h3>回看讲解</h3><p>正式蓝图会显示讲解词和对应画面。</p>
              <h3>片尾</h3><p>新建联与已合作两个版本，共用片头和教学主体。</p>
            </div>
          </div>
          <Feedback label="蓝图修改" messages={blueprintNotes} onSend={message => recordFeedback(setBlueprintNotes, message)} />
          <div className="cm-footer"><button className="cm-button secondary" onClick={() => setStep(0)}>返回素材</button>
            <button className="cm-button" onClick={() => setStep(2)}>确认演示蓝图</button></div>
        </section>
      </>}
      {step === 2 && <>
        <div className="cm-heading"><h1>预览与下载</h1><p>集中提出修改，核对后确认并下载。</p></div>
        <section className="cm-panel cm-work">
          <div className="cm-board">
            <div className="cm-board-source"><h2>播放器示例</h2><video src={source?.url} controls preload="metadata" aria-label="原片播放器示例" /></div>
            <div className="cm-board-copy"><h3>当前播放的是原片</h3><p>剪辑服务接通后，这里显示待终审的剪辑结果。</p></div>
          </div>
          <Feedback label="成片修改" messages={previewNotes} onSend={message => {
            setConfirmed(false)
            recordFeedback(setPreviewNotes, message)
          }} />
          <div className="cm-footer">
            <button className="cm-button secondary" onClick={() => { setConfirmed(false); setStep(1) }}>返回蓝图</button>
            {!confirmed ? <button className="cm-button" onClick={() => setConfirmed(true)}>确认演示预览</button>
              : <a className="cm-button" href={source?.url} download={`演示原片-${source?.file.name}`}><Download size={17} /> 下载演示文件</a>}
          </div>
        </section>
      </>}
      </>}
    </div>
  </div>
}
