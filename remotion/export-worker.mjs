import { fileURLToPath } from 'node:url';
import { ensureBrowser } from '@remotion/renderer';
import { renderClip, renderTimeline } from './render.mjs';

async function prepareOwnedChrome() {
  if (process.platform === 'win32') return;
  const browser = await ensureBrowser({ browserExecutable: process.env.CC_BROWSER_EXECUTABLE ?? null });
  if (!('path' in browser)) throw new Error('Chromium executable is unavailable');
  cancellation.signal.throwIfAborted();
  process.env.OPENCHATCUT_OWNED_CHROME = browser.path;
  process.env.CC_BROWSER_EXECUTABLE = fileURLToPath(new URL('./owned-chromium.sh', import.meta.url));
}

const cancellation = new AbortController();
function send(message) {
  return new Promise((resolve) => {
    if (!process.connected) { resolve(); return; }
    process.send(message, () => resolve());
  });
}

process.on('disconnect', () => cancellation.abort());
let started = false;
process.on('message', async (message) => {
  if (message.stop) { cancellation.abort(); return; }
  if (!message.input || started || cancellation.signal.aborted) return;
  started = true;
  try {
    await prepareOwnedChrome();
    let percent = -1;
    const { clip, ...options } = message.input;
    const render = clip ? renderClip : renderTimeline;
    const result = await render({
      ...options,
      onProgress(progress) {
        const next = Math.floor(progress * 100);
        if (next <= percent) return;
        percent = next;
        void send({ progress });
      },
      signal: cancellation.signal,
    });
    await send({ result });
  } catch (error) {
    await send({ error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  } finally {
    // Remotion keeps unowned timer and HTTP handles alive after a render.
    // The supervisor waits for actual exit before reporting completion.
    process.exit(process.exitCode ?? 0);
  }
});
