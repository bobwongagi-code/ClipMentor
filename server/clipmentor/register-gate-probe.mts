import { readFile } from 'node:fs/promises';
import { recordEditorApprovedGateProbe } from './production-gate-probes';

const [candidateFile, acceptanceFile] = process.argv.slice(2);
if(!candidateFile||!acceptanceFile)throw Error('Usage: tsx server/clipmentor/register-gate-probe.mts <saved-project.json> <editor-acceptance.json>');
const [candidate,acceptance]=await Promise.all([candidateFile,acceptanceFile].map(file=>readFile(file,'utf8').then(body=>JSON.parse(body))));
console.log(JSON.stringify(await recordEditorApprovedGateProbe(candidate,acceptance),null,2));
