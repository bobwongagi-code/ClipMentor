import { readFile, stat } from 'node:fs/promises';
import { migrateProjectDoc } from '../../src/persist/projectStore';
import { diffDeliveryCheck } from '../../src/clipmentor/delivery-diff';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('Usage: npm run diff:delivery-check -- before.json after.json [--json]\nRead-only comparison of explicit ProjectDoc snapshots; revision names alone are not resolved.');
} else {
  try {
    if (args.length < 2 || args.length > 3 || (args.length === 3 && args[2] !== '--json')) throw new Error('arguments');
    const load = async (file: string) => {
      if ((await stat(file)).size > 16 * 1024 * 1024) throw new Error('size');
      const raw = JSON.parse(await readFile(file, 'utf8'));
      const doc = migrateProjectDoc(structuredClone(raw));
      if (!doc || !Array.isArray(raw.timelines)) throw new Error('document');
      // Compare persisted records, not identities synthesized while opening an old snapshot.
      const persisted = { activeTimelineId: raw.activeTimelineId, assets: Array.isArray(raw.assets) ? raw.assets : [], timelines: raw.timelines };
      return { doc, persisted };
    };
    const [before, after] = await Promise.all([load(args[0]), load(args[1])]);
    const result = await diffDeliveryCheck(before.doc, after.doc, { before: before.persisted, after: after.persisted });
    if (args[2] === '--json') console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Revision ${result.from_revision ?? 'unknown'} → ${result.to_revision ?? 'unknown'}; ${result.changes.length} changed records; ${result.added_audio_assets} added audio assets.`);
      console.log(`Plan gate: ${result.from_gate.code} → ${result.to_gate.code}. This report is not film acceptance.`);
      for (const c of result.changes) console.log(`${c.scope} ${JSON.stringify(c.id)}: ${c.change}${c.fields.length ? ' ' + JSON.stringify(c.fields) : ''}`);
      if (result.active_timeline_changed) console.log('Active timeline changed.');
      if (result.review_binding_changed) console.log('Review version/content binding changed.');
      if (result.baseline_changed) console.log('Source identity/range changed; do not inherit old approval.');
      if (!result.changes.length && !result.active_timeline_changed && !result.review_binding_changed && result.from_gate.code === result.to_gate.code && result.from_gate.allowed === result.to_gate.allowed) console.log('No compared delivery fields changed; unchanged records omitted.');
    }
  } catch {
    console.error('Cannot compare snapshots. Supply two readable ProjectDoc JSON files (each ≤16 MiB) and optional --json. No files were changed.');
    process.exitCode = 1;
  }
}
