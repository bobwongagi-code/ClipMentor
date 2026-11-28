import { expect, test, type Page, type Route } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { checkFinalReview } from '../review-controls'

const production='**/api/clipmentor/production*'
const groups=[{id:'two',label:'第 2 组'}]
const base={active:false,feedbackUsed:false,sequence:1}
const assets=['source','product','sales','cta'].map(id=>({id,name:id}))
const clip=await readFile(new URL('../fixtures/preflight.webm',import.meta.url))

async function stubIntake(page:Page) {
  await page.route('**/api/clipmentor/intake',route=>route.fulfill({json:{receipt:{projectId:'review-fixture',assets}}}))
}

function previewVideo(route:Route){
  const match=/^bytes=(\d+)-(\d*)$/.exec(route.request().headers()['range']??'')
  const headers={'Accept-Ranges':'bytes'}
  if(!match)return route.fulfill({contentType:'video/webm',headers,body:clip})
  const start=Number(match[1]),end=match[2]?Math.min(clip.length-1,Number(match[2])):clip.length-1
  return route.fulfill({status:206,contentType:'video/webm',headers:{...headers,'Content-Range':`bytes ${start}-${end}/${clip.length}`},
    body:clip.subarray(start,end+1)})
}

test('a fixed-project board restores both drafts and keeps confirm blocked on refresh',async({page})=>{
  await page.setViewportSize({width:360,height:780})
  const context=page.context()
  await context.route('**/api/clipmentor/intake',route=>route.fulfill({json:{receipt:{projectId:'review-fixture',assets}}}))
  let revision='board-one'
  await context.route(production,route=>{
    if(route.request().method()==='POST')return route.fulfill({json:{opinionPlacements:[{index:0,unitId:'two',label:'第 2 组'}]}})
    const view=new URL(route.request().url()).searchParams.get('view')
    if(view==='panel_board')return route.fulfill({contentType:'text/html',headers:{'X-ClipMentor-Board-Identity':revision},body:`
      <meta charset="UTF-8"><details><summary>第 2 组意见</summary><textarea aria-label="第 2 组意见"></textarea></details>
      <script>
        const field=document.querySelector('textarea');
        field.addEventListener('input',()=>parent.postMessage({type:'clipmentor:blueprint-opinion',unitId:'two',text:field.value},'*'));
        addEventListener('message',event=>{
          if(event.source!==parent||event.data?.type!=='clipmentor:blueprint-opinion-draft'||!Array.isArray(event.data.entries))return;
          field.value=event.data.entries.find(item=>item.unitId==='two')?.text??'';
          field.closest('details').open=Boolean(field.value);
        });
      </script>`})
    return route.fulfill({json:{task:{...base,taskId:'board-task',status:'awaiting_blueprint',stage:'copy_review',blueprintRevision:revision,
      boardIdentity:revision,canConfirmBlueprint:true,dualBlueprint:true,reviewGroups:groups}}})
  })
  await page.goto('/')
  const board=page.frameLocator('iframe[title="人审版蓝图"]')
  const group=board.getByRole('textbox',{name:'第 2 组意见'})
  const overall=page.getByLabel('整体意见',{exact:true})
  const confirm=page.getByRole('button',{name:'确认蓝图，开始制作'})
  await board.getByText('第 2 组意见').click()
  await group.fill('恢复第二组意见')
  await expect(page.getByRole('button',{name:'第 2 组',exact:true})).toBeVisible()
  const submit=page.getByRole('button',{name:'提交意见',exact:true})
  const button=await submit.boundingBox()
  expect.soft(button!.y+button!.height).toBeLessThanOrEqual(780)
  if(!await overall.isVisible())await page.getByText('整体意见',{exact:true,selector:'summary'}).click()
  await overall.fill('恢复整体意见')
  await page.reload()
  await expect(overall).toHaveValue('恢复整体意见')
  await expect(group).toHaveValue('恢复第二组意见')
  await expect(confirm).toBeDisabled()
  const other=await context.newPage()
  await other.goto(page.url())
  const otherGroup=other.frameLocator('iframe[title="人审版蓝图"]').getByRole('textbox',{name:'第 2 组意见'})
  await expect(otherGroup).toHaveValue('恢复第二组意见')
  await group.fill('另一窗口更新的意见')
  await expect(otherGroup).toHaveValue('另一窗口更新的意见')
  await other.close()
  await submit.click()
  await expect(page.getByRole('button',{name:'移动',exact:true})).toBeInViewport()
  await page.getByRole('button',{name:'留在原处',exact:true}).click()
  revision='board-two'
  await page.reload()
  await expect(overall).toHaveValue('')
  await expect(confirm).toBeEnabled()
})

