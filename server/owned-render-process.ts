import { spawn } from 'node:child_process';
import { windowsRenderJobCommand } from './windows-render-job.ts';

// Run independently of the server. The IPC pipe also closes on SIGKILL, when
// the server cannot run an AbortSignal listener or remove its staging files.
const supervisor = String.raw`
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { constants, setPriority, tmpdir } = require('node:os');
const { join } = require('node:path');
let child;
let keeper;
let owned = false;
let stopping = false;
let startupTimeout;
let gracefulStop;
let exited = false;
let temporary;
let outcome;
const windows = process.platform === 'win32';
const ffmpegGate = [
  "const { spawn } = require('node:child_process');",
  "process.once('message', ({ input }) => {",
  "  const child = spawn(input.command, input.args, { stdio: 'inherit', windowsHide: true });",
  "  child.once('error', (error) => console.error(error.message));",
  "  child.once('close', (code) => process.exit(code ?? 1));",
  "});",
].join('\n');
function killTree() {
  if (windows) {
    keeper?.stdin.end();
  } else if (child?.pid) {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH' && !exited) child.kill('SIGKILL'); }
  }
}
function stop() {
  if (stopping) return;
  stopping = true;
  if (!child && !keeper) { process.exit(1); return; }
  if (!exited && child?.connected && (!windows || owned)) {
    child.send({ stop: true }, () => {});
    gracefulStop = setTimeout(killTree, 1500);
  } else killTree();
}
const send = (value) => { if (process.connected) process.send(value, () => {}); };
function finish() {
  if (keeper || !outcome) return;
  clearTimeout(gracefulStop);
  if (temporary) {
    try { rmSync(temporary, { recursive: true, force: true, maxRetries: 2 }); }
    catch (error) { console.error(error.message); }
  }
  send({ exit: outcome });
  if (process.connected) process.disconnect();
  process.exitCode = outcome.code === 0 ? 0 : 1;
}
function startChild(command, args, ipc) {
  child = spawn(command, args, {
    detached: !windows,
    stdio: ['ignore', 'inherit', 'inherit', ...(ipc ? ['ipc'] : [])],
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
    killTree();
  });
  child.once('close', (code, signal) => {
    outcome = { code, signal };
    if (windows) killTree();
    finish();
  });
}
function startWindows({ command, args, input }) {
  const worker = input !== undefined;
  const powerShell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const job = spawn(powerShell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', process.argv[1]], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, TEMP: temporary, TMP: temporary },
  });
  keeper = job;
  let diagnostic = '';
  job.stderr.on('data', (chunk) => { diagnostic = (diagnostic + chunk).slice(-4000); });
  job.stdin.on('error', () => {});
  startupTimeout = setTimeout(() => {
    send({ error: 'Windows render job setup timed out' });
    killTree();
    job.kill('SIGKILL');
  }, 20000);
  const lines = require('node:readline').createInterface({ input: job.stdout });
  lines.on('line', (line) => {
    if (line === 'listening' && !stopping && process.connected && !child) {
      startChild(worker ? command : process.execPath, worker ? args : ['--eval', ffmpegGate], true);
      if (child.pid) job.stdin.write(child.pid + '\n');
      else killTree();
    }
    if (line === 'owned' && !owned) {
      owned = true;
      clearTimeout(startupTimeout);
      if (stopping || !process.connected || exited || !child?.connected) killTree();
      else child.send({ input: worker ? input : { command, args } }, (error) => {
        if (error) { send({ error: error.message }); killTree(); }
      });
    }
  });
  job.once('error', (error) => send({ error: 'Windows render job unavailable: ' + error.message }));
  job.once('close', (code) => {
    clearTimeout(startupTimeout);
    lines.close();
    keeper = undefined;
    if ((!owned && !stopping) || code !== 0) {
      send({ error: 'Windows render job could not confirm ownership or shutdown: ' + diagnostic });
    }
    // The gated child cannot start an encoder without the keeper's ownership
    // line. If setup failed, only that idle child needs to be terminated here.
    if (!owned && child && !exited) child.kill('SIGKILL');
    if (!child) outcome = { code: 1, signal: null };
    finish();
  });
}
process.on('disconnect', stop);
process.on('SIGTERM', stop);
process.on('message', (message) => {
  if (message.stop) { stop(); return; }
  if (child || keeper || !process.connected) return;
  const { command, args, input } = message;
  const worker = input !== undefined;
  if (worker || windows) {
    try { temporary = mkdtempSync(join(tmpdir(), 'openchatcut-render-')); }
    catch (error) { send({ error: error.message }); process.disconnect(); process.exitCode = 1; return; }
  }
  if (windows) startWindows(message);
  else {
    startChild(command, args, worker);
    if (worker) child.send({ input }, () => {});
  }
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
    const windows = process.platform === 'win32';
    const owned = spawn(process.execPath, [
      '--eval', supervisor, ...(windows ? ['--', windowsRenderJobCommand] : []),
    ], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      // libuv otherwise kills this direct Windows child with the owner, before
      // it can close the native job and acknowledge its descendants are gone.
      detached: windows,
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
