#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const version = packageJson.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`package version must be semver x.y.z, got ${version}`);

const outputRoot = path.resolve(process.argv[2] ?? path.join(root, 'dist', 'agent-skill-distribution'));
const canonicalSkill = 'agent-skills/kaleidosphere';
const canonicalFiles = [
  'SKILL.md',
  'references/contract.json',
  'scripts/validate-request.mjs',
];
const denySecret = /(?:sk-[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9_]{20,}|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|password\s*=|token\s*=|secret\s*=)/i;
const remoteExecution = /(?:curl|wget)\s+[^|;&\n]+[|]\s*(?:sh|bash)|npx\s+-?y\s+[^@\s]+@latest/i;

function relSafe(file) {
  const normalized = path.posix.normalize(file);
  if (normalized.startsWith('../') || normalized === '..' || path.isAbsolute(file) || normalized.includes('\0')) {
    throw new Error(`unsafe relative path: ${file}`);
  }
  return normalized;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readCanonical(file) {
  const relative = relSafe(file);
  const absolute = path.join(root, canonicalSkill, relative);
  const stat = await lstat(absolute);
  if (!stat.isFile()) throw new Error(`canonical file is not a regular file: ${file}`);
  const bytes = await readFile(absolute);
  const text = bytes.toString('utf8');
  if (denySecret.test(text)) throw new Error(`secret-like value denied in canonical file: ${file}`);
  if (remoteExecution.test(text)) throw new Error(`remote executable pattern denied in canonical file: ${file}`);
  return { relative, absolute, bytes, digest: sha256(bytes) };
}

async function writeBytes(base, file, bytes, mode = 0o644) {
  const relative = relSafe(file);
  const absolute = path.join(base, relative);
  if (!absolute.startsWith(`${base}${path.sep}`)) throw new Error(`path escaped output root: ${file}`);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, bytes, { mode });
  await chmod(absolute, mode);
}

async function copySkill(destination) {
  const records = [];
  for (const file of canonicalFiles) {
    const record = await readCanonical(file);
    await writeBytes(destination, record.relative, record.bytes, file.endsWith('.mjs') ? 0o755 : 0o644);
    records.push(record);
  }
  return records;
}

