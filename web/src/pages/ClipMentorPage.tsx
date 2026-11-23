import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { Check, Download, Film, Image, Send, Upload } from 'lucide-react'
import './clipmentor.css'
import ProductionPanel from './ProductionPanel'

const slots = [
  { key: 'source', title: '爆款原片', accept: 'video/mp4,video/webm,video/quicktime', icon: Film, formats: ['.mp4', '.webm', '.mov'] },
  { key: 'product', title: '商品图', accept: 'image/png,image/jpeg,image/webp', icon: Image, formats: ['.png', '.jpg', '.jpeg', '.webp'] },
  { key: 'sales', title: '销量截图', accept: 'image/png,image/jpeg,image/webp', icon: Image, formats: ['.png', '.jpg', '.jpeg', '.webp'] },
  { key: 'cta', title: 'CTA 行动号召图', accept: 'image/png,image/jpeg,image/webp', icon: Image, formats: ['.png', '.jpg', '.jpeg', '.webp'] },
] as const

type Slot = typeof slots[number]['key']
type Material = { file: File; url: string; status: 'checking' | 'ready' | 'error'; detail: string; frame?: string }
type IntakeReceipt = { projectId: string; assets: { id: string; name: string; sourceContentHash?: string }[] }
type Message = { role: '你' | '系统'; text: string }
const stages = ['上传素材', '审核蓝图', '预览与下载'] as const

