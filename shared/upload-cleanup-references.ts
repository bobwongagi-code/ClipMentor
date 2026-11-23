import { exportAttemptIdFromFilename, isExportStageFilename, isPublishedExportFilename } from './export-media-names.ts';
import { isProjectStoreRecord, projectIdFromProjectStoreKey } from './project-store-validation.ts';

const UPLOAD_PREFIX = '/media/uploads/';
const OFFLINE_DRAFT_PREFIX = 'offline-edit-session:';

export function isUploadCleanupEntry(key: string): boolean {
  return key === 'projects' || key.startsWith('project:') || key.startsWith('versions:') || key.startsWith(OFFLINE_DRAFT_PREFIX);
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
    if (key.startsWith('versions:')) {
      if (!Array.isArray(value)) throw new Error('Project version media references could not be verified');
      for (const snapshot of value) {
        if (!isProjectStoreRecord(snapshot)) throw new Error('Project version media references could not be verified');
        addDocument(snapshot.doc);
      }
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
