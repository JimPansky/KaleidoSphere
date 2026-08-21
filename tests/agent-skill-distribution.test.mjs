import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
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

test('distribution builder creates three byte-identical thin host views', async () => {
  const dir = await buildDistribution();
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));

  assert.equal(manifest.packageVersion, '0.18.7');
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
});

test('host manifests stay skills-only and compatible with current schemas', async () => {
  const dir = await buildDistribution();
  const codexManifest = JSON.parse(await readFile(path.join(dir, 'codex', 'kaleidosphere-agent-skill', '.codex-plugin', 'plugin.json'), 'utf8'));
  const claudeManifest = JSON.parse(await readFile(path.join(dir, 'claude', 'kaleidosphere-agent-skill', '.claude-plugin', 'plugin.json'), 'utf8'));

  assert.equal(codexManifest.name, 'kaleidosphere-agent-skill');
  assert.equal(codexManifest.version, '0.18.7');
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
  assert.equal(claudeManifest.version, '0.18.7');
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
    assert.match(archive.archive, /^archives\/kaleidosphere-(?:clawhub-skill|codex-plugin|claude-plugin)-v0\.18\.7\.tar\.gz$/);
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
