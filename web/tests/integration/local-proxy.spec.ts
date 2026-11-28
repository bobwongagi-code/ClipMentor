import {approvedFixtureReview} from '../review-controls'
import { createServer, request } from 'node:http'
import { expect, test } from '@playwright/test'
import { createServer as createViteServer } from 'vite'

test('the local dev proxy preserves the board identity in both directions', async ({ page }) => {
  const identity = 'a'.repeat(64)
  const presentation = 'current-headings'
  const upstream = createServer((req,res) => {
    const url = new URL(req.url!, 'http://localhost')
    switch (url.searchParams.get('view')) {
      case 'panel_board':
        if (url.searchParams.get('boardIdentity') !== identity || url.searchParams.get('boardPresentation') !== presentation) {
          res.writeHead(409).end('wrong board identity')
          return
        }
        res.writeHead(200, { 'content-type':'text/html', 'X-ClipMentor-Board-Identity':identity }).end('<p>Current board</p>')
        return
      case 'panel':
        res.writeHead(200, { 'content-type':'application/json' }).end(JSON.stringify({task:{
          ...approvedFixtureReview,taskId:'current', status:'awaiting_blueprint', stage:'copy_review', blueprintRevision:'r1', boardIdentity:identity, boardPresentation:presentation, active:false, sequence:1,
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

test('workspace dev proxy routes only the selected task to its saved inputs',async({page})=>{
  const id='workspace-project'
  const calls:string[]=[]
  const upstream=createServer(async(req,res)=>{
    const url=new URL(req.url!, 'http://localhost')
    calls.push(`${url.pathname}:${url.searchParams.get('projectId')??''}`)
    expect(req.headers['sec-fetch-site']).toBe('same-origin')
    if(req.method==='POST'&&url.pathname.endsWith('/task-workspace')){
      let body=''
      for await (const chunk of req)body+=chunk
      res.writeHead(201,{'Content-Type':'application/json'}).end(body)
      return
    }
    if(url.searchParams.get('view')==='panel_video'){
      expect(req.headers.range).toBe('bytes=2-4')
      res.writeHead(206,{'Content-Type':'video/mp4','Content-Range':'bytes 2-4/9','Content-Length':'3','Accept-Ranges':'bytes'})
      if(url.searchParams.get('renderId')==='truncated'){
        res.write('2',()=>setTimeout(()=>res.destroy(),20))
      }else res.end('234')
      return
    }
    const data=url.pathname.endsWith('/task-workspace')
      ?{running:0,limit:5,tasks:[{id,name:'示例任务',status:'materials',updatedAt:1,outputs:[]}]}
      :url.searchParams.get('projectId')!==id?null
        :url.pathname.endsWith('/material-intake')?{receipt:{projectId:id,assets:['source.mp4','product.png','sales.png','cta.png'].map((name,id)=>({name,id:String(id)}))}}
        :{task:null}
    res.writeHead(data?200:404,{'Content-Type':'application/json'}).end(JSON.stringify(data))
  })
  await new Promise<void>((resolve,reject)=>upstream.once('error',reject).listen(0,'127.0.0.1',resolve))
  const address=upstream.address()
  if(!address||typeof address==='string')throw Error('Workspace fixture port unavailable')
  const priorProject=process.env.CLIPMENTOR_PROJECT_ID,priorPort=process.env.CLIPMENTOR_BACKEND_PORT
  const priorNodeEnv=process.env.NODE_ENV
  let vite:Awaited<ReturnType<typeof createViteServer>>|undefined
  try{
    process.env.CLIPMENTOR_PROJECT_ID=''
    process.env.CLIPMENTOR_BACKEND_PORT=String(address.port)
    vite=await createViteServer({server:{host:'127.0.0.1',port:0,strictPort:true,hmr:false}})
    await vite.listen()
    const origin=vite.resolvedUrls?.local[0]
    if(!origin)throw Error('Workspace development server unavailable')
    await page.goto(origin)
    await page.getByRole('link',{name:'查看素材',exact:true}).click()
    await expect(page.getByText('四份素材都已保存。')).toBeVisible()
    expect(calls).toContain('/api/clipmentor/task-workspace:')
    expect(calls).toContain('/api/clipmentor/material-intake:'+id)
    expect(calls).toContain('/api/clipmentor/production-task:'+id)
    expect(await page.evaluate(async()=>(await fetch('/api/clipmentor/intake')).status)).toBe(400)
    expect(await page.evaluate(async()=>(await fetch('/api/clipmentor/unknown')).status)).toBe(404)

    const body=JSON.stringify({id,name:'分块请求'})
    const result=await new Promise<{status?:number;body:string}>((resolve,reject)=>{
      const post=request(new URL('/api/clipmentor/tasks',origin),{method:'POST',headers:{
        Origin:new URL(origin).origin,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json',
      }},async response=>{
        let received=''
        try{
          for await(const chunk of response)received+=chunk
          resolve({status:response.statusCode,body:received})
        }catch(error){reject(error)}
      })
      post.setTimeout(3000,()=>post.destroy(Error('local POST timed out'))).once('error',reject)
      post.write(body.slice(0,9));post.end(body.slice(9))
    })
    expect(result).toEqual({status:201,body})

    const readRange=async(renderId:string)=>{
      const response=await fetch(new URL(`/api/clipmentor/production?view=panel_video&projectId=${id}&renderId=${renderId}`,origin),{
        headers:{Range:'bytes=2-4','Sec-Fetch-Site':'same-origin'},signal:AbortSignal.timeout(3000),
      })
      expect(response.status).toBe(206)
      expect(response.headers.get('Content-Range')).toBe('bytes 2-4/9')
      return response.text()
    }
    expect(await readRange('valid')).toBe('234')
    await expect(readRange('truncated')).rejects.toThrow('terminated')
  }finally{
    if(priorProject===undefined)delete process.env.CLIPMENTOR_PROJECT_ID
    else process.env.CLIPMENTOR_PROJECT_ID=priorProject
    if(priorPort===undefined)delete process.env.CLIPMENTOR_BACKEND_PORT
    else process.env.CLIPMENTOR_BACKEND_PORT=priorPort
    await vite?.close()
    if(priorNodeEnv===undefined)delete process.env.NODE_ENV
    else process.env.NODE_ENV=priorNodeEnv
    upstream.closeAllConnections()
    await new Promise<void>(resolve=>upstream.close(()=>resolve()))
  }
})
