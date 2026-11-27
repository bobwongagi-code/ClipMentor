import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { preview } from 'vite'

const endpoints = '/workspace-api'
const a='board-a', b='board-b', exportsId='outputs'
const outputs=[{audience:'existing_partner'},{audience:'new_contact'}]
const boardTasks=[
  {id:a,name:'短片甲',status:'blueprint',updatedAt:4,stage:'copy_review',outputs:[]},
  {id:b,name:'短片乙',status:'blueprint',updatedAt:3,stage:'copy_review',outputs:[]},
  {id:exportsId,name:'交付夹具',status:'preview',updatedAt:2,stage:'self_check',outputs},
]
const assets=['source.webm','product.png','sales.png','cta.png'].map((name,id)=>({name,id:String(id)}))
const baseTask={sequence:1,active:false,feedbackUsed:false}
const versionRead=(audience:string)=>(url:URL)=>url.pathname===`${endpoints}/production`
  &&!url.searchParams.has('view')&&url.searchParams.get('audience')===audience
const image={name:'test.png',mimeType:'image/png',
  buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jH1sAAAAASUVORK5CYII=','base64')}
const source=fileURLToPath(new URL('../fixtures/preflight.webm',import.meta.url))
let path:string, origin:string
let server:Awaited<ReturnType<typeof preview>>
let running=5, held=false, clientFailed=false, staleBoard=false
let partnerHeld=false, partnerFailed=false
const created=new Map<string,string>()
const uploaded=new Set<string>()
const calls:Array<{route:string;projectId:string|null}> = []

test.beforeAll(async ()=>{
  path=await mkdtemp(join(tmpdir(),'clipmentor-workspace-web-'))
  execFileSync(process.execPath,['node_modules/vite/bin/vite.js','build','--outDir',path,'--emptyOutDir'],{
    env:{...process.env,NODE_ENV:'production',CLIPMENTOR_PUBLIC_WORKSPACE:'1',CLIPMENTOR_PUBLIC_API_BASE_PATH:endpoints},stdio:'pipe',
  })
  server=await preview({configFile:false,build:{outDir:path},preview:{host:'127.0.0.1',port:0},plugins:[{
    name:'clip-workspace-fixture',
    configurePreviewServer(vite){
      vite.middlewares.use(endpoints,async(req,res)=>{
        const url=new URL(req.url??'/', 'http://localhost')
        const view=url.searchParams.get('view')??'panel'
        const id=url.searchParams.get('projectId')
        const audience=url.searchParams.get('audience')
        const send=(status:number,body:unknown)=>res.writeHead(status,{'Content-Type':'application/json'}).end(JSON.stringify(body))
        calls.push({route:`${req.method} ${url.pathname} ${view}`,projectId:id})
        if(url.pathname==='/tasks'){
          if(req.method==='POST'){
            const parts:Buffer[]=[]
            for await(const part of req)parts.push(part)
            const {id,name}=JSON.parse(Buffer.concat(parts).toString())
            created.set(id,name)
            send(201,{id,name});return
          }
          send(200,{running,limit:5,tasks:[...boardTasks,...Array.from(created,([id,name])=>({id,name,status:'materials',updatedAt:1,outputs:[]}))]});return
        }
        if(id!==a&&id!==b&&id!==exportsId&&(!id||!created.has(id))){send(404,{});return}
        if(url.pathname==='/intake'){
          if(req.method==='POST'){
            for await(const _chunk of req){ /* Drain the fixture request. */ }
            uploaded.add(id)
            send(200,{projectId:id,assets});return
          }
          send(200,uploaded.has(id)||!created.has(id)?{receipt:{projectId:id,assets}}:{});return
        }
        if(url.pathname!=='/production'){send(404,{});return}
        if(req.method==='POST'){send(409,{reason:'capacity'});return}
        if(view==='panel_board'){
          const identity=staleBoard&&id===a?'changed-a':id
          res.writeHead(200,{'Content-Type':'text/html','X-ClipMentor-Board-Identity':identity}).end(
            `<h2>蓝图夹具</h2><details><summary>第 1 组意见</summary><textarea aria-label="第 1 组意见" data-blueprint-opinion="group-1"></textarea></details>
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
        if(view==='panel_draft_download'||view==='panel_download'){
          const expected=view==='panel_draft_download'?'draft-contact':'ready-partner'
          if(url.searchParams.get('renderId')!==expected||view==='panel_draft_download'&&held){send(409,{});return}
          res.writeHead(200,{'Content-Type':'video/mp4','Content-Disposition':`attachment; filename="${expected}.mp4"`}).end('fixture');return
        }
        if(view==='panel_poster'){
          res.writeHead(200,{'Content-Type':'image/png'}).end(image.buffer);return
        }
        if(id===a||id===b){
          const identity=staleBoard&&id===a?'changed-a':id
          send(200,{task:{...baseTask,taskId:id,status:'awaiting_blueprint',stage:'copy_review',blueprintRevision:identity,
            boardIdentity:identity,dualBlueprint:true,canConfirmBlueprint:true,reviewGroups:[{id:'group-1',label:'第 1 组'}]}});return
        }
        if(id===exportsId){
          if(!audience){send(200,{task:null,outputs,outputOwner:{taskId:id,sequence:1}});return}
          if(audience==='new_contact'&&clientFailed){send(503,{});return}
          if(audience==='existing_partner'&&partnerFailed){send(503,{});return}
          send(200,{task:{...baseTask,taskId:`${id}-${audience}`,audience,stage:'self_check',blueprintConfirmed:true,previewDuration:28,
            ...(audience==='new_contact'?{status:'blocked',previewPending:true,deliveryHeld:held,renderId:'draft-contact',
              materialAttachment:{assetId:'cta',label:'CTA 海报'}}:
              {status:'completed',previewReviewed:true,deliveryHeld:partnerHeld,renderId:'ready-partner',confirmedAt:1770000000000,downloadName:'saved.mp4',
                attachments:[{assetId:'board-pdf',fileName:'board.pdf'}]})}});return
        }
        send(200,{task:null})
      })
    },
  }]})
  const address=server.httpServer.address()
  if(!address||typeof address==='string')throw Error('Fixture port unavailable')
  origin=`http://127.0.0.1:${address.port}`
})
test.afterAll(async()=>{
  await new Promise<void>(resolve=>server?server.httpServer.close(()=>resolve()):resolve())
  if(path)await rm(path,{recursive:true,force:true})
})

test('homepage and upload disclose a lost slot and retain the four saved assets',async({page})=>{
  await page.goto(origin)
  await expect(page.getByText('5 / 5')).toBeVisible()
  await page.getByRole('link',{name:'新建任务'}).click()
  await expect(page.getByText('名额已满，可以先选好素材。')).toBeVisible()
  await page.getByLabel('任务名称（选填）').fill('上传竞争')
  await page.getByLabel('爆款原片',{exact:true}).setInputFiles(source)
  for(const label of ['商品图','销量截图','CTA 行动号召图']){
    await page.getByLabel(label,{exact:true}).setInputFiles({...image,name:`${label}.png`})
  }
  await expect(page.getByRole('button',{name:'等待运行名额'})).toBeDisabled()
  expect(calls.filter(call=>call.route.startsWith('POST'))).toHaveLength(0)
  running=4
  const start=page.getByRole('button',{name:'开始制作'})
  await expect(start).toBeEnabled({timeout:8000})
  await start.click()
  await expect(page.getByText('素材已保存。名额空出后，点「开始制作」。')).toBeVisible()
  await expect(page.getByText('四份素材均已保存到当前工程。')).toBeVisible()
  expect(calls.filter(call=>call.route.startsWith('POST')).map(call=>call.route)).toEqual([
    'POST /tasks panel','POST /intake panel','POST /production panel',
  ])
})

test('task switching isolates local opinions and a superseded board cannot inherit them',async({page})=>{
  await page.setViewportSize({width:360,height:780})
  await page.goto(`${origin}/?task=${a}`)
  const overall=page.getByRole('textbox',{name:'整体意见'})
  await overall.fill('只留在短片甲')
  const group=page.frameLocator('iframe[title="人审版蓝图"]')
  await group.getByText('第 1 组意见').click()
  await group.getByRole('textbox',{name:'第 1 组意见'}).fill('本组草稿')
  const switchTasks=page.getByRole('combobox',{name:'切换任务'})
  await switchTasks.selectOption(b)
  await expect(overall).toHaveValue('')
  await switchTasks.selectOption(a)
  await expect(overall).toHaveValue('只留在短片甲')
  await expect(group.getByRole('textbox',{name:'第 1 组意见'})).toHaveValue('本组草稿')
  staleBoard=true
  await page.reload()
  await expect(overall).toHaveValue('')
  await page.goto(`${origin}/?task=does-not-exist`)
  await expect(page.getByRole('heading',{name:'找不到这个任务'})).toBeVisible()
  expect(calls.some(call=>call.projectId==='does-not-exist')).toBe(false)
})

test('download eligibility is isolated by version and the pending card links to its own preview',async({page})=>{
  const route=`${origin}/?task=${exportsId}&view=downloads`
  await page.goto(route)
  const clip=(title:string)=>page.getByRole('article').filter({has:page.getByRole('heading',{name:title})})
  const partner=clip('已合作达人版'), contact=clip('新建联达人版')
  await expect(partner.getByRole('link',{name:'下载成片'})).toHaveAttribute('href',/renderId=ready-partner.*audience=existing_partner.*projectId=outputs/)
  await expect(partner.locator('img')).toHaveAttribute('src',/view=panel_poster.*renderId=ready-partner/)
  await expect(contact.locator('img')).toHaveAttribute('src',/view=panel_poster.*renderId=draft-contact/)
  await expect(contact.getByRole('link',{name:'下载成片'})).toHaveCount(0)
  await expect(contact.getByRole('link',{name:'去看片'})).toHaveAttribute('href',/task=outputs&audience=new_contact/)
  await contact.getByText('需要先下载一份？').click()
  await expect(contact.getByRole('link',{name:'下载未复核版本'})).toHaveAttribute('href',/view=panel_draft_download.*renderId=draft-contact/)
  await contact.getByRole('link',{name:'去看片'}).click()
  await expect(page.getByRole('tab',{name:/新建联达人版/})).toHaveAttribute('aria-selected','true')
  held=true
  await page.goto(route)
  await expect(contact.getByText(/可看片，需修改/)).toBeVisible()
  await expect(contact.getByRole('link',{name:'去看片'})).toBeVisible()
  await expect(contact.getByText('需要先下载一份？')).toHaveCount(0)
  clientFailed=true
  await page.reload()
  await expect(contact.getByText('暂不可下载')).toBeVisible()
  await expect(partner.getByRole('link',{name:'下载成片'})).toBeVisible()
})

test('one pending audience request does not delay a second version or change its download authority',async({page})=>{
  const partner=page.getByRole('article').filter({has:page.getByRole('heading',{name:'已合作达人版'})})
  const contact=page.getByRole('article').filter({has:page.getByRole('heading',{name:'新建联达人版'})})
  let release!:()=>void
  const paused=new Promise<void>(resolve=>{release=resolve})
  const gate=versionRead('new_contact')
  await page.route(gate,async route=>{await paused;await route.continue().catch(()=>{})})
  try{
    await page.goto(`${origin}/?task=${exportsId}&view=downloads`)
    await expect(contact.getByText('正在读取下载状态…')).toBeVisible()
    await expect(partner.getByRole('link',{name:'下载成片'})).toBeVisible()
  }finally{release()}
  await page.unroute(gate)
  partnerHeld=true
  clientFailed=false
  try{
    await page.reload()
    await expect(partner.getByRole('link',{name:'下载成片'})).toHaveCount(0)
    await expect(partner.getByRole('link',{name:'去看片'})).toBeVisible()
    partnerFailed=true
    await contact.getByRole('link',{name:'去看片'}).click()
    await expect(page.getByRole('tab',{name:/新建联达人版/})).toHaveAttribute('aria-selected','true')
    await expect(page.getByRole('tabpanel',{name:'新建联达人版'}).locator('video')).toHaveCount(1)
  }finally{partnerHeld=false;partnerFailed=false;held=false}
})

test('a session rejection removes the previously authorized task workspace',async({page})=>{
  await page.clock.install()
  await page.goto(origin)
  const oldTask=page.getByRole('link',{name:'打开 短片甲'})
  await expect(oldTask).toBeVisible()
  await page.route(`**${endpoints}/tasks`,route=>route.fulfill({status:401,json:{error:'signed-out'}}))
  await page.clock.fastForward(6000)
  await expect(page.getByText('任务列表访问已失效，请刷新页面。')).toBeVisible()
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
    await page.goto(`${origin}/?task=${exportsId}`)
    const contact=page.getByRole('tab',{name:/新建联达人版/})
    const partner=page.getByRole('tab',{name:/已合作达人版/})
    await expect(contact).toHaveAttribute('aria-selected','true')
    expect(waiting).toBe(true)
    const player=await page.getByRole('tabpanel',{name:'新建联达人版'}).locator('video').boundingBox()
    expect(player!.y+player!.height).toBeLessThanOrEqual(640)
    release()
    await expect(partner).toContainText('可下载')
    await expect(contact).toHaveAttribute('aria-selected','true')
  }finally{release()}
})
