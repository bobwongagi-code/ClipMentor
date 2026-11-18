import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { mimeFor, uploadDir } from '../media-dir.ts';
import { readCommittedExportSizes } from './generation-job-store.ts';
import { exportSizeMatches } from './generation-job-types.ts';

export async function matchesCommittedExportFile(
  name: string, file: string, sizes: ReadonlyMap<string, number | undefined>,
): Promise<boolean> {
  if (!sizes.has(name)) return false;
  const info = await lstat(file).catch(() => null);
  return !!info?.isFile() && exportSizeMatches(info.size, sizes.get(name));
}

export async function resolveCommittedExport(name: string) {
  const directory = uploadDir();
  const sizes = await readCommittedExportSizes().catch(() => null);
  if (!sizes?.has(name) || directory !== uploadDir()) return null;
  const file = join(directory, name);
  const info = await lstat(file).catch(() => null);
  const bytes = sizes.get(name);
  if (!info?.isFile() || !exportSizeMatches(info.size, bytes)) return null;
  return { file, bytes: info.size, contentType: mimeFor(name), cached: true };
}
