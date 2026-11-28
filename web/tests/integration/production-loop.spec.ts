import {checkFinalReview} from '../review-controls'
import { test, expect } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

async function stopFixtureServer(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  async function wait(milliseconds: number) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([exited.then(() => true), new Promise<boolean>(resolve => { timer=setTimeout(() => resolve(false),milliseconds) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
  child.kill('SIGTERM')
  if (await wait(3000)) return
  child.kill('SIGKILL')
  if (!await wait(3000)) throw new Error('Fixture server did not exit; isolated profile retained to avoid deleting files while they are being written')
}

// Runs the production panel HTTP handler and persistent store. Only the worker and
// reviewer are deterministic local fixture replays. This is not a new Agent production run.
test('web feedback, new board, guarded confirmation, two outputs and bound download through actual handlers', async ({ page }, info) => {
  test.setTimeout(150_000)
  const sourceRoot = resolve(process.env.CLIPMENTOR_TEST_SOURCE_ROOT!)
  const root = await mkdtemp(join(tmpdir(), 'cm-web-loop-'))
  const proof = process.env.CLIPMENTOR_WEB_TEST_ARTIFACTS || info.outputPath('proof')
  await mkdir(proof, { recursive: true })
  let child: ChildProcess | undefined
  let logs = '', origin = ''
  let holdPraiseReadback = false
  const praiseReadback = Promise.withResolvers<void>()
  const blocked: string[] = [], forwarded: string[] = []
  try {
    child = spawn(process.execPath, ['--import', 'tsx', join(sourceRoot, 'server/clipmentor/production-web-loop.test-server.ts')], {
      cwd: sourceRoot, env: { ...process.env, CLIPMENTOR_WEB_TEST_DATA: root, CLIPMENTOR_WEB_TEST_HOLD_PREVIEWS:'1' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout!.on('data', bytes => { logs += String(bytes) })
    child.stderr!.on('data', bytes => { logs += String(bytes) })
    await expect.poll(() => {
      const ready = logs.split('\n').find(line => line.startsWith('{"ready":true'))
      if (ready) origin = JSON.parse(ready).origin
      return !!origin
    }, { timeout: 30_000, message: 'Isolated fixture server must start; inspect server.log on failure' }).toBe(true)

    // The test server serves the actual page via a GET-only static proxy and handles
    // business requests itself. This also covers browser downloads, which may bypass
    // Playwright route.fetch. Unknown API paths and POSTs stay away from the frontend proxy and live backends.
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url())
      if (url.origin !== origin) { blocked.push(`${request.method()} ${request.url()}`); await route.abort(); return }
      if (url.pathname.startsWith('/api/')) forwarded.push(`${request.method()} ${url.pathname}${url.search}`)
      if(url.pathname==='/api/clipmentor/production'&&!url.search){
        if(request.method()==='POST'&&request.postDataJSON()?.blueprintOpinions?.some((entry:{text:string})=>entry.text==='这组很好'))holdPraiseReadback=true
        if(request.method()==='GET'&&holdPraiseReadback)await praiseReadback.promise
      }
      await route.continue()
    })
    const state = async () => await (await fetch(origin + '/api/clipmentor/production')).json()
    const audit = async () => await (await fetch(origin + '/audit')).json()
    await page.setViewportSize({ width: 1200, height: 900 })
    await page.goto(origin)
    const inputs=(await audit()).inputs
    for(const [label,key] of [['爆款原片','source'],['商品图','product'],['销量截图','sales'],['合作海报','cta']]){
      await page.getByLabel(label,{exact:true}).setInputFiles(inputs[key])
    }
    await page.getByRole('button',{name:'上传素材'}).click()
    await expect(page.frameLocator('iframe').locator('body')).toContainText('剪辑蓝图',{timeout:30_000})
    const firstRevision = (await state()).task.blueprintRevision
    // Two tabs can render the same draft revision against different requirements.
    // The first tab's confirmation must never bind to the second tab's newer cache.
    const rawScreens=process.env.CLIPMENTOR_V2_RAW_DIR
    if(rawScreens){
      await mkdir(rawScreens,{recursive:true})
      const frame=page.frameLocator('iframe')
      for(const [size,width,height] of [['desktop',1280,900],['mobile',390,844]] as const){
        await page.setViewportSize({width,height})
        await page.screenshot({path:join(rawScreens,`blueprint-${size}.png`),animations:'disabled'})
        const geometry=await page.evaluate(selectors=>Object.fromEntries(selectors.map(selector=>{
          const {x,y,width,height}=document.querySelector(selector)!.getBoundingClientRect()
          return [selector,{x,y,width,height}]
        })),['h1','.cm-blueprint-opinion-nav','.cm-action-bar'])
        await writeFile(join(rawScreens,`blueprint-${size}-geometry.json`),JSON.stringify(geometry))
      }
      const img=frame.locator('.source-strip button').first()
      await img.click()
      const zoom=frame.getByRole('dialog')
      await expect(zoom).toBeInViewport()
      await zoom.getByRole('button',{name:'关闭'}).click()
      await expect(zoom).toBeHidden()
      await page.evaluate(()=>window.scrollTo(0,0))
      await page.setViewportSize({width:1200,height:900})
    }
    const firstBoard=(await state()).task
    expect(firstBoard.boardIdentity).toMatch(/^[a-f0-9]{64}$/)
    // The task and its review board must survive loss of an exact upload.
    const readIntake = async () => (await fetch(origin + '/api/clipmentor/intake', {
      headers: { 'sec-fetch-site': 'same-origin' },
    })).json()
    const savedIntake = (await readIntake()).receipt
    const uploadDir = join(root, 'media/uploads')
    const ctaBytes = await readFile(inputs.cta)
    const registeredCopies: string[] = []
    for (const name of await readdir(uploadDir)) {
      if (name.startsWith('clipmentor-intake-') && name.endsWith('.png')
        && (await readFile(join(uploadDir, name))).equals(ctaBytes)) registeredCopies.push(name)
    }
    expect(registeredCopies).toHaveLength(1)
    const ctaCopy = join(uploadDir, registeredCopies[0])
    await rm(ctaCopy)
    await page.reload()
    await expect(page.getByRole('heading', { name: '补传缺少的素材' })).toBeVisible()
    await expect(page.frameLocator('iframe').locator('body')).toContainText('剪辑蓝图', { timeout: 30_000 })
    await page.getByLabel('合作海报', { exact: true }).setInputFiles(inputs.cta)
    await page.getByRole('button', { name: '补传素材' }).click()
    await expect(page.getByRole('heading', { name: '补传缺少的素材' })).toHaveCount(0)
    await expect(page.frameLocator('iframe').locator('body')).toContainText('剪辑蓝图', { timeout: 30_000 })
    expect(await readFile(ctaCopy)).toEqual(ctaBytes)
    expect((await readIntake()).receipt).toEqual(savedIntake)
    expect((await state()).task).toMatchObject({
      taskId: firstBoard.taskId, blueprintRevision: firstRevision,
      boardIdentity: firstBoard.boardIdentity, sequence: firstBoard.sequence,
    })
    expect((await audit()).workerEvents).toHaveLength(0)
    const requirements=async(enabled:boolean)=>fetch(origin+'/api/clipmentor/fixture-requirements',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled})})
    expect((await requirements(true)).status).toBe(200)
    const secondBoard=(await state()).task
    expect(secondBoard.blueprintRevision).toBe(firstBoard.blueprintRevision)
    expect(secondBoard.boardIdentity).not.toBe(firstBoard.boardIdentity)
    const newerBoard=await fetch(origin+'/api/clipmentor/production?'+new URLSearchParams({view:'panel_board',revision:firstRevision,boardIdentity:secondBoard.boardIdentity}))
    expect(newerBoard.status).toBe(200)
    expect(newerBoard.headers.get('X-ClipMentor-Board-Identity')).toBe(secondBoard.boardIdentity)
    const staleBoard=await fetch(origin+'/api/clipmentor/production',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'revise_blueprint',text:'must not apply feedback from an old board',revision:firstRevision,boardIdentity:firstBoard.boardIdentity})})
    expect(staleBoard.status).toBe(409)
    expect((await staleBoard.json()).reason).toBe('review_board_changed')
    expect((await state()).task.sequence).toBe(firstBoard.sequence)
    expect((await requirements(false)).status).toBe(200)
    await page.reload()
    const blueprint=page.frameLocator('iframe')
    await expect(blueprint.locator('body')).toContainText('剪辑蓝图', { timeout: 30_000 })
    await expect.poll(async()=>{
      const outer=await page.locator('iframe').evaluate(node=>node.clientHeight)
      const content=await blueprint.locator('main').evaluate(node=>Math.ceil(node.getBoundingClientRect().height))
      return outer-content
    }).toBe(0)
    const groupOpinion=blueprint.getByRole('textbox', { name:'第 1 组意见' })
    const overallOpinion=page.getByRole('textbox', { name:'整体意见' })
    const opinionNav=page.getByRole('navigation',{name:'蓝图意见'})
    await expect(opinionNav.getByText('已填写')).toHaveCount(0)
    await opinionNav.getByRole('link',{name:'填写整体意见'}).click()
    await expect(overallOpinion).toBeInViewport()
    await expect(groupOpinion).toBeHidden()
    await blueprint.locator('[data-card="group-1"] .group-opinion summary').click()
    await overallOpinion.fill('改'.repeat(4000))
    await groupOpinion.fill('补'.repeat(4000))
    await expect(opinionNav.getByRole('link',{name:'整体',exact:true})).toBeVisible()
    await blueprint.locator('[data-card="group-1"] .group-opinion summary').click()
    await opinionNav.getByRole('button',{name:'第 1 组',exact:true}).click()
    await expect(groupOpinion).toBeFocused()
    await expect(groupOpinion).toHaveValue('补'.repeat(4000))
    await page.getByRole('button', { name:'提交意见' }).click()
    await expect(page.getByText('意见太长，请删减后再提交。')).toBeVisible()
    expect((await audit()).workerEvents).toHaveLength(0)
    const longOverall='改'.repeat(3000)
    const longMisplaced='整体'+'补'.repeat(3000)
    await overallOpinion.fill(longOverall)
    await groupOpinion.fill(longMisplaced)
    await page.getByRole('button', { name:'提交意见' }).click()
    await expect(page.getByText('要把这条意见移到整体意见吗？')).toBeVisible()
    await page.getByRole('button', { name:'移动', exact:true }).click()
    await expect(page.getByText('合并后意见太长，请缩短后再移动。')).toBeVisible()
    await expect(overallOpinion).toHaveValue(longOverall)
    await expect(groupOpinion).toHaveValue(longMisplaced)
    expect((await audit()).workerEvents).toHaveLength(0)
    await overallOpinion.clear()
    await groupOpinion.fill('整体标题要改短')
    await page.getByRole('button', { name:'提交意见' }).click()
    await expect(page.getByText('要把这条意见移到整体意见吗？')).toBeVisible()
    expect((await audit()).workerEvents).toHaveLength(0)
    await page.getByRole('button', { name:'移动', exact:true }).click()
    await expect(overallOpinion).toHaveValue('整体标题要改短')
    await expect(groupOpinion).toHaveValue('')
    await expect(opinionNav.getByRole('button',{name:'第 1 组',exact:true})).toHaveCount(0)
    expect((await audit()).workerEvents).toHaveLength(0)
    await overallOpinion.clear()
    await groupOpinion.fill('这组很好')
    try{
      await page.getByRole('button', { name:'提交意见' }).click()
      await expect(page.getByText('意见已记录。')).toBeVisible()
      await expect(groupOpinion).toHaveValue('')
      await expect(groupOpinion).toBeDisabled()
    }finally{
      holdPraiseReadback=false
      praiseReadback.resolve()
    }
    await expect(groupOpinion).toBeEditable()
    await expect(page.getByRole('button', { name:'确认并修改' })).toHaveCount(0)
    expect((await audit()).workerEvents).toHaveLength(0)
    await groupOpinion.fill('第一句保留，第二句改短')
    await page.getByRole('button', { name:'提交意见' }).click()
    await expect(page.getByText('保留 第 1 句 Tengok semula pembukaannya.',{exact:false})).toBeVisible()
    await expect(page.getByRole('button', { name:'确认并修改' })).toBeVisible()
    await expect(page.getByRole('button', { name:'确认蓝图，开始制作' })).toBeDisabled()
    expect((await audit()).workerEvents).toHaveLength(0)
    await groupOpinion.clear()
    await overallOpinion.fill('把标题改成修订后测试')
    await expect(page.getByLabel('意见针对哪里')).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: '整体意见' })).toBeVisible()
    await page.getByRole('button', { name: '提交意见' }).click()
    await expect.poll(async () => { const task=(await state()).task; return task?.status==='awaiting_blueprint'&&typeof task.blueprintRevision==='string'&&task.blueprintRevision!==firstRevision }, { timeout:30000 }).toBe(true)
    await page.reload()
    await expect(page.frameLocator('iframe').getByRole('heading',{name:'剪辑蓝图',exact:true})).toBeVisible({timeout:30_000})
    await page.getByText('整体意见 · 修改对照',{exact:true}).click()
    await expect(page.getByText('修订后测试',{exact:true})).toBeVisible()
    const revised = (await state()).task
    expect(revised.blueprintRevision).not.toBe(firstRevision)
    expect(revised.blueprintOpinionDifferences).toMatchObject({overall:{label:'整体意见',changes:[{after:'修订后测试'}]},groups:[]})
    // Deliberately replaying the old revision must remain rejected by the real handler.
    const stale = await page.evaluate(async revision => (await fetch('/api/clipmentor/production', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({action:'approve_blueprint',revision}) })).status, firstRevision)
    expect(stale).toBe(409)
    const approve = page.getByRole('button', { name: '确认蓝图，开始制作' })
    await expect(approve).toBeEnabled()
    const withheld=await fetch(origin+'/api/clipmentor/production',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({action:'approve_blueprint',revision:revised.blueprintRevision,boardIdentity:revised.boardIdentity})})
    expect(withheld.status).toBe(409)
    expect((await withheld.json()).issue).toMatchObject({kind:'binding',message:expect.stringContaining('刷新蓝图')})
    await page.screenshot({ path: join(proof, '01-revised-board.png'), fullPage: true })
    await page.getByRole('button', { name: '确认蓝图，开始制作' }).click()
    await expect.poll(async () => (await state()).outputs?.length).toBe(2)
    await page.reload()
    const partner = page.getByRole('tabpanel', { name: '已合作达人版', exact: true })
    const prospect = page.getByRole('tabpanel', { name: '新建联达人版', exact: true })
    await expect(page.getByRole('region', { name: '已合作达人版', exact: true }).getByLabel('制作阶段')).toBeVisible()
    await expect(page.getByRole('region', { name: '新建联达人版', exact: true }).getByLabel('制作阶段')).toBeVisible()
    await page.screenshot({ path: join(proof, '02-two-output-progress.png'), fullPage: true })
    expect((await fetch(origin+'/api/clipmentor/fixture-release-previews',{method:'POST'})).status).toBe(204)
    await page.getByRole('tab',{name:/已合作达人版/}).click()
    await expect(partner.locator('video')).toBeVisible()
    await page.getByRole('tab',{name:/新建联达人版/}).click()
    await expect(prospect.locator('video')).toBeVisible()
    await page.getByRole('tab',{name:/已合作达人版/}).click()
    await page.screenshot({ path: join(proof, '02-two-synthetic-previews.png'), fullPage: true })
    const old = await (await fetch(origin + '/api/clipmentor/production?audience=existing_partner')).json()
    await partner.getByLabel('我已看过成片',{exact:true}).check()
    await expect(partner.getByRole('button', { name: '确认并下载成片' })).toBeDisabled()
    const previewEndpoint=origin+'/api/clipmentor/production?audience=existing_partner'
    for(const [previewWatched,languageConfirmed] of [[true,false],[false,true]]){
      const response=await fetch(previewEndpoint,{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({action:'accept',renderId:old.task.renderId,previewWatched,languageConfirmed})})
      expect(response.status).toBe(409)
      expect((await response.json()).issue.kind).toBe('content')
    }
    expect((await fetch(previewEndpoint+'&view=panel_download&renderId='+encodeURIComponent(old.task.renderId))).status).toBe(409)
    const noEnd=await fetch(previewEndpoint,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({action:'revise_preview',renderId:old.task.renderId,text:'只调整这个时间段',feedbackTarget:{scope:'range',start:0}})})
    expect(noEnd.status).toBe(409)
    expect((await noEnd.json()).issue).toEqual({kind:'binding',message:'请选择意见针对的片段、讲解组或整部成片。'})
    const emptyRange=await fetch(previewEndpoint,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({action:'revise_preview',renderId:old.task.renderId,text:'只调整这个时间段',feedbackTarget:{scope:'range',start:0,end:0.001}})})
    expect(emptyRange.status).toBe(409)
    expect((await emptyRange.json()).issue).toEqual({kind:'binding',message:'这段时间没有包含完整片段，请扩大时间段，或改选一组。'})
    expect((await (await fetch(previewEndpoint)).json()).task.sequence).toBe(old.task.sequence)
    await checkFinalReview(partner)
    await expect(partner.getByRole('button', { name: '确认并下载成片' })).toBeEnabled()
    await partner.getByRole('textbox', { name: '修改意见' }).fill('调整本组短标')
    await partner.getByRole('radio',{name:'第 1 组',exact:true}).check()
    await partner.getByLabel('改什么').selectOption('execution')
    await partner.getByRole('button', { name: '提交修改' }).click()
    await expect.poll(async () => { const task=(await (await fetch(origin + '/api/clipmentor/production?audience=existing_partner')).json()).task; return task?.status==='awaiting_review'&&typeof task.renderId==='string'&&task.renderId!==old.task.renderId }).toBe(true)
    // Stay in the same page: a prior checkbox must not approve a new render.
    await expect(partner.getByLabel('我已看过成片',{exact:true})).not.toBeChecked()
    await expect(partner.getByRole('button', { name: '确认并下载成片' })).toBeDisabled()
    await expect(partner.getByText('这一版的修改次数已用完，可联系维护人员。', {exact:true})).toBeVisible()
    const staleRender = await page.evaluate(async renderId => (await fetch('/api/clipmentor/production?audience=existing_partner', { method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'accept',renderId,languageConfirmed:true}) })).status, old.task.renderId)
    expect(staleRender).toBe(409)
    for (const [region,audience] of [[partner,'existing_partner'],[prospect,'new_contact']] as const) {
      await page.getByRole('tab',{name:audience==='existing_partner'?/已合作达人版/:/新建联达人版/}).click()
      await expect(region.getByRole('button', { name: '确认并下载成片' })).toBeDisabled()
      await checkFinalReview(region)
      const download = page.waitForEvent('download')
      await region.getByRole('button', { name: '确认并下载成片' }).click()
      const file = await download
      expect(file.suggestedFilename()).toMatch(/网页闭环测试.*\.mp4$/)
      const path = join(proof, file.suggestedFilename())
      await file.saveAs(path)
      expect(await readFile(path)).toEqual(await readFile(join(root, `media/uploads/web-loop-synthetic-${audience}.mp4`)))
      await expect(region.getByRole('link', { name: '下载成片', exact:true })).toBeVisible()
    }
    const result = await audit()
    expect(result.providerCalls).toBe(0)
    expect(result.fakeReviewerCalls).toBe(2)
    expect(result.cancelledState).toBe('cancelled')
    expect(result.recoveredEffects).toBe(1)
    expect(forwarded.filter(route => route === 'POST /api/clipmentor/intake')).toHaveLength(2)
    expect(result.actions.map((action:{status:number}) => action.status)).toEqual([409,200,200,200,200,200,409,409,200,409,409,409,409,200,409,200,200])
    expect(result.actions.every((action:{project:string,taskId:string}) => action.project.startsWith('web-loop-fixture')&&!!action.taskId)).toBe(true)
    expect(result.workerEvents.every((event: {project:string}) => event.project.startsWith('web-loop-fixture'))).toBe(true)
    expect(result.actions.filter((action:{action:string,status:number}) => action.action === 'revise_blueprint' && action.status===200)).toHaveLength(5)
    expect(result.workerEvents.filter((event:{stage:string})=>event.stage==='blueprint')).toHaveLength(1)
    expect(result.actions.filter((action:{action:string}) => action.action === 'revise_preview')).toHaveLength(3)
    expect(blocked).toEqual([])
    await page.screenshot({ path: join(proof, '03-confirmed-downloads.png'), fullPage: true })
    await writeFile(join(proof, 'audit.json'), JSON.stringify({ ...result, forwarded, blocked, firstRevision, revisedRevision: revised.blueprintRevision, scope: 'real HTTP handler and store, synthetic worker/reviewer/media; not live Agent production or semantic quality' }, null, 2))
  } finally {
    if (origin) { try { await writeFile(join(proof, 'last-audit.json'), JSON.stringify({ ...(await (await fetch(origin + '/audit')).json()), forwarded, blocked }, null, 2)) } catch {} }
    await writeFile(join(proof, 'server.log'), logs)
    await stopFixtureServer(child)
    await rm(root, { recursive:true, force:true })
  }
})
