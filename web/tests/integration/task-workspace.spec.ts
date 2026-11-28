import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { preview, type Plugin } from 'vite'

const endpoints = '/workspace-api'
const a='board-a', b='board-b', exportsId='outputs', pausedId='paused', activeId='running'
const outputs=[{audience:'existing_partner'},{audience:'new_contact'}]
const boardTasks=[
  {id:pausedId,name:'暂停示例',status:'paused',stage:'edit',updatedAt:5,outputs:[{audience:'existing_partner',status:'completed',stage:'self_check'},{audience:'new_contact',status:'paused',stage:'edit'}]},
  {id:activeId,name:'制作示例',status:'running',stage:'edit',updatedAt:6,outputs:[]},
  {id:a,name:'短片甲',status:'blueprint',updatedAt:4,stage:'copy_review',outputs:[]},
  {id:b,name:'短片乙',status:'blueprint',updatedAt:3,stage:'copy_review',outputs:[]},
  {id:exportsId,name:'成片示例',status:'preview',updatedAt:2,stage:'self_check',outputs:[
    {audience:'existing_partner',status:'completed',stage:'self_check'},
    {audience:'new_contact',status:'preview',stage:'self_check',awaitingConfirmation:true},
  ]},
]
const assets=['source.webm','product.png','sales.png','cta.png'].map((name,id)=>({name,id:String(id)}))
const baseTask={sequence:1,active:false,feedbackUsed:false}
const versionRead=(audience:string)=>(url:URL)=>url.pathname===`${endpoints}/production`
  &&!url.searchParams.has('view')&&url.searchParams.get('audience')===audience
