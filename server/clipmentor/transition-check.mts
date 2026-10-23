/** Read-only CLI for the same structural self-check used by the Agent. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkTransitionManifest } from '../../src/clipmentor/transition-check.ts';
export { checkTransitionManifest } from '../../src/clipmentor/transition-check.ts';

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: tsx server/clipmentor/transition-check.mts execution-manifest.json');
    console.log(JSON.stringify(checkTransitionManifest(JSON.parse(await readFile(resolve(process.argv[2]), 'utf8'))), null, 2));
  } catch (error) {
    console.error(error instanceof SyntaxError ? 'Invalid manifest JSON' : error instanceof Error ? error.message : 'Manifest check failed');
    process.exitCode = 1;
  }
}
