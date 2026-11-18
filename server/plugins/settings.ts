import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { keyStatus, setKeys } from '../keystore.ts';
import { runProbe } from '../key-probes.ts';
import {
  checkMediaDir,
  DEFAULT_UPLOAD_DIR,
  exportAttemptIdFromFilename,
  expandMediaDir,
  syncUploadDirectories,
  uploadDir,
} from '../media-dir.ts';
import {
  DATA_DIR_ENV,
  assertCurrentStorageProfile,
  defaultRootDir,
  isIsolatedDevProfile,
  runtimeProfile,
  type RuntimeProfile,
} from '../runtime-profile.ts';
import {
  checkDataDir,
  expandDataDir,
  readDataDirPointer,
  readDataDirPointerAuthority,
  relocateDataDir,
  relocatedMediaDestination,
  writeDataDirPointer,
} from '../data-dir.ts';

const ISOLATED_R2_SETTINGS = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'R2_ENABLED',
  'R2_PRESIGN',
] as const;

export function assertProfileSensitiveSettingsPatch(
  patch: Readonly<Record<string, unknown>>,
  profile: RuntimeProfile = runtimeProfile(),
): void {
  if (!isIsolatedDevProfile(profile)) return;
  if (Object.hasOwn(patch, 'MEDIA_DIR')) {
    throw new Error('MEDIA_DIR cannot be changed while an isolated development profile is active');
  }
  if (ISOLATED_R2_SETTINGS.some((name) => Object.hasOwn(patch, name))) {
    throw new Error('R2 settings cannot be changed while an isolated development profile is active');
  }
}

// Dev-only settings endpoint bound to the Vite dev server (localhost). Key VALUES flow
// browser → server here and are stored server-side + in .env.local; they never flow back
// (GET returns booleans only); keys never leave the server.
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > 100_000) throw new Error('request body too large');
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    // Generic message on purpose: V8's SyntaxError can echo the raw body (which may
    // contain a key value) and our catch-all logs error messages.
    throw new Error('invalid JSON body');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be a JSON object');
  return parsed as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

/** keyStatus + absolute path to the current asset directory. FCPXML export goes to /media/uploads/<name>
 * Convert to real disk path, otherwise every asset in NLE will be offline; the directory changes with MEDIA_DIR,
 * Only the server knows, so it is returned to the front-end along with the settings (non-key, can be disclosed). */
function settingsBody(restartRequired = false) {
  const profile = runtimeProfile();
  const status = keyStatus();
  const configured = readDataDirPointer() ?? '';
  return {
    ...status,
    // The storage root is configuration, not a credential: echo it raw so the
    // settings field shows where projects actually live. It is not a keystore
    // key (the keystore lives inside the root), hence the explicit merge.
    models: { ...status.models, [DATA_DIR_ENV]: configured },
    mediaDir: uploadDir(),
    dataDir: profile.rootDir,
    ...(restartRequired ? { restartRequired: true } : {}),
  };
}

/** Apply a storage-root change: validate, copy the existing data, record the
 *  pointer. The active profile resolved at startup, so the move only takes
 *  effect on the next launch; the caller reports that to the user.
 *
 *  Media is copied separately from the RESOLVED upload directory, not from
 *  `<root>/media`: in the default profile uploads live outside the root (the
 *  checkout's `public/media/uploads`, or `userData/...` when packaged), so
 *  copying the root's own `media` folder would move an empty directory and
 *  take every `/media/uploads/...` reference offline after the restart. */
