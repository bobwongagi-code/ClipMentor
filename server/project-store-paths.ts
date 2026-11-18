import { join } from 'node:path';

export const PROJECT_STORE_DIRECTORY = 'project-store-v1';

export function legacyProjectStoreEntryPath(rootDir: string, key: string): string {
  return join(rootDir, PROJECT_STORE_DIRECTORY, `${encodeURIComponent(key)}.json`);
}

export function sqliteProjectStorePath(rootDir: string): string {
  return join(rootDir, 'project-store-v1.sqlite3');
}

export function legacyProjectBulkPendingPath(rootDir: string): string {
  return join(rootDir, 'project-store-bulk-pending-v1.json');
}
