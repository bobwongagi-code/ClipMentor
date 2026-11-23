// Inventory and explicit cleanup of local upload copies. Project documents and
// history remain references even when absent from the dashboard index.
import { collectStoredUploadReferences, isCleanupProtectedUpload } from '../../shared/upload-cleanup-references';
import { deleteMediaBlob } from './mediaBlobStore';
import { migrateProjectDoc, purgeProject } from './projectStore';
import { kvGetAuthoritative, kvUploadCleanupSnapshots } from './sharedKv';

const MEDIA_PREFIX = '/media/uploads/';

export interface UploadFileInfo {
  name: string;
  bytes: number;
  mtimeMs: number;
}
export interface UnreferencedSourceCandidate extends UploadFileInfo {
  kind: 'unreferenced-source';
  autoDelete: false;
}

export async function listUploadFiles(): Promise<UploadFileInfo[]> {
  const res = await fetch('/upload/list', { cache: 'no-store' });
  if (!res.ok) throw new Error(`/upload/list → HTTP ${res.status}`);
  const body = (await res.json()) as { files?: UploadFileInfo[] };
  if (!Array.isArray(body.files)) throw new Error('Upload inventory could not be verified');
  return body.files;
}

export async function collectAllUploadRefs(excludeId?: string): Promise<Set<string>> {
  const refs = new Set<string>();
  for (const entries of await kvUploadCleanupSnapshots()) {
    for (const src of collectStoredUploadReferences(entries, excludeId)) refs.add(src);
  }
  return refs;
}

export function unreferencedOf(files: UploadFileInfo[], refs: Set<string>): UploadFileInfo[] {
  return files.filter(f => !isCleanupProtectedUpload(f.name) && !refs.has(MEDIA_PREFIX + f.name));
}

async function deleteUploadFile(name: string): Promise<boolean> {
  const res = await fetch(`/upload?name=${encodeURIComponent(name)}&cleanup=1`, { method: 'DELETE', redirect: 'error' });
  // Only drop the browser cache after the authoritative reference check and
  // disk deletion succeed. Cloud originals remain available for recovery.
  if (!res.ok) return false;
  const result = await res.json();
  if (result?.ok !== true || result.r2Removed !== false || result.localFileRemoved !== true
    || !Number.isSafeInteger(result.removed) || result.removed <= 0) return false;
  await deleteMediaBlob(MEDIA_PREFIX + name);
  return true;
}

export async function deleteUnreferencedUploads(names: readonly string[]): Promise<number> {
  const refs = await collectAllUploadRefs();
  let removed = 0;
  for (const name of new Set(names)) {
    if (isCleanupProtectedUpload(name) || refs.has(MEDIA_PREFIX + name)) continue;
    if (await deleteUploadFile(name).catch(() => false)) removed++;
  }
  return removed;
}

export interface CleanupScan {
  files: UnreferencedSourceCandidate[];
  sourceCandidates: UnreferencedSourceCandidate[];
}

/** Opening the dialog only inventories files. It never purges project records. */
export async function scanUnreferenced(): Promise<CleanupScan> {
  // List disk first: an upload published after the reference snapshot cannot
  // be classified using that earlier snapshot.
  const files = await listUploadFiles();
  const refs = await collectAllUploadRefs();
  const sourceCandidates = unreferencedOf(files, refs).map((file) => ({
    ...file,
    kind: 'unreferenced-source' as const,
    autoDelete: false as const,
  }));
  return { files: sourceCandidates, sourceCandidates };
}

/** An explicit project purge is independent of optional local media cleanup. */
export async function purgeProjectCascade(id: string): Promise<{ filesDeleted: number }> {
  let names: string[] = [];
  try {
    const doc = migrateProjectDoc(await kvGetAuthoritative<unknown>(`project:${id}`));
    // A saved URL can have multiple protective aliases. Only a direct asset
    // filename authorizes cascade removal; the inventory handles other orphans.
    names = (doc?.assets ?? []).map(asset => asset.src).filter(src => src.startsWith(MEDIA_PREFIX))
      .map(src => src.slice(MEDIA_PREFIX.length))
      .filter(name => name.length > 0 && !/[?#%/\\]/.test(name));
  } catch { /* unreadable project data cannot authorize a cascade */ }
  await purgeProject(id);
  if (!names.length) return { filesDeleted: 0 };
  try {
    return { filesDeleted: await deleteUnreferencedUploads(names) };
  } catch {
    // A failed history or project read retains the media. The user confirmed
    // the project purge, which has already completed.
    return { filesDeleted: 0 };
  }
}
