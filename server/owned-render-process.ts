import { spawn } from 'node:child_process';

// Run independently of the server. The IPC pipe also closes on SIGKILL, when
// the server cannot run an AbortSignal listener or remove its staging files.
const supervisor = String.raw`
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { constants, setPriority, tmpdir } = require('node:os');
const { join } = require('node:path');
let child;
let gracefulStop;
let exited = false;
const windows = process.platform === 'win32';
function killTree() {
  if (!child?.pid) return;
  if (windows) {
    if (exited) return;
    const taskkill = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore', windowsHide: true,
    });
    const fallback = () => { if (!exited) child.kill('SIGKILL'); };
    taskkill.once('error', fallback);
    taskkill.once('exit', (code) => { if (code !== 0) fallback(); });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH' && !exited) child.kill('SIGKILL'); }
  }
}
function stop(graceful) {
  if (!child) { process.exit(1); return; }
  if (exited || gracefulStop) return;
  if (graceful && child.connected) {
    child.send({ stop: true }, () => {});
    gracefulStop = setTimeout(killTree, 1500);
  } else killTree();
}
const send = (value) => { if (process.connected) process.send(value, () => {}); };
process.on('disconnect', () => stop(true));
process.on('SIGTERM', () => stop(true));
process.on('message', (message) => {
  if (message.stop) { stop(true); return; }
  if (child || !process.connected) return;
  const { command, args, input } = message;
  const worker = input !== undefined;
  let temporary;
  if (worker) {
    try { temporary = mkdtempSync(join(tmpdir(), 'openchatcut-render-')); }
    catch (error) { send({ error: error.message }); process.disconnect(); process.exitCode = 1; return; }
  }
  child = spawn(command, args, {
    detached: !windows,
    stdio: ['ignore', 'inherit', 'inherit', ...(worker ? ['ipc'] : [])],
    windowsHide: true,
    env: temporary ? { ...process.env, TMPDIR: temporary, TEMP: temporary, TMP: temporary } : process.env,
  });
  if (child.pid) {
    try { setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL); }
    catch {}
  }
  child.on('message', send);
  child.once('error', (error) => send({ error: error.message }));
  child.once('exit', () => {
    exited = true;
    // The worker may have failed while one of its encoders still owns a file.
    if (!windows) killTree();
  });
  child.once('close', (code, signal) => {
    clearTimeout(gracefulStop);
    if (temporary) {
      try { rmSync(temporary, { recursive: true, force: true, maxRetries: 2 }); }
      catch (error) { console.error(error.message); }
    }
    send({ exit: { code, signal } });
    if (process.connected) process.disconnect();
    process.exitCode = code === 0 ? 0 : 1;
  });
  if (worker) child.send({ input }, () => {});
});
`;

interface OwnedProcessOptions {
  command: string;
  args: string[];
  input?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (progress: number) => void;
}

interface OwnedProcessMessage {
  error?: string;
  result?: unknown;
  exit?: { code: number | null; signal: NodeJS.Signals | null };
  progress?: number;
}

export async function runOwnedProcess<T = void>({ command, args, input, signal, timeoutMs, onProgress }: OwnedProcessOptions): Promise<T> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const owned = spawn(process.execPath, ['--eval', supervisor], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
    });
    let stderr = '';
    let result: T | undefined;
    let outcome: OwnedProcessMessage['exit'];
    let failure: Error | undefined;
    const stop = () => {
      if (owned.connected) owned.send({ stop: true }, () => {});
    };
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      failure = new Error('native export process timed out');
      stop();
    }, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    owned.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });
    owned.on('message', (message: OwnedProcessMessage) => {
      if (message.error) failure ??= new Error(message.error);
      if (typeof message.progress === 'number') onProgress?.(message.progress);
      if (message.result !== undefined) result = message.result as T;
      if (message.exit) outcome = message.exit;
    });
    owned.once('error', (error) => { failure ??= error; });
    owned.once('close', () => {
      signal?.removeEventListener('abort', stop);
      clearTimeout(timer);
      if (signal?.aborted) reject(signal.reason);
      else if (failure) reject(failure);
      else if (outcome?.code !== 0 || (input !== undefined && result === undefined)) {
        reject(new Error(`native export process failed (${outcome?.signal ?? outcome?.code ?? 'no exit receipt'}): ${stderr.slice(-600)}`));
      } else resolve(result as T);
    });
    owned.send({ command, args, input }, (error) => { if (error) failure ??= error; });
    if (signal?.aborted) stop();
  });
}
