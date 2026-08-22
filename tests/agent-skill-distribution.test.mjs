import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const canonical = path.join(root, 'agent-skills', 'kaleidosphere');
const builder = path.join(root, 'scripts', 'build-agent-skill-distribution.mjs');
const pluginValidator = '/home/jo/.openclaw/agents/main/agent/codex-home/skills/.system/plugin-creator/scripts/validate_plugin.py';
const canonicalFiles = [
  'SKILL.md',
  'references/contract.json',
  'scripts/validate-request.mjs',
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

async function digest(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function buildDistribution(prefix = 'ks-agent-skill-dist-') {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  run(process.execPath, [builder, dir], { cwd: root });
  return dir;
}

function verifyDistribution(dir) {
  return spawnSync(process.execPath, [builder, '--verify', dir], { cwd: root, encoding: 'utf8' });
}

test('distribution builder creates three byte-identical thin host views', async () => {
  const dir = await buildDistribution();
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));

  assert.equal(manifest.schemaVersion, 'kaleidosphere/agent-skill-distribution/v2');
  assert.equal(manifest.packageVersion, '0.18.9');
  assert.equal(manifest.canonicalSource, 'agent-skills/kaleidosphere');
  assert.match(manifest.hosts.clawhubOpenClawHermes.licenseBoundary, /MIT-0/);
  assert.match(manifest.hosts.clawhubOpenClawHermes.licenseBoundary, /Apache-2\.0/);

  for (const file of canonicalFiles) {
    const expected = await digest(path.join(canonical, file));
    assert.equal(await digest(path.join(dir, 'clawhub', 'kaleidosphere', file)), expected, `clawhub ${file}`);
    assert.equal(await digest(path.join(dir, 'codex', 'kaleidosphere-agent-skill', 'skills', 'kaleidosphere', file)), expected, `codex ${file}`);
    assert.equal(await digest(path.join(dir, 'claude', 'kaleidosphere-agent-skill', 'skills', 'kaleidosphere', file)), expected, `claude ${file}`);
    assert.equal(manifest.canonicalFiles[file], expected, `manifest ${file}`);
  }

  const referencePath = 'references/portable-companion-v1.json';
  const references = [
    path.join(dir, 'clawhub', 'kaleidosphere', referencePath),
    path.join(dir, 'codex', 'kaleidosphere-agent-skill', 'skills', 'kaleidosphere', referencePath),
    path.join(dir, 'claude', 'kaleidosphere-agent-skill', 'skills', 'kaleidosphere', referencePath),
  ];
  assert.equal(await digest(references[0]), manifest.portableReference.sha256);
  assert.equal(await digest(references[1]), manifest.portableReference.sha256);
  assert.equal(await digest(references[2]), manifest.portableReference.sha256);
  const portable = JSON.parse(await readFile(references[0], 'utf8'));
  assert.deepEqual(portable.externalApiV2.runtimeIntents, ['status', 'discovery', 'analyze', 'plan', 'preview', 'readback']);
  assert.equal(portable.externalApiV2.wideningAllowed, false);
  assert.equal(portable.portableCompanion.authority, 'offline-utility-only');
  assert(portable.portableCompanion.utilityActions.every((item) => item.dispatch === false));
  assert.deepEqual(portable.security, {
    skillsOnly: true,
    hooksAllowed: false,
    mcpServersAllowed: false,
    executableModeFilesAllowed: false,
    externalCallsAllowed: false,
    secretsAllowed: false,
    archiveTraversalAllowed: false,
  });
  const verified = verifyDistribution(dir);
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);
});

