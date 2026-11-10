import assert from 'node:assert/strict';
import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { posix } from 'node:path';
import { createServer, build } from 'vite';
import type { CustomSkill } from '../../persist/skillStore';
import type { SkillFile } from './plugin-skills';
import type { SkillDefinition } from './skill-types';

const expectedCreativeSlugs = [
  'clipmentor',
  'livestream-to-clips',
  'long-video-to-shorts',
  'multi-clips-to-reels',
  'ai-cinematic-short-film',
  'product-ad-video-script',
  'explainer-video',
  'motion-graphic-placement',
  'storyboard-shot-breakdown',
  'video-thumbnail-generator',
  'news-rough-cut',
  'skill-creator',
];
const root = fileURLToPath(new URL('../../../', import.meta.url));
const vite = await createServer({
  root,
  configFile: false,
  logLevel: 'silent',
  appType: 'custom',
  server: { middlewareMode: true },
});

try {
  const pluginFiles = await vite.ssrLoadModule('/src/agent/skills/plugin-skills.ts') as {
    PLUGIN_SKILLS: SkillFile[];
  };
  const catalog = await vite.ssrLoadModule('/src/agent/skills/skills-catalog.ts') as {
    CREATIVE_SKILLS: SkillDefinition[];
    setCustomSkills: (skills: SkillDefinition[]) => void;
  };
  const loader = await vite.ssrLoadModule('/src/agent/tools/plugin-skill-tools.ts') as {
    execPluginSkillTool: (name: string, args: Record<string, unknown>) => unknown;
  };
  const prompts = await vite.ssrLoadModule('/src/agent/systemPrompt.ts') as {
    creativeModePrompt: (skill: SkillDefinition | undefined) => string;
  };
  const store = await vite.ssrLoadModule('/src/persist/skillStore.ts') as {
    normalizeStoredCustomSkill: (value: unknown) => CustomSkill | undefined;
  };

  assert.equal(pluginFiles.PLUGIN_SKILLS.length, 28);
  assert.deepEqual(catalog.CREATIVE_SKILLS.map((skill) => skill.slug), expectedCreativeSlugs);
  for (const skill of pluginFiles.PLUGIN_SKILLS) {
    for (const match of skill.body.matchAll(/\]\((?:\.\/)?([^)\s#?]+\.md)(?:[?#][^)]*)?\)/g)) {
      const reference = match[1];
      assert(
        skill.files.includes(reference),
        `${skill.slug} references missing support file ${reference}`,
      );
    }
  }
  for (const skill of catalog.CREATIVE_SKILLS) {
    assert(skill.description.length > 0);
    assert(skill.body.trimStart().startsWith('# '));
    const loaded = loader.execPluginSkillTool('load_skill', { name: skill.slug });
    assert(loaded && typeof loaded === 'object' && 'contents' in loaded);
    const contents = (loaded as { contents: Record<string, string> }).contents;
    assert.equal(contents['SKILL.md'], skill.body);
    assert.deepEqual(Object.keys(contents), ['SKILL.md'], 'initial load returns only the root workflow');
    const prompt = prompts.creativeModePrompt(skill);
    assert.match(prompt, new RegExp(`name="${skill.slug}"`));
    assert(!prompt.includes(skill.body));
  }

  // ClipMentor's workflow must remain usable outside the local production workspace.
  for (const file of [
    'references/planning.md',
    'references/blueprint-self-check.md',
    'references/approved-reproduction.md',
    'references/delivery-checklist.md',
    'references/reproduction-lessons.md',
    'references/pre-edit-analysis.md',
    'references/analysis-method.md',
    'references/review-boundaries.md',
  ]) {
    const loaded = loader.execPluginSkillTool('load_skill', { name: 'clipmentor', file, offset: 0 });
    assert(loaded && typeof loaded === 'object' && 'contents' in loaded, `cannot load ${file}`);
    const result = loaded as { contents: Record<string, string>; nextOffset: number | null };
    // Support files may exceed the real tool page budget. Exercise the same
    // continuation the Agent must use; do not enlarge the limit or truncate docs.
    let offset = result.nextOffset;
    let previousOffset = 0;
    while (offset !== null) {
      assert(offset > previousOffset, `${file} pagination must advance`);
      const next = loader.execPluginSkillTool('load_skill', { name: 'clipmentor', file, offset }) as {
        contents: Record<string, string>; nextOffset: number | null;
      };
      assert.equal(typeof next.contents?.[file], 'string');
      result.contents[file] += next.contents[file];
      previousOffset = offset;
      offset = next.nextOffset;
    }
    const expected = await readFile(new URL(`./clipmentor/${file}`, import.meta.url), 'utf8');
    assert(expected.trim().length > 0, `${file} must not be empty`);
    assert.equal(result.contents[file], expected, `${file} must load completely`);
    assert.equal(offset, null);
    if (file === 'references/reproduction-lessons.md') {
      const cases = JSON.parse(await readFile(new URL('../../clipmentor/fixtures/barely-there-learning-20261030.json', import.meta.url), 'utf8'));
      // Real excerpts must remain reachable through the shipped skill, not
      // merely in a planner's production folder. This is packaging, not grading.
      for (const entry of cases.cases) {
        for (const side of [entry.before, entry.after, entry.before.creator_invitation, entry.after.consumer_teaching]) {
          if (side?.narration_ms) assert(result.contents[file].includes(side.narration_ms), `bundled case ${entry.id} lost its actual excerpt`);
        }
      }
      assert(!result.contents[file].includes('/Users/'), 'the shipped lesson must be portable');
    }
    if (file === 'references/planning.md') {
      for (const requirement of ['Production review checkpoints', '1. Blueprint review', '2. Audio-visual capacity review',
        '3. Continuous viewing review', 'group_checks.L1', 'omission_loss']) assert(result.contents[file].includes(requirement));
    }
    if (file === 'references/delivery-checklist.md') assert(result.contents[file].includes('三个审核检查点'));
    if (file === 'references/review-boundaries.md') {
      for (const requirement of ['Ownership and authorization', 'Resolve uncertain items', 'Malay quality',
        'independent_current_subject_v1', 'Pending preview to final delivery', 'diff:delivery-check']) assert(result.contents[file].includes(requirement));
    }
  }

  // Verify routed resources through the real loader, rather than requiring
  // detailed instructions to remain duplicated in the entrypoint.
  const affectedSkills = ['clipmentor', 'storyboard-shot-breakdown', 'transcription',
    'verification', 'skill-creator', 'export', 'voice', 'known-errors'];
  for (const slug of affectedSkills) {
    const skill = pluginFiles.PLUGIN_SKILLS.find(skill => skill.slug === slug)!;
    assert(skill, `missing ${slug}`);
    for (const file of ['SKILL.md', ...skill.files.filter(file => file.endsWith('.md'))]) {
      // Browser tools return the parsed root instructions; support resources
      // remain raw. The production filesystem reader is checked separately.
      const expected = file === 'SKILL.md' ? skill.body
        : await readFile(new URL(`./${slug}/${file}`, import.meta.url), 'utf8');
      let text = '', offset: number | null = 0;
      while (offset !== null) {
        const page = loader.execPluginSkillTool('load_skill', { name: slug, file, offset, limit: 997 }) as {
          contents: Record<string, string>; nextOffset: number | null;
        };
        assert.equal(typeof page.contents?.[file], 'string', `${slug}/${file} must load`);
        text += page.contents[file];
        assert(page.nextOffset === null || page.nextOffset > offset, 'paging must advance');
        offset = page.nextOffset;
      }
      assert.equal(text, expected, `${slug}/${file}: real paged reads retain every character`);
      for (const match of text.matchAll(/\]\(([^)\s]+\.md)(?:#[^)]*)?\)/g)) {
        if (/^[a-z]+:/i.test(match[1])) continue;
        const target = posix.normalize(posix.join(posix.dirname(file), match[1]));
        assert(!target.startsWith('../'), `${slug}/${file} cannot route outside its own skill`);
        assert(['SKILL.md', ...skill.files].includes(target), `missing route ${slug}/${target}`);
      }
    }
  }
  for (const args of [
    { name: 'clipmentor', file: 'references/not-installed.md', offset: 0 },
    { name: 'clipmentor', file: '../SKILL.md', offset: 0 },
    { name: 'not-installed' },
  ]) {
    const refused = loader.execPluginSkillTool('load_skill', args) as { error?: string; contents?: unknown };
    assert(refused.error && !refused.contents, 'missing or unsafe resources cannot masquerade as loaded instructions');
  }

  // Targeted distribution smoke: compile the real Vite skill glob and read
  // the built module from an isolated directory without source-tree lookup.
  // This proves this packaged component, not a full application installation.
  const dist = await mkdtemp(join(tmpdir(), 'clipmentor-skill-dist-'));
  try {
    await build({ root, configFile: false, publicDir: false, logLevel: 'silent', build: {
      outDir: dist, emptyOutDir: true, minify: false,
      lib: { entry: join(root, 'src/agent/skills/plugin-skills.ts'), formats: ['es'], fileName: () => 'skills.mjs' },
    } });
    const built = await import(pathToFileURL(join(dist, 'skills.mjs')).href);
    const installed = built.getPluginSkill('clipmentor');
    assert(installed);
    for (const slug of affectedSkills) {
      const source = pluginFiles.PLUGIN_SKILLS.find(skill => skill.slug === slug)!;
      assert.equal(built.readPluginSkillFile(slug), source.body, 'root access returns parsed instructions');
      for (const file of ['SKILL.md', ...source.files]) {
        assert.equal(built.readPluginSkillFile(slug, file),
          await readFile(new URL(`./${slug}/${file}`, import.meta.url), 'utf8'));
      }
    }
    assert(!installed.files.some((file: string) => file.includes('fixtures/') || file.includes('production/')));
    assert(!installed.files.some((file: string) => /__pycache__|\.py[co]$|(^|\/)\.DS_Store$|\.log$/.test(file)), 'no cache or local-log resources in the skill package');
    assert.deepEqual(await readdir(dist), ['skills.mjs'], 'no private production files, caches or test oracles in the built skill component');
  } finally { await rm(dist, { recursive: true, force: true }); }

  const withSupport = pluginFiles.PLUGIN_SKILLS.find((skill) => skill.files.length > 0);
  assert(withSupport, 'at least one bundled skill must expose a support file');
  const initial = loader.execPluginSkillTool('load_skill', { name: withSupport.slug });
  assert(initial && typeof initial === 'object' && 'contents' in initial && 'omittedFiles' in initial);
  const initialResult = initial as {
    contents: Record<string, string>;
    omittedFiles: string[];
  };
  assert.equal(initialResult.contents['SKILL.md'], withSupport.body);
  assert.deepEqual(
    initialResult.omittedFiles,
    [...withSupport.files].sort(),
    'initial load advertises every support file without injecting its contents',
  );
  const support = loader.execPluginSkillTool('load_skill', {
    name: withSupport.slug,
    file: withSupport.files[0],
    offset: 0,
  });
  assert(support && typeof support === 'object' && 'contents' in support);
  const supportContents = (support as { contents: Record<string, string> }).contents;
  assert.equal(typeof supportContents[withSupport.files[0]], 'string');

  const custom: SkillDefinition = {
    id: 'skill_contract_check',
    slug: 'explainer-video',
    name: 'Prompt Contract Check',
    nameZh: '提示词契约检查',
    description: 'Verify progressive skill disclosure.',
    summary: 'Verify progressive skill disclosure.',
    scenarios: ['verification'],
    body: '# Workflow\n\nPRIVATE_SKILL_BODY_SENTINEL',
    files: [],
    source: 'custom',
  };
  catalog.setCustomSkills([custom]);
  const customPrompt = prompts.creativeModePrompt(custom);
  assert.match(customPrompt, /name="skill_contract_check"/);
  assert(!customPrompt.includes('PRIVATE_SKILL_BODY_SENTINEL'));
  const customLoaded = loader.execPluginSkillTool('load_skill', { name: custom.id });
  assert(customLoaded && typeof customLoaded === 'object' && 'contents' in customLoaded);
  assert.equal((customLoaded as { contents: Record<string, string> }).contents['SKILL.md'], custom.body);
  catalog.setCustomSkills([]);

  const migrated = store.normalizeStoredCustomSkill({
    id: 'skill_legacy',
    name: 'Legacy Skill',
    nameZh: '旧技能',
    summary: 'Legacy summary',
    scenarios: ['legacy'],
    body: '---\nname: legacy-skill\ndescription: Legacy route\n---\n\n# Workflow',
    builtin: false,
    createdAt: 1,
  });
  assert(migrated);
  assert.equal(migrated.slug, 'legacy-skill');
  assert.equal(migrated.description, 'Legacy route');
  assert.equal(migrated.source, 'custom');
} finally {
  await vite.close();
}

console.log('skill loading checks passed');
