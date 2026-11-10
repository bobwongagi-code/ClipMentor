import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  DEV_PROFILE_METADATA,
  loadOrCreateDevProfile,
  profileChildEnvironment,
  resolveDevHeadlessShell,
  describeDevCheckout,
} from './dev-profile.mjs';

const UUID_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const UUID_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const fixture = await mkdtemp(join(tmpdir(), 'openchatcut-dev-profile-'));

async function fixturePaths(name) {
  const root = join(fixture, name);
  const gitDir = join(root, 'git-dir');
  const repoRoot = join(root, 'checkout');
  const homeDir = join(root, 'home');
  await Promise.all([
    mkdir(gitDir, { recursive: true }),
    mkdir(repoRoot, { recursive: true }),
    mkdir(homeDir, { recursive: true }),
  ]);
  return { gitDir, repoRoot, homeDir };
}

async function expectInvalid(paths, value, pattern) {
  const metadataPath = join(paths.gitDir, DEV_PROFILE_METADATA);
  await writeFile(metadataPath, value, { mode: 0o600 });
  await assert.rejects(
    loadOrCreateDevProfile({ ...paths, randomId: () => UUID_A }),
    pattern,
  );
}

try {
  const source = join(fixture, 'versioned-source');
  await mkdir(source);
  const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
  git('init', '-q');
  await writeFile(join(source, 'code.txt'), 'first');
  git('add', 'code.txt');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--no-gpg-sign', '-qm', 'fixture');
  assert.deepEqual(await describeDevCheckout(source), { repoRoot: source, commit: git('rev-parse', 'HEAD'), dirty: false });
  await writeFile(join(source, 'untracked-source.txt'), 'new');
  assert.equal((await describeDevCheckout(source)).dirty, true, 'untracked source must not be reported as a clean committed version');
  await rm(join(source, 'untracked-source.txt'));
  await writeFile(join(source, 'code.txt'), 'modified');
  assert.equal((await describeDevCheckout(source)).dirty, true, 'modified tracked source is only based on the parent commit');

  // Exercise the real launcher from a different checkout. Override only the
  // child test's os.homedir function; never repurpose HOME or touch user profiles.
  await mkdir(join(source, 'scripts'));
  const launcher = join(source, 'scripts', 'dev-profile.mjs');
  await writeFile(launcher, await readFile(new URL('./dev-profile.mjs', import.meta.url)));
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--no-gpg-sign', '-qm', 'launcher fixture');
  const caller = join(fixture, 'caller-checkout'), commandHome = join(fixture, 'command-home');
  await mkdir(caller);
  execFileSync('git', ['init', '-q'], { cwd: caller });
  const commandRoot = await realpath(source);
  const commandProfile = await loadOrCreateDevProfile({ gitDir: join(source, '.git'), repoRoot: commandRoot, homeDir: commandHome, randomId: () => UUID_A });
  await writeFile(commandProfile.keystorePath, 'CM_PROFILE_MARKER=source-profile\n');
  const preload = "import os from 'node:os';import{syncBuiltinESMExports}from'node:module';os.homedir=()=>process.env.CM_FIXTURE_PROFILE_HOME;syncBuiltinESMExports();";
  const output = execFileSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload), launcher,
    '--exec', process.execPath, '-e', "console.log('CHILD '+JSON.stringify({cwd:process.cwd(),profileId:process.env.OPENCHATCUT_DEV_PROFILE_ID,marker:process.env.CM_PROFILE_MARKER}))"], {
    cwd: caller, encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH, CC_BROWSER_EXECUTABLE: 'fixture-browser', CM_FIXTURE_PROFILE_HOME: commandHome },
  });
  const child = JSON.parse(output.split('\n').find(line => line.startsWith('CHILD ')).slice(6));
  assert.deepEqual(child, { cwd: commandRoot, profileId: UUID_A, marker: 'source-profile' });
  assert(output.includes(`source ${commandRoot}`) && output.includes(`commit ${git('rev-parse', 'HEAD')}`) && output.includes('clean working tree'));
  await assert.rejects(readFile(join(caller, '.git', DEV_PROFILE_METADATA)), { code: 'ENOENT' }, 'the caller checkout must not select or create the executing source profile');
  const stablePaths = await fixturePaths('stable');
  const first = await loadOrCreateDevProfile({ ...stablePaths, randomId: () => UUID_A });
  const reused = await loadOrCreateDevProfile({ ...stablePaths, randomId: () => UUID_B });
  assert.equal(first.id, UUID_A);
  assert.deepEqual(reused, first);
  assert.equal(first.rootDir, join(stablePaths.homeDir, '.openchatcut', 'dev-profiles', UUID_A));
  assert.deepEqual(
    JSON.parse(await readFile(join(stablePaths.gitDir, DEV_PROFILE_METADATA), 'utf8')),
    { version: 1, profileId: UUID_A, repoRoot: stablePaths.repoRoot },
  );
  await writeFile(
    first.keystorePath,
    "OPENAI_API_KEY='profile#secret'\nLLM_BASE_URL=https://example.test/\\$route\nASSEMBLYAI_API_KEY=\n",
    { mode: 0o600 },
  );
  const childEnvironment = await profileChildEnvironment(first, {
    OPENAI_API_KEY: 'checkout-secret',
    UNRELATED: 'inherited',
    OPENCHATCUT_DEV_PROFILE_ID: UUID_B,
    ASSEMBLYAI_API_KEY: 'checkout-transcription-secret',
  });
  assert.equal(childEnvironment.OPENAI_API_KEY, 'profile#secret');
  assert.equal(childEnvironment.LLM_BASE_URL, 'https://example.test/$route');
  assert.equal(childEnvironment.UNRELATED, 'inherited');
  assert.equal(childEnvironment.ASSEMBLYAI_API_KEY, '',
    'an isolated empty-value tombstone must suppress an inherited checkout secret');
  assert.equal(childEnvironment.OPENCHATCUT_DEV_PROFILE_ID, UUID_A);

  const shellExecutable = join(fixture, 'headless-shell');
  await writeFile(shellExecutable, 'test shell', { mode: 0o755 });
  let browserResolutionCalls = 0;
  const resolveCachedBrowser = async (options) => {
    browserResolutionCalls += 1;
    assert.equal(options.chromeMode, 'headless-shell');
    assert.equal(options.logLevel, 'error');
    return { type: 'local-puppeteer-browser', path: shellExecutable };
  };
  assert.equal(
    await resolveDevHeadlessShell({}, resolveCachedBrowser),
    shellExecutable,
    'Remotion-approved executable headless shell is reused',
  );
  const discoveredShellEnvironment = await profileChildEnvironment(first, {}, resolveCachedBrowser);
  assert.equal(discoveredShellEnvironment.CC_BROWSER_EXECUTABLE, shellExecutable);
  const explicitShellEnvironment = await profileChildEnvironment(first, {
    CC_BROWSER_EXECUTABLE: '/explicit/headless-shell',
  }, async () => {
    assert.fail('explicit browser configuration must bypass Remotion resolution');
  });
  assert.equal(
    explicitShellEnvironment.CC_BROWSER_EXECUTABLE,
    '/explicit/headless-shell',
    'an explicit browser executable remains authoritative',
  );
  assert.equal(browserResolutionCalls, 2);
  assert.equal(
    await resolveDevHeadlessShell({}, async (options) => {
      options.onBrowserDownload({ chromeMode: 'headless-shell' });
      return { type: 'no-browser' };
    }),
    undefined,
    'missing or version-mismatched caches fall back without starting a download',
  );
  if (process.platform !== 'win32') {
    await chmod(shellExecutable, 0o644);
    assert.equal(
      await resolveDevHeadlessShell({}, resolveCachedBrowser),
      undefined,
      'a non-executable cache entry is never injected',
    );
  }
  if (process.platform !== 'win32') {
    assert.equal((await stat(first.metadataPath)).mode & 0o777, 0o600);
    assert.equal((await stat(first.rootDir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(first.rootDir, 'electron-user-data'))).mode & 0o777, 0o700);
    assert.equal((await stat(join(first.rootDir, 'project-store-auth-v1'))).mode & 0o777, 0o700);
    assert.equal((await stat(join(first.rootDir, 'media', 'uploads'))).mode & 0o777, 0o700);
  }

  const concurrentPaths = await fixturePaths('concurrent');
  const [left, right] = await Promise.all([
    loadOrCreateDevProfile({ ...concurrentPaths, randomId: () => UUID_A }),
    loadOrCreateDevProfile({ ...concurrentPaths, randomId: () => UUID_B }),
  ]);
  assert.equal(left.id, right.id);
  assert.ok(left.id === UUID_A || left.id === UUID_B);

  await expectInvalid(await fixturePaths('corrupt'), '{not-json', /not valid JSON/);
  await expectInvalid(
    await fixturePaths('partial'),
    JSON.stringify({ version: 1, profileId: UUID_A }),
    /expected only version, profileId, and repoRoot/,
  );
  await expectInvalid(
    await fixturePaths('traversal'),
    JSON.stringify({ version: 1, profileId: '../escape', repoRoot: join(fixture, 'traversal', 'checkout') }),
    /invalid profileId/,
  );

  const movedPaths = await fixturePaths('moved');
  await loadOrCreateDevProfile({ ...movedPaths, randomId: () => UUID_A });
  await assert.rejects(
    loadOrCreateDevProfile({
      ...movedPaths,
      repoRoot: join(fixture, 'other-checkout'),
      randomId: () => UUID_B,
    }),
    /repoRoot changed.*Remove that file to regenerate/s,
  );
} finally {
  await rm(fixture, { recursive: true, force: true });
}
