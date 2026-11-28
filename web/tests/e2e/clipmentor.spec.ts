import {acknowledgeOverallFeedback,approvedFixtureReview,checkFinalReview} from '../review-controls'
import { expect, test } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const source = fileURLToPath(new URL('../fixtures/preflight.webm', import.meta.url))
const image = {
  name: 'image.png',
  mimeType: 'image/png',
  buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jH1sAAAAASUVORK5CYII=', 'base64'),
}

for (const matching of [true, false]) {
  test(`disconnected material upload checks saved bytes before recovery (match=${matching})`, async ({ page }) => {
    const sourceBytes = await readFile(source)
    const files = [
      { name:'source.webm', mimeType:'video/webm', buffer:sourceBytes },
      { ...image, name:'product.png' },
      { ...image, name:'sales.png' },
      { ...image, name:'cta.png' },
    ]
    const hashes = files.map(file => createHash('sha256').update(file.buffer).digest('hex'))
    if (!matching) hashes[3] = '0'.repeat(64)
    let submissions = 0
    await page.route('**/api/clipmentor/intake', async route => {
      if (route.request().method() === 'POST') {
        submissions++
        await route.abort('failed')
        return
      }
      const assets = files.map(({name},index) => ({id:String(index),name,sourceContentHash:hashes[index]}))
      await route.fulfill({json:{receipt:submissions?{projectId:'fixture',assets}:null}})
    })
    await page.route('**/api/clipmentor/production', route => route.fulfill({json:{task:null}}))
    await page.goto('/')
    for(const [index,label] of ['爆款原片','商品图','销量截图','合作海报'].entries()){
      await page.getByLabel(label,{exact:true}).setInputFiles(files[index])
    }
    await page.getByRole('button',{name:'上传素材'}).click()
    if (matching) {
      await expect(page.getByRole('heading',{name:'素材已上传'})).toBeVisible()
    } else {
      await expect(page.getByText('已保存的素材与本次上传不一致，请刷新查看。')).toBeVisible()
      await expect(page.getByRole('heading',{name:'素材已上传'})).toHaveCount(0)
    }
    expect(submissions).toBe(1)
  })
}

test('upload errors use business copy for known reasons and hide raw diagnostics',async({page})=>{
  const raw='内部夹具回执 /用户/本地目录 ENOENT'
  let replies=0
  await page.route('**/api/clipmentor/intake',route=>route.request().method()==='GET'
    ?route.fulfill({json:{receipt:null}})
    :route.fulfill({status:409,json:{reason:++replies===1?'source':'unknown',error:raw}}))
  await page.route('**/api/clipmentor/production',route=>route.fulfill({json:{task:null}}))
  await page.goto('/')
  await page.getByLabel('爆款原片').setInputFiles(source)
  for(const name of ['商品图','销量截图','合作海报'])await page.getByLabel(name).setInputFiles(image)
  const upload=page.getByRole('button',{name:'上传素材'})
  await upload.click()
  await expect(page.getByRole('alert')).toHaveText('原片无法播放或没有声音，请检查后再上传。')
  await upload.click()
  await expect(page.getByRole('alert')).toHaveText('暂时无法保存素材，请稍后再试。')
  await expect(page.getByText(raw)).toHaveCount(0)
})

test('unreadable and missing files block the start', async ({ page }) => {
  await page.goto('/?demo=1')
  await expect(page).toHaveTitle('ClipMentor')
  const start = page.getByRole('button', { name: '开始制作' })
  await expect(start).toBeDisabled()
  await page.getByLabel('商品图').setInputFiles({ ...image, buffer: Buffer.from('invalid image') })
  await expect(page.getByText('文件无法读取，请更换')).toBeVisible()
  await page.getByLabel('商品图').setInputFiles(image)
  await expect(page.getByText('1 × 1')).toBeVisible()
  await expect(start).toBeDisabled()
})

test('materials lead to blueprint confirmation, preview feedback, then demo download', async ({ page }) => {
  await page.goto('/?demo=1')
  await page.getByLabel('爆款原片').setInputFiles(source)
  await page.getByLabel('商品图').setInputFiles(image)
  await page.getByLabel('销量截图').setInputFiles({ ...image, name: 'sales.png' })
  await expect(page.getByRole('button', { name: '开始制作' })).toBeDisabled()
  await page.getByLabel('合作海报').setInputFiles({ ...image, name: 'cta.gif' })
  await expect(page.getByText('支持 PNG、JPG、WebP')).toBeVisible()
  await page.getByLabel('合作海报').setInputFiles({ ...image, name: 'cta.png' })
  await expect(page.getByRole('combobox')).toHaveCount(0)
  await page.getByRole('button', { name: '开始制作' }).click()
  await expect(page.getByRole('heading', { name: '审核蓝图' })).toBeVisible()
  await expect(page.getByRole('img', { name: '上传原片的首帧' })).toBeVisible()
  await expect(page.getByText('新建联与已合作两个版本，共用片头和教学主体。')).toBeVisible()
  await page.getByRole('textbox', { name: '蓝图修改' }).fill('说明对比画面')
  await page.getByRole('button', { name: '发送修改意见' }).click()
  await expect(page.getByText('说明对比画面')).toBeVisible()
  await page.getByRole('button', { name: '确认演示蓝图' }).click()
  await expect(page.getByText('当前播放的是原片')).toBeVisible()
  await expect(page.getByRole('link', { name: '下载演示文件' })).toHaveCount(0)
  await page.getByRole('button', { name: '确认演示预览' }).click()
  await expect(page.getByRole('link', { name: '下载演示文件' })).toHaveAttribute('download', '演示原片-preflight.webm')
  await page.getByRole('textbox', { name: '成片修改' }).fill('调整片尾')
  await page.getByRole('button', { name: '发送修改意见' }).click()
  await expect(page.getByText('调整片尾')).toBeVisible()
  await expect(page.getByRole('link', { name: '下载演示文件' })).toHaveCount(0)
})

