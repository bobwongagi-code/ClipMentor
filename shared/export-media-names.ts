const EXPORT_MEDIA_ID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const EXPORT_ATTEMPT_FILENAME = new RegExp(`^openchatcut-export-job-(${EXPORT_MEDIA_ID})\\.(?:mp4|webm|mov|mp3|wav)$`, 'i');
const PUBLISHED_EXPORT_FILENAME = new RegExp(`^openchatcut-derived-${EXPORT_MEDIA_ID}\\.(?:mp4|webm|mov|mp3|wav)$`, 'i');
export const EXPORT_STAGE_PREFIX = 'openchatcut-export-stage-';
const EXPORT_STAGE_FILENAME = new RegExp(`^${EXPORT_STAGE_PREFIX}${EXPORT_MEDIA_ID}\\.(?:mp4|webm)$`, 'i');

export function exportAttemptIdFromFilename(name: string): string | undefined {
  const match = EXPORT_ATTEMPT_FILENAME.exec(name);
  return match?.[0] === name ? match[1].toLowerCase() : undefined;
}

export function isExportStageFilename(name: string, includePartial = false): boolean {
  const candidate = includePartial && name.toLowerCase().endsWith('.part') ? name.slice(0, -5) : name;
  return EXPORT_STAGE_FILENAME.exec(candidate)?.[0] === candidate;
}

export function isPublishedExportFilename(name: string): boolean {
  return PUBLISHED_EXPORT_FILENAME.exec(name)?.[0] === name;
}

export function isPrivateExportFilename(name: string): boolean {
  return /^\.openchatcut-(?:export-job|derived)-/i.test(name);
}
