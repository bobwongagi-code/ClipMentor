import teashellHistorical from './teashell-historical.json';

/** Explicit historical imports keep their source hash check at the normal import boundary. */
export function historicalClipMentorImport(id: unknown) {
  return id === 'teashell_historical_v1' ? teashellHistorical : undefined;
}
