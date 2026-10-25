import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { editorCredentialAuthorized } from '../editor-auth';
import { CopyReviewError, copyReviewDependencies, reviewClipMentorCopy, type CopyReviewDependencies } from '../clipmentor/copy-review';

/** Local-editor endpoint. No key, verdict or reviewer identity comes from the author. */
export function clipMentorCopyReviewPlugin(deps?: CopyReviewDependencies): Plugin {
  return { name: 'clipmentor-copy-review', configureServer(server) {
    server.middlewares.use('/api/clipmentor/review-copy', async (req: IncomingMessage, res: ServerResponse) => {
      const send = (status: number, value: unknown) => { if (!res.destroyed) { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(value)); } };
      if (req.method !== 'POST') { req.resume(); send(405, { error: 'POST required' }); return; }
      if (!editorCredentialAuthorized(req, true)) { req.resume(); send(401, { error: 'Editor origin required' }); return; }
      if (!String(req.headers['content-type']).startsWith('application/json')) { req.resume(); send(415, { error: 'JSON required' }); return; }
      const abort = new AbortController();
      const onClose = () => { if (!res.writableEnded) abort.abort(); };
      res.on('close', onClose);
      try {
        let size = 0; const parts: Buffer[] = [];
        for await (const part of req) { size += part.length; if (size > 2 * 1024 * 1024) { send(413, { error: 'Review request exceeds 2 MiB; no reviewer started' }); return; } parts.push(Buffer.from(part)); }
        let value: unknown;
        try { value = JSON.parse(Buffer.concat(parts).toString('utf8')); }
        catch { send(400, { error: 'Invalid JSON; no reviewer started' }); return; }
        send(200, await reviewClipMentorCopy(value, deps ?? copyReviewDependencies(), abort.signal));
      } catch (error) {
        if (error instanceof CopyReviewError) send(error.status, { error: error.message, diagnostic: error.diagnostic, production_approved: false });
        else send(500, { error: 'Review service failed; outcome unknown. Keep operationId; no automatic retry.', production_approved: false });
      } finally { res.off('close', onClose); }
    });
  } };
}
