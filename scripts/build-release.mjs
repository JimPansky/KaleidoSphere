#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('release version must be semver x.y.z');

const archiveName = `Superset_BI_Agent-v${version}.tar.gz`;
const checksumName = `${archiveName}.sha256`;
const outputDir = path.resolve(process.argv[2] ?? path.join(root, 'dist', 'release'));
const archivePath = path.join(outputDir, archiveName);
const checksumPath = path.join(outputDir, checksumName);

function runGit(args, options = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', ...options });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function isGitCheckout() {
  return spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' }).status === 0;
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true, mode: 0o755 });

const gzip = createGzip({ mtime: 0, level: 9 });
if (isGitCheckout()) {
  const status = runGit(['status', '--porcelain', '--untracked-files=no']);
  if (status && process.env.CM_BI_RELEASE_ALLOW_DIRTY !== '1') {
    throw new Error('release archive requires a clean tracked worktree; set CM_BI_RELEASE_ALLOW_DIRTY=1 only for local regression tests');
  }
  const archive = spawn('git', ['archive', '--format=tar', `--prefix=Superset_BI_Agent-v${version}/`, 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
  const archiveClosed = new Promise((resolve) => archive.on('close', resolve));
  await pipeline(archive.stdout, gzip, createWriteStream(archivePath, { mode: 0o644 }));
  const exitCode = await archiveClosed;
  if (exitCode !== 0) throw new Error(`git archive exited ${exitCode}`);
} else {
  const archive = spawn('tar', [
    '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
    '--exclude=./.git', '--exclude=./node_modules', '--exclude=./.env', '--exclude=./dist',
    '--exclude=./.runtime/metadata', '--exclude=./.runtime/projection', '--exclude=./.runtime/receipts', '--exclude=./.runtime/secrets',
    '--exclude=./.secrets/llm_api_key', '--exclude=./.secrets/mssql_password', '--exclude=./.secrets/oracle_password',
    '--transform', `s#^\\.#Superset_BI_Agent-v${version}#`, '-cf', '-', '.',
  ], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
  const archiveClosed = new Promise((resolve) => archive.on('close', resolve));
  await pipeline(archive.stdout, gzip, createWriteStream(archivePath, { mode: 0o644 }));
  const exitCode = await archiveClosed;
  if (exitCode !== 0) throw new Error(`tar archive exited ${exitCode}`);
}

const digest = createHash('sha256').update(await readFile(archivePath)).digest('hex');
const checksumLine = `${digest}  ${archiveName}\n`;
await writeFile(checksumPath, checksumLine, { mode: 0o644 });
process.stdout.write(`${checksumLine}${archivePath}\n${checksumPath}\n`);
