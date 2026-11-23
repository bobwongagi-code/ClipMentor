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
  const blocked: string[] = [], forwarded: string[] = []
  try {
    child = spawn(process.execPath, ['--import', 'tsx', join(sourceRoot, 'server/clipmentor/production-web-loop.test-server.ts')], {
      cwd: sourceRoot, env: { ...process.env, CLIPMENTOR_WEB_TEST_DATA: root }, stdio: ['ignore', 'pipe', 'pipe'],
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
      await route.continue()
    })
    const state = async () => await (await fetch(origin + '/api/clipmentor/production')).json()
    const audit = async () => await (await fetch(origin + '/audit')).json()
    await page.setViewportSize({ width: 1200, height: 900 })
    await page.goto(origin)
    const inputs=(await audit()).inputs
    for(const [label,key] of [['爆款原片','source'],['商品图','product'],['销量截图','sales'],['CTA 行动号召图','cta']]){
      await page.getByLabel(label,{exact:true}).setInputFiles(inputs[key])
    }
    await page.getByRole('button',{name:'上传素材'}).click()
    await expect(page.frameLocator('iframe').locator('body')).toContainText('剪辑蓝图',{timeout:30_000})
    const firstRevision = (await state()).task.blueprintRevision
    // Two tabs can render the same draft revision against different requirements.
    // The first tab's confirmation must never bind to the second tab's newer cache.
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
    await expect(page.getByRole('heading', { name: '补传缺失素材' })).toBeVisible()
    await expect(page.frameLocator('iframe').locator('body')).toContainText('剪辑蓝图', { timeout: 30_000 })
    await page.getByLabel('CTA 行动号召图', { exact: true }).setInputFiles(inputs.cta)
    await page.getByRole('button', { name: '补传素材' }).click()
    await expect(page.getByRole('heading', { name: '补传缺失素材' })).toHaveCount(0)
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
    await expect(page.frameLocator('iframe').locator('body')).toContainText('剪辑蓝图', { timeout: 30_000 })
    await page.getByRole('textbox', { name: '修改意见' }).fill('把标题改成修订后测试')
    await page.getByRole('button', { name: '提交修改' }).click()
    await expect.poll(async () => { const task=(await state()).task; return task?.status==='awaiting_blueprint'&&typeof task.blueprintRevision==='string'&&task.blueprintRevision!==firstRevision }, { timeout:30000 }).toBe(true)
    await page.reload()
    await expect(page.frameLocator('iframe').locator('body')).toContainText('修订后测试', { timeout: 30_000 })
    const revised = (await state()).task
    expect(revised.blueprintRevision).not.toBe(firstRevision)
    // Deliberately replaying the old revision must remain rejected by the real handler.
    const stale = await page.evaluate(async revision => (await fetch('/api/clipmentor/production', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({action:'approve_blueprint',revision}) })).status, firstRevision)
    expect(stale).toBe(409)
    await page.screenshot({ path: join(proof, '01-revised-board.png'), fullPage: true })
    await page.getByRole('button', { name: '确认蓝图，开始制作' }).click()
    await expect.poll(async () => (await state()).outputs?.length).toBe(2)
    await page.reload()
    const partner = page.getByRole('region', { name: '已合作达人版', exact: true })
    const prospect = page.getByRole('region', { name: '新建联达人版', exact: true })
    await expect(partner.getByLabel('制作阶段')).toBeVisible()
    await expect(prospect.getByLabel('制作阶段')).toBeVisible()
    await page.screenshot({ path: join(proof, '02-two-output-progress.png'), fullPage: true })
    await expect(partner.locator('video')).toBeVisible()
    await expect(prospect.locator('video')).toBeVisible()
    await page.screenshot({ path: join(proof, '02-two-synthetic-previews.png'), fullPage: true })
    const old = await (await fetch(origin + '/api/clipmentor/production?audience=existing_partner')).json()
    await partner.getByRole('checkbox').check()
    await expect(partner.getByRole('button', { name: '确认并下载成片' })).toBeEnabled()
    await partner.getByRole('textbox', { name: '修改意见' }).fill('只调整片尾留白')
    await partner.getByRole('button', { name: '提交修改' }).click()
    await expect.poll(async () => { const task=(await (await fetch(origin + '/api/clipmentor/production?audience=existing_partner')).json()).task; return task?.status==='awaiting_review'&&typeof task.renderId==='string'&&task.renderId!==old.task.renderId }).toBe(true)
    // Stay in the same page: a prior checkbox must not approve a new render.
    await expect(partner.getByRole('checkbox')).not.toBeChecked()
    await expect(partner.getByRole('button', { name: '确认并下载成片' })).toBeDisabled()
    const staleRender = await page.evaluate(async renderId => (await fetch('/api/clipmentor/production?audience=existing_partner', { method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'accept',renderId,languageConfirmed:true}) })).status, old.task.renderId)
    expect(staleRender).toBe(409)
    for (const [region,audience] of [[partner,'existing_partner'],[prospect,'new_contact']] as const) {
      await expect(region.getByRole('button', { name: '确认并下载成片' })).toBeDisabled()
      await region.getByRole('checkbox').check()
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
    expect(result.actions.map((action:{status:number}) => action.status)).toEqual([409,200,409,200,200,409,200,200])
    expect(result.actions.every((action:{project:string,taskId:string}) => action.project.startsWith('web-loop-fixture')&&!!action.taskId)).toBe(true)
    expect(result.workerEvents.every((event: {project:string}) => event.project.startsWith('web-loop-fixture'))).toBe(true)
    expect(result.actions.filter((action:{action:string,status:number}) => action.action === 'revise_blueprint' && action.status===200)).toHaveLength(1)
    expect(result.actions.filter((action:{action:string}) => action.action === 'revise_preview')).toHaveLength(1)
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