test('preview feedback requires an explicit choice before final confirmation',async({page})=>{
  await stubIntake(page)
  const posts:Array<{action:string;text?:string}>=[]
  let status='awaiting_review'
  let pending=true
  let failAcceptance=true
  await page.route(production,async route=>{
    const url=new URL(route.request().url())
    if(url.searchParams.get('view')==='panel_video')return previewVideo(route)
    if(url.searchParams.get('view')==='panel_download')return route.fulfill({status:200,body:'fixture'})
    if(route.request().method()==='POST'){
      posts.push(route.request().postDataJSON())
      if(failAcceptance)return route.fulfill({status:409,json:{error:'fixture rejected'}})
      status='completed';pending=false
      return route.fulfill({json:{accepted:true}})
    }
    return route.fulfill({json:{task:{...base,taskId:'preview-task',status,stage:'self_check',canAcceptPreview:true,
      renderId:'reviewed-cut',previewReviewed:true,previewDuration:111.15,reviewGroups:groups,sequence:pending?1:2}}})
  })
  await page.goto('/')
  const opinion=page.getByRole('textbox',{name:'修改意见'})
  const approve=page.getByRole('button',{name:'确认并下载成片',exact:true})
  await opinion.fill('我打算修改这一版')
  await page.getByLabel('意见针对哪里').selectOption('range')
  await page.getByLabel('开始（秒）').fill('40.93')
  await page.getByLabel('结束（秒）').fill('15')
  await expect(page.getByText('结束时间要晚于开始时间。')).toBeVisible()
  await expect(page.getByRole('button',{name:'提交修改'})).toBeDisabled()
  await checkFinalReview(page)
  await expect(approve).toBeDisabled()
  expect(posts).toHaveLength(0)
  await page.getByRole('button',{name:'保留草稿并确认成片'}).click()
  await expect(page.getByText('操作还没完成，请稍后再看。')).toBeVisible()
  expect(posts).toHaveLength(1)
  await expect(opinion).toHaveValue('我打算修改这一版')
  await page.reload()
  await expect(opinion).toHaveValue('我打算修改这一版')
  await page.getByRole('button',{name:'放弃草稿'}).click()
  await expect(opinion).toHaveValue('')
  expect(posts).toHaveLength(1)
  await page.reload()
  await expect(opinion).toHaveValue('')
  await opinion.fill('我打算修改这一版')
  await checkFinalReview(page)
  failAcceptance=false
  await page.getByRole('button',{name:'保留草稿并确认成片'}).click()
  await expect(page.getByText('我打算修改这一版',{exact:true})).toBeVisible()
  expect(posts).toHaveLength(2)
  expect(posts.every(post=>post.action==='accept'&&post.text===undefined)).toBe(true)
})

test('a late media update cannot undo a chapter jump during an immediate version switch',async({page})=>{
  await page.setViewportSize({width:320,height:640})
  await stubIntake(page)
  await page.route(production,route=>{
    const url=new URL(route.request().url())
    const audience=url.searchParams.get('audience')
    if(url.searchParams.get('view')==='panel_video')return previewVideo(route)
    return route.fulfill({json:audience?{task:{...base,taskId:audience,sourceTaskId:'parent',audience,stage:'self_check',blueprintConfirmed:true,
      status:audience==='existing_partner'?'awaiting_review':'blocked',renderId:audience==='existing_partner'?'preview-cut':undefined,
      previewChapters:[{id:'two',label:'第 2 组',seconds:.12}]}}
      :{task:null,outputOwner:{taskId:'parent',sequence:1},outputs:[{audience:'existing_partner'},{audience:'new_contact'}]}})
  })
  await page.goto('/')
  const video=page.locator('video')
  await expect.poll(()=>video.evaluate(media=>Number.isFinite((media as HTMLVideoElement).duration))).toBe(true)
  const player=await video.boundingBox()
  expect.soft(player!.y+player!.height).toBeLessThanOrEqual(640)
  await page.evaluate(()=>{
    const player=document.querySelector('video')!
    const time=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'currentTime')!
    Object.defineProperty(player,'currentTime',{get:()=>time.get!.call(player),set:value=>{
      // Make Chromium deliver the previous position before the new seek settles.
      player.dispatchEvent(new Event('timeupdate',{bubbles:true}))
      time.set!.call(player,value)
    }})
    document.querySelector<HTMLButtonElement>('.cm-preview-chapters button')!.click()
    document.querySelector<HTMLButtonElement>('button[role=tab][id$=new_contact]')!.click()
  })
  await expect(page.getByRole('tab',{name:/新建联达人版/})).toHaveAttribute('aria-selected','true')
  await page.getByRole('tab',{name:/已合作达人版/}).click()
  await expect.poll(()=>video.evaluate(media=>(media as HTMLVideoElement).currentTime)).toBeCloseTo(.12,2)
})