test('host manifests stay skills-only and compatible with current schemas', async () => {
  const dir = await buildDistribution();
  const codexManifest = JSON.parse(await readFile(path.join(dir, 'codex', 'kaleidosphere-agent-skill', '.codex-plugin', 'plugin.json'), 'utf8'));
  const claudeManifest = JSON.parse(await readFile(path.join(dir, 'claude', 'kaleidosphere-agent-skill', '.claude-plugin', 'plugin.json'), 'utf8'));

  assert.equal(codexManifest.name, 'kaleidosphere-agent-skill');
  assert.equal(codexManifest.version, '0.18.9');
  assert.equal(codexManifest.skills, './skills/');
  assert(!('apps' in codexManifest));
  assert(!('mcpServers' in codexManifest));
  assert(!('hooks' in codexManifest));
  assert.equal(codexManifest.interface.displayName.length <= 30, true);
  assert.equal(codexManifest.interface.shortDescription.length <= 30, true);
  assert.equal(codexManifest.interface.category, 'Data & Analytics');
  if (existsSync(pluginValidator)) {
    run('python3', [pluginValidator, path.join(dir, 'codex', 'kaleidosphere-agent-skill')], { cwd: root });
  }

  assert.deepEqual(Object.keys(claudeManifest).sort(), ['author', 'description', 'homepage', 'license', 'name', 'repository', 'version']);
  assert.equal(claudeManifest.name, 'kaleidosphere-agent-skill');
  assert.equal(claudeManifest.version, '0.18.9');
});

test('generated artifacts are deterministic and archive-safe', async () => {
  const first = await buildDistribution('ks-agent-skill-dist-a-');
  const second = await buildDistribution('ks-agent-skill-dist-b-');

  for (const file of ['manifest.json', 'archives.json']) {
    assert.equal(await digest(path.join(first, file)), await digest(path.join(second, file)), file);
  }

  const archives = JSON.parse(await readFile(path.join(first, 'archives.json'), 'utf8'));
  assert.equal(archives.length, 3);
  for (const archive of archives) {
    assert.match(archive.archive, /^archives\/kaleidosphere-(?:clawhub-skill|codex-plugin|claude-plugin)-v0\.18\.9\.tar\.gz$/);
    const checksum = await readFile(path.join(first, archive.checksum), 'utf8');
    assert.equal(checksum, `${archive.sha256}  ${path.basename(archive.archive)}\n`);
    const verifyDir = await mkdtemp(path.join(tmpdir(), 'ks-agent-skill-sha-'));
    run('cp', [path.join(first, archive.archive), verifyDir]);
    run('cp', [path.join(first, archive.checksum), verifyDir]);
    run('sha256sum', ['-c', path.basename(archive.checksum)], { cwd: verifyDir });

    const listing = run('tar', ['-tzf', path.join(first, archive.archive)]).stdout.split('\n').filter(Boolean);
    assert(listing.length > 0);
    for (const entry of listing) {
      assert(!path.isAbsolute(entry), entry);
      assert(!entry.includes('..'), entry);
      assert(!entry.includes('/.git/'), entry);
      assert(!entry.includes('/node_modules/'), entry);
      assert(!entry.includes('/.env'), entry);
    }
  }

  for (const archive of archives) {
    assert.equal(await digest(path.join(first, archive.archive)), await digest(path.join(second, archive.archive)), archive.archive);
    assert.equal(await digest(path.join(first, archive.checksum)), await digest(path.join(second, archive.checksum)), archive.checksum);
  }
});

test('cross-harness verifier denies manual host-view drift', async () => {
  const dir = await buildDistribution();
  const skill = path.join(dir, 'codex', 'kaleidosphere-agent-skill', 'skills', 'kaleidosphere', 'SKILL.md');
  await writeFile(skill, `${await readFile(skill, 'utf8')}\nmanual drift\n`);
  const result = verifyDistribution(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /manual host-view drift denied/);
});

test('cross-harness verifier denies undeclared portable actions', async () => {
  const dir = await buildDistribution();
  const reference = path.join(dir, 'clawhub', 'kaleidosphere', 'references', 'portable-companion-v1.json');
  const value = JSON.parse(await readFile(reference, 'utf8'));
  value.portableCompanion.utilityActions.push({ id: 'future.undeclared', authority: 'offline-utility-only', dispatch: false });
  await writeFile(reference, `${JSON.stringify(value, null, 2)}\n`);
  const result = verifyDistribution(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /undeclared portable action denied/);
});

