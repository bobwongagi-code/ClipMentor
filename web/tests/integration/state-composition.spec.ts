import {acceptGroups,acknowledgeOverallFeedback,checkFinalReview} from '../review-controls'
import { test, expect, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

const deferred = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r }); return { promise, release } }
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(`Timed out: ${label}`)), milliseconds) })]) }
  finally { clearTimeout(timer) }
}
async function stop(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>(r => child.once('exit', () => r()))
  child.kill('SIGTERM')
  let timer: ReturnType<typeof setTimeout> | undefined
  try { await Promise.race([exited, new Promise<void>((_, reject) => { timer = setTimeout(() => reject(Error('Fixture failed to stop; profile retained')), 6000) })]) }
  finally { clearTimeout(timer) }
}

for (const timing of ['request', 'response'] as const) for (const replacement of ['render', 'parent'] as const) for (const action of ['accept', 'revise_preview'] as const) {
  // A completed accept cannot legally be revised; test its pending success against
  // a replacement parent instead of inventing an unsupported handler transition.
  if (timing === 'response' && replacement === 'render') continue
  test(`two real-handler tabs isolate old ${action} ${timing} after ${replacement} replacement`, async ({ context, page }, info) => {
    const source = resolve(process.env.CLIPMENTOR_TEST_SOURCE_ROOT!)
    const root = await mkdtemp(join(tmpdir(), 'cm-web-loop-'))
    const proof = info.outputPath('proof')
    await mkdir(proof, { recursive: true })
    let child: ChildProcess | undefined, origin = '', logs = ''
    const gate = deferred(), entered = deferred()
    const downloads: string[] = [], blocked: string[] = [], posts: unknown[] = []
    try {
      let serverPath = join(source, 'server/clipmentor/production-web-loop.test-server.ts')
      if (replacement === 'parent') {
        let code = await readFile(serverPath, 'utf8')
        const marker = " if(url.pathname==='/audit'){"
        expect(code.split(marker)).toHaveLength(2)
        // TEST-ONLY hook: replace the persisted parent manifest and both child tasks.
        // Business requests still execute the unmodified real production panel.
        const hook = `  if(url.pathname==='/fixture-replace-parent'){
   assert.equal(req.method,'POST');
   const parent=await createProductionTask(input as any),children=[];
   parent.projectRevision=(await loadOfflineStoredProject(project))!.revision;
   for(const audience of ['existing_partner','new_contact']){
    const childProject=project+'-'+audience;
    const child=await createProductionTask({...input,projectId:childProject,panelDelivery:{audience,productAssetId:'fixture-product',productAssetHash:'a'.repeat(64),salesAssetId:'fixture-sales',ctaAssetId:'fixture-cta',ctaAssetHash:'b'.repeat(64)}} as any);
    child.blueprintApproval={sourceProjectId:project,sourceTaskId:parent.taskId,sourceRevision:parent.projectRevision,digest:'a'.repeat(64),requirementsDigest:'b'.repeat(64),confirmedAt:Date.now()};
    if(audience==='new_contact')child.sharedProduction={projectId:children[0].projectId,taskId:children[0].taskId};
    await readyPreview(child);children.push({projectId:childProject,taskId:child.taskId,audience});
   }
   parent.productionChildren=children;parent.status='awaiting_review';await productionTaskStore.save(parent);
   const {productionOutputsMatch}=await import('./production-decisions');
   assert.equal(productionOutputsMatch(parent,await Promise.all(children.map(c=>productionTaskStore.load(c.projectId,c.taskId)))),true,'fixture replacement must satisfy real parent binding');
   res.setHeader('content-type','application/json');res.end(JSON.stringify({fixtureOnly:true,parent:parent.taskId,children}));return;
  }
`
        // Static asset proxy must not capture our explicit private fixture path.
        expect(code.split("url.pathname!=='/audit'")).toHaveLength(2)
        code = code.replace("url.pathname!=='/audit'", "url.pathname!=='/audit'&&url.pathname!=='/fixture-replace-parent'")
        code = code.replace(marker, hook + marker)
        code = code.replace(/import\('([^']+)'\)/g, (match, path: string) => path.startsWith('.') ? `import(${JSON.stringify(resolve(source, 'server/clipmentor', path))})` : match)
        code = code.replace("new URL('../../src/clipmentor/fixtures/production-saved-projects-20261028.json',import.meta.url)", JSON.stringify(join(source, 'src/clipmentor/fixtures/production-saved-projects-20261028.json')))
        serverPath = join(proof, 'private-state-server.mts')
        await writeFile(serverPath, code)
      }
      child = spawn(process.execPath, ['--import', 'tsx', serverPath], { cwd: source, env: { ...process.env, CLIPMENTOR_WEB_TEST_DATA: root }, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout!.on('data', b => { logs += String(b) }); child.stderr!.on('data', b => { logs += String(b) })
      await expect.poll(() => { const line = logs.split('\n').find(s => s.startsWith('{"ready":true')); if (line) origin = JSON.parse(line).origin; return !!origin }, { timeout: 30_000 }).toBe(true)
      await context.route('**/*', async route => {
        if (new URL(route.request().url()).origin !== origin) { blocked.push(route.request().url()); await route.abort(); return }
        await route.continue()
      })
      const state = async () => (await fetch(origin + '/api/clipmentor/production?audience=existing_partner', { signal: AbortSignal.timeout(5000) })).json()
      const audit = async () => (await fetch(origin + '/audit', { signal: AbortSignal.timeout(5000) })).json()
      const checkpoint = async (stage: string) => writeFile(join(proof, 'stage-' + stage + '.json'), JSON.stringify({ state: await state(), audit: await audit(), posts, downloads }, null, 2))
      const partner = (p: Page) => p.getByRole('region', { name: '已合作达人版', exact: true })
      await page.goto(origin)
      const inputs = (await audit()).inputs
      for (const [label, key] of [['爆款原片', 'source'], ['商品图', 'product'], ['销量截图', 'sales'], ['CTA 行动号召图', 'cta']]) await page.getByLabel(label, { exact: true }).setInputFiles(inputs[key])
      await page.getByRole('button', { name: '上传素材' }).click()
      await expect(page.frameLocator('iframe').locator('body')).toContainText('剪辑蓝图', { timeout: 30_000 })
      await acceptGroups(page)
    await page.getByRole('button', { name: '确认蓝图，开始制作' }).click()
      await expect.poll(async () => (await state()).task?.status, { timeout: 20_000 }).toBe('awaiting_review')
      await page.reload()
      const other = await context.newPage()
      await other.goto(origin)
      await expect(partner(other).locator('video')).toBeVisible()
      const old = (await state()).task
      page.on('download', d => downloads.push(d.url()))
      // Hold the original browser request before dispatch, then send it exactly once
      // to the production handler. No mocked action response or illegal POST exists.
      await page.route('**/api/clipmentor/production?audience=existing_partner', async route => {
        const req = route.request()
        if (req.method() !== 'POST' || req.postDataJSON().action !== action || req.postDataJSON().renderId !== old.renderId || posts.length) { await route.continue(); return }
        posts.push(req.postDataJSON())
        if (timing === 'request') {
          entered.release(); await gate.promise
          const response = await route.fetch()
          await route.fulfill({ response })
        } else {
          const response = await route.fetch()
          expect(response.status()).toBe(200)
          entered.release(); await gate.promise
          await route.fulfill({ response })
        }
      })
      if (action === 'accept') {
        await checkFinalReview(partner(page))
        await partner(page).getByRole('button', { name: '确认并下载成片' }).click()
      } else {
        await partner(page).getByRole('textbox', { name: '修改意见' }).fill('只调整片尾留白')
        await acknowledgeOverallFeedback(partner(page))
        await partner(page).getByRole('button', { name: '提交修改' }).click()
      }
      await bounded(entered.promise, 'old action entered route')
      await checkpoint('01-old-action-held')
      if (replacement === 'render') {
        await partner(other).getByRole('textbox', { name: '修改意见' }).fill('只调整片尾留白')
        await acknowledgeOverallFeedback(partner(other))
        await partner(other).getByRole('button', { name: '提交修改' }).click()
      } else {
        // Independent tab triggers only the explicitly private fixture mutation.
        expect(await other.evaluate(async () => (await fetch('/fixture-replace-parent', { method: 'POST' })).status)).toBe(200)
      }
      await expect.poll(async () => (await state()).task?.renderId).not.toBe(old.renderId)
      const fresh = (await state()).task
      expect(fresh.status).toBe('awaiting_review')
      if (replacement === 'render') expect(fresh.taskId).toBe(old.taskId)
      else expect(fresh.taskId).not.toBe(old.taskId)
      await checkpoint('02-replacement-persisted')
      const releasedResponse = page.waitForResponse(r => r.request().method() === 'POST' && r.request().postDataJSON()?.action === action && r.request().postDataJSON()?.renderId === old.renderId && r.url().includes('audience=existing_partner'), { timeout: 10_000 })
      gate.release()
      await releasedResponse
      if (timing === 'request') await expect(partner(page).getByText(/绑定或格式问题/)).toBeVisible()
      else await expect(partner(page).locator('video')).toHaveAttribute('src', new RegExp(encodeURIComponent(fresh.renderId)))
      await expect.poll(async () => (await audit()).actions.filter((a: { action: string; renderId?: string }) => a.action === action && a.renderId === old.renderId).length).toBe(action === 'revise_preview' && replacement === 'render' ? 2 : 1)
      await expect.poll(async () => (await audit()).actions.at(-1)?.status).toBe(timing === 'request' ? 409 : 200)
      expect((await state()).task.renderId).toBe(fresh.renderId)
      expect((await state()).task.status).toBe('awaiting_review')
      expect(downloads).toEqual([])
      expect(posts).toHaveLength(1)
      await checkpoint('03-old-action-released')
      // Positive control: current render is independently accepted and the download
      // bytes match isolated synthetic media, rather than only a visible UI label.
      await other.reload()
      await checkFinalReview(partner(other))
      const accepted = other.waitForResponse(r => r.request().method() === 'POST' && r.request().postDataJSON()?.action === 'accept' && r.request().postDataJSON()?.renderId === fresh.renderId && r.url().includes('audience=existing_partner'), { timeout: 10_000 })
      const downloaded = other.waitForEvent('download', { timeout: 10_000 })
      // Attach rejection immediately so a failed HTTP assertion cannot leave an
      // unhandled download timeout while the fixture is being stopped.
      const downloadResult = downloaded.then(file => ({ file }), error => ({ error }))
      await partner(other).getByRole('button', { name: '确认并下载成片' }).click()
      const acceptedResponse = await accepted
      await checkpoint('04-current-accept-response')
      if (acceptedResponse.status() !== 200) {
        const body = await bounded(acceptedResponse.text(), 'failed accept response body', 3000).catch(error => String(error))
        expect(acceptedResponse.status(), body).toBe(200)
      }
      expect(acceptedResponse.status()).toBe(200)
      const resultDownload = await downloadResult
      if ('error' in resultDownload) throw resultDownload.error
      const file = resultDownload.file, destination = join(proof, 'current-render.mp4')
      await file.saveAs(destination)
      const actual = await readFile(destination), expected = await readFile(join(root, 'media/uploads/web-loop-synthetic-existing_partner.mp4'))
      expect(actual).toEqual(expected)
      const final = (await state()).task, result = await audit()
      expect(final.renderId).toBe(fresh.renderId); expect(final.status).toBe('completed')
      expect(result.providerCalls).toBe(0)
      expect(result.actions.map((a: { status: number }) => a.status)).toEqual(replacement === 'render' ? [200, 200, 409, 200] : [200, timing === 'request' ? 409 : 200, 200])
      expect(result.actions.filter((a: { action: string; renderId: string }) => a.action === action && a.renderId === old.renderId)).toHaveLength(action === 'revise_preview' && replacement === 'render' ? 2 : 1)
      expect(blocked).toEqual([])
      // Retain raw persistent store files as an independent postcondition source.
      const persisted: Record<string, string> = {}
      for (const name of await readdir(root, { recursive: true })) if (/\.(json|jsonl)$/.test(name)) {
        const bytes = await readFile(join(root, name)); persisted[name] = bytes.toString()
      }
      expect(Object.values(persisted).join('\n')).toContain(fresh.renderId)
      await writeFile(join(proof, 'evidence.json'), JSON.stringify({ action, old, fresh, final, audit: result, originalRequests: posts, staleDownloads: downloads, download: { bytes: actual.length, sha256: sha(actual), expectedSha256: sha(expected) }, persisted, blocked }, null, 2))
    } finally {
      gate.release()
      if (origin) { try { await writeFile(join(proof, 'last-audit.json'), JSON.stringify(await (await fetch(origin + '/audit')).json(), null, 2)) } catch {} }
      await writeFile(join(proof, 'server.log'), logs)
      await stop(child)
      // root is the mkdtemp-created, fixed-prefix profile from this test only.
      if (resolve(root).startsWith(resolve(tmpdir()) + '/cm-web-loop-')) await rm(root, { recursive: true, force: true })
    }
  })
}