async function applyDataDirChange(
  raw: string,
  profile: RuntimeProfile,
  log: (msg: string) => void,
  saveOtherSettings: () => Promise<void>,
  hasOtherSettings: boolean,
): Promise<void> {
  if (process.env[DATA_DIR_ENV]?.trim()) {
    throw new Error(`storage directory is pinned by ${DATA_DIR_ENV} and cannot be changed from settings`);
  }
  if (isIsolatedDevProfile(profile)) {
    throw new Error('storage directory cannot be changed while an isolated development profile is active');
  }
  const checked = await checkDataDir(raw, defaultRootDir(profile));
  if (!checked.ok) throw new Error(checked.error ?? 'invalid storage directory');
  const target = expandDataDir(raw);
  // Clearing the field is a relocation too: it sends the next launch back to the
  // default root, which is empty or stale for anyone who has been running
  // elsewhere. It needs the same consistency checks and copy as any other move.
  const destination = target ?? defaultRootDir(profile);
  const outcome = await relocateDataDir(profile.rootDir, destination, log, {
    generationJobStore: profile.generationJobStore,
    shouldPublish: () => {
      const configured = readDataDirPointerAuthority() ?? defaultRootDir(profile);
      if (destination !== profile.rootDir && configured === destination) {
        if (hasOtherSettings) throw new Error('restart before saving other settings');
        return false;
      }
      assertCurrentStorageProfile(profile);
      return true;
    },
    prepareTarget: async (unfinishedAttempts) => {
      const mediaDestination = relocatedMediaDestination(target, destination, DEFAULT_UPLOAD_DIR);
      await syncUploadDirectories(uploadDir(profile), mediaDestination, log, true, (name) => {
        const attemptId = exportAttemptIdFromFilename(name);
        return !attemptId || !unfinishedAttempts?.has(attemptId);
      });
      await saveOtherSettings();
    },
    publishTarget: () => writeDataDirPointer(target),
  });
  if (outcome.refused === 'sqlite-store-active') {
    throw new Error('the source SQLite project store could not be verified for relocation');
  }
  if (outcome.refused === 'target-contains-data') {
    throw new Error('the target already contains storage data; choose a different directory');
  }
}

export function settingsPlugin(): Plugin {
  return {
    name: 'openchatcut-settings',
    configureServer(server) {
      server.middlewares.use('/api/keys', async (req, res) => {
        try {
          if (req.method === 'GET') { sendJson(res, 200, settingsBody()); return; }
          // POST /api/keys/test: "Test connection" detection. overrides = unsaved temporary values of the panel,
          // Only this detection takes effect and does not fall into keystore / .env.local; the result will never contain the key value.
          if (req.method === 'POST' && req.url === '/test') {
            const body = await readBody(req);
            const page = typeof body.page === 'string' ? body.page : '';
            const overrides = body.overrides && typeof body.overrides === 'object' && !Array.isArray(body.overrides)
              ? body.overrides as Record<string, unknown>
              : {};
            sendJson(res, 200, await runProbe(page, overrides));
            return;
          }
          if (req.method === 'POST') {
            const profile = runtimeProfile();
            const patch = await readBody(req);
            assertProfileSensitiveSettingsPatch(patch, profile);
            // The storage root is not a keystore key (the keystore lives inside
            // it): handle and strip it before setKeys sees the patch.
            const dataDirChanged = Object.hasOwn(patch, DATA_DIR_ENV);
            const dataDir = String(patch[DATA_DIR_ENV] ?? '');
            delete patch[DATA_DIR_ENV];
            const previousMediaDir = uploadDir(profile);
            let nextMediaDir: string | undefined;
            if ('MEDIA_DIR' in patch) {
              const rawMediaDir = String(patch.MEDIA_DIR ?? '');
              const checked = await checkMediaDir(rawMediaDir, profile);
              if (!checked.ok) throw new Error(checked.error ?? 'invalid media directory');
              nextMediaDir = expandMediaDir(rawMediaDir) ?? profile.mediaDir;
            }
            const log = (msg: string) => server.config.logger.info(msg);
            const saveOtherSettings = async () => {
              if (nextMediaDir) await syncUploadDirectories(previousMediaDir, nextMediaDir, log);
              await setKeys(patch);
            };
            if (dataDirChanged) await applyDataDirChange(
              dataDir, profile, log, saveOtherSettings, Object.keys(patch).length > 0,
            );
            else await saveOtherSettings();
            sendJson(res, 200, settingsBody(dataDirChanged));
            return;
          }
          sendJson(res, 405, { error: 'method not allowed — use GET or POST' });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[settings] ${message}`);  // message only — never a key value
          if (!res.headersSent) sendJson(res, 400, { error: message });
        }
      });
    },
  };
}