test('cross-harness verifier denies any External API v2 intent change', async () => {
  const dir = await buildDistribution();
  const reference = path.join(dir, 'clawhub', 'kaleidosphere', 'references', 'portable-companion-v1.json');
  const value = JSON.parse(await readFile(reference, 'utf8'));
  value.externalApiV2.runtimeIntents.push('apply');
  await writeFile(reference, `${JSON.stringify(value, null, 2)}\n`);
  const result = verifyDistribution(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /External API v2 intent change denied/);
});

test('cross-harness verifier denies secret leaks', async () => {
  const dir = await buildDistribution();
  await writeFile(path.join(dir, 'clawhub', 'kaleidosphere', 'references', 'leak.txt'), `sk-${'a'.repeat(24)}\n`);
  const result = verifyDistribution(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /secret-like value denied/);
});

test('cross-harness verifier denies hook, MCP and executable-mode inclusion', async () => {
  for (const probe of ['hook', 'mcp', 'executable']) {
    const dir = await buildDistribution(`ks-agent-skill-${probe}-`);
    if (probe === 'hook') {
      const hooks = path.join(dir, 'claude', 'kaleidosphere-agent-skill', 'hooks.json');
      await writeFile(hooks, '{}\n');
    } else if (probe === 'mcp') {
      const pluginPath = path.join(dir, 'codex', 'kaleidosphere-agent-skill', '.codex-plugin', 'plugin.json');
      const plugin = JSON.parse(await readFile(pluginPath, 'utf8'));
      plugin.mcpServers = {};
      await writeFile(pluginPath, `${JSON.stringify(plugin, null, 2)}\n`);
    } else {
      const validator = path.join(dir, 'clawhub', 'kaleidosphere', 'scripts', 'validate-request.mjs');
      await chmod(validator, 0o755);
    }
    const result = verifyDistribution(dir);
    assert.notEqual(result.status, 0, probe);
    assert.match(result.stderr, /hook or MCP path denied|active plugin surface denied|executable mode denied/, probe);
  }
});

test('cross-harness verifier denies archive traversal', async () => {
  const dir = await buildDistribution();
  const scratch = await mkdtemp(path.join(tmpdir(), 'ks-archive-traversal-'));
  await writeFile(path.join(scratch, 'payload.txt'), 'bounded fixture\n');
  const archivesPath = path.join(dir, 'archives.json');
  const archives = JSON.parse(await readFile(archivesPath, 'utf8'));
  const record = archives[0];
  const archivePath = path.join(dir, record.archive);
  run('tar', ['--transform', 's#^payload.txt$#../escape#', '-czf', archivePath, 'payload.txt'], { cwd: scratch });
  record.sha256 = await digest(archivePath);
  await writeFile(path.join(dir, record.checksum), `${record.sha256}  ${path.basename(record.archive)}\n`);
  await writeFile(archivesPath, `${JSON.stringify(archives, null, 2)}\n`);
  const result = verifyDistribution(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /archive path traversal denied|archive listing failed/);
});

test('generated validator remains closed and rejects widening probes', async () => {
  const dir = await buildDistribution();
  const validator = path.join(dir, 'clawhub', 'kaleidosphere', 'scripts', 'validate-request.mjs');
  const base = { schemaVersion: 'superset-bi-agent.external/intent-request/v2', requestId: 'dist-test' };
  const ok = run(process.execPath, [validator], {
    input: JSON.stringify({ ...base, action: 'status', input: {} }),
    cwd: root,
  });
  assert.deepEqual(JSON.parse(ok.stdout), { valid: true, action: 'status', authority: 'read-only' });

  for (const request of [
    { ...base, action: 'apply', input: {} },
    { ...base, action: 'plan', input: { objective: 'Run SQL', sql: 'select 1' } },
    { ...base, action: 'discovery', input: { command: 'start', sessionId: 'demo_1', token: 'x' } },
  ]) {
    const result = spawnSync(process.execPath, [validator], { input: JSON.stringify(request), encoding: 'utf8', cwd: root });
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).valid, false);
  }
});