function inspect(file: File, url: string, slot: Slot): Promise<{ detail: string; frame?: string }> {
  const formats: readonly string[] = slots.find(entry => entry.key === slot)!.formats
  if (!formats.some(extension => file.name.toLowerCase().endsWith(extension))) {
    return Promise.reject(new Error(slot === 'source' ? '支持 MP4、MOV、WebM' : '支持 PNG、JPG、WebP'))
  }
  if (file.size === 0) return Promise.reject(new Error('文件为空，请更换'))
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
      else reject(new Error('文件无法读取，请更换'))
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

export default function ClipMentorPage() {
  const [materials, setMaterials] = useState<Partial<Record<Slot, Material>>>({})
  const urls = useRef<Partial<Record<Slot, string>>>({})
  const demo = !__CLIPMENTOR_INTAKE__ || new URLSearchParams(window.location.search).get('demo') === '1'
  const [receipt, setReceipt] = useState<IntakeReceipt>()
  const [checkingReceipt, setCheckingReceipt] = useState(!demo)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const uploadActive = useRef(false)
  const [step, setStep] = useState(0)
  const [dragSlot, setDragSlot] = useState<Slot>()
  const [blueprintNotes, setBlueprintNotes] = useState<Message[]>([])
  const [previewNotes, setPreviewNotes] = useState<Message[]>([])
  const [confirmed, setConfirmed] = useState(false)
  const size = Object.values(materials).reduce((sum, material) => sum + material.file.size, 0)
  // Leave headroom for the multipart headers within the server's request limit.
  const sizeExceeded = size > 64 * 1024 * 1024 - 4096
  const ready = !sizeExceeded && slots.every(({ key }) => materials[key]?.status === 'ready')

  useEffect(() => () => {
    Object.values(urls.current).forEach(URL.revokeObjectURL)
    urls.current = {}
  }, [])

  useEffect(() => {
    if (demo) return
    const controller = new AbortController()
    void (async () => {
      try {
        const response = await fetch('/api/clipmentor/intake', { signal: controller.signal })
        if (!response.ok) throw new Error('无法读取上传记录，请稍后刷新。')
        const { receipt: saved } = await response.json() as { receipt: IntakeReceipt | null }
        if (!controller.signal.aborted && saved?.assets.length === slots.length) setReceipt(saved)
      } catch {
        if (!controller.signal.aborted) setUploadError('无法读取上传记录，请稍后刷新。')
      } finally {
        if (!controller.signal.aborted) setCheckingReceipt(false)
      }
    })()
    return () => controller.abort()
  }, [demo])

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
    void inspect(file, url, slot).then(
      ({ detail, frame }) => setMaterial('ready', detail, frame),
      error => setMaterial('error', error.message),
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
    if (!ready || uploadActive.current || receipt) return
    const body = new FormData()
    const files = slots.map(({ key }) => materials[key]!.file)
    slots.forEach(({ key },index) => body.append(key,files[index]))
    uploadActive.current = true
    setUploading(true)
    setUploadError('')
    try {
      const response = await fetch('/api/clipmentor/intake', { method: 'POST', body }).catch(() => undefined)
      const result = await response?.json().catch(() => undefined)
      if (response?.ok && result?.projectId && result.assets?.length === slots.length) {
        setReceipt(result)
        return
      }
      if (response && !response.ok && response.status < 500 && !result?.commitUncertain) {
        throw new Error(result?.error || '工程未确认收到素材')
      }
      // A disconnected response can follow a successful commit. Read the
      // receipt once and bind all four entries to this upload before moving on.
      const readback = await fetch('/api/clipmentor/intake').catch(() => undefined)
      const saved: IntakeReceipt | undefined = readback?.ok
        ? (await readback.json().catch(() => undefined))?.receipt
        : undefined
      if (!saved?.projectId || saved.assets?.length !== files.length) {
        throw new Error('暂未确认素材已保存，请稍后刷新核对。')
      }
      for (const [index,file] of files.entries()) {
        const asset = saved.assets[index]
        const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
        const hash = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2,'0')).join('')
        if (asset?.name !== file.name || asset.sourceContentHash !== hash) {
          throw new Error('工程内保存的素材与本次上传不一致。')
        }
      }
      setReceipt(saved)
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : '上传未确认')
    } finally {
      uploadActive.current = false
      setUploading(false)
    }
  }

  const source = materials.source
  return <div className="cm-shell">
    <header className="cm-header">
      <div className="cm-brand"><img src="/clipmentor-mark.svg" alt="" /><strong>ClipMentor</strong></div>
      {demo && <span className="cm-demo">流程演示</span>}
    </header>
    <main className="cm-main page-enter">
      {(!receipt || demo) && <nav aria-label="制作步骤"><ol className="cm-steps">
        {stages.map((label, index) => <li key={label} aria-current={index === step ? 'step' : undefined}>
          <span>{index < step ? <Check size={15} /> : index + 1}</span>{label}
        </li>)}
      </ol></nav>}
      {receipt && !demo ? <ProductionPanel assets={receipt.assets.map((asset, index) => ({ ...asset, title: slots[index].title }))} onRecheck={() => { setReceipt(undefined); setUploadError('') }} /> : checkingReceipt ? <p className="cm-caption" role="status">正在检查上传记录…</p> : step === 0 && <>
        <div className="cm-heading"><h1>上传制作素材</h1><p>选好原片、商品图、销量截图和 CTA 行动号召图，再开始拆解。</p></div>
        <section className="cm-panel">
          <div className="cm-materials">
            {slots.map(({ key, title, accept, icon: Icon }) => {
              const material = materials[key]
              return <label className="cm-upload" data-dragging={dragSlot === key} key={key}
                onDragOver={event => { event.preventDefault(); setDragSlot(key) }}
                onDragLeave={() => setDragSlot(undefined)}
                onDrop={event => { event.preventDefault(); setDragSlot(undefined); addFile(key, event.dataTransfer.files[0]) }}>
                <input type="file" aria-label={title} accept={accept} disabled={uploading || !!receipt} onChange={event => selectFile(key, event)} />
                <span className="cm-slot-icon">{material?.status === 'ready' ? <Check size={22} /> : <Icon size={22} />}</span>
                <strong>{title}</strong>
                {material && <span className="cm-filename">{material.file.name}</span>}
                <span className="cm-material-state" role="status" data-error={material?.status === 'error'}>
                  {material?.detail ?? (key === 'source' ? 'MP4、MOV、WebM' : 'PNG、JPG、WebP')}
                </span>
              </label>
            })}
          </div>
          <div className="cm-footer">
            <button className="cm-button" disabled={!ready || uploading} onClick={() => void uploadMaterials()}><Upload size={17} /> {uploading ? '正在上传并回读…' : demo ? '开始制作' : '上传素材'}</button>
          </div>
        </section>
        {(sizeExceeded || uploadError) && <p className="cm-caption cm-upload-error" role="alert">
          {sizeExceeded ? '素材合计接近或超过 64 MiB，请减小文件后再上传。' : uploadError}
        </p>}
        <p className="cm-caption" role="status">{demo ? '本地检查文件能否打开，素材留在当前浏览器。演示流程尚未连接制作服务。'
          : '合计上限 64 MiB。原片须有音轨，上传后会核对工程中的四份素材。'}</p>
      </>}
      {step === 1 && <>
        <div className="cm-heading"><h1>审核蓝图</h1><p>对照原片、口播和讲解。修改后确认蓝图，才进入剪辑。</p></div>
        <section className="cm-panel cm-work">
          <div className="cm-board">
            <div className="cm-board-source">
              <h2>人审板 · 版式示例</h2>
              {source?.frame && <img src={source.frame} className="cm-board-frame" alt="上传原片的首帧" />}
            </div>
            <div className="cm-board-copy">
              <h3>原片口播</h3><p>真实制作后显示原话中文，马来语可展开。</p>
              <h3>回看讲解</h3><p>真实制作后显示每组教学点、画面截图和短标中马对照。</p>
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
    </main>
  </div>
}
