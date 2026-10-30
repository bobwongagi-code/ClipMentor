/** Local read-only command; advisory output never grants production permission. */
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lintBlueprint } from '../../src/clipmentor/blueprint-lint.ts';

export async function checkBlueprintFiles(args: string[]) {
  try {
    if (!(args.length === 1 || args.length === 3 && args[1] === '--md')) throw new Error('Usage: check:clipmentor-blueprint -- candidate.json [--md view.md]');
    const jsonPath = resolve(args[0]), input = JSON.parse(await readFile(jsonPath, 'utf8'));
    if (args.length === 1) return lintBlueprint(input);
    const mdPath = resolve(args[2]), text = await readFile(mdPath, 'utf8');
    // Only explicit local Markdown links or backtick file references. Never fetch URLs.
    const references: Array<{ reference: string; is_source: boolean }> = [];
    for (const match of text.matchAll(/\[([^\]\n]+)\]\(([^)\n]+\.json)(?:#[^)]*)?\)|`([^`\n]+\.json)`/gu)) {
      const reference = match[2] ?? match[3];
      const label = match[1] ?? text.slice(Math.max(0, match.index! - 32), match.index);
      const is_source = /机器源|机源|machine[ -]?source|候选.*JSON|蓝图.*JSON/iu.test(label) && !/历史|旧版|先前|previous|historical|parent/iu.test(label);
      if (/^[a-z][a-z\d+.-]*:/iu.test(reference)) continue;
      references.push({ reference, is_source });
    }
    const inputReal = await realpath(jsonPath);
    const checks = await Promise.all(references.map(async ({ reference, is_source }) => {
      let local = reference;
      try { local = decodeURIComponent(reference); } catch { /* Report malformed literal references as missing. */ }
      const path = resolve(dirname(mdPath), local);
      try { return { reference, exists: (await stat(path)).isFile(), is_source, matches_input: await realpath(path) === inputReal }; }
      catch { return { reference, exists: false, is_source, matches_input: false }; }
    }));
    return lintBlueprint(input, { markdown: { text, references: checks } });
  } catch (error) {
    return { advisory_only: true, scope: 'input_unreadable_no_check_claim', findings: [{ rule_id: 'INPUT', level: 'notice', location: '$', excerpt: '', message: error instanceof Error ? error.message : 'Unable to read input' }] };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await checkBlueprintFiles(process.argv.slice(2)), null, 2));
  // Even a malformed input is an advisory report, never a save/dispatch gate.
}