async function walkFiles(dir, prefix = '') {
  const out = [];
  for (const entry of (await readdir(path.join(dir, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(dir, relative);
    if (entry.isSymbolicLink()) throw new Error(`symlink denied in distribution: ${relative}`);
    if (entry.isDirectory()) out.push(...await walkFiles(dir, relative));
    else if (entry.isFile()) out.push(relative);
    else throw new Error(`non-regular path denied in distribution: ${relative}`);
  }
  return out;
}

async function writeJson(file, value) {
  await writeBytes(outputRoot, file, `${JSON.stringify(value, null, 2)}\n`);
}

function tarGz(sourceDir, archivePath, rootName) {
  const result = spawnSync('tar', [
    '--sort=name',
    '--mtime=@0',
    '--owner=0',
    '--group=0',
    '--numeric-owner',
    '--transform', `s#^\\.#${rootName}#`,
    '-czf',
    archivePath,
    '.',
  ], {
    cwd: sourceDir,
    encoding: 'utf8',
    env: { ...process.env, GZIP: '-n' },
  });
  if (result.status !== 0) throw new Error(`tar failed for ${sourceDir}: ${result.stderr || result.stdout}`);
}

async function writeChecksum(archivePath) {
  const digest = sha256(await readFile(archivePath));
  const checksumPath = `${archivePath}.sha256`;
  await writeFile(checksumPath, `${digest}  ${path.basename(archivePath)}\n`, { mode: 0o644 });
  return { archive: archivePath, checksum: checksumPath, sha256: digest };
}

function validateContract(contract) {
  const expected = ['status', 'discovery', 'analyze', 'plan', 'preview', 'readback'];
  if (JSON.stringify(contract.actions) !== JSON.stringify(expected)) throw new Error('canonical action contract widened');
  if (contract.authority !== 'authority-free') throw new Error('canonical authority changed');
  const forbidden = new Set(contract.forbidden);
  for (const value of ['free_sql', 'credential', 'raw_row', 'arbitrary_url', 'provider_payload', 'apply', 'write', 'delete', 'deploy']) {
    if (!forbidden.has(value)) throw new Error(`forbidden contract value missing: ${value}`);
  }
}

async function validateTree(base) {
  const files = await walkFiles(base);
  for (const file of files) {
    if (file.startsWith('../') || file.includes('/../')) throw new Error(`archive path escape: ${file}`);
    const bytes = await readFile(path.join(base, file));
    const text = bytes.toString('utf8');
    if (denySecret.test(text)) throw new Error(`secret-like value denied in generated file: ${file}`);
    if (remoteExecution.test(text)) throw new Error(`remote executable pattern denied in generated file: ${file}`);
  }
  return files;
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true, mode: 0o755 });

const skillRecords = await copySkill(path.join(outputRoot, 'clawhub', 'kaleidosphere'));
const codexSkillRecords = await copySkill(path.join(outputRoot, 'codex', 'kaleidosphere-agent-skill', 'skills', 'kaleidosphere'));
const claudeSkillRecords = await copySkill(path.join(outputRoot, 'claude', 'kaleidosphere-agent-skill', 'skills', 'kaleidosphere'));
const contract = JSON.parse((await readCanonical('references/contract.json')).bytes.toString('utf8'));
validateContract(contract);

for (const [label, records] of Object.entries({ clawhub: skillRecords, codex: codexSkillRecords, claude: claudeSkillRecords })) {
  for (const record of records) {
    const generated = label === 'clawhub'
      ? path.join(outputRoot, 'clawhub', 'kaleidosphere', record.relative)
      : path.join(outputRoot, label, 'kaleidosphere-agent-skill', 'skills', 'kaleidosphere', record.relative);
    const generatedDigest = sha256(await readFile(generated));
    if (generatedDigest !== record.digest) throw new Error(`${label} generated bytes differ for ${record.relative}`);
  }
}

const codexManifest = {
  name: 'kaleidosphere-agent-skill',
  version,
  description: 'KaleidoSphere bounded BI AgentSkill distribution',
  author: {
    name: 'JoFe2',
    url: 'https://github.com/JoFe2',
  },
  homepage: 'https://github.com/JoFe2/KaleidoSphere',
  repository: 'https://github.com/JoFe2/KaleidoSphere',
  license: 'Apache-2.0',
  keywords: ['kaleidosphere', 'agent-skill', 'business-intelligence', 'openclaw'],
  skills: './skills/',
  interface: {
    displayName: 'KaleidoSphere',
    shortDescription: 'Bounded BI skill',
    longDescription: 'Use the KaleidoSphere AgentSkill for bounded status, discovery, analyze, plan, preview and readback requests under the closed authority-free contract.',
    developerName: 'JoFe2',
    category: 'Data & Analytics',
    capabilities: ['Bounded BI workflows', 'Closed action validation', 'Readback evidence review'],
    websiteURL: 'https://github.com/JoFe2/KaleidoSphere',
    defaultPrompt: [
      'Use KaleidoSphere for BI status.',
      'Plan a bounded BI preview.',
      'Review KaleidoSphere readback evidence.'
    ],
    brandColor: '#0F766E'
  }
};

const claudeManifest = {
  name: 'kaleidosphere-agent-skill',
  description: 'KaleidoSphere bounded BI AgentSkill distribution',
  version,
  author: {
    name: 'JoFe2',
    url: 'https://github.com/JoFe2'
  },
  homepage: 'https://github.com/JoFe2/KaleidoSphere',
  repository: 'https://github.com/JoFe2/KaleidoSphere',
  license: 'Apache-2.0'
};

await writeBytes(path.join(outputRoot, 'codex', 'kaleidosphere-agent-skill'), '.codex-plugin/plugin.json', `${JSON.stringify(codexManifest, null, 2)}\n`);
await writeBytes(path.join(outputRoot, 'claude', 'kaleidosphere-agent-skill'), '.claude-plugin/plugin.json', `${JSON.stringify(claudeManifest, null, 2)}\n`);

const hostFiles = {
  clawhub: await validateTree(path.join(outputRoot, 'clawhub', 'kaleidosphere')),
  codex: await validateTree(path.join(outputRoot, 'codex', 'kaleidosphere-agent-skill')),
  claude: await validateTree(path.join(outputRoot, 'claude', 'kaleidosphere-agent-skill')),
};

const digests = Object.fromEntries(skillRecords.map((record) => [record.relative, record.digest]));
const distributionManifest = {
  schemaVersion: 'kaleidosphere/agent-skill-distribution/v1',
  packageVersion: version,
  canonicalSource: canonicalSkill,
  canonicalFiles: digests,
  generatedAt: '1970-01-01T00:00:00.000Z',
  hosts: {
    clawhubOpenClawHermes: {
      path: 'clawhub/kaleidosphere',
      licenseBoundary: 'ClawHub publishes skills under MIT-0; repository source remains Apache-2.0.',
      files: hostFiles.clawhub
    },
    codex: {
      path: 'codex/kaleidosphere-agent-skill',
      manifest: 'codex/kaleidosphere-agent-skill/.codex-plugin/plugin.json',
      licenseBoundary: 'Codex plugin package follows repository Apache-2.0 unless a catalog imposes a separate listing license.',
      files: hostFiles.codex
    },
    claudeCode: {
      path: 'claude/kaleidosphere-agent-skill',
      manifest: 'claude/kaleidosphere-agent-skill/.claude-plugin/plugin.json',
      licenseBoundary: 'Claude Code plugin package follows repository Apache-2.0 unless a catalog imposes a separate listing license.',
      files: hostFiles.claude
    }
  },
  nonClaims: [
    'Generated artifacts do not claim public marketplace listing.',
    'Generated artifacts do not claim Hermes, Codex or Claude Code runtime execution.',
    'Generated artifacts do not widen the closed KaleidoSphere action contract.'
  ]
};
await writeJson('manifest.json', distributionManifest);

const archivesDir = path.join(outputRoot, 'archives');
await mkdir(archivesDir, { recursive: true, mode: 0o755 });
const archives = [
  {
    source: path.join(outputRoot, 'clawhub', 'kaleidosphere'),
    rootName: `kaleidosphere-clawhub-skill-v${version}`,
    file: `kaleidosphere-clawhub-skill-v${version}.tar.gz`,
  },
  {
    source: path.join(outputRoot, 'codex', 'kaleidosphere-agent-skill'),
    rootName: `kaleidosphere-codex-plugin-v${version}`,
    file: `kaleidosphere-codex-plugin-v${version}.tar.gz`,
  },
  {
    source: path.join(outputRoot, 'claude', 'kaleidosphere-agent-skill'),
    rootName: `kaleidosphere-claude-plugin-v${version}`,
    file: `kaleidosphere-claude-plugin-v${version}.tar.gz`,
  },
];

const archiveRecords = [];
for (const archive of archives) {
  const archivePath = path.join(archivesDir, archive.file);
  tarGz(archive.source, archivePath, archive.rootName);
  archiveRecords.push(await writeChecksum(archivePath));
}
await writeJson('archives.json', archiveRecords.map((record) => ({
  archive: path.relative(outputRoot, record.archive).split(path.sep).join('/'),
  checksum: path.relative(outputRoot, record.checksum).split(path.sep).join('/'),
  sha256: record.sha256
})));

for (const record of archiveRecords) {
  process.stdout.write(`${record.sha256}  ${path.relative(outputRoot, record.archive).split(path.sep).join('/')}\n`);
}
