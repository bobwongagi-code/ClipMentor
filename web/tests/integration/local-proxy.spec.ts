import { createServer } from 'node:http'
import { expect, test } from '@playwright/test'

test('the local dev proxy preserves the board identity in both directions', async ({ page }) => {
  const identity = 'a'.repeat(64)
  const upstream = createServer((req,res) => {
    const url = new URL(req.url!, 'http://localhost')
    switch (url.searchParams.get('view')) {
      case 'panel_board':
        if (url.searchParams.get('boardIdentity') !== identity) {
          res.writeHead(409).end('wrong board identity')
          return
        }
        res.writeHead(200, { 'content-type':'text/html', 'X-ClipMentor-Board-Identity':identity }).end('<p>Current board</p>')
        return
      case 'panel':
        res.writeHead(200, { 'content-type':'application/json' }).end(JSON.stringify({task:{
          taskId:'current', status:'awaiting_blueprint', stage:'copy_review', blueprintRevision:'r1', boardIdentity:identity, active:false, sequence:1,
        }}))
        return
    }
    res.writeHead(200, { 'content-type':'application/json' }).end(JSON.stringify({receipt:{
      projectId:'test-fixture',assets:['source.mp4','product.png','sales.png','cta.png'].map((name,id)=>({id:String(id),name})),
    }}))
  })
  // Bind the actual dev proxy's isolated upstream port first. If it is already in use,
  // fail before visiting the page so the case cannot touch a real project.
  await new Promise<void>((resolve,reject)=>upstream.once('error',reject).listen(15399,'127.0.0.1',resolve))
  try {
    await page.goto('/')
    await expect(page.frameLocator('iframe').getByText('Current board')).toBeVisible()
    await expect(page.getByRole('button',{name:'确认蓝图，开始制作'})).toBeEnabled()
    const stale=await page.evaluate(async ()=>(await fetch('/api/clipmentor/production?view=panel_board&revision=r1&boardIdentity=stale')).status)
    expect(stale).toBe(409)
  } finally {
    upstream.closeAllConnections()
    await new Promise<void>((resolve,reject)=>upstream.close(error=>error?reject(error):resolve()))
  }
})
