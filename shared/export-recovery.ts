export type ExportRecoveryStage = 'polling' | 'output-ready' | 'delivery-ambiguous' | 'target-committed';
export type ExportRecoveryTransition = 'ready' | 'ambiguous' | 'commit' | 'rebind';

/** Rebinding changes the destination of a retained result, never its identity or a completed delivery. */
export function exportRecoveryNextStage(stage: ExportRecoveryStage, action: ExportRecoveryTransition): ExportRecoveryStage | null {
  switch (action) {
    case 'ready': return stage === 'polling' ? 'output-ready' : stage;
    case 'ambiguous': return stage === 'output-ready' ? 'delivery-ambiguous' : null;
    case 'commit': return stage === 'output-ready' || stage === 'delivery-ambiguous' ? 'target-committed' : null;
    case 'rebind': return stage === 'target-committed' ? null : stage === 'delivery-ambiguous' ? 'output-ready' : stage;
  }
}

/** Descriptor shape only; possession/permission of a browser handle is checked separately. */
export function isExportRecoveryDestination(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const destination = value as Record<string, unknown>;
  if (typeof destination.label !== 'string' || !destination.label) return false;
  if (destination.type === 'browser-directory' || destination.type === 'browser-file') {
    if (destination.handle === null) return true;
    if (!destination.handle || typeof destination.handle !== 'object') return false;
    const handle = destination.handle as Record<string, unknown>;
    return handle.kind === (destination.type === 'browser-directory' ? 'directory' : 'file') && typeof handle.name === 'string';
  }
  if (destination.type === 'downloads') return true;
  if (destination.type === 'desktop-directory') return typeof destination.grantId === 'string';
  return destination.type === 'desktop-file' && typeof destination.grantId === 'string' && typeof destination.filename === 'string';
}