const image={name:'test.png',mimeType:'image/png',
  buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jH1sAAAAASUVORK5CYII=','base64')}
const source=fileURLToPath(new URL('../fixtures/preflight.webm',import.meta.url))
const rawScreens=process.env.CLIPMENTOR_V2_RAW_DIR
const visualMedia=process.env.CLIPMENTOR_V2_VISUAL_MEDIA
const visualVideo=visualMedia?await readFile(visualMedia):undefined
let path:string, origin:string, standaloneOrigin:string
let standalone:Awaited<ReturnType<typeof preview>>|undefined
let visualCase=false
let server:Awaited<ReturnType<typeof preview>>
const videoBytes=await readFile(source)
let running=5, held=false, clientFailed=false, staleBoard=false
let partnerHeld=false, partnerFailed=false
const created=new Map<string,string>()
const flows=new Map<string,{phase:'blueprint'|'preview'|'completed';revision:number;feedback:boolean;pending:boolean}>()
const flowPosts=new Map<string,Array<Record<string,unknown>>>()
const flowTasks=()=>Array.from(created,([id,name])=>{
  const flow=flows.get(id)
  const status=flow?.phase??'materials'
  return {id,name,status,stage:status==='blueprint'?'copy_review':status==='materials'?undefined:'self_check',updatedAt:1,outputs:[]}
})
async function readBody(req:AsyncIterable<Buffer>){
  const parts:Buffer[]=[]
  for await(const part of req)parts.push(part)
  return JSON.parse(Buffer.concat(parts).toString())
}
const uploaded=new Set<string>()
const calls:Array<{route:string;projectId:string|null}> = []

test.beforeAll(async ()=>{
  path=await mkdtemp(join(tmpdir(),'clipmentor-workspace-web-'))
  const build=(outDir:string,workspace:boolean)=>execFileSync(process.execPath,['node_modules/vite/bin/vite.js','build','--outDir',outDir,'--emptyOutDir'],{
    env:{...process.env,NODE_ENV:'production',CLIPMENTOR_PUBLIC_WORKSPACE:workspace?'1':'0',CLIPMENTOR_PUBLIC_API_BASE_PATH:endpoints},stdio:'pipe',
  })
  const fixtures:Plugin={
    name:'clip-workspace-fixture',
    configurePreviewServer(vite){
      vite.middlewares.use(endpoints,async(req,res)=>{
        const url=new URL(req.url??'/', 'http://localhost')
        const view=url.searchParams.get('view')??'panel'
        const id=url.searchParams.get('projectId')??(visualCase?exportsId:null)
        const audience=url.searchParams.get('audience')
        const send=(status:number,body:unknown)=>res.writeHead(status,{'Content-Type':'application/json'}).end(JSON.stringify(body))
        calls.push({route:`${req.method} ${url.pathname} ${view}`,projectId:id})
        if(url.pathname==='/tasks'){
          if(req.method==='POST'){
            const {id,name}=await readBody(req)
            created.set(id,name)
            send(201,{id,name});return
          }
          const tasks=visualCase?[
            {...boardTasks[4],name:'JUDYDOLL 修容盘',updatedAt:Date.now()-120_000,outputs:[
              {audience:'existing_partner',status:'preview',stage:'self_check'},
              {audience:'new_contact',status:'paused',stage:'edit'},
            ]},
            {...boardTasks[2],name:'Dr. Lan 眼影盘',updatedAt:Date.now()-900_000},
            {...boardTasks[1],name:'SugarBomb 唇釉',updatedAt:Date.now()-180_000},
            {...boardTasks[1],id:'running-analysis',name:'Barely There 粉底',stage:'analysis',updatedAt:Date.now()-300_000},
            {...boardTasks[0],name:'NIUMO 洗面奶',updatedAt:Date.now()-500_000},
            {...boardTasks[0],id:'completed',name:'TeaShell 面膜',status:'completed',updatedAt:Date.now()-86_400_000},
          ]:[...boardTasks,...flowTasks()]
          send(200,{running,limit:5,tasks});return
        }
        if(id!==a&&id!==b&&id!==exportsId&&id!==pausedId&&id!==activeId&&(!id||!created.has(id))){send(404,{});return}
        if(url.pathname==='/intake'){
          if(req.method==='POST'){
            for await(const _chunk of req){ /* Drain the fixture request. */ }
            uploaded.add(id)
            send(200,{projectId:id,assets});return
          }
          send(200,uploaded.has(id)||!created.has(id)?{receipt:{projectId:id,assets}}:{});return
        }
        if(url.pathname!=='/production'){send(404,{});return}
        if(req.method==='POST'){
          const name=id&&created.get(id)
          const flow=id&&flows.get(id)
          if(!id||typeof name!=='string'||!name.startsWith('流程验收')){send(409,{reason:'capacity'});return}
          const body=await readBody(req)
          const previous=flowPosts.get(id)??[]
          flowPosts.set(id,[...previous,body])
          if(body.action==='start'&&uploaded.has(id))flows.set(id,{phase:'blueprint',revision:1,feedback:false,pending:false})
          else if(flow&&flow.phase==='blueprint'&&body.action==='approve_blueprint'&&body.boardIdentity===id){
            flow.phase='preview';flow.pending=name.includes('复核暂停')
          }else if(flow?.phase==='preview'&&!flow.pending&&body.action==='revise_preview'&&body.renderId===`cut-${flow.revision}`&&!flow.feedback){
            flow.feedback=true;flow.revision++
          }else if(flow?.phase==='preview'&&!flow.pending&&body.action==='accept'&&body.renderId===`cut-${flow.revision}`&&body.previewWatched&&body.languageConfirmed){
            flow.phase='completed'
          }else{send(409,{reason:'fixture_transition'});return}
          send(200,{accepted:true});return
        }
        if(view==='panel_board'){
          const identity=staleBoard&&id===a?'changed-a':id
          res.writeHead(200,{'Content-Type':'text/html','X-ClipMentor-Board-Identity':identity}).end(
            `<h2>蓝图示例</h2><details><summary>第 1 组意见</summary><textarea aria-label="第 1 组意见" data-blueprint-opinion="group-1"></textarea></details>
            <script>
              const field=document.querySelector('textarea');
              field.addEventListener('input',()=>parent.postMessage({type:'clipmentor:blueprint-opinion',unitId:'group-1',text:field.value},'*'));
              addEventListener('message',event=>{
                if(event.source!==parent||event.data?.type!=='clipmentor:blueprint-opinion-draft'||!Array.isArray(event.data.entries))return;
                field.value=event.data.entries?.find(item=>item.unitId==='group-1')?.text??'';
                field.closest('details').open=Boolean(field.value);
              });
            </script>`,
          );return
        }
        const flow=id&&flows.get(id)
        if(flow&&view==='panel_download'&&flow.phase==='completed'&&url.searchParams.get('renderId')===`cut-${flow.revision}`){
          res.writeHead(200,{'Content-Type':'video/mp4','Content-Disposition':'attachment; filename="reviewed.mp4"'}).end('fixture');return
        }
        if(flow&&view==='panel_draft_download'&&flow.phase==='preview'&&flow.pending&&url.searchParams.get('renderId')===`cut-${flow.revision}`){
          res.writeHead(200,{'Content-Type':'video/mp4','Content-Disposition':"attachment; filename*=UTF-8''%E6%9C%AA%E5%A4%8D%E6%A0%B8_cut.mp4"}).end('fixture');return
        }
        if(view==='panel_draft_download'||view==='panel_download'){
          const expected=view==='panel_draft_download'?'draft-contact':'ready-partner'
          if(url.searchParams.get('renderId')!==expected||view==='panel_draft_download'&&held){send(409,{});return}
          res.writeHead(200,{'Content-Type':'video/mp4','Content-Disposition':`attachment; filename="${expected}.mp4"`}).end('fixture');return
        }
        if(view==='panel_video'){
          const media=visualCase&&visualVideo?visualVideo:videoBytes
          const start=Number(/^bytes=(\d+)-/.exec(req.headers.range??'')?.[1]??0)
          res.writeHead(206,{'Content-Type':'video/webm','Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${media.length-1}/${media.length}`}).end(media.subarray(start));return
        }
        if(view==='panel_poster'){
          res.writeHead(200,{'Content-Type':'image/png'}).end(image.buffer);return
        }
        if(flow){
          const blueprint=flow.phase==='blueprint'
          send(200,{task:{...baseTask,taskId:id,sequence:flow.revision,
            status:blueprint?'awaiting_blueprint':flow.pending?'blocked':flow.phase==='completed'?'completed':'awaiting_review',
            stage:blueprint?'copy_review':'self_check',feedbackUsed:flow.feedback,
            reviewGroups:[{id:'group-1',label:'第 1 组'}],
            ...(blueprint?{blueprintRevision:id,boardIdentity:id,canApproveBlueprint:true}:
              {blueprintConfirmed:true,renderId:`cut-${flow.revision}`,previewPending:flow.pending,previewReviewed:!flow.pending,
                canAcceptPreview:!flow.pending,previewDuration:1,downloadName:'reviewed.mp4',
                previewChapters:[{id:'opening',label:'片头',seconds:0},{id:'group-1',label:'第 1 组',seconds:0.25}]})}})
          return
        }
        if(id===a||id===b){
          const identity=staleBoard&&id===a?'changed-a':id
          send(200,{task:{...baseTask,taskId:id,status:'awaiting_blueprint',stage:'copy_review',blueprintRevision:identity,
            boardIdentity:identity,dualBlueprint:true,canConfirmBlueprint:true,reviewGroups:[{id:'group-1',label:'第 1 组'}]}});return
        }
        if(id===exportsId||id===pausedId){
          if(!audience){send(200,{task:null,outputs,outputOwner:{taskId:id,sequence:1}});return}
          if(visualCase&&id===exportsId&&audience==='existing_partner'){
            const reviewGroups=Array.from({length:3},(_,i)=>({id:'group-'+(i+1),label:'第 '+(i+1)+' 组'}))
            send(200,{task:{...baseTask,taskId:`${id}-${audience}`,sourceTaskId:id,audience,stage:'self_check',
              status:'blocked',stopReason:'limit',previewDuration:111,renderId:'draft-partner',previewPending:true,
              reviewGroups,previewChapters:[{id:'opening',label:'片头',seconds:0},
                ...reviewGroups.map(({id,label},i)=>({id,label,seconds:12+i*22})),
                {id:'ending',label:'片尾',seconds:97}],
            }});return
          }
          if((id===pausedId||visualCase)&&audience==='new_contact'){
            send(200,{task:{...baseTask,taskId:`${id}-${audience}`,sourceTaskId:id,audience,status:'blocked',stage:'edit',stopReason:'limit',blueprintConfirmed:true}});return
          }
          if(audience==='new_contact'&&clientFailed){send(503,{});return}
          if(audience==='existing_partner'&&partnerFailed){send(503,{});return}
          send(200,{task:{...baseTask,taskId:`${id}-${audience}`,sourceTaskId:id,audience,stage:'self_check',blueprintConfirmed:true,previewDuration:28,
            previewChapters:[{id:'opening',label:'片头',seconds:0},{id:'group-1',label:'第 1 组',seconds:0.25},{id:'ending',label:'片尾',seconds:0.5}],
            ...(audience==='new_contact'?{status:'blocked',previewPending:true,deliveryHeld:held,renderId:'draft-contact',
              materialAttachment:{assetId:'cta',label:'合作海报'}}:
              {status:'completed',previewReviewed:true,deliveryHeld:partnerHeld,renderId:'ready-partner',confirmedAt:1770000000000,downloadName:'saved.mp4',
                attachments:[{assetId:'board-pdf',fileName:'board.pdf'}]})}});return
        }
        send(200,{task:null})
      })
    },
  }
  const start=async(outDir:string)=>preview({configFile:false,build:{outDir},preview:{host:'127.0.0.1',port:0},plugins:[fixtures]})
  const address=(site:Awaited<ReturnType<typeof preview>>)=>{
    const bound=site.httpServer.address()
    if(!bound||typeof bound==='string')throw Error('Fixture port unavailable')
    return `http://127.0.0.1:${bound.port}`
  }
  const workspace=join(path,'workspace')
  build(workspace,true)
  server=await start(workspace)
  origin=address(server)
  const direct=join(path,'direct')
  build(direct,false)
  standalone=await start(direct)
  standaloneOrigin=address(standalone)
})
test.afterAll(async()=>{
  for(const site of [server,standalone])if(site){
    site.httpServer.closeAllConnections()
    await new Promise<void>(resolve=>site.httpServer.close(()=>resolve()))
  }
  if(path)await rm(path,{recursive:true,force:true})
})

test('homepage and upload disclose a lost slot and retain the four saved assets',async({page})=>{
  await page.goto(origin)
  await expect(page.getByText('5/5',{exact:true})).toBeVisible()
  await expect(page.getByRole('button',{name:'新建任务'})).toBeDisabled()
  await page.getByRole('link',{name:'先选素材'}).click()
  await expect(page.getByText('名额已满，可以先选好素材。')).toBeVisible()
  await page.getByLabel('任务名称（选填）').fill('上传竞争')
  await page.getByLabel('爆款原片',{exact:true}).setInputFiles(source)
  for(const label of ['商品图','销量截图','合作海报']){
    await page.getByLabel(label,{exact:true}).setInputFiles({...image,name:`${label}.png`})
  }
  await expect(page.getByText(/四份素材已就绪/)).toBeVisible()
  await expect(page.locator('.cm-upload[data-state="ready"]')).toHaveCount(4)
  await expect(page.getByRole('button',{name:'等待空位'})).toBeDisabled()
  expect(calls.filter(call=>call.route.startsWith('POST'))).toHaveLength(0)
  running=4
  const start=page.getByRole('button',{name:'开始制作'})
  await expect(start).toBeEnabled({timeout:8000})
  await start.click()
  await expect(page.getByText('素材已保存。有空位后，点「开始制作」。')).toBeVisible()
  await expect(page.getByText('四份素材都已保存。')).toBeVisible()
  expect(calls.filter(call=>call.route.startsWith('POST')).map(call=>call.route)).toEqual([
    'POST /tasks panel','POST /intake panel','POST /production panel',
  ])
})

test('task switching isolates local opinions and a superseded board cannot inherit them',async({page})=>{
  await page.setViewportSize({width:360,height:780})
  await page.goto(`${origin}/?task=${a}`)
  const overall=page.getByLabel('整体意见',{exact:true})
  await page.getByText('整体意见',{selector:'summary',exact:true}).click()
  await overall.fill('只留在短片甲')
  const group=page.frameLocator('iframe[title="人审版蓝图"]')
  await group.getByText('第 1 组意见').click()
  await group.getByRole('textbox',{name:'第 1 组意见'}).fill('本组草稿')
  const switchTasks=page.getByRole('combobox',{name:'切换任务'})
  await switchTasks.selectOption(b)
  await expect(page).toHaveURL(new RegExp(`task=${a}$`))
  await expect(page.getByRole('heading',{level:1})).toHaveCount(1)
  await page.getByRole('button',{name:'打开所选任务'}).click()
  await expect(overall).toHaveValue('')
  await switchTasks.selectOption(a)
  await page.getByRole('button',{name:'打开所选任务'}).click()
  await expect(overall).toHaveValue('只留在短片甲')
  await expect(group.getByRole('textbox',{name:'第 1 组意见'})).toHaveValue('本组草稿')
  staleBoard=true
  await page.reload()
  await expect(overall).toHaveValue('')
  await page.goto(`${origin}/?task=does-not-exist`)
  await expect(page.getByRole('heading',{name:/找不到这个任务/})).toBeVisible()
  expect(calls.some(call=>call.projectId==='does-not-exist')).toBe(false)
})

function version(page:Page,audience:'existing_partner'|'new_contact'){
  const title=audience==='existing_partner'?'已合作达人版':'新建联达人版'
  return {
    tab:page.getByRole('tab',{name:new RegExp(title)}),
    panel:page.getByRole('tabpanel',{name:title,exact:true}),
  }
}

test('legacy download links use the film tab and isolate audience eligibility',async({page})=>{
  const route=`${origin}/?task=${exportsId}&view=downloads`
  const partner=version(page,'existing_partner'), contact=version(page,'new_contact')
  await page.goto(route)
  await expect(page.getByRole('button',{name:'成片',exact:true})).toHaveAttribute('aria-current','page')
  await partner.tab.click()
  await expect(partner.panel.getByRole('link',{name:'下载成片',exact:true})).toHaveAttribute('href',/renderId=ready-partner.*audience=existing_partner.*projectId=outputs/)
  await expect(partner.panel.getByRole('link',{name:'下载原片分镜（PDF）'})).toBeVisible()
  await contact.tab.click()
  await expect(contact.panel.getByRole('link',{name:'先下未复核版'})).toHaveAttribute('href',/view=panel_draft_download.*renderId=draft-contact/)
  await expect(contact.panel.getByRole('link',{name:'下载合作海报'})).toHaveAttribute('href',/view=panel_material.*renderId=draft-contact.*assetId=cta/)
  await expect(contact.panel.getByRole('button',{name:'确认成片',exact:true})).toBeDisabled()
  await expect(page.locator('video')).toHaveCount(1)
  held=true
  try{
    await page.reload()
    await expect(contact.panel.getByText('成片需要修改。')).toBeVisible()
    await expect(contact.panel.getByRole('link',{name:'先下未复核版'})).toHaveCount(0)
    clientFailed=true
    await page.reload()
    await expect(contact.tab).toContainText('读取状态失败')
    await partner.tab.click()
    await expect(partner.panel.getByRole('link',{name:'下载成片',exact:true})).toBeVisible()
  }finally{held=false;clientFailed=false}
})

test('home opens the outstanding version and the three task tabs preserve it',async({page})=>{
  await page.goto(origin)
  await page.getByRole('link',{name:'去看片 · 成片示例 · 新建联达人版'}).click()
  const partner=version(page,'existing_partner'), contact=version(page,'new_contact')
  await expect(contact.tab).toHaveAttribute('aria-selected','true')
  await expect(page.getByRole('heading',{level:1})).toHaveCount(1)
  await partner.tab.click()
  await page.getByRole('button',{name:'素材',exact:true}).click()
  await expect(page.getByRole('region',{name:'制作素材'}).getByText('product.png')).toBeVisible()
  await page.getByRole('button',{name:'蓝图',exact:true}).click()
  await expect(page.getByText(/蓝图已进入制作/)).toBeVisible()
  await page.getByRole('button',{name:'成片',exact:true}).click()
  await expect(partner.tab).toHaveAttribute('aria-selected','true')
  await expect(partner.panel.getByRole('link',{name:'下载成片',exact:true})).toBeVisible()
  await page.goto(`${origin}/?task=${b}&view=downloads`)
  await expect(page.getByText('蓝图确认并生成预览后，可在这里看片。')).toBeVisible()
})

for(const scenario of ['delayed-read','switched','delayed-ack'])test(`confirmation follows the saved version (${scenario})`,async({page})=>{
  let accepted=false, readsAfterAccept=0, release!:()=>void
  const delayedAck=new Promise<void>(resolve=>{release=resolve})
  await page.route(versionRead('new_contact'),async route=>{
    if(route.request().method()==='POST'){
      expect(route.request().postDataJSON()).toMatchObject({action:'accept',renderId:'draft-contact',previewWatched:true,languageConfirmed:true})
      accepted=true
      if(scenario==='delayed-ack')await delayedAck
      await route.fulfill({json:{accepted:true}}).catch(error=>{if(scenario!=='delayed-ack')throw error})
      return
    }
    if(scenario!=='delayed-ack'&&accepted&&++readsAfterAccept===1){await route.fulfill({status:503,json:{}});return}
    await route.fulfill({json:{task:{...baseTask,sequence:accepted?2:1,taskId:`${exportsId}-new_contact`,sourceTaskId:exportsId,audience:'new_contact',stage:'self_check',
      status:accepted?'completed':'awaiting_review',renderId:'draft-contact',blueprintConfirmed:true,previewReviewed:true,
      ...(accepted?{confirmedAt:1770000000000}:{canAcceptPreview:true,visualCriteria:{digest:'fixture'}})}}})
  })
  await page.clock.install()
  await page.setViewportSize({width:320,height:640})
  await page.goto(`${origin}/?task=${exportsId}&audience=new_contact`)
  await page.getByLabel('我已看过成片').check()
  await page.getByLabel('我已核对口播和字幕').check()
  await page.getByRole('button',{name:'确认成片',exact:true}).click()
  try{
    await expect.poll(()=>accepted).toBe(true)
    if(scenario!=='delayed-ack')await expect(page.getByText('已收到，正在更新状态。')).toBeVisible()
    if(scenario==='switched')await page.getByRole('tab',{name:/已合作达人版/}).click()
    await page.clock.fastForward(9000)
    if(scenario==='switched'){
      await expect(page.getByRole('tab',{name:/新建联达人版/})).toContainText('可下载')
      await expect(page).toHaveURL(/task=outputs&audience=existing_partner$/)
    }else{
      await expect(page).toHaveURL(/task=outputs&audience=new_contact$/)
      await expect(version(page,'new_contact').panel.getByRole('link',{name:'下载成片',exact:true})).toBeVisible()
    }
  }finally{release()}
})

test('one pending audience request does not delay a second version or change its download authority',async({page})=>{
  const partner=version(page,'existing_partner'), contact=version(page,'new_contact')
  let release!:()=>void
  const paused=new Promise<void>(resolve=>{release=resolve})
  const gate=versionRead('new_contact')
  await page.route(gate,async route=>{await paused;await route.continue().catch(()=>{})})
  try{
    await page.goto(`${origin}/?task=${exportsId}&view=film&audience=existing_partner`)
    await expect(contact.tab).toContainText('正在读取')
    await expect(partner.panel.getByRole('link',{name:'下载成片',exact:true})).toBeVisible()
  }finally{release()}
  await page.unroute(gate)
  partnerHeld=true
  try{
    await page.reload()
    await expect(partner.tab).toContainText('需修改')
    await expect(partner.panel.getByRole('link',{name:'下载成片',exact:true})).toHaveCount(0)
    partnerFailed=true
    await page.reload()
    await contact.tab.click()
    await expect(partner.tab).toContainText('读取状态失败')
    await expect(contact.panel.locator('video')).toBeVisible()
  }finally{partnerHeld=false;partnerFailed=false}
})

for(const mismatch of ['audience','source'])test(`a ${mismatch} mismatch cannot offer another ending’s download`,async({page})=>{
  await page.route(versionRead('new_contact'),route=>route.fulfill({json:{task:{...baseTask,
    taskId:'wrong-output',sourceTaskId:mismatch==='source'?'other-source':exportsId,
    audience:mismatch==='audience'?'existing_partner':'new_contact',status:'completed',stage:'self_check',renderId:'wrong',
  }}}))
  await page.goto(`${origin}/?task=${exportsId}&view=downloads&audience=new_contact`)
  const contact=version(page,'new_contact'), partner=version(page,'existing_partner')
  await expect(contact.tab).toContainText('读取状态失败')
  await expect(contact.panel.getByRole('link',{name:'下载成片',exact:true})).toHaveCount(0)
  await partner.tab.click()
  await expect(partner.panel.getByRole('link',{name:'下载成片',exact:true})).toBeVisible()
})

test('an explicitly unavailable version loses stale actions without hiding the other preview',async({page})=>{
  clientFailed=false
  held=false
  await page.clock.install()
  await page.goto(`${origin}/?task=${exportsId}&audience=existing_partner`)
  const partner=page.getByRole('tab',{name:/已合作达人版/})
  const contact=page.getByRole('tab',{name:/新建联达人版/})
  await expect(partner).toContainText('可下载')
  await expect(contact).toContainText('可以看片')
  await page.route(versionRead('existing_partner'),route=>route.fulfill({status:409,json:{reason:'output_unavailable'}}))
  await page.clock.fastForward(9000)
  await expect(partner).toContainText('读取状态失败')
  await expect(page.getByRole('tabpanel',{name:'已合作达人版'}).locator('video')).toHaveCount(0)
  await expect(page.getByRole('button',{name:'开始制作',exact:true})).toHaveCount(0)
  await contact.click()
  await expect(page.getByRole('tabpanel',{name:'新建联达人版'}).locator('video')).toHaveCount(1)
})

test('a disabled revision can keep its draft and submit only after readback recovers',async({page})=>{
  let unavailable=true
  await page.route(versionRead('new_contact'),route=>route.fulfill({json:{task:{...baseTask,
    taskId:`${exportsId}-new_contact`,sourceTaskId:exportsId,audience:'new_contact',status:'awaiting_review',stage:'self_check',
    renderId:'draft-contact',previewFeedbackUnavailable:unavailable,deliveryUnavailable:unavailable,canAcceptPreview:!unavailable,
  }}}))
  await page.clock.install()
  await page.goto(`${origin}/?task=${exportsId}&audience=new_contact`)
  const panel=page.getByRole('tabpanel',{name:'新建联达人版'})
  const opinion=panel.getByRole('textbox',{name:'修改意见'})
  await opinion.fill('缩短片尾留白')
  await panel.getByRole('radio',{name:'整体',exact:true}).check()
  await panel.getByLabel('这条意见针对整支视频').check()
  const submit=panel.getByRole('button',{name:'提交修改'})
  await expect(submit).toBeDisabled()
  unavailable=false
  await page.clock.fastForward(9000)
  await expect(opinion).toHaveValue('缩短片尾留白')
  await expect(submit).toBeEnabled()
})

test('a session rejection removes the previously authorized task workspace',async({page})=>{
  await page.clock.install()
  await page.goto(origin)
  const oldTask=page.getByRole('link',{name:'去审蓝图 · 短片甲'})
  await expect(oldTask).toBeVisible()
  await page.route(`**${endpoints}/tasks`,route=>route.fulfill({status:401,json:{error:'signed-out'}}))
  await page.clock.fastForward(6000)
  await expect(page.getByText('登录已失效，请刷新页面。')).toBeVisible()
  await expect(oldTask).toHaveCount(0)
})

test('a playable version stays selected when its slower sibling becomes available',async({page})=>{
  clientFailed=false
  await page.setViewportSize({width:320,height:640})
  let release!:()=>void
  let waiting=false
  const paused=new Promise<void>(resolve=>{release=resolve})
  await page.route(versionRead('existing_partner'),async route=>{
    waiting=true
    await paused
    await route.continue().catch(()=>{})
  })
  try{
    await page.goto(`${origin}/?task=${exportsId}&audience=new_contact`)
    const contact=page.getByRole('tab',{name:/新建联达人版/})
    const partner=page.getByRole('tab',{name:/已合作达人版/})
    await expect(contact).toHaveAttribute('aria-selected','true')
    expect(waiting).toBe(true)
    const player=await page.getByRole('tabpanel',{name:'新建联达人版'}).locator('video').boundingBox()
    const bar=await page.locator('.cm-action-bar:visible').boundingBox()
    expect(bar!.y+bar!.height).toBeLessThanOrEqual(640)
    expect(player!.width).toBeLessThanOrEqual(320)
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(320)
    release()
    await expect(partner).toContainText('可下载')
    await expect(contact).toHaveAttribute('aria-selected','true')
  }finally{release()}
})


async function capture(page:Page,name:string,size:string){
  if(!rawScreens)return
  await mkdir(rawScreens,{recursive:true})
  await page.evaluate(()=>document.fonts.ready.then(()=>undefined))
  await page.screenshot({path:join(rawScreens,`${name}-${size}.png`),animations:'disabled'})
}

test.describe('首页 · 三轮',()=>{
  test('桌面待办优先，制作中不重复，暂停默认折叠',async({page})=>{
    running=3
    await page.setViewportSize({width:1280,height:900})
    await page.goto(origin)
    const main=page.getByRole('main')
    await expect(main.getByRole('heading',{level:2}).first()).toHaveText(/^待你处理/)
    await expect(main.getByRole('link',{name:/去看片/})).toHaveCount(1)
    await expect(main.getByLabel('制作阶段')).toHaveCount(1)
    await expect(main.getByText('无需操作')).toBeVisible()
    await expect(main.getByText('暂停示例')).toBeHidden()

  })
  test('手机名额满了仍可选料，回收后新建恢复',async({page})=>{
    running=5
    await page.setViewportSize({width:390,height:844})
    await page.clock.install()
    await page.goto(origin)
    await expect(page.getByRole('button',{name:'新建任务'})).toBeDisabled()
    await expect(page.getByRole('link',{name:'先选素材'})).toBeVisible()
    running=3
    await page.clock.fastForward(6000)
    await expect(page.getByRole('link',{name:'新建任务'})).toBeVisible()
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(390)

  })
  test('空列表与读取失败有明确状态',async({page})=>{
    let fail=true
    await page.clock.install()
    await page.route(`**${endpoints}/tasks`,route=>fail
      ?route.fulfill({status:503,json:{}}):route.fulfill({json:{tasks:[],running:0,limit:5}}))
    await page.goto(origin)
    await expect(page.getByRole('alert')).toContainText('列表暂时没更新')
    fail=false
    await page.clock.fastForward(6000)
    await expect(page.getByRole('heading',{name:'还没有任务'})).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
  })
})

test.describe('蓝图 · 三轮',()=>{
  test('整体和分组入口默认收起，零意见可确认',async({page})=>{
    staleBoard=false
    await page.goto(`${origin}/?task=${a}`)
    await expect(page.getByRole('button',{name:'确认蓝图，开始制作'})).toBeEnabled()
    await expect(page.getByLabel('整体意见',{exact:true})).toBeHidden()
    await expect(page.frameLocator('iframe').getByRole('textbox',{name:'第 1 组意见'})).toBeHidden()
    await expect(page.getByRole('button',{name:'提交意见',exact:true})).toBeDisabled()
  })
  test('只提交填写过的组，整体清空仍能继续输入',async({page})=>{
    let sent:Record<string,unknown>|undefined
    await page.route(`**${endpoints}/production?projectId=${a}`,route=>{
      if(route.request().method()!=='POST')return route.continue()
      sent=route.request().postDataJSON()
      return route.fulfill({json:{accepted:true,notesSaved:true}})
    })
    await page.goto(`${origin}/?task=${a}`)
    await page.getByText('整体意见',{selector:'summary',exact:true}).click()
    const overall=page.getByLabel('整体意见',{exact:true})
    await overall.fill('临时文字')
    await overall.clear()
    await expect(overall).toBeVisible()
    const frame=page.frameLocator('iframe')
    await frame.getByText('第 1 组意见').click()
    await frame.getByRole('textbox',{name:'第 1 组意见'}).fill('只改这一组')
    await expect(page.getByRole('navigation',{name:'蓝图意见'}).getByRole('button',{name:'第 1 组'})).toBeVisible()
    await page.getByRole('button',{name:'提交意见',exact:true}).click()
    await expect.poll(()=>sent).toMatchObject({action:'revise_blueprint',blueprintOpinions:[{unitId:'group-1',text:'只改这一组'}]})
  })
  test('另一版已完成时，二次待审仍直达正确蓝图和步骤',async({page})=>{
    const task={...boardTasks.find(task=>task.id===exportsId)!,status:'blueprint',stage:'copy_review',
      outputs:[{audience:'existing_partner',status:'completed',stage:'self_check'},{audience:'new_contact',status:'blueprint',stage:'copy_review'}]}
    await page.route(`**${endpoints}/tasks`,route=>route.fulfill({json:{tasks:[task],running:0,limit:5}}))
    await page.route(versionRead('new_contact'),route=>route.fulfill({json:{task:{...baseTask,
      taskId:'reopened-board',sourceTaskId:exportsId,audience:'new_contact',status:'awaiting_blueprint',stage:'copy_review',
      blueprintRevision:exportsId,boardIdentity:exportsId,canApproveBlueprint:true,blueprintConfirmed:true,feedbackUsed:true,
    }}}))
    await page.goto(origin)
    await page.getByRole('link',{name:/去审蓝图 · 成片示例/}).click()
    await expect(page.getByRole('button',{name:'蓝图',exact:true})).toHaveAttribute('aria-current','page')
    await expect(page.getByRole('list',{name:'制作步骤'}).locator('[aria-current=step] span')).toHaveText('审蓝图')
    await expect(page.frameLocator('iframe').getByText('蓝图示例')).toBeVisible()
    await expect(page.getByRole('button',{name:'确认蓝图，开始制作'})).toBeEnabled()
  })
})

test.describe('任务详情 · 三轮',()=>{
  test('桌面四步骤与三标签，成片仅加载所选版本',async({page})=>{
    await page.setViewportSize({width:1280,height:900})
    await page.goto(`${origin}/?task=${exportsId}&audience=new_contact`)
    await expect(page.getByRole('list',{name:'制作步骤'}).locator('li span')).toHaveText(['交素材','审蓝图','看片提意见','拿成片'])
    await expect(page.getByRole('navigation',{name:'任务详情'}).getByRole('button')).toHaveText(['素材','蓝图','成片'])
    await expect(page.getByRole('tabpanel',{name:'新建联达人版'}).locator('video')).toBeVisible()
    await expect(page.locator('video')).toHaveCount(1)

  })
  test('已暂停和已确认的入口分别打开各自版本',async({page})=>{
    await page.goto(origin)
    const inactive=page.locator('.cm-task-inactive')
    await inactive.locator('summary').click()
    await expect(inactive.getByText('停在「剪辑」',{exact:false})).toBeVisible()
    await inactive.getByRole('link',{name:'查看原因',exact:true}).click()
    await expect(version(page,'new_contact').tab).toHaveAttribute('aria-selected','true')
    await expect(version(page,'new_contact').panel.getByText('查看原因')).toBeVisible()
    await expect(version(page,'new_contact').panel.getByRole('button',{name:/继续/})).toHaveCount(0)
    await version(page,'existing_partner').tab.click()
    await expect(version(page,'existing_partner').panel.getByRole('link',{name:'下载成片',exact:true})).toBeVisible()
  })
  test('手机切标签及版本保留本版意见',async({page})=>{
    await page.setViewportSize({width:390,height:844})
    await page.goto(`${origin}/?task=${exportsId}&audience=new_contact`)
    const contact=version(page,'new_contact')
    const opinion=contact.panel.getByRole('textbox',{name:'修改意见'})
    await expect(opinion).toBeVisible()

    await opinion.fill('只留给新建联版')
    await page.getByRole('button',{name:'素材',exact:true}).click()
    await expect(page.getByRole('region',{name:'制作素材'}).locator('li')).toHaveCount(4)
    await page.getByRole('button',{name:'成片',exact:true}).click()
    await expect(opinion).toHaveValue('只留给新建联版')
    await version(page,'existing_partner').tab.click()
    await expect(version(page,'existing_partner').panel.getByRole('textbox',{name:'修改意见'})).toHaveCount(0)
    await contact.tab.click()
    await expect(opinion).toHaveValue('只留给新建联版')
  })
})

test.describe('预览 · 三轮',()=>{
  test('复核暂停仍从可以看片说起，提前下载为次要动作',async({page})=>{
    await page.setViewportSize({width:1280,height:900})
    await page.goto(`${origin}/?task=${exportsId}&view=film&audience=new_contact`)
    const contact=version(page,'new_contact')
    await expect(contact.panel.locator('.cm-review-summary p').first()).toHaveText(/^可以看片/)
    await expect(contact.panel.getByRole('button',{name:'确认成片',exact:true})).toBeDisabled()
    await expect(contact.panel.getByRole('link',{name:'先下未复核版'})).toHaveClass(/secondary/)
    await expect(contact.panel.getByRole('link',{name:'下载成片',exact:true})).toHaveCount(0)

  })
  test('窄屏和横向平板的播放器与底部操作条不重叠',async({page})=>{
    for(const [width,height] of [[320,640],[390,844],[768,900]]){
      await page.setViewportSize({width,height})
      await page.goto(`${origin}/?task=${exportsId}&view=film&audience=new_contact`)
      const contact=version(page,'new_contact')
      const player=contact.panel.locator('video')
      const bar=contact.panel.locator('.cm-action-bar')
      await expect(player).toBeVisible()
      await expect(bar.getByRole('button',{name:'确认成片',exact:true})).toBeInViewport()
      const videoBox=await player.boundingBox(),barBox=await bar.boundingBox()
      expect(videoBox!.y+videoBox!.height).toBeLessThanOrEqual(barBox!.y)
      expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width)

    }
  })
  test('独立手机预览的底栏符合稿件高度，完整显示提意见入口',async({page})=>{
    visualCase=true
    try{
      for(const [width,height] of [[390,844],[360,780],[320,640]]){
        await page.setViewportSize({width,height})
        await page.goto(standaloneOrigin)
        const bar=page.locator('.cm-action-bar:visible')
        const entry=page.getByRole('button',{name:'在这里提意见'})
        await expect(entry).toBeEnabled()
        const confirm=bar.getByRole('button',{name:'确认并下载成片',exact:true})
        await expect(confirm).toBeDisabled()
        const barBox=(await bar.boundingBox())!
        expect(barBox.y+barBox.height).toBeCloseTo(height,1)
        if(width===390)expect(barBox.height).toBeCloseTo(122.58,1)
        for(const button of await bar.getByRole('button').all()){
          expect(await button.evaluate(element=>{
            const range=document.createRange()
            range.selectNodeContents(element)
            return range.getClientRects().length
          })).toBe(1)
        }
        await expect.poll(async()=>{
          const [playerBox,entryBox,footerBox]=await Promise.all([
            page.locator('video').boundingBox(),entry.boundingBox(),bar.boundingBox(),
          ])
          return !!playerBox&&!!entryBox&&!!footerBox&&playerBox.y+playerBox.height<=entryBox.y
            &&entryBox.y+entryBox.height<=footerBox.y
        }).toBe(true)
        expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width)
        await entry.click()
        await expect(page.getByLabel('开始（秒）')).toHaveValue('0')
        await expect(page.getByLabel('结束（秒）')).toHaveValue('')
      }
    }finally{visualCase=false}
  })
  test('当前时间只填开始，失败读回不开放确认',async({page})=>{
    await page.goto(`${origin}/?task=${exportsId}&audience=new_contact`)
    const contact=version(page,'new_contact')
    const start=contact.panel.getByRole('button',{name:'在这里提意见'})
    await expect(start).toBeEnabled()
    await start.click()
    await expect(contact.panel.getByLabel('开始（秒）')).toHaveValue('0')
    await expect(contact.panel.getByLabel('结束（秒）')).toHaveValue('')
    await expect(contact.panel.getByRole('button',{name:'提交修改'})).toBeDisabled()
    await expect(contact.panel.getByRole('button',{name:'确认成片',exact:true})).toBeDisabled()
  })
})

// Each run starts at Home and ends with a bound download in the same task.
for(const [scenario,width,height] of [['常规',1280,900],['复核暂停',390,844],['跨任务草稿',320,640]] as const){
  test(`完整任务流程 · ${scenario}`,async({page})=>{
    running=3
    await page.setViewportSize({width,height})
    await page.goto(origin)
    await page.getByRole('link',{name:'新建任务'}).click()
    const name='流程验收 '+scenario
    await page.getByLabel('任务名称（选填）').fill(name)
    await page.getByLabel('爆款原片',{exact:true}).setInputFiles(source)
    for(const label of ['商品图','销量截图','合作海报'])await page.getByLabel(label,{exact:true}).setInputFiles({...image,name:label+'.png'})
    await page.getByRole('button',{name:'开始制作',exact:true}).click()
    await expect(page.getByRole('heading',{level:1,name})).toBeVisible()
    const id=new URL(page.url()).searchParams.get('task')!
    await expect(page.getByRole('list',{name:'制作步骤'}).locator('li span')).toHaveText(['交素材','审蓝图','看片提意见','拿成片'])
    const approve=page.getByRole('button',{name:'确认蓝图，开始制作'})
    await expect(approve).toBeEnabled()
    await page.getByRole('button',{name:'素材',exact:true}).click()
    await expect(page.getByRole('region',{name:'制作素材'}).locator('li')).toHaveCount(4)
    // Reload the task without a pinned tab before continuing its normal phase progression.
    await page.goto(`${origin}/?task=${id}`)
    await expect(approve).toBeEnabled()
    await approve.click()
    await expect(page.getByRole('button',{name:'成片',exact:true})).toHaveAttribute('aria-current','page')
    const summary=page.locator('.cm-review-summary')
    await expect(summary.locator('p').first()).toContainText(/^可以看片/)
    const confirm=page.getByRole('button',{name:'确认成片',exact:true})
    await expect(confirm).toBeDisabled()
    const feedback=page.getByRole('textbox',{name:'修改意见'})
    const submit=page.getByRole('button',{name:'提交修改'})
    await feedback.fill('只调整选中的画面')
    if(scenario==='复核暂停'){
      await expect(summary).toContainText('复核已暂停')
      const download=page.waitForEvent('download')
      await page.getByRole('link',{name:/先下未复核版/}).click()
      expect((await download).suggestedFilename()).toMatch(/^未复核_/u)
      await page.getByRole('button',{name:'在这里提意见'}).click()
      await expect(page.getByLabel('开始（秒）')).toHaveValue(/^[0-9.]+$/)
      await expect(page.getByLabel('结束（秒）')).toHaveValue('')
      await page.getByLabel('结束（秒）').fill('2')
      await expect(page.getByText('时间段不能超出视频时长。')).toBeVisible()
      await expect(submit).toBeDisabled()
      flows.get(id)!.pending=false
      await page.reload()
      await expect(feedback).toHaveValue('只调整选中的画面')
      await page.getByLabel('结束（秒）').fill('0.5')
    }else{
      await page.getByRole('radio',{name:'第 1 组',exact:true}).check()
      if(scenario==='跨任务草稿'){
        const switchTasks=page.getByRole('combobox',{name:'切换任务'})
        const open=page.getByRole('button',{name:'打开所选任务'})
        await switchTasks.selectOption(a);await open.click()
        await expect(page.getByRole('button',{name:'确认蓝图，开始制作'})).toBeEnabled()
        await switchTasks.selectOption(id);await open.click()
        await expect(feedback).toHaveValue('只调整选中的画面')
        await expect(page.getByRole('radio',{name:'第 1 组',exact:true})).toBeChecked()
      }
    }
    await expect(submit).toBeEnabled()
    await submit.click()
    await expect(page.getByRole('region',{name:'本版对照与当前状态'})).toContainText('改后的预览已生成')
    await expect(confirm).toBeDisabled()
    await page.getByLabel('我已看过成片').check()
    await page.getByLabel('我已核对口播和字幕').check()
    const url=page.url()
    await confirm.click()
    const ready=page.getByRole('link',{name:'下载成片',exact:true})
    await expect(ready).toHaveAttribute('href',/view=panel_download.*renderId=cut-2/)
    await expect(page).toHaveURL(url)
    const download=page.waitForEvent('download')
    await ready.click()
    expect((await download).suggestedFilename()).toBe('reviewed.mp4')
    const writes=flowPosts.get(id)!
    expect(writes.map(write=>write.action)).toEqual(['start','approve_blueprint','revise_preview','accept'])
    expect(writes[2].feedbackTarget).toEqual(scenario==='复核暂停'?{scope:'range',start:0,end:0.5}:{scope:'group',unitId:'group-1',kind:'content'})
    expect(writes[3].renderId).toBe('cut-2')
  })
}


// Capture equivalent data and the two actual entry surfaces for the design review.
if(rawScreens)test('captures matched workspace and direct preview viewports',async({page})=>{
  visualCase=true
  running=3
  try{
    for(const [size,width,height] of [['desktop',1280,900],['mobile',390,844]] as const){
      await page.setViewportSize({width,height})
      for(const [name,url] of [
        ['home',origin],['detail',`${origin}/?task=${exportsId}&audience=existing_partner`],['preview',standaloneOrigin],
      ]){
        await page.goto(url)
        if(name==='home')await expect(page.getByRole('heading',{name:'任务',exact:true})).toBeVisible()
        else{
          const surface=name==='detail'?version(page,'existing_partner').panel:page
          await expect(surface.locator('video')).toBeVisible()
          await expect(surface.getByRole('button',{name:'在这里提意见'})).toBeEnabled()
          await surface.getByRole('radio',{name:'第 2 组',exact:true}).check()
          await surface.getByRole('textbox',{name:'修改意见'}).fill('缩短这一组的原片等候。')
          if(visualVideo){
            await surface.locator('video').evaluate((video:HTMLVideoElement)=>{video.currentTime=34})
            await expect(surface.getByRole('button',{name:'在这里提意见'})).toContainText('0:34')
          }
          await page.evaluate(()=>{
            if(document.activeElement instanceof HTMLElement)document.activeElement.blur()
            window.scrollTo(0,0)
          })
          await expect(surface.getByRole('button',{name:/^确认(?:并下载)?成片$/})).toBeDisabled()
          if(name==='detail')await expect(page.getByRole('heading',{name:'新建联达人版 · 已暂停'})).toBeVisible()
          else await expect(page.getByRole('heading',{name:'看片并确认'})).toBeVisible()
        }
        await capture(page,name,size)
        const geometry=await page.evaluate(selectors=>Object.fromEntries(selectors.map(selector=>{
          const elements=[...document.querySelectorAll(selector)]
          const visible=elements.find(element=>element.getBoundingClientRect().width>0)
          if(!visible)return [selector,null]
          const {x,y,width,height}=visible.getBoundingClientRect()
          return [selector,{x,y,width,height}]
        })),['h1','.cm-task-sidebar','.cm-task-attention ul','.cm-task-detail-nav','.cm-preview-tabs','.cm-preview-media video','.cm-review-summary','.cm-action-bar'])
        await writeFile(join(rawScreens,`${name}-${size}-geometry.json`),JSON.stringify(geometry))
      }
    }
  }finally{visualCase=false}
})
