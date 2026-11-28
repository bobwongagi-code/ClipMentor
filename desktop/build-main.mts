import { build } from 'esbuild';
import { loadedProductionGeneration } from '../server/clipmentor/production-generation';

await build({
 entryPoints:['desktop/main.ts'],
 bundle:true,
 platform:'node',
 format:'esm',
 packages:'external',
 sourcemap:true,
 outfile:'desktop-dist/main.mjs',
 define:{__CLIPMENTOR_PRODUCTION_BUILD__:JSON.stringify(await loadedProductionGeneration)},
});
