import {acknowledgeOverallFeedback,checkFinalReview} from '../review-controls'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { preview } from 'vite'

const apiBasePath = '/gateway/clip-mentor'
const revision = 'saved-revision'
const identity = 'b'.repeat(64)
const build = (outDir: string, apiPath: string) => execFileSync(process.execPath,
  ['node_modules/vite/bin/vite.js', 'build', '--outDir', outDir, '--emptyOutDir'],
  {
    env: {
      ...process.env, CLIPMENTOR_PUBLIC_API_BASE_PATH: apiPath,
      CLIPMENTOR_PROJECT_ID: 'dev-only-project', CLIPMENTOR_BACKEND_PORT: 'invalid-dev-only-port',
    },
    stdio: 'pipe',
  })

test('the built business frontend reads only the configured same-origin API', async ({ page }) => {
  const outDir = await mkdtemp(join(tmpdir(), 'clipmentor-web-api-'))
  let server: Awaited<ReturnType<typeof preview>> | undefined
  try {
    build(outDir, apiBasePath)
    let exists = true
    const requests: string[] = []
    server = await preview({
      configFile: false, build: { outDir }, preview: { host: '127.0.0.1', port: 0 },
      plugins: [{
        name: 'production-api-fixture',
        configurePreviewServer(previewServer) {
          previewServer.middlewares.use(apiBasePath, (req, res) => {
            const url = new URL(req.url ?? '/', 'http://localhost')
            requests.push(`${req.method} ${url.pathname}`)
            const send = (status: number, value: object) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value))
            if (req.method !== 'GET') { send(405, {}); return }
            if (url.pathname === '/intake') {
              if (!exists) { send(404, { error: '上传目标工程不存在' }); return }
              send(200, { receipt: {
                projectId: 'existing-fixture', revision,
                assets: ['source.mp4', 'product.png', 'sales.png', 'cta.png'].map((name, id) => ({ id: String(id), name })),
              } })
              return
            }
            if (url.pathname !== '/production') { send(404, {}); return }
            if (url.searchParams.get('view') === 'panel_board') {
              if (!exists || url.searchParams.get('revision') !== revision || url.searchParams.get('boardIdentity') !== identity) {
                send(409, {}); return
              }
              res.writeHead(200, { 'Content-Type': 'text/html', 'X-ClipMentor-Board-Identity': identity })
                .end('<h2>新建联达人</h2><p>独立 CTA</p><h2>已合作达人</h2><p>现有 Storyboard</p>')
              return
            }
            send(200, { task: exists ? {
              taskId: 'saved-task', revision, status: 'awaiting_blueprint', stage: 'copy_review',
              blueprintRevision: revision, boardIdentity: identity, active: false, sequence: 1, dualBlueprint: true,
            } : null })
          })
        },
      }],
    })
    const address = server.httpServer.address()
    if (!address || typeof address === 'string') throw new Error('Fixture did not bind an HTTP port')
    const origin = `http://127.0.0.1:${address.port}`
    await page.goto(origin)
    const board = page.frameLocator('iframe[title="人审版蓝图"]')
    await expect(board.getByText('独立 CTA')).toBeVisible()
    await expect(board.getByText('现有 Storyboard')).toBeVisible()
    expect(requests).toEqual(['GET /intake', 'GET /production', 'GET /production'])

    exists = false
    await page.reload()
    await expect(page.getByText('无法读取上传记录，请稍后刷新。')).toBeVisible()
    await expect(page.locator('iframe[title="人审版蓝图"]')).toHaveCount(0)
    expect(requests.at(-1)).toBe('GET /intake')
    const boardUrl = `${origin}${apiBasePath}/production?view=panel_board&revision=${revision}&boardIdentity=${identity}`
    expect((await page.request.get(boardUrl)).status()).toBe(409)

    const requestCount = requests.length
    await page.goto(`${origin}/?demo=1`)
    await expect(page.getByText('演示流程尚未连接制作服务')).toBeVisible()
    expect(requests).toHaveLength(requestCount)
  } finally {
    if (server) {
      server.httpServer.closeAllConnections()
      await new Promise<void>((resolve, reject) => server!.httpServer.close(error => error ? reject(error) : resolve()))
    }
    await rm(outDir, { recursive: true, force: true })
  }
})

