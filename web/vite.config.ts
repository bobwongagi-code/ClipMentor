import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { request } from 'node:http'
import { pipeline } from 'node:stream'
import path from 'path'

export default defineConfig(({ mode, command, isPreview }) => {
  const {
    CLIPMENTOR_PROJECT_ID: projectId,
    CLIPMENTOR_BACKEND_PORT = '5199',
    CLIPMENTOR_PUBLIC_API_BASE_PATH = '',
    CLIPMENTOR_PUBLIC_WORKSPACE = '',
  } = loadEnv(mode, process.cwd(), 'CLIPMENTOR_')
  const development = command === 'serve' && !isPreview
  const backendPort = Number(CLIPMENTOR_BACKEND_PORT)
  if (development && (!/^\d{1,5}$/.test(CLIPMENTOR_BACKEND_PORT) || backendPort < 1 || backendPort > 65535)) {
    throw new Error('Invalid CLIPMENTOR_BACKEND_PORT')
  }
  const localFixedProject = development && /^[a-zA-Z0-9_-]{1,160}$/.test(projectId ?? '')
  const localWorkspace = development && !projectId
  const localApiEnabled = localFixedProject || localWorkspace
  const publicApiPath = command === 'build' ? CLIPMENTOR_PUBLIC_API_BASE_PATH : ''
  if (publicApiPath && (!publicApiPath.startsWith('/')
    || publicApiPath.slice(1).split('/').some(segment => !segment || /[^a-zA-Z0-9_-]/.test(segment)))) {
    throw new Error('Invalid CLIPMENTOR_PUBLIC_API_BASE_PATH: use a same-origin path such as /api/clipmentor')
  }
  const apiBasePath = localApiEnabled ? '/api/clipmentor' : publicApiPath
  return {
    plugins: [react(), {
      name: 'local-clipmentor-intake',
      configureServer(server) {
        if (!localApiEnabled) return
        server.middlewares.use('/api/clipmentor', (req, res) => {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const workspace = url.pathname === '/tasks' && localWorkspace
          if (!workspace && url.pathname !== '/intake' && url.pathname !== '/production') {
            res.writeHead(404).end()
            return
          }
          const intake = url.pathname === '/intake'
          const view = url.searchParams.get('view') ?? 'panel'
          if (!intake && !workspace && !['panel', 'panel_board', 'panel_video', 'panel_poster', 'panel_download', 'panel_draft_download', 'panel_reference', 'panel_attachment', 'panel_material'].includes(view)) {
            res.writeHead(404).end()
            return
          }
          const id = localFixedProject ? projectId ?? '' : url.searchParams.get('projectId') ?? ''
          if (!workspace && !/^[a-zA-Z0-9_-]{1,160}$/.test(id)) {
            res.writeHead(400).end()
            return
          }
          const params = new URLSearchParams(workspace ? {} : { projectId: id })
          if (!intake && !workspace) {
            params.set('view', view)
            for (const key of ['revision', 'boardIdentity', 'boardPresentation', 'renderId', 'criterion', 'audience', 'assetId', 'excerpt']) {
              const value = url.searchParams.get(key)
              if (value) params.set(key, value)
            }
          }
          const host = req.headers.host ?? ''
          const localHost = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)
          const reading = req.method === 'GET'
          if ((!reading && req.method !== 'POST') || !localHost
            || (!reading && req.headers.origin !== `http://${host}`) || req.headers['sec-fetch-site'] !== 'same-origin'
            || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) {
            res.writeHead(403).end()
            return
          }
          const upstream = request({
            hostname: '127.0.0.1', port: backendPort, method: req.method,
            path: `/api/clipmentor/${workspace?'task-workspace':intake?'material-intake':'production-task'}?${params}`,
            headers: {
              origin: `http://127.0.0.1:${backendPort}`, 'sec-fetch-site': 'same-origin',
              'content-type': req.headers['content-type'] ?? '',
              ...(req.headers['content-length'] !== undefined ? { 'content-length': req.headers['content-length'] } : {}),
              ...(req.headers.range ? { range: req.headers.range } : {}),
            },
          }, response => {
            const headers = Object.fromEntries(['content-type','content-length','content-disposition','content-security-policy','content-range','accept-ranges','x-clipmentor-board-identity']
              .flatMap(key => response.headers[key] ? [[key, response.headers[key]!]] : []))
            res.writeHead(response.statusCode ?? 502, { ...headers, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
            pipeline(response,res,()=>{})
          })
          upstream.setTimeout(120_000, () => upstream.destroy())
          upstream.on('error', () => {
            if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: '制作服务暂未连接，请刷新查看当前状态' }))
            else res.destroy()
          })
          res.on('close', () => { if (!res.writableEnded) upstream.destroy() })
          req.pipe(upstream)
        })
      },
    }],
    define: {
      __CLIPMENTOR_API_BASE_PATH__: JSON.stringify(apiBasePath),
      __CLIPMENTOR_WORKSPACE__: JSON.stringify(localWorkspace || !!publicApiPath && CLIPMENTOR_PUBLIC_WORKSPACE==='1'),
    },
    resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  }
})
