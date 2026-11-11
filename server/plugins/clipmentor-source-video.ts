import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { editorCredentialAuthorized } from '../editor-auth';
import { sourceVideoDependencies, observeSourceVideo, readSourceVideoReceipt, SourceVideoOperationError, type SourceVideoDependencies } from '../clipmentor/source-video';

/** Local-editor endpoint. No key, verdict or reviewer identity comes from the author. */
export function clipMentorSourceVideoPlugin(deps?: SourceVideoDependencies): Plugin {
  return { name: 'clipmentor-source-video', configureServer(server) {
    server.middlewares.use('/api/clipmentor/observe-video', async (req: IncomingMessage, res: ServerResponse) => {
      const headers=(status:number)=>{if(!res.headersSent){res.statusCode=status;
        res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');}};
      const send = (status: number, value: unknown) => { if (!res.destroyed) { headers(status);res.end(JSON.stringify(value)); } };
      if (req.method !== 'POST') { req.resume(); send(405, { error: 'POST required' }); return; }
      if (!editorCredentialAuthorized(req, true)) { req.resume(); send(401, { error: 'Editor origin required' }); return; }
      if (!String(req.headers['content-type']).startsWith('application/json')) { req.resume(); send(415, { error: 'JSON required' }); return; }
      const abort = new AbortController();
      const onClose = () => { if (!res.writableEnded) abort.abort(); };
      res.on('close', onClose);
      try {
        let size = 0; const parts: Buffer[] = [];
        for await (const part of req) { size += part.length; if (size > 2 * 1024 * 1024) throw new Error('Body too large'); parts.push(Buffer.from(part)); }
        const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
        const dependencies = deps ?? sourceVideoDependencies();
        if (body?.action === 'read_receipt') {
          if (Object.keys(body).some(k => !['action','operationId','projectId'].includes(k))) throw new Error('Invalid read request');
          send(200, await readSourceVideoReceipt(body.operationId, body.projectId, dependencies));
        } else {
          // Match the existing preview route: keep local fetch alive only after
          // source preflight and reservation, during the same single post().
          const waiting={...dependencies,post:async(...args:Parameters<SourceVideoDependencies['post']>)=>{
            headers(200);res.write('\n');
            const heartbeat=setInterval(()=>{if(!res.destroyed&&!res.writableEnded)res.write('\n');},20_000);
            heartbeat.unref();
            try{return await dependencies.post(...args);}finally{clearInterval(heartbeat);}
          }};
          const resume=body?.action==='resume_preparation';
          if(resume)delete body.action;
          send(200,await observeSourceVideo(body,waiting,abort.signal,resume));
        }
      } catch (error) {
        if (error instanceof SourceVideoOperationError) {
          send(error.receipt.validation ? 422 : 502, {error:error.message,receipt:error.receipt});
          return;
        }
        send(400, { error: 'Source observation unavailable, invalid or outcome unknown. Keep operationId; no automatic retry. No source or credential details are returned.' });
      } finally { res.off('close', onClose); }
    });
  } };
}
