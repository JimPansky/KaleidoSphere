import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

test('release archive checksum is portable from a clean verifier directory', async () => {
  const buildDir = await mkdtemp(path.join(tmpdir(), 'sba-release-build-'));
  const verifyDir = await mkdtemp(path.join(tmpdir(), 'sba-release-verify-'));

  run('node', ['scripts/build-release.mjs', buildDir], {
    cwd: root,
    env: { ...process.env, CM_BI_RELEASE_ALLOW_DIRTY: '1' },
  });

  const checksumPath = path.join(buildDir, 'Superset_BI_Agent-v0.5.0.tar.gz.sha256');
  const archivePath = path.join(buildDir, 'Superset_BI_Agent-v0.5.0.tar.gz');
  const checksum = await readFile(checksumPath, 'utf8');
  assert.match(checksum, /^[a-f0-9]{64}  Superset_BI_Agent-v0\.5\.0\.tar\.gz\n$/);
  assert.doesNotMatch(checksum.split(/\s+/)[1], /\//);

  await cp(checksumPath, path.join(verifyDir, path.basename(checksumPath)));
  await cp(archivePath, path.join(verifyDir, path.basename(archivePath)));
  run('sha256sum', ['-c', 'Superset_BI_Agent-v0.5.0.tar.gz.sha256'], { cwd: verifyDir });

  const listing = run('tar', ['-tzf', 'Superset_BI_Agent-v0.5.0.tar.gz'], { cwd: verifyDir }).stdout;
  assert(listing.includes('Superset_BI_Agent-v0.5.0/package.json\n'));
  assert(!listing.includes('/.git/'));
  assert(!listing.includes('Superset_BI_Agent-v0.4.1/.env\n'));
  assert(!listing.includes('/node_modules/'));
  for (const entry of listing.split('\n').filter((line) => /\/\.(?:runtime|secrets)\//.test(line))) {
    assert.match(entry, /\/\.(?:runtime|secrets)\/(?:\.gitkeep)?$/);
  }
});
