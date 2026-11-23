import { exportAttemptIdFromFilename, isExportStageFilename, isPublishedExportFilename } from './export-media-names.ts';
import { isProjectStoreRecord, projectIdFromProjectStoreKey } from './project-store-validation.ts';

const UPLOAD_PREFIX = '/media/uploads/';
const OFFLINE_DRAFT_PREFIX = 'offline-edit-session:';

// SQLite GLOB and the browser/file stores share exactly the same ownership set.
// Only a trailing '*' is supported. Removing the owner releases its references.
export const uploadCleanupKeyPatterns = [
  'projects', 'project:*', 'versions:*', OFFLINE_DRAFT_PREFIX + '*', 'templates:all',
  'proposal:*', 'agent-session-proposal:*', 'external-proposal:*', 'upload-finalize:*',
  'agent-artifact:*', 'agent-session-artifact:*',
] as const;

export function isUploadCleanupEntry(key: string): boolean {
  return uploadCleanupKeyPatterns.some(pattern => pattern.endsWith('*')
    ? key.startsWith(pattern.slice(0, -1)) : key === pattern);
}

/** LUTs can belong to installed extensions. Export staging and job outputs
 * have their own lifecycle. Promoted previews may be referenced solely by
 * production receipts and need explicit delivery-aware removal. */
export function isCleanupProtectedUpload(name: string): boolean {
  return /\.cube$/i.test(name) || isExportStageFilename(name, true)
    || !!exportAttemptIdFromFilename(name) || isPublishedExportFilename(name);
}

export function collectStoredUploadReferences(
  entries: Record<string, unknown>,
  excludeId?: string,
): Set<string> {
  const refs = new Set<string>();
  const index = entries.projects;
  if (index !== undefined && (!Array.isArray(index) || index.some((item) =>
    !isProjectStoreRecord(item) || typeof item.id !== 'string'
    || (item.id !== excludeId && !Object.hasOwn(entries, `project:${item.id}`))))) {
    throw new Error('Project index references could not be verified');
  }

  const documents: unknown[] = [];
  const addDocument = (value: unknown) => {
    if (!isProjectStoreRecord(value) || value.kind === 'quarantined-project-store-entry'
      || (!Array.isArray(value.timelines) && !Array.isArray(value.items))) {
      throw new Error('Project media references could not be verified');
    }
    documents.push(value);
  };
  for (const [key, value] of Object.entries(entries)) {
    if (excludeId !== undefined && isUploadCleanupEntry(key) && projectIdFromProjectStoreKey(key) === excludeId) continue;
    if (key.startsWith('project:')) addDocument(value);
    if (key.startsWith('versions:') || key === 'templates:all') {
      if (!Array.isArray(value)) throw new Error('Saved document media references could not be verified');
      for (const snapshot of value) {
        if (!isProjectStoreRecord(snapshot)) throw new Error('Saved document media references could not be verified');
        addDocument(snapshot.doc);
      }
    }
    if (key.startsWith('agent-artifact:') || key.startsWith('agent-session-artifact:')) {
      if (!isProjectStoreRecord(value) || typeof value.kind !== 'string' || value.kind === 'quarantined-project-store-entry') {
        throw new Error('Agent artifact could not be verified');
      }
      if (value.kind === 'server-run-draft') {
        if (typeof value.body !== 'string') throw new Error('Saved runtime draft could not be verified');
        // Runtime draft base documents and replayable tool actions are serialized JSON.
        const body: unknown = JSON.parse(value.body);
        if (!isProjectStoreRecord(body)) throw new Error('Saved runtime draft could not be verified');
        documents.push(body);
      }
    }
    if (key.startsWith('proposal:') || key.startsWith('agent-session-proposal:')
      || key.startsWith('external-proposal:') || key.startsWith('upload-finalize:')) {
      if (!isProjectStoreRecord(value) || value.kind === 'quarantined-project-store-entry') {
        throw new Error('Saved proposal or upload references could not be verified');
      }
      documents.push(value);
    }
    if (key.startsWith(OFFLINE_DRAFT_PREFIX)) {
      if (!isProjectStoreRecord(value) || value.version !== 1
        || typeof value.sessionId !== 'string' || !value.sessionId
        || typeof value.clientName !== 'string' || typeof value.baseRevision !== 'string' || !value.baseRevision
        || (value.approvalMode !== 'auto' && value.approvalMode !== 'manual')
        || !Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt) || !Array.isArray(value.operations)) {
        throw new Error('Offline draft media references could not be verified');
      }
      addDocument(value.draftDoc);
      documents.push(value.operations);
    }
  }
  const seen = new Set<object>();
  while (documents.length) {
    const value = documents.pop();
    if (typeof value === 'string' && value.startsWith(UPLOAD_PREFIX)) {
      refs.add(value);
      const path = value.split(/[?#]/, 1)[0]!;
      refs.add(path);
      try { refs.add(decodeURIComponent(path)); } catch { /* a literal percent is also a valid filename */ }
    } else if (value && typeof value === 'object' && !seen.has(value)) {
      seen.add(value);
      for (const entry of Object.values(value)) documents.push(entry);
    }
  }
  return refs;
}