test('mobile upload page fits the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto('/?demo=1')
  await expect(page.getByRole('heading', { name: '上传制作素材' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
})

for (const status of ['blocked', 'awaiting_blueprint']) test(`current saved draft stays reviewable with feedback while task is ${status}`, async ({ page }) => {
  await page.route('**/api/clipmentor/intake', route => route.fulfill({ json: {
    receipt: { projectId: 'fixture', assets: ['source.mp4', 'product.png', 'sales.png', 'cta.png'].map((name, i) => ({ id: String(i), name })) },
  } }))
  let feedback = ''
  let posts = 0
  await page.route('**/api/clipmentor/production*', async route => {
    const request = route.request()
    if (new URL(request.url()).searchParams.get('view') === 'panel_board') {
      await route.fulfill({ contentType: 'text/html', body: '<h2>现行正式蓝图</h2>' }); return
    }
    if (request.method() === 'POST') {
      const body = request.postDataJSON()
      expect(body.action).toBe('revise_blueprint')
      expect(body.revision).toBe('saved-current')
      feedback = body.blueprintOpinions[0].text; posts++
      await route.fulfill({ json: { accepted: true, saved: true, dispatched: false } }); return
    }
    await route.fulfill({ json: { task: { status, stage: 'copy_review', active: false, sequence: posts,
      revision: 'old-task', blueprintRevision: 'saved-current', hasBlueprintFeedback:!!feedback, blueprintFeedbackSummary:feedback?[feedback]:[],
      canApproveBlueprint: false, dualBlueprint: true, blueprintMessage:'蓝图检查尚未完成，暂不能开始制作。', approvalUnavailable: 'INTERNAL_STALE_REVIEW_SENTINEL' } } })
  })
  await page.goto('/')
  await expect(page.frameLocator('iframe').getByText('现行正式蓝图')).toBeVisible()
  await expect(page.getByRole('button', { name: '确认蓝图，开始制作' })).toBeVisible()
  await expect(page.getByRole('button', { name: '确认蓝图，开始制作' })).toBeDisabled()
  await expect(page.getByText('蓝图还在核对，核对完才能开始制作。')).toBeVisible()
  await expect(page.getByText('INTERNAL_STALE_REVIEW_SENTINEL')).toHaveCount(0)
  await page.getByText('整体意见',{exact:true,selector:'summary'}).click()
  await page.getByRole('textbox', { name: '整体意见' }).fill('保留成绩钩子')
  await page.getByRole('button', {name:'提交意见'}).click()
  await expect(page.getByText('保留成绩钩子')).toHaveCount(0)
  expect(posts).toBe(1)
})

test('saved materials lead to board, preview and download on the same page', async ({ page }) => {
  const names = ['source.mp4', 'product.png', 'sales.png', 'cta.png']
  await page.route('**/api/clipmentor/intake', route => route.fulfill({ json: {
    receipt: { projectId: 'fixture', assets: names.map((name, index) => ({ id: String(index), name })) },
  } }))
  let task: Record<string, unknown> | null = null
  const actions: string[] = []
  let boardReads = 0
  let revisionPosts = 0
  const visualCriteria = { digest: 'a'.repeat(64), entries: [{ id: 'cta', quote: '同屏要有商品和佣金。', question: '商品和佣金能同时认出吗？', fileName: '参考片.mp4', seconds: 12 }] }
  await page.context().route('**/api/clipmentor/production*', async route => {
    const request = route.request()
    const view = new URL(request.url()).searchParams.get('view')
    if (view === 'panel_board') {
      if (++boardReads === 1) {
        await route.fulfill({ status: 503, json: { error: 'internal_board_fixture' } })
        return
      }
      await route.fulfill({ contentType: 'text/html', body: '<h2>人审审片板样本</h2>' })
      return
    }
    if (view === 'panel_download') { await route.fulfill({contentType:'video/mp4',headers:{'Content-Disposition':'attachment; filename=JUDYDOLL-fixture.mp4'},body:Buffer.from('fixture')}); return }
    if (view === 'panel_video') { await route.fulfill({ status: 404 }); return }
    if (view === 'panel_reference') {
      expect(new URL(request.url()).searchParams.get('criterion')).toBe('cta')
      await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="gold"/></svg>' })
      return
    }
    if (request.method() === 'POST') {
      const body = request.postDataJSON()
      if (body.action === 'revise_blueprint' && ++revisionPosts === 1) {
        await route.fulfill({ status: 409, json: { reason: 'review_board_reload' } })
        return
      }
      actions.push(body.action)
      if (body.action === 'start') task = {
        status: 'blocked', stage: 'blueprint', active: true, sequence: 0,
        blocked: 'blueprint_stage_incomplete: private diagnostic', canContinue: true,
      }
      if (body.action === 'revise_blueprint') {
        expect(boardReads).toBe(3)
        expect(body.revision).toBe('r1')
        expect(body.blueprintOpinions).toEqual([{unitId:null,text:'补清拍法'}])
        task = { ...approvedFixtureReview,status: 'awaiting_blueprint', stage: 'blueprint', revision: 'r2', sequence: 2 }
      }
      if (body.action === 'approve_blueprint') {
        expect(body.revision).toBe('r2')
        task = { status: 'awaiting_review', canAcceptPreview:true, stage: 'self_check', renderId: 'render-1', downloadName:'JUDYDOLL-fixture.mp4', sequence: 3, visualCriteria }
      }
      if (body.action === 'revise_preview') {
        expect(body.renderId).toBe('render-1')
        task = { status: 'awaiting_review', canAcceptPreview:true, stage: 'self_check', renderId: 'render-2', downloadName:'JUDYDOLL-fixture.mp4', feedbackUsed: true, sequence: 4, visualCriteria }
      }
      if (body.action === 'accept') {
        expect(body.languageConfirmed).toBe(true)
        expect(body.visualCriteriaDigest).toBe(visualCriteria.digest)
        expect(body.previewWatched).toBe(true)
        expect(body.confirmedVisualCriteria).toBeUndefined()
        task = { status: 'completed', renderId: 'render-2', downloadName:'JUDYDOLL-fixture.mp4', sequence: 5 }
      }
      await route.fulfill({ json: { accepted: true } })
      return
    }
    await route.fulfill({ json: { task: task && { taskId: 'fixture-task', ...task } } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: '开始制作' }).click()
  await expect(page.getByRole('heading', { name: '生成蓝图' })).toBeVisible()
  await expect(page.getByText(/制作暂停|技术记录|private diagnostic|继续制作/)).toHaveCount(0)
  task = { status: 'awaiting_blueprint', stage: 'blueprint', revision: 'r1', sequence: 1 }
  await expect(page.frameLocator('iframe[title="人审版蓝图"]').getByText('人审审片板样本')).toBeVisible()
  expect(boardReads).toBe(2)
  await expect(page.getByText(/internal_board_fixture|重新读取/)).toHaveCount(0)
  await page.getByText('整体意见',{exact:true,selector:'summary'}).click()
  await page.getByRole('textbox', { name: '整体意见' }).fill('补清拍法')
  await page.getByRole('button', {name:'提交意见'}).click()
  await page.getByRole('button', { name: '确认蓝图，开始制作' }).click()
  await expect(page.getByRole('heading', { name: '看片' })).toBeVisible()
  await expect(page.getByRole('img', { name: '参照画面' })).toHaveCount(0)
  await expect(page.getByText('同屏要有商品和佣金。')).toHaveCount(0)
  await expect(page.locator('.cm-final-comparison')).toHaveCount(0)
  await page.setViewportSize({ width: 375, height: 812 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
  await checkFinalReview(page)
  await expect(page.getByRole('button', { name: '确认并下载成片' })).toBeEnabled()
  await page.getByRole('textbox', { name: '修改意见' }).fill('修正片尾')
  await acknowledgeOverallFeedback(page)
  await page.getByRole('button', {name:'提交修改'}).click()
  await expect(page.getByRole('textbox', { name: '修改意见' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '确认并下载成片' })).toBeDisabled()
  await checkFinalReview(page)
  const downloadEvent=page.waitForEvent('download')
  await page.getByRole('button', { name: '确认并下载成片' }).click()
  const downloaded=await downloadEvent
  expect(downloaded.url()).toContain('view=panel_download')
  expect(downloaded.suggestedFilename()).toBe('JUDYDOLL-fixture.mp4')
  await expect(page.getByRole('link', { name: '下载成片' })).toHaveAttribute('href', /panel_download.*render-2/)
  expect(revisionPosts).toBe(2)
  expect(actions).toEqual(['start', 'revise_blueprint', 'approve_blueprint', 'revise_preview', 'accept'])
  expect(new URL(page.url()).pathname).toBe('/')
})

test('one confirmation starts both outputs without an audience choice',async({page})=>{
  await page.route('**/api/clipmentor/intake',route=>route.fulfill({json:{receipt:{projectId:'fixture',assets:['source.mp4','product.png','sales.png','cta.png'].map((name,i)=>({id:String(i),name}))}}}))
  let submitted=false
  const reviewEndings=[
    {id:'existing_partner',label:'已合作达人版',materials:[{id:'storyboard',name:'Storyboard.pdf'},{id:'product',name:'商品图.png'}]},
    {id:'new_contact',label:'新建联达人版',materials:[{id:'cta',name:'CTA.png'}]},
  ]
  await page.route('**/api/clipmentor/production*',async route=>{
    const request=route.request()
    if(new URL(request.url()).searchParams.get('view')==='panel_board'){
      await route.fulfill({contentType:'text/html',body:'<h2>修改后的蓝图</h2>'});return
    }
    if(request.method()==='POST'){
      expect(request.postDataJSON()).toMatchObject({action:'produce_versions',revision:'current-draft'})
      expect(request.postDataJSON()).not.toHaveProperty('audience')
      expect(request.postDataJSON().blueprintReview).toEqual({scope:'whole_blueprint'})
      submitted=true
      await route.fulfill({json:{accepted:true}});return
    }
    const audience=new URL(request.url()).searchParams.get('audience')
    await route.fulfill({json:submitted
      ?audience?{task:{taskId:audience,sourceTaskId:'original-task',status:audience==='new_contact'?'waiting':'running',stage:'copy_review',active:audience==='existing_partner',sequence:2,blueprintConfirmed:true,audience}}
        :{task:null,outputOwner:{taskId:'original-task',sequence:213},outputs:[{audience:'existing_partner'},{audience:'new_contact'}]}
      :{task:{...approvedFixtureReview,savedReview:undefined,reviewEndings,taskId:'original-task',status:'blocked',stage:'copy_review',active:false,sequence:212,revision:'old-review',blueprintRevision:'current-draft',canApproveBlueprint:false,canConfirmBlueprint:true,dualBlueprint:true}}})
  })
  await page.goto('/')
  await expect(page.frameLocator('iframe').getByText('修改后的蓝图')).toBeVisible()
  const confirm=page.getByRole('button',{name:'确认蓝图，开始制作'})
  await expect(page.getByRole('region',{name:'逐组人审'})).toHaveCount(0)
  await expect(page.getByRole('checkbox',{name:/已核对.*达人版/})).toHaveCount(0)
  await expect(page.getByLabel('意见针对哪里')).toHaveCount(0)
  await expect(confirm).toBeEnabled()
  await confirm.click()
  await expect(page.getByRole('heading',{name:'新建联达人版'})).toBeVisible()
  await expect(page.getByRole('heading',{name:'已合作达人版'})).toBeVisible()
  await expect(page.getByRole('region',{name:'新建联达人版',exact:true}).getByRole('status')).toContainText('等另一版剪完')
  expect(submitted).toBe(true)
})


test('both previews keep feedback, approval and downloads bound to their own ending',async({page})=>{
  await page.route('**/api/clipmentor/intake',route=>route.fulfill({json:{receipt:{projectId:'fixture',assets:['source.mp4','product.png','sales.png','cta.png'].map((name,i)=>({id:String(i),name}))}}}))
  const accepted=new Set<string>(),actions:string[]=[]
  await page.route('**/api/clipmentor/production*',async route=>{
    const request=route.request(),url=new URL(request.url()),audience=url.searchParams.get('audience')
    if(request.method()==='POST'){
      const body=request.postDataJSON()
      expect(['existing_partner','new_contact']).toContain(audience)
      expect(body.renderId).toBe(`render-${audience}`)
      actions.push(`${audience}:${body.action}`)
      if(body.action==='accept')accepted.add(audience!)
      await route.fulfill({json:{accepted:true}});return
    }
    if(url.searchParams.get('view')==='panel_download'){await route.fulfill({contentType:'video/mp4',headers:{'Content-Disposition':'attachment; filename=JUDYDOLL-fixture.mp4'},body:Buffer.from('fixture')});return}
    if(url.searchParams.get('view')==='panel_video'){await route.fulfill({body:Buffer.alloc(0),contentType:'video/mp4'});return}
    const productionDifferences=audience==='existing_partner'?{groups:[
      {label:'第 1 组',changes:[{before:'原句较长',after:'句子缩短，意思保留'}],kept:[]},
    ]}:undefined
    await route.fulfill({json:audience?{task:{taskId:audience,sourceTaskId:'parent',audience,status:accepted.has(audience)?'completed':'awaiting_review',canAcceptPreview:!accepted.has(audience),stage:'self_check',sequence:accepted.has(audience)?2:1,renderId:`render-${audience}`,active:false,feedbackUsed:false,productionDifferences}}
      :{task:null,outputOwner:{taskId:'parent',sequence:1},outputs:[{audience:'existing_partner'},{audience:'new_contact'}]}})
  })
  await page.goto('/')
  const existing=page.getByRole('tabpanel',{name:'已合作达人版'}),fresh=page.getByRole('tabpanel',{name:'新建联达人版'})
  await expect(existing.locator('video')).toHaveAttribute('src',/audience=existing_partner/)
  await expect(page.locator('video')).toHaveCount(1)
  await existing.getByText('制作调整',{exact:true}).click()
  await existing.getByText('第 1 组 · 修改对照',{exact:true}).click()
  await expect(existing.getByText('句子缩短，意思保留',{exact:true})).toBeVisible()
  await page.getByRole('tab',{name:/新建联达人版/}).click()
  await expect(fresh.locator('video')).toHaveAttribute('src',/audience=new_contact/)
  await expect(fresh.getByText('制作调整',{exact:true})).toHaveCount(0)
  expect(actions).toEqual([])
  await fresh.getByRole('textbox',{name:'修改意见'}).fill('只改新建联结尾')
  await acknowledgeOverallFeedback(fresh)
  await fresh.getByRole('button', {name:'提交修改'}).click()
  await page.getByRole('tab',{name:/已合作达人版/}).click()
  await checkFinalReview(existing)
  await existing.getByRole('button',{name:'确认并下载成片'}).click()
  await expect(existing.getByRole('link',{name:'下载成片'})).toHaveAttribute('href',/audience=existing_partner/)
  await page.getByRole('tab',{name:/新建联达人版/}).click()
  await expect(fresh.getByRole('link',{name:'下载成片'})).toHaveCount(0)
  await checkFinalReview(fresh)
  await fresh.getByRole('button',{name:'确认并下载成片'}).click()
  await expect(fresh.getByRole('link',{name:'下载成片'})).toHaveAttribute('href',/audience=new_contact/)
  expect(actions).toEqual(['new_contact:revise_preview','existing_partner:accept','new_contact:accept'])
})


test('blueprint approval has optional opinions even when the server returns legacy review fields',async({page})=>{
  await page.route('**/api/clipmentor/intake',route=>route.fulfill({json:{receipt:{projectId:'fixture',assets:['source','product','sales','cta'].map(id=>({id,name:id}))}}}))
  const writes:unknown[]=[]
  await page.route('**/api/clipmentor/production*',route=>{
    if(route.request().method()==='POST'){
      writes.push(route.request().postDataJSON())
      return route.fulfill({json:{accepted:true}})
    }
    return new URL(route.request().url()).searchParams.get('view')==='panel_board'
      ?route.fulfill({contentType:'text/html',headers:{'X-ClipMentor-Board-Identity':'current-board'},body:
        '<h2>审核蓝图</h2><label>第 1 组意见<textarea data-blueprint-opinion="u"></textarea></label><section><h2>片尾</h2><h3>新建联达人</h3><h3>已合作达人</h3><p>请核对佣金等合作数字是否正确。</p></section>'})
      :route.fulfill({json:{task:{status:'awaiting_blueprint',stage:'copy_review',active:false,sequence:1,
        blueprintRevision:'r1',boardIdentity:'current-board',canConfirmBlueprint:true,dualBlueprint:true,manualNarrationReview:true,
        reviewGroups:[{id:'u',label:'第 1 组'}],reviewEndings:[{id:'new_contact',label:'新建联达人',materials:[]}],
        savedReview:{groups:[{id:'u',stance:'changes',decision:'历史表态'}],endings:[]},
      }}})
  })
  await page.goto('/')
  const board=page.frameLocator('iframe')
  await expect(board.getByRole('textbox',{name:'第 1 组意见'})).toHaveValue('')
  await expect(page.getByLabel('整体意见',{exact:true})).toHaveValue('')
  for(const surface of [page,board]){
    await expect(surface.getByRole('checkbox')).toHaveCount(0)
    await expect(surface.getByRole('combobox')).toHaveCount(0)
    await expect(surface.getByText(/逐组确认|人工口播确认|两种片尾|片尾合作条款待核实|教达人改哪个决定|意见针对哪里/)).toHaveCount(0)
  }
  await expect(board.getByRole('heading',{name:'新建联达人'})).toBeVisible()
  await expect(board.getByRole('heading',{name:'已合作达人'})).toBeVisible()
  await expect(page.getByRole('button',{name:'提交意见'})).toBeDisabled()
  const confirm=page.getByRole('button',{name:'确认蓝图，开始制作'})
  await expect(confirm).toBeEnabled()
  expect(writes).toHaveLength(0)
  await confirm.click()
  expect(writes).toEqual([{
    action:'produce_versions',revision:'r1',boardIdentity:'current-board',blueprintReview:{scope:'whole_blueprint'},
  }])
})

test('the business board confirms saved feedback without printing an author summary or diagnostic',async({page})=>{
  const points=['INTERNAL_SUMMARY_SENTINEL 审核回执未绑定。']
  await page.route('**/api/clipmentor/intake',route=>route.fulfill({json:{receipt:{projectId:'fixture',assets:['source','product','sales','cta'].map(id=>({id,name:id}))}}}))
  await page.route('**/api/clipmentor/production*',route=>new URL(route.request().url()).searchParams.get('view')==='panel_board'
    ?route.fulfill({contentType:'text/html',body:'<h2>审核蓝图</h2>'})
    :route.fulfill({json:{task:{...approvedFixtureReview,status:'blocked',stage:'copy_review',active:false,sequence:1,blueprintRevision:'r1',hasBlueprintFeedback:true,blueprintFeedbackSummary:points,canConfirmBlueprint:true,
      reviewIssue:{kind:'binding',message:'INTERNAL_REVIEW_SENTINEL 维护回执 v3'}}}}))
  await page.goto('/')
  await expect(page.getByText('上次修改意见已保存。')).toBeVisible()
  await expect(page.getByRole('alert')).toHaveText('请刷新页面，查看最新版本。')
  await expect(page.getByText(/INTERNAL_SUMMARY_SENTINEL|INTERNAL_REVIEW_SENTINEL|审核回执|上次意见：/)).toHaveCount(0)
  await page.setViewportSize({width:375,height:812})
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
  await expect(page.getByRole('button',{name:'确认蓝图，开始制作'})).toBeEnabled()
})

test('board identity refreshes a changed sibling or requirement at the same draft revision', async ({ page }) => {
  await page.clock.install()
  await page.route('**/api/clipmentor/intake', route => route.fulfill({json:{receipt:{projectId:'fixture',assets:['source.mp4','product.png','sales.png','cta.png'].map((name,id)=>({id:String(id),name}))}}}))
  let identity='board-one', presentation='headings-old', reads=0
  await page.route('**/api/clipmentor/production*', async route => {
    const request=route.request(), url=new URL(request.url())
    if(url.searchParams.get('view')==='panel_board'){
      expect(url.searchParams.get('boardPresentation')).toBe(presentation)
      await route.fulfill({contentType:'text/html',headers:{'X-ClipMentor-Board-Identity':identity},body:`<h2>${identity} ${presentation}</h2>`});return
    }
    reads++
    await route.fulfill({json:{task:{taskId:'same-task',status:'awaiting_blueprint',stage:'copy_review',revision:'same-revision',active:false,sequence:1,boardIdentity:identity,boardPresentation:presentation}}})
  })
  await page.goto('/')
  await expect(page.frameLocator('iframe').getByText('board-one headings-old')).toBeVisible()
  const feedback=page.getByLabel('整体意见',{exact:true})
  if(!await feedback.isVisible())await page.getByText('整体意见',{exact:true,selector:'summary'}).click()
  await feedback.fill('保留同一蓝图的意见')
  presentation='headings-current'
  await page.clock.fastForward(8000)
  await expect(page.frameLocator('iframe').getByText('board-one headings-current')).toBeVisible()
  await expect(feedback).toHaveValue('保留同一蓝图的意见')
  identity='board-two'
  await page.clock.fastForward(8000)
  await expect.poll(()=>reads).toBeGreaterThan(1)
  await expect(page.frameLocator('iframe').getByText('board-two headings-current')).toBeVisible()
  await expect(feedback).toHaveValue('')
})

test('a late cache reload cannot replace a newer board', async ({ page }) => {
  await page.clock.install()
  await page.route('**/api/clipmentor/intake', route=>route.fulfill({json:{receipt:{projectId:'fixture',assets:['source.mp4','product.png','sales.png','cta.png'].map((name,id)=>({id:String(id),name}))}}}))
  let revision='r1', boardReads=0, release!:()=>void
  const held=new Promise<void>(resolve=>{release=resolve})
  await page.route('**/api/clipmentor/production*', async route=>{
    const request=route.request(),url=new URL(request.url())
    if(url.searchParams.get('view')==='panel_board'){
      const requested=url.searchParams.get('revision')!
      if(++boardReads===2)await held
      await route.fulfill({contentType:'text/html',body:`<h2>${requested}</h2>`}).catch(()=>{});return
    }
    if(request.method()==='POST'){await route.fulfill({status:409,json:{reason:'review_board_reload'}});return}
    await route.fulfill({json:{task:{taskId:'same-task',status:'awaiting_blueprint',stage:'copy_review',revision,active:false,sequence:revision==='r1'?1:2}}})
  })
  await page.goto('/')
  await expect(page.frameLocator('iframe').getByText('r1',{exact:true})).toBeVisible()
  if(!await page.getByLabel('整体意见',{exact:true}).isVisible())await page.getByText('整体意见',{exact:true,selector:'summary'}).click()
  await page.getByLabel('整体意见',{exact:true}).fill('update')
  await page.getByRole('button', {name:'提交意见'}).click()
  await expect.poll(()=>boardReads).toBe(2)
  revision='r2'
  await page.clock.fastForward(8000)
  await expect(page.frameLocator('iframe').getByText('r2',{exact:true})).toBeVisible()
  release()
  await expect(page.getByLabel('整体意见',{exact:true})).toHaveValue('')
  if(!await page.getByLabel('整体意见',{exact:true}).isVisible())await page.getByText('整体意见',{exact:true,selector:'summary'}).click()
  await page.getByLabel('整体意见',{exact:true}).fill('revise r2')
  await expect(page.getByRole('button',{name:'提交意见'})).toBeEnabled()
  await expect(page.frameLocator('iframe').getByText('r2',{exact:true})).toBeVisible()
})

test('connection failures remain visible after a saved state and clear on recovery', async ({ page }) => {
  await page.clock.install()
  await page.route('**/api/clipmentor/intake', route=>route.fulfill({json:{receipt:{projectId:'fixture',assets:['source.mp4','product.png','sales.png','cta.png'].map((name,id)=>({id:String(id),name}))}}}))
  let failing=false,reads=0
  await page.route('**/api/clipmentor/production*',async route=>{
    if(new URL(route.request().url()).searchParams.get('view')==='panel_board'){
      await route.fulfill({contentType:'text/html',body:'<h2>saved board</h2>'});return
    }
    reads++
    if(failing){await route.fulfill({status:503});return}
    await route.fulfill({json:{task:{taskId:'same-task',status:'awaiting_blueprint',stage:'copy_review',revision:'r1',active:false,sequence:1}}})
  })
  await page.goto('/')
  await expect(page.frameLocator('iframe').getByText('saved board')).toBeVisible()
  failing=true
  for(let n=0;n<3;n++){
    const before=reads
    await page.clock.fastForward(8000)
    await expect.poll(()=>reads).toBeGreaterThan(before)
  }
  await expect(page.getByRole('alert')).toContainText('正在重连')
  await expect(page.frameLocator('iframe').getByText('saved board')).toBeVisible()
  failing=false
  const before=reads
  await page.clock.fastForward(8000)
  await expect.poll(()=>reads).toBeGreaterThan(before)
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('late successful acceptance cannot download an older render', async ({ page }) => {
  await page.clock.install()
  await page.route('**/api/clipmentor/intake', route=>route.fulfill({json:{receipt:{projectId:'fixture',assets:['source.mp4','product.png','sales.png','cta.png'].map((name,id)=>({id:String(id),name}))}}}))
  let sequence=1, posts=0, downloads=0
  let release!:()=>void
  const held=new Promise<void>(resolve=>{release=resolve})
  await page.route('**/api/clipmentor/production*',async route=>{
    const request=route.request(),view=new URL(request.url()).searchParams.get('view')
    if(view==='panel_video'){await route.fulfill({status:404});return}
    if(view==='panel_download'){downloads++;await route.fulfill({status:404});return}
    if(request.method()==='POST'){
      expect(request.postDataJSON().renderId).toBe('render-1')
      posts++
      await held
      await route.fulfill({json:{accepted:true}}).catch(()=>{})
      return
    }
    await route.fulfill({json:{task:{taskId:'same-task',status:'awaiting_review', canAcceptPreview:true,stage:'self_check',sequence,renderId:`render-${sequence}`,active:false,feedbackUsed:false}}})
  })
  await page.goto('/')
  try{
    await page.getByRole('textbox',{name:'修改意见'}).fill('旧预览意见')
    await checkFinalReview(page)
    await page.getByRole('button',{name:'保留草稿并确认成片'}).click()
    await expect.poll(()=>posts).toBe(1)
    sequence=2
    await page.clock.fastForward(8000)
    await expect(page.locator('video')).toHaveAttribute('src',/render-2/)
    await expect(page.getByRole('textbox',{name:'修改意见'})).toHaveValue('')
    await page.getByRole('textbox',{name:'修改意见'}).fill('新预览意见')
    await checkFinalReview(page)
    release()
    await page.clock.runFor(50)
    await expect(page.getByRole('textbox',{name:'修改意见'})).toHaveValue('新预览意见')
    await expect(page.getByLabel('我已核对口播和字幕',{exact:true})).toBeChecked()
    expect(downloads).toBe(0)
  }finally{release()}
})

test('a poll started before a confirmed action cannot restore a different old task', async ({ page }) => {
  await page.clock.install()
  await page.route('**/api/clipmentor/intake',route=>route.fulfill({json:{receipt:{projectId:'fixture',assets:['source.mp4','product.png','sales.png','cta.png'].map((name,id)=>({id:String(id),name}))}}}))
  let posted=false,holdPoll=false,oldPollStarted=false
  let release!:()=>void
  const delayed=new Promise<void>(resolve=>{release=resolve})
  await page.route('**/api/clipmentor/production*',async route=>{
    const request=route.request(),url=new URL(request.url())
    if(url.searchParams.has('view')){
      await route.fulfill({contentType:'text/html',body:'<p>'+url.searchParams.get('revision')+'</p>'})
      return
    }
    if(request.method()==='POST'){
      posted=true
      await route.fulfill({json:{accepted:true}})
      return
    }
    const revision=posted?'new-board':'old-board'
    if(holdPoll&&!posted){
      holdPoll=false
      oldPollStarted=true
      await delayed
    }
    await route.fulfill({json:{task:{...approvedFixtureReview,taskId:revision,sequence:1,status:'awaiting_blueprint',stage:'copy_review',revision,active:false}}}).catch(()=>{})
  })
  const board=page.frameLocator('iframe')
  await page.goto('/')
  try{
    await expect(board.getByText('old-board')).toBeVisible()
    holdPoll=true
    await page.clock.fastForward(8000)
    await expect.poll(()=>oldPollStarted).toBe(true)
    await page.getByRole('button',{name:'确认蓝图，开始制作'}).click()
    await expect(board.getByText('new-board')).toBeVisible()
    const oldResponse=page.waitForResponse(response=>response.url().endsWith('/api/clipmentor/production')&&response.request().method()==='GET')
    release()
    await (await oldResponse).finished()
    await page.clock.runFor(100)
    await expect(board.getByText('new-board')).toBeVisible()
  }finally{release()}
})

test('an open two-output tab observes an externally persisted newer shared blueprint', async ({ page, context }) => {
  await page.clock.install()
  let changed=false
  await context.route('**/api/clipmentor/intake',route=>route.fulfill({json:{receipt:{projectId:'fixture',assets:['source','product','sales','cta'].map(id=>({id,name:id}))}}}))
  await context.route('**/api/clipmentor/production*',async route=>{
    const request=route.request(),url=new URL(request.url()),audience=url.searchParams.get('audience')
    if(url.searchParams.get('view')==='panel_board'){
      await route.fulfill({contentType:'text/html',body:'<h2>另一页保存的新蓝图</h2>'});return
    }
    if(url.searchParams.get('view')==='panel_video'){await route.fulfill({status:404});return}
    // The real handler ignores audience when the current parent has no children.
    await route.fulfill({json:changed
      ?{task:{taskId:'new-shared',status:'awaiting_blueprint',stage:'copy_review',revision:'new-draft',sequence:1,active:false}}
      :audience?{task:{taskId:audience,sourceTaskId:'old-shared',audience,status:'awaiting_review', canAcceptPreview:true,stage:'self_check',renderId:`old-${audience}`,sequence:1,active:false}}
        :{task:null,outputOwner:{taskId:'old-shared',sequence:1},outputs:[{audience:'existing_partner'},{audience:'new_contact'}]}})
  })
  await page.goto('/')
  await page.getByRole('tab',{name:/新建联达人版/}).click()
  await expect(page.getByRole('tabpanel',{name:'新建联达人版'}).locator('video')).toBeVisible()
  const other=await context.newPage()
  try{
    // Consumer-only fixture: a newer owning task has already been persisted.
    // Production control admission is exercised by the actual-handler integration.
    await other.goto('/')
    changed=true
    await page.clock.fastForward(8000)
    await expect(page.frameLocator('iframe').getByText('另一页保存的新蓝图')).toBeVisible()
    await expect(page.locator('video')).toHaveCount(0)
  }finally{await other.close()}
})

test('two tabs keep attachment and accepted download identities separate for both outputs', async ({ page, context }) => {
  await page.clock.install()
  const accepted=new Set<string>()
  await context.route('**/api/clipmentor/intake',route=>route.fulfill({json:{receipt:{projectId:'fixture',assets:['source','product','sales','cta'].map(id=>({id,name:id}))}}}))
  await context.route('**/api/clipmentor/production*',async route=>{
    const request=route.request(),url=new URL(request.url()),audience=url.searchParams.get('audience')
    if(url.searchParams.get('view')==='panel_video'){await route.fulfill({status:404});return}
    if(url.searchParams.get('view')==='panel_download'){
      await route.fulfill({contentType:'video/mp4',headers:{'Content-Disposition':`attachment; filename=${audience}.mp4`},body:Buffer.from(audience!)});return
    }
    if(request.method()==='POST'){
      expect(request.postDataJSON()).toMatchObject({action:'accept',renderId:`render-${audience}`,languageConfirmed:true})
      accepted.add(audience!)
      await route.fulfill({json:{accepted:true}});return
    }
    await route.fulfill({json:audience?{task:{taskId:audience,sourceTaskId:'parent',audience,status:accepted.has(audience)?'completed':'awaiting_review',canAcceptPreview:!accepted.has(audience),stage:'self_check',renderId:`render-${audience}`,sequence:accepted.has(audience)?2:1,active:false,attachments:[{assetId:`storyboard-${audience}`,fileName:`${audience}.html`}]}}
      :{task:null,outputOwner:{taskId:'parent',sequence:1},outputs:[{audience:'existing_partner'},{audience:'new_contact'}]}})
  })
  await page.goto('/')
  const other=await context.newPage()
  try{
    await other.goto('/')
    for(const [audience,title] of [['existing_partner','已合作达人版'],['new_contact','新建联达人版']] as const){
      const first=page.getByRole('tabpanel',{name:title,exact:true}),second=other.getByRole('tabpanel',{name:title,exact:true})
      for(const window of [page,other])await window.getByRole('tab',{name:new RegExp(title)}).click()
      const attachment=first.getByRole('link',{name:'下载原片分镜（PDF）'})
      const url=new URL((await attachment.getAttribute('href'))!,'http://fixture')
      expect(Object.fromEntries(url.searchParams)).toEqual({view:'panel_attachment',renderId:`render-${audience}`,audience,assetId:`storyboard-${audience}`})
      await checkFinalReview(second)
      const download=other.waitForEvent('download')
      await second.getByRole('button',{name:'确认并下载成片'}).click()
      const downloaded=await download
      const downloadUrl=new URL(downloaded.url())
      expect(Object.fromEntries(downloadUrl.searchParams)).toEqual({view:'panel_download',renderId:`render-${audience}`,audience})
      await page.clock.fastForward(8000)
      await expect(first.getByRole('link',{name:'下载成片',exact:true})).toHaveAttribute('href',new RegExp(`renderId=render-${audience}&audience=${audience}`))
      await expect(first.getByRole('checkbox')).toHaveCount(0)
    }
  }finally{await other.close()}
})

test('reopening the panel reads the saved acceptance without replaying the action', async ({ page }) => {
  await page.route('**/api/clipmentor/intake',route=>route.fulfill({json:{receipt:{projectId:'fixture',assets:['source.mp4','product.png','sales.png','cta.png'].map((name,id)=>({id:String(id),name}))}}}))
  let posts=0,downloadRequests=0
  let release!:()=>void
  const held=new Promise<void>(resolve=>{release=resolve})
  await page.route('**/api/clipmentor/production*',async route=>{
    const request=route.request(),view=new URL(request.url()).searchParams.get('view')
    if(view==='panel_download'){downloadRequests++;await route.fulfill({status:404});return}
    if(view==='panel_video'){await route.fulfill({status:404});return}
    if(request.method()==='POST'){
      expect(request.postDataJSON().action).toBe('accept')
      posts++
      await held
      await route.fulfill({json:{accepted:true}}).catch(()=>{})
      return
    }
    await route.fulfill({json:{task:{taskId:'one-job',status:posts?'completed':'awaiting_review',canAcceptPreview:!posts,stage:'self_check',sequence:posts+1,renderId:'approved-render',active:false,feedbackUsed:false}}})
  })
  await page.goto('/')
  try{
    await checkFinalReview(page)
    await page.getByRole('button',{name:'确认并下载成片'}).click()
    await expect.poll(()=>posts).toBe(1)
    await page.reload()
    await expect(page.getByRole('link',{name:'下载成片',exact:true})).toHaveAttribute('href',/renderId=approved-render/)
    release()
    expect(posts).toBe(1)
    expect(downloadRequests).toBe(0)
  }finally{release()}
})

test('teaching excerpt loads only from the current sandboxed review board', async ({page}) => {
  const identity = 'fixture-excerpt-identity'
  let requests = 0
  await page.route('**/api/clipmentor/intake', route => route.fulfill({json:{receipt:{
    projectId:'fixture',assets:['source','product','sales','cta'].map(id=>({id,name:id})),
  }}}))
  await page.route('**/api/clipmentor/production*', async route => {
    const query = new URL(route.request().url()).searchParams
    if (query.get('view') !== 'panel_board') {
      await route.fulfill({json:{task:{status:'awaiting_blueprint',stage:'copy_review',active:false,sequence:1,
        boardIdentity:identity,blueprintRevision:'saved-motion',dualBlueprint:true}}})
      return
    }
    expect(query.get('boardIdentity')).toBe(identity)
    expect(query.get('revision')).toBe('saved-motion')
    if (query.get('excerpt') === '1') {
      requests++
      await route.fulfill({contentType:'video/mp4',headers:{'X-ClipMentor-Board-Identity':requests===1?'wrong':identity},body:'mp4-fixture'})
      return
    }
    await route.fulfill({contentType:'text/html',headers:{'X-ClipMentor-Board-Identity':identity},body:`
      <button id="request">看回看示意</button><p id="status" role="status"></p>
      <script>
        document.querySelector('#request').onclick=()=>parent.postMessage({type:'clipmentor:request-teaching-excerpt'},new URL(document.baseURI).origin)
        addEventListener('message', event => {
          if(event.source===parent&&event.data?.type==='clipmentor:teaching-excerpt'){
            document.querySelector('#status').textContent=event.data.bytes?'已收到预览':'暂时无法播放'
          }
        })
      </script>`})
  })
  await page.goto('/')
  const board=page.frameLocator('iframe[title="人审版蓝图"]')
  await expect(board.getByRole('button',{name:'看回看示意'})).toBeVisible()
  await page.evaluate(()=>window.postMessage({type:'clipmentor:request-teaching-excerpt'},location.origin))
  await expect(board.getByRole('status')).toBeEmpty()
  expect(requests).toBe(0)
  await board.getByRole('button',{name:'看回看示意'}).click()
  await expect(board.getByRole('status')).toHaveText('暂时无法播放')
  await board.getByRole('button',{name:'看回看示意'}).click()
  await expect(board.getByRole('status')).toHaveText('已收到预览')
  expect(requests).toBe(2)
})

test('materials and a paused blueprint have no maintenance upload controls', async ({ page }) => {
  await page.route('**/api/clipmentor/intake', route => route.fulfill({ json: {
    receipt: { projectId: 'fixture', assets: ['source.mp4','product.png','sales.png','cta.png'].map((name,id)=>({id:String(id),name})) },
  } }))
  let task: Record<string,unknown>|null=null
  const posts: Array<Record<string,unknown>>=[]
  await page.route('**/api/clipmentor/production*',route=>{
    if(route.request().method()==='GET')return route.fulfill({json:{task}})
    posts.push(route.request().postDataJSON())
    task={taskId:'fixture-task',status:'blocked',stage:'blueprint',revision:'saved-candidate',sequence:9,active:false,
      stopReason:'maintenance',stopDetail:'INTERNAL_REPAIR_SENTINEL',feedbackUsed:false,
      canBindSourceRequirements:true,canResumeBoundRequirements:true}
    return route.fulfill({json:{accepted:true}})
  })
  await page.goto('/')
  const start=page.getByRole('button',{name:'开始制作',exact:true})
  await expect(start).toBeEnabled()
  await expect(page.locator('input[type=file]')).toHaveCount(0)
  await start.click()
  await expect(page.getByText('已暂停，进度已保存，无需重新上传。')).toBeVisible()
  await expect(page.getByText('INTERNAL_REPAIR_SENTINEL')).toHaveCount(0)
  await expect(page.getByText('项目要求')).toHaveCount(0)
  await expect(page.locator('input[type=file]')).toHaveCount(0)
  expect(posts).toHaveLength(1)
  expect(posts[0]).toEqual(expect.objectContaining({action:'start'}))
  expect(posts[0]).not.toHaveProperty('doneCriteria')
})

test('intake for another project uses the same neutral upload instructions', async ({page}) => {
  await page.route('**/api/clipmentor/intake',route=>route.fulfill({json:{receipt:null}}))
  await page.goto('/')
  await expect(page.getByRole('heading',{name:'上传制作素材'})).toBeVisible()
  await expect(page.getByText('上传原片、商品图、销量截图和合作海报。')).toBeVisible()
  await expect(page.getByText(/JUDYDOLL/)).toHaveCount(0)
})

test('a saved blueprint opens with a missing upload and restores only its registered slot', async ({ page }) => {
  const assets = ['source.mp4', 'product.png', 'sales.png', 'cta.png'].map((name, index) => ({
    id: String(index), name, sourceContentHash: index === 3 ? createHash('sha256').update(image.buffer).digest('hex') : String(index).repeat(64),
  }))
  const receipt = { projectId: 'saved-project', assets }
  let repaired = false, submissions = 0
  await page.route('**/api/clipmentor/intake', async route => {
    if (route.request().method() === 'POST') {
      submissions++
      const multipart = route.request().postDataBuffer()!.toString('latin1')
      expect(multipart).toContain('name="cta"')
      expect(multipart).not.toMatch(/name="(?:source|product|sales)"/)
      repaired = true
      return route.fulfill({ json: receipt })
    }
    return route.fulfill({ json: { receipt: repaired ? receipt : null, ...(!repaired && { repair: { ...receipt, missingSlots: ['cta'] } }) } })
  })
  await page.route('**/api/clipmentor/production*', route => {
    const params = new URL(route.request().url()).searchParams
    if (params.get('view') === 'panel_board') {
      expect(params.get('revision')).toBe('saved-revision')
      return route.fulfill({ contentType: 'text/html', body: '<h2>同一个双结尾蓝图</h2>' })
    }
    expect(route.request().method()).toBe('GET')
    return route.fulfill({ json: { task: {
      taskId: 'saved-task', status: 'awaiting_blueprint', stage: 'copy_review', active: false,
      blueprintRevision: 'saved-revision', sequence: 17,
    } } })
  })
  await page.goto('/')
  await expect(page.frameLocator('iframe').getByText('同一个双结尾蓝图')).toBeVisible()
  await expect(page.getByRole('heading', { name: '补传缺少的素材' })).toBeVisible()
  await expect(page.locator('input[type=file]')).toHaveCount(1)
  await page.getByLabel('合作海报', { exact: true }).setInputFiles({ ...image, name: 'local.png' })
  await page.getByRole('button', { name: '补传素材' }).click()
  await expect(page.getByRole('heading', { name: '补传缺少的素材' })).toHaveCount(0)
  await expect(page.frameLocator('iframe').getByText('同一个双结尾蓝图')).toBeVisible()
  expect(submissions).toBe(1)
})

test('a recovered board can be opened in place after the read retries stop', async ({ page }) => {
  await page.clock.install()
  let boardReads = 0, healthy = false
  await page.route('**/api/clipmentor/intake', route => route.fulfill({ json: { receipt: {
    projectId: 'fixture', assets: ['source', 'product', 'sales', 'cta'].map(id => ({ id, name: id })),
  } } }))
  await page.route('**/api/clipmentor/production*', route => {
    if (new URL(route.request().url()).searchParams.get('view') === 'panel_board') {
      boardReads++
      if (healthy) return route.fulfill({ contentType: 'text/html', body: '<h2>恢复的原版审核板</h2>' })
      if (boardReads === 1) return route.fulfill({ json: { error: 'temporary read failure' } })
      if (boardReads === 2) return route.fulfill({ contentType: 'text/html', body: '  ' })
      return route.fulfill({ status: 503 })
    }
    return route.fulfill({ json: { task: { taskId: 'existing-task', status: 'awaiting_blueprint', stage: 'copy_review', active: false, sequence: 1, blueprintRevision: 'r1' } } })
  })
  await page.goto('/')
  await expect.poll(() => boardReads).toBe(1)
  await page.clock.fastForward(2000)
  await expect.poll(() => boardReads).toBe(2)
  await page.clock.fastForward(2000)
  const reload = page.getByRole('button', { name: '重新打开蓝图' })
  await expect(reload).toBeVisible()
  expect(boardReads).toBe(3)
  const text = page.getByRole('textbox', { name: '整体意见' })
  if(!await text.isVisible())await page.getByText('整体意见',{exact:true,selector:'summary'}).click()
  await text.fill('保留当前意见')
  await expect(page.getByRole('button', { name: '提交意见' })).toBeDisabled()
  healthy = true
  await reload.click()
  await expect(page.frameLocator('iframe').getByText('恢复的原版审核板')).toBeVisible()
  await expect(text).toHaveValue('保留当前意见')
  await expect(page.getByRole('button', { name: '提交意见' })).toBeEnabled()
})

test('restore a registered source by its bytes when the browser cannot decode its codec', async ({ page }) => {
  const original = Buffer.from('opaque registered video bytes')
  const hash = createHash('sha256').update(original).digest('hex')
  const assets = ['camera.mov', 'product.png', 'sales.png', 'cta.png'].map((name, i) => ({
    id: String(i), name, sourceContentHash: i === 0 ? hash : String(i).repeat(64),
  }))
  const receipt = { projectId: 'existing-project', assets }
  let posts = 0
  await page.route('**/api/clipmentor/intake', route => {
    if (route.request().method() === 'POST') {
      posts++
      expect(route.request().postDataBuffer()?.includes(original)).toBe(true)
      return route.fulfill({ json: receipt })
    }
    return route.fulfill({ json: { receipt: null, repair: { ...receipt, missingSlots: ['source'] } } })
  })
  await page.route('**/api/clipmentor/production', route => route.fulfill({ json: { task: null } }))
  await page.goto('/')
  const file = page.getByLabel('爆款原片', { exact: true })
  const submit = page.getByRole('button', { name: '补传素材' })
  await file.setInputFiles({ name: 'wrong.mov', mimeType: 'video/quicktime', buffer: Buffer.from('other bytes') })
  await expect(page.getByText('这份文件与原来上传的不一致，请选原文件。')).toBeVisible()
  await expect(submit).toBeDisabled()
  await file.setInputFiles({ name: 'renamed.mov', mimeType: 'video/quicktime', buffer: original })
  await expect(submit).toBeEnabled()
  await submit.click()
  await expect(page.getByRole('heading', { name: '素材已上传' })).toBeVisible()
  expect(posts).toBe(1)
})

test('a repair cannot adopt a different asset manifest from the same project', async ({ page }) => {
  const hash = createHash('sha256').update(image.buffer).digest('hex')
  const assets = ['source.mp4', 'product.png', 'sales.png', 'cta.png'].map((name, i) => ({
    id: 'original-' + i, name, sourceContentHash: i === 3 ? hash : String(i).repeat(64),
  }))
  const receipt = { projectId: 'same-project', assets }
  const changed = { ...receipt, assets: [{ ...assets[0], id: 'another-source' }, ...assets.slice(1)] }
  let posts = 0
  await page.route('**/api/clipmentor/intake', route => {
    if (route.request().method() === 'POST') {
      posts++
      return route.fulfill({ json: changed })
    }
    return route.fulfill({ json: posts ? { receipt: changed } : { receipt: null, repair: { ...receipt, missingSlots: ['cta'] } } })
  })
  await page.route('**/api/clipmentor/production', route => route.fulfill({ json: { task: null } }))
  await page.goto('/')
  await page.getByLabel('合作海报', { exact: true }).setInputFiles(image)
  await page.getByRole('button', { name: '补传素材' }).click()
  await expect(page.getByRole('alert')).toHaveText('任务已更新，请刷新后再查看素材。')
  await expect(page.getByRole('heading', { name: '补传缺少的素材' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '素材已上传' })).toHaveCount(0)
  expect(posts).toBe(1)
})

test('pending preview keeps a timed opinion across variant and review changes without early submission', async ({ page }) => {
  await page.clock.install()
  await page.setViewportSize({width:360,height:780})
  const clip=await readFile(source)
  const posts:unknown[]=[]
  let reviewed=false
  await page.route('**/api/clipmentor/intake',route=>route.fulfill({json:{receipt:{projectId:'fixture',assets:['source','product','sales','cta'].map(id=>({id,name:id}))}}}))
  await page.route('**/api/clipmentor/production*',async route=>{
    const request=route.request(),url=new URL(request.url())
    const audience=url.searchParams.get('audience')
    if(request.method()==='POST'){
      posts.push(request.postDataJSON())
      await route.fulfill({json:{accepted:true}});return
    }
    if(url.searchParams.get('view')==='panel_video'){
      const match=/^bytes=(\d+)-(\d*)$/.exec(request.headers()['range']??'')
      const headers={'Accept-Ranges':'bytes'}
      if(!match){await route.fulfill({contentType:'video/webm',headers,body:clip});return}
      const start=Number(match[1]),end=match[2]?Math.min(clip.length-1,Number(match[2])):clip.length-1
      await route.fulfill({status:206,contentType:'video/webm',headers:{...headers,'Content-Range':`bytes ${start}-${end}/${clip.length}`},body:clip.subarray(start,end+1)})
      return
    }
    if(!audience){await route.fulfill({json:{task:null,outputOwner:{taskId:'parent',sequence:1},outputs:[{audience:'existing_partner'},{audience:'new_contact'}]}});return}
    if(audience==='new_contact'){
      await route.fulfill({json:{task:{taskId:audience,sourceTaskId:'parent',audience,sequence:1,status:'waiting',stage:'copy_review',active:false,blueprintConfirmed:true}}});return
    }
    await route.fulfill({json:{task:{taskId:audience,sourceTaskId:'parent',audience,sequence:reviewed?2:1,status:reviewed?'awaiting_review':'blocked',stage:'self_check',active:false,blueprintConfirmed:true,
      renderId:'existing-render',previewPending:!reviewed,previewReviewed:reviewed,canAcceptPreview:reviewed,previewDuration:.2,
      ...(reviewed?{visualCriteria:{digest:'reviewed-digest'}}:{}),
      previewChapters:[{id:'group',label:'第 1 组',seconds:.12}],reviewGroups:[{id:'group',label:'第 1 组'}]}}})
  })
  await page.goto('/')
  const tab=page.getByRole('tab',{name:/已合作达人版/})
  const panel=page.getByRole('tabpanel',{name:'已合作达人版'})
  await expect(tab).toHaveAttribute('aria-selected','true')
  await expect(panel.getByRole('button',{name:'在这里提意见',exact:true})).toBeEnabled()
  await panel.getByRole('navigation',{name:'视频章节'}).getByRole('button',{name:/第 1 组/}).click()
  await expect.poll(()=>panel.locator('video').evaluate((video:HTMLVideoElement)=>video.currentTime)).toBeCloseTo(.12,2)
  await panel.getByRole('button',{name:'在这里提意见',exact:true}).click()
  await expect(panel.getByLabel('开始（秒）')).not.toHaveValue('')
  await panel.getByLabel('结束（秒）').fill('0.19')
  await panel.getByRole('textbox',{name:'修改意见'}).fill('检查工具移开的时机')
  await expect(panel.getByRole('button',{name:'提交修改'})).toBeDisabled()
  await expect(panel.getByRole('button',{name:'确认并下载成片'})).toBeDisabled()
  await expect(page.locator('[href*="panel_download"]')).toHaveCount(0)
  await tab.press('ArrowRight')
  await expect(page.getByRole('tab',{name:/新建联达人版/})).toHaveAttribute('aria-selected','true')
  await expect(page.locator('video')).toHaveCount(0)
  await page.getByRole('tab',{name:/新建联达人版/}).press('ArrowLeft')
  await expect(panel.getByRole('textbox',{name:'修改意见'})).toHaveValue('检查工具移开的时机')
  expect(posts).toHaveLength(0)
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(360)
  reviewed=true
  await page.clock.fastForward(8000)
  await expect(panel.getByRole('button',{name:'提交修改'})).toBeEnabled()
  await expect(panel.getByRole('textbox',{name:'修改意见'})).toHaveValue('检查工具移开的时机')
  await panel.getByRole('button',{name:'提交修改'}).click()
  expect(posts).toHaveLength(1)
  expect(posts[0]).toMatchObject({action:'revise_preview',renderId:'existing-render',feedbackTarget:{scope:'range',end:.19}})
})