test('a production build rejects non-local or ambiguous API paths', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'clipmentor-web-api-'))
  try {
    for (const path of ['https://example.invalid/api', '//example.invalid/api', '/api/../other', '/api?key=value', '/api\n']) {
      expect(() => build(outDir, path)).toThrow(/Invalid CLIPMENTOR_PUBLIC_API_BASE_PATH/)
    }
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
})

test.describe('production gateway responses', () => {
  let outDir: string
  let server: Awaited<ReturnType<typeof preview>>
  let origin: string
  let redirectedRequests = 0
  let downloadRequests = 0
  let confirmedDelivery = false
  test.beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), 'clipmentor-web-api-'))
    build(outDir, apiBasePath)
    server = await preview({
      configFile: false, build: { outDir }, preview: { host: '127.0.0.1', port: 0 },
      plugins: [{
        name: 'gateway-redirect-fixture',
        configurePreviewServer(previewServer) {
          previewServer.middlewares.use((req, res, next) => {
            if (req.url === apiBasePath + '/production' && req.method === 'POST') {
              res.writeHead(307, { Location: '/session' }).end()
              return
            }
            if (req.url === '/session') {
              redirectedRequests++
              res.writeHead(200, { 'Content-Type': 'text/html' }).end('<h1>Sign in</h1>')
              return
            }
            const url = new URL(req.url ?? '/', 'http://localhost')
            if (url.pathname === apiBasePath + '/production' && url.searchParams.get('view') === 'panel_download') {
              downloadRequests++
              if (!confirmedDelivery || url.searchParams.get('renderId') !== 'one-render') {
                res.writeHead(409).end()
                return
              }
              res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Disposition': 'attachment; filename=confirmed.mp4' })
                .end('fixture video bytes')
              return
            }
            next()
          })
        },
      }],
    })
    const address = server.httpServer.address()
    if (!address || typeof address === 'string') throw new Error('Fixture did not bind an HTTP port')
    origin = `http://127.0.0.1:${address.port}`
  })
  test.afterAll(async () => {
    try {
      if (server) {
        server.httpServer.closeAllConnections()
        await new Promise<void>((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()))
      }
    } finally {
      if (outDir) await rm(outDir, { recursive: true, force: true })
    }
  })

  for (const response of ['html', 'redirect', 'unacknowledged'] as const) {
    test(`a gateway ${response} write response retains reviewer feedback`, async ({ page }) => {
      let posts = 0, saved = false
      const redirectCount = redirectedRequests
      await page.route(`**${apiBasePath}/intake`, route => route.fulfill({ json: { receipt: fixtureReceipt } }))
      await page.route(`**${apiBasePath}/production**`, async route => {
        if (route.request().method() === 'POST') {
          expect(route.request().postDataJSON()).toMatchObject({ action: 'revise_blueprint', revision, boardIdentity: identity,
            blueprintOpinions:[{unitId:null,text:'保留这条意见'}] })
          posts++
          if (posts === 2) {
            saved = true
            return route.fulfill({ contentType: 'Application/JSON; charset=utf-8', body: '{"accepted":true}' })
          }
          if (response === 'redirect') return route.continue()
          if (response === 'unacknowledged') return route.fulfill({ json: { accepted: false } })
          return route.fulfill({ contentType: 'text/html', body: '<h1>Sign in</h1>' })
        }
        if (new URL(route.request().url()).searchParams.get('view') === 'panel_board') {
          return route.fulfill({ contentType: 'text/html', headers: { 'X-ClipMentor-Board-Identity': identity }, body: '<h2>当前双结尾蓝图</h2>' })
        }
        return route.fulfill({ json: { task: saved ? { ...fixtureBoard, hasBlueprintFeedback: true } : fixtureBoard } })
      })

      await page.goto(origin)
      await expect(page.frameLocator('iframe').getByText('当前双结尾蓝图')).toBeVisible()
      const feedback = page.getByRole('textbox', { name: '整体意见' })
      const submit = page.getByRole('button', { name: '提交意见' })
      await feedback.fill('保留这条意见')
      await submit.click()
      await expect(submit).toBeEnabled()
      await expect(feedback).toHaveValue('保留这条意见')
      await expect(page.getByRole('alert')).toContainText('操作暂未确认')
      expect(posts).toBe(1)
      expect(redirectedRequests).toBe(redirectCount)
      await submit.click()
      await expect(feedback).toHaveValue('')
      await expect(page.getByRole('region', { name: '上次修改要点' })).toBeVisible()
      expect(posts).toBe(2)
    })
  }

  for (const failedReadback of ['unavailable', 'older sequence'] as const) {
    test(`an acknowledged acceptance waits for saved confirmation with ${failedReadback} readback`, async ({ page }) => {
      await page.clock.install()
      let posts = 0, readFailed = false
      confirmedDelivery = false
      const beforeDownloads = downloadRequests
      await page.route(`**${apiBasePath}/intake`, route => route.fulfill({ json: { receipt: fixtureReceipt } }))
      await page.route(`**${apiBasePath}/production**`, async route => {
        const request = route.request()
        const view = new URL(request.url()).searchParams.get('view')
        if (view === 'panel_video') return route.fulfill({ status: 404 })
        if (view === 'panel_download') return route.continue()
        if (request.method() === 'POST') {
          expect(request.postDataJSON()).toMatchObject({ action: 'accept', renderId: 'one-render' })
          posts++
          return route.fulfill({ json: { accepted: true } })
        }
        if (posts && !confirmedDelivery) {
          readFailed = true
          if (failedReadback === 'unavailable') return route.fulfill({ status: 503 })
          return route.fulfill({ json: { task: {
            taskId: 'delivery-task', stage: 'self_check', status: 'completed',
            sequence: 2, active: false, renderId: 'one-render', downloadName: 'confirmed.mp4',
          } } })
        }
        return route.fulfill({ json: { task: {
          taskId: 'delivery-task', stage: 'self_check', status: confirmedDelivery ? 'completed' : 'awaiting_review',
          sequence: confirmedDelivery ? 4 : 3, active: false, renderId: 'one-render', downloadName: 'confirmed.mp4',
        } } })
      })
      await page.goto(origin)
      await checkFinalReview(page)
      await page.getByRole('button', { name: '确认并下载成片' }).click()
      await expect.poll(() => readFailed).toBe(true)
      await expect(page.getByText('操作已收到，正在核对最新状态。')).toBeVisible()
      await expect(page.getByRole('button', { name: '确认并下载成片' })).toBeDisabled()
      expect(downloadRequests).toBe(beforeDownloads)
      expect(posts).toBe(1)
      confirmedDelivery = true
      await page.clock.fastForward(8000)
      const link = page.getByRole('link', { name: '下载成片', exact: true })
      await expect(link).toHaveAttribute('href', new RegExp(`^${apiBasePath}/production\\?view=panel_download&renderId=one-render$`))
      const downloadStarted = page.waitForEvent('download')
      await link.click()
      const download = await downloadStarted
      expect(download.suggestedFilename()).toBe('confirmed.mp4')
      expect(await readFile(await download.path(), 'utf8')).toBe('fixture video bytes')
      expect(downloadRequests).toBe(beforeDownloads + 1)
      expect(posts).toBe(1)
    })
  }

  test('returning to the same preview does not revive an abandoned pending flag', async ({ page }) => {
    await page.clock.install()
    let previewAvailable = true, posts = 0
    let releaseWrite!: () => void
    const heldWrite = new Promise<void>(resolve => { releaseWrite = resolve })
    await page.route(`**${apiBasePath}/intake`, route => route.fulfill({ json: { receipt: fixtureReceipt } }))
    await page.route(`**${apiBasePath}/production**`, async route => {
      const request = route.request()
      if (new URL(request.url()).searchParams.has('view')) return route.fulfill({ status: 404 })
      if (request.method() === 'POST') {
        posts++
        await heldWrite
        await route.fulfill({ json: { accepted: true } }).catch(() => {})
        return
      }
      return route.fulfill({ json: { task: {
        taskId: 'restoring-task', stage: 'self_check', active: false, sequence: 3,
        ...(previewAvailable ? { status: 'awaiting_review', renderId: 'restoring-render' } : { status: 'blocked' }),
      } } })
    })
    try {
      await page.goto(origin)
      const feedback = page.getByRole('textbox', { name: '修改意见' })
      await feedback.fill('保留本版修改意见')
      await acknowledgeOverallFeedback(page)
      await page.getByRole('button', {name:'提交修改'}).click()
      await expect.poll(() => posts).toBe(1)
      await expect(feedback).toBeDisabled()
      previewAvailable = false
      await page.clock.fastForward(8000)
      await expect(feedback).toHaveCount(0)
      previewAvailable = true
      await page.clock.fastForward(8000)
      await expect(feedback).toHaveValue('保留本版修改意见')
      await expect(feedback).toBeEnabled()
      releaseWrite()
      expect(posts).toBe(1)
    } finally {
      releaseWrite()
    }
  })

  test('an expired gateway session hides the previously loaded board', async ({ page }) => {
    await page.clock.install()
    let expired = false
    await page.route(`**${apiBasePath}/intake`, route => route.fulfill({ json: { receipt: fixtureReceipt } }))
    await page.route(`**${apiBasePath}/production**`, async route => {
      if (expired) return route.fulfill({ status: 401, json: {} })
      if (new URL(route.request().url()).searchParams.get('view') === 'panel_board') {
        return route.fulfill({ contentType: 'text/html', headers: { 'X-ClipMentor-Board-Identity': identity }, body: '<h2>受限人审板</h2>' })
      }
      return route.fulfill({ json: { task: fixtureBoard } })
    })
    await page.goto(origin)
    await expect(page.frameLocator('iframe').getByText('受限人审板')).toBeVisible()
    expired = true
    await page.clock.fastForward(8000)
    await expect(page.getByRole('alert')).toContainText('访问已失效')
    await expect(page.locator('iframe')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '提交修改' })).toHaveCount(0)
  })

  test('a malformed status response preserves the board while the API recovers', async ({ page }) => {
    await page.clock.install()
    let malformed = false, statusReads = 0
    await page.route(`**${apiBasePath}/intake`, route => route.fulfill({ json: { receipt: fixtureReceipt } }))
    await page.route(`**${apiBasePath}/production**`, route => {
      if (new URL(route.request().url()).searchParams.get('view') === 'panel_board') {
        return route.fulfill({ contentType: 'text/html', headers: { 'X-ClipMentor-Board-Identity': identity }, body: '<h2>仍可阅读的蓝图</h2>' })
      }
      statusReads++
      return malformed ? route.fulfill({ contentType: 'application/json', body: 'null' })
        : route.fulfill({ json: { task: fixtureBoard } })
    })
    await page.goto(origin)
    const board = page.frameLocator('iframe').getByText('仍可阅读的蓝图')
    await expect(board).toBeVisible()
    malformed = true
    for (let i = 0; i < 3; i++) {
      const before = statusReads
      await page.clock.fastForward(8000)
      await expect.poll(() => statusReads).toBeGreaterThan(before)
      await expect(board).toBeVisible()
    }
    await expect(page.getByRole('alert')).toContainText('正在重新连接')
    malformed = false
    await page.clock.fastForward(8000)
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(board).toBeVisible()
  })
})

const fixtureReceipt = {
  projectId: 'existing-fixture', revision,
  assets: ['source.mp4', 'product.png', 'sales.png', 'cta.png'].map((name, id) => ({ id: String(id), name })),
}
const fixtureBoard = {
  taskId: 'saved-task', revision, status: 'awaiting_blueprint', stage: 'copy_review',
  blueprintRevision: revision, boardIdentity: identity, active: false, sequence: 1, dualBlueprint: true,
}
