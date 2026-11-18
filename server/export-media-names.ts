const EXPORT_MEDIA_ID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const EXPORT_ATTEMPT_FILENAME = new RegExp(`^openchatcut-export-job-(${EXPORT_MEDIA_ID})\\.(?:mp4|webm|mov|mp3|wav)$`, 'i');

export function exportAttemptIdFromFilename(name: string): string | undefined {
  const match = EXPORT_ATTEMPT_FILENAME.exec(name);
  return match?.[0] === name ? match[1].toLowerCase() : undefined;
}

export function isPrivateExportFilename(name: string): boolean {
  return /^\.openchatcut-(?:export-job|derived)-/i.test(name);
}
