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

const verifyOnly = process.argv[2] === '--verify';
const outputRoot = path.resolve((verifyOnly ? process.argv[3] : process.argv[2]) ?? path.join(root, 'dist', 'agent-skill-distribution'));
const canonicalSkill = 'agent-skills/kaleidosphere';
const canonicalFiles = [
  'SKILL.md',
  'references/contract.json',
  'scripts/validate-request.mjs',
];
const portableCompanionFiles = [
  'contracts/portable-companion/v1/portable-companion.schema.json',
  'contracts/portable-companion/v1/compatibility-matrix.json',
  'contracts/portable-companion/v1/profile-template.schema.json',
  'contracts/portable-companion/v1/receipt-envelope.schema.json',
];
const externalApiV2SchemaFile = 'contracts/external-api/v2/external-bi-api.schema.json';
const hostContractsFile = 'agent-skills/host-contracts.json';
const portableReference = 'references/portable-companion-v1.json';
const expectedRuntimeIntents = ['status', 'discovery', 'analyze', 'plan', 'preview', 'readback'];
const denySecret = /(?:sk-[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9_]{20,}|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|password\s*=|token\s*=|secret\s*=)/i;
const remoteExecution = /(?:curl|wget)\s+[^|;&\n]+[|]\s*(?:sh|bash)|npx\s+-?y\s+[^@\s]+@latest/i;
const activeHostPath = /(?:^|\/)(?:hooks?(?:\.json)?|mcp(?:-?servers?)?(?:\.json)?)(?:\/|$)/i;
const executableArtifact = /\.(?:sh|bash|zsh|fish|exe|dll|so|dylib|wasm|node)$/i;

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

async function readRepoSource(file) {
  const relative = relSafe(file);
  const absolute = path.join(root, relative);
  if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error(`source path escaped repository: ${file}`);
  const stat = await lstat(absolute);
  if (!stat.isFile()) throw new Error(`canonical source is not a regular file: ${file}`);
  const bytes = await readFile(absolute);
  const text = bytes.toString('utf8');
  if (denySecret.test(text)) throw new Error(`secret-like value denied in canonical source: ${file}`);
  if (remoteExecution.test(text)) throw new Error(`remote executable pattern denied in canonical source: ${file}`);
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

async function copySkill(destination, portableBindingBytes) {
  const records = [];
  for (const file of canonicalFiles) {
    const record = await readCanonical(file);
    await writeBytes(destination, record.relative, record.bytes, 0o644);
    records.push(record);
  }
  await writeBytes(destination, portableReference, portableBindingBytes, 0o644);
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
  if (JSON.stringify(contract.actions) !== JSON.stringify(expectedRuntimeIntents)) throw new Error('canonical action contract widened');
  if (contract.authority !== 'authority-free') throw new Error('canonical authority changed');
  const forbidden = new Set(contract.forbidden);
  for (const value of ['free_sql', 'credential', 'raw_row', 'arbitrary_url', 'provider_payload', 'apply', 'write', 'delete', 'deploy']) {
    if (!forbidden.has(value)) throw new Error(`forbidden contract value missing: ${value}`);
  }
}

function exactArray(actual, expected, reason) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(reason);
}

function exactObject(actual, expected, reason) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(reason);
}

async function loadExpectedDistribution() {
  const skillRecords = await Promise.all(canonicalFiles.map((file) => readCanonical(file)));
  const portableRecords = await Promise.all(portableCompanionFiles.map((file) => readRepoSource(file)));
  const externalSchemaRecord = await readRepoSource(externalApiV2SchemaFile);
  const hostContractsRecord = await readRepoSource(hostContractsFile);
  const skillContract = JSON.parse(skillRecords.find((record) => record.relative === 'references/contract.json').bytes.toString('utf8'));
  const matrix = JSON.parse(portableRecords.find((record) => record.relative.endsWith('/compatibility-matrix.json')).bytes.toString('utf8'));
  const portableSchema = JSON.parse(portableRecords.find((record) => record.relative.endsWith('/portable-companion.schema.json')).bytes.toString('utf8'));
  const externalSchema = JSON.parse(externalSchemaRecord.bytes.toString('utf8'));
  const hostContracts = JSON.parse(hostContractsRecord.bytes.toString('utf8'));

  validateContract(skillContract);
  exactArray(matrix.externalApiV2?.runtimeIntents, expectedRuntimeIntents, 'External API v2 intent change denied in Portable Companion matrix');
  if (matrix.externalApiV2?.runtimeIntentCount !== 6 || matrix.externalApiV2?.wideningAllowed !== false) {
    throw new Error('External API v2 intent count or widening policy changed');
  }
  exactArray(externalSchema.properties?.action?.enum, expectedRuntimeIntents, 'External API v2 intent change denied in canonical schema');
  exactArray(portableSchema.properties?.externalApiV2?.properties?.runtimeIntents?.prefixItems?.map((item) => item.const), expectedRuntimeIntents, 'External API v2 intent change denied in Portable Companion schema');

  if (hostContracts.schemaVersion !== 'kaleidosphere/agent-skill-host-contracts/v2') throw new Error('host contract v2 required');
  const crossHarness = hostContracts.crossHarness;
  if (crossHarness?.schemaVersion !== 'kaleidosphere/cross-harness-portable/v1') throw new Error('cross-harness contract missing');
  exactArray(crossHarness.canonicalSources?.skill, canonicalFiles.map((file) => `${canonicalSkill}/${file}`), 'host contract canonical skill sources drifted');
  exactArray(crossHarness.canonicalSources?.portableCompanion, portableCompanionFiles, 'host contract Portable Companion sources drifted');
  if (crossHarness.canonicalSources?.externalApiV2 !== externalApiV2SchemaFile) throw new Error('host contract External API v2 source drifted');
  if (crossHarness.generatedReference !== portableReference) throw new Error('host contract generated reference drifted');
  exactArray(crossHarness.externalApiV2Intents, expectedRuntimeIntents, 'host contract External API v2 intent change denied');

  const portableUtilityActions = matrix.portableUtilityActions.map((item) => item.id);
  exactArray(crossHarness.portableUtilityActions, portableUtilityActions, 'undeclared portable action denied');
  if (matrix.portableUtilityActions.some((item) => item.authority !== 'offline-utility-only' || item.dispatch !== false)) {
    throw new Error('Portable Companion authority or dispatch boundary changed');
  }
  exactObject(crossHarness.security, {
    skillsOnly: true,
    hooksAllowed: false,
    mcpServersAllowed: false,
    executableModeFilesAllowed: false,
    externalCallsAllowed: false,
    secretsAllowed: false,
    archiveTraversalAllowed: false,
  }, 'cross-harness security policy drifted');
  if (crossHarness.authority !== 'offline-utility-only' || crossHarness.runtimeDispatch !== false || crossHarness.marketplaceApprovalClaim !== false || crossHarness.productionClaim !== false) {
    throw new Error('cross-harness authority boundary changed');
  }

  const skillDigests = Object.fromEntries(skillRecords.map((record) => [record.relative, record.digest]));
  const portableDigests = Object.fromEntries(portableRecords.map((record) => [record.relative, record.digest]));
  const binding = {
    schemaVersion: 'kaleidosphere/cross-harness-portable-reference/v1',
    packageVersion: version,
    generatedFrom: {
      canonicalSkill: { path: canonicalSkill, files: skillDigests },
      portableCompanion: { contractVersion: matrix.contract.version, files: portableDigests },
      externalApiV2: { schema: externalApiV2SchemaFile, sha256: externalSchemaRecord.digest },
      hostContract: { path: hostContractsFile, sha256: hostContractsRecord.digest },
    },
    externalApiV2: {
      contractId: matrix.externalApiV2.contractId,
      contractVersion: matrix.externalApiV2.contractVersion,
      runtimeIntents: expectedRuntimeIntents,
      wideningAllowed: false,
    },
    portableCompanion: {
      contractId: matrix.contract.id,
      contractVersion: matrix.contract.version,
      authority: crossHarness.authority,
      utilityActions: matrix.portableUtilityActions,
      boundaries: matrix.boundaries,
    },
    security: crossHarness.security,
    nonClaims: [
      'No runtime dispatch, activation or external call.',
      'No credentials, raw/customer data or provider payloads.',
      'No hooks, MCP server, executable-mode file, hosted service or remote connector.',
      'No public marketplace approval, host runtime compatibility or production claim.',
    ],
  };
  const bindingBytes = Buffer.from(`${JSON.stringify(binding, null, 2)}\n`);
  return {
    skillRecords,
    portableRecords,
    externalSchemaRecord,
    hostContractsRecord,
    skillContract,
    matrix,
    hostContracts,
    binding,
    bindingBytes,
    bindingDigest: sha256(bindingBytes),
  };
}

async function validateTree(base) {
  const files = await walkFiles(base);
  for (const file of files) {
    if (file.startsWith('../') || file.includes('/../')) throw new Error(`archive path escape: ${file}`);
    if (activeHostPath.test(file)) throw new Error(`hook or MCP path denied in generated file: ${file}`);
    if (executableArtifact.test(file)) throw new Error(`executable artifact denied in generated file: ${file}`);
    const absolute = path.join(base, file);
    const stat = await lstat(absolute);
    if ((stat.mode & 0o111) !== 0) throw new Error(`executable mode denied in generated file: ${file}`);
    const bytes = await readFile(absolute);
    const text = bytes.toString('utf8');
    if (denySecret.test(text)) throw new Error(`secret-like value denied in generated file: ${file}`);
    if (remoteExecution.test(text)) throw new Error(`remote executable pattern denied in generated file: ${file}`);
    if (file.endsWith('/plugin.json')) {
      const plugin = JSON.parse(text);
      for (const key of ['hooks', 'mcpServers', 'apps', 'commands', 'agents']) {
        if (key in plugin) throw new Error(`active plugin surface denied: ${key}`);
      }
    }
  }
  return files;
}

function validateArchiveEntry(entry, expectedRoot) {
  const normalized = entry.replace(/\/$/, '');
  const segments = normalized.split('/');
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.includes('\\') || segments.includes('..') || segments.includes('')) {
    throw new Error(`archive path traversal denied: ${entry}`);
  }
  if (segments[0] !== expectedRoot) throw new Error(`archive root drift denied: ${entry}`);
  if (activeHostPath.test(normalized)) throw new Error(`hook or MCP path denied in archive: ${entry}`);
  if (executableArtifact.test(normalized)) throw new Error(`executable artifact denied in archive: ${entry}`);
}

async function validateArchive(archivePath, expectedRoot) {
  const listing = spawnSync('tar', ['-tzf', archivePath], { encoding: 'utf8' });
  if (listing.status !== 0) throw new Error(`archive listing failed: ${path.basename(archivePath)}: ${listing.stderr || listing.stdout}`);
  const entries = listing.stdout.split('\n').filter(Boolean);
  if (entries.length === 0) throw new Error(`empty archive denied: ${path.basename(archivePath)}`);
  for (const entry of entries) validateArchiveEntry(entry, expectedRoot);

  const verbose = spawnSync('tar', ['--numeric-owner', '-tvzf', archivePath], { encoding: 'utf8' });
  if (verbose.status !== 0) throw new Error(`archive mode listing failed: ${path.basename(archivePath)}: ${verbose.stderr || verbose.stdout}`);
  for (const line of verbose.stdout.split('\n').filter(Boolean)) {
    const mode = line.trim().split(/\s+/)[0];
    if (!/^[d-][rwx-]{9}$/.test(mode)) throw new Error(`non-regular archive entry denied: ${line}`);
    if (mode.startsWith('-') && mode.includes('x')) throw new Error(`executable mode denied in archive: ${line}`);
  }
}

async function verifyDistribution(base, expected) {
  const manifest = JSON.parse(await readFile(path.join(base, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 'kaleidosphere/agent-skill-distribution/v2') throw new Error('distribution manifest v2 required');
  if (manifest.packageVersion !== version) throw new Error('distribution package version drift denied');
  if (manifest.canonicalSource !== canonicalSkill) throw new Error('distribution canonical source drift denied');
  if (manifest.portableReference?.path !== portableReference || manifest.portableReference?.sha256 !== expected.bindingDigest) {
    throw new Error('portable reference digest drift denied');
  }
  exactObject(manifest.canonicalFiles, Object.fromEntries(expected.skillRecords.map((record) => [record.relative, record.digest])), 'canonical skill digest manifest drift denied');
  exactObject(manifest.portableCompanionFiles, Object.fromEntries(expected.portableRecords.map((record) => [record.relative, record.digest])), 'Portable Companion source digest manifest drift denied');
  exactArray(manifest.externalApiV2Intents, expectedRuntimeIntents, 'External API v2 intent change denied in distribution manifest');
  exactArray(manifest.portableUtilityActions, expected.matrix.portableUtilityActions.map((item) => item.id), 'undeclared portable action denied in distribution manifest');

  const views = [
    ['clawhub', path.join(base, 'clawhub', 'kaleidosphere'), manifest.hosts.clawhubOpenClawHermes],
    ['codex', path.join(base, 'codex', 'kaleidosphere-agent-skill'), manifest.hosts.codex],
    ['claude', path.join(base, 'claude', 'kaleidosphere-agent-skill'), manifest.hosts.claudeCode],
  ];
  for (const [label, hostRoot, hostManifest] of views) {
    const skillRoot = label === 'clawhub' ? hostRoot : path.join(hostRoot, 'skills', 'kaleidosphere');
    for (const record of expected.skillRecords) {
      if (sha256(await readFile(path.join(skillRoot, record.relative))) !== record.digest) throw new Error(`manual host-view drift denied: ${label}/${record.relative}`);
    }
    const bindingBytes = await readFile(path.join(skillRoot, portableReference));
    let binding;
    try {
      binding = JSON.parse(bindingBytes.toString('utf8'));
    } catch {
      throw new Error(`manual host-view drift denied: ${label}/${portableReference}`);
    }
    exactArray(binding.externalApiV2?.runtimeIntents, expectedRuntimeIntents, 'External API v2 intent change denied in generated host view');
    exactArray(binding.portableCompanion?.utilityActions?.map((item) => item.id), expected.matrix.portableUtilityActions.map((item) => item.id), 'undeclared portable action denied in generated host view');
    if (sha256(bindingBytes) !== expected.bindingDigest) throw new Error(`manual host-view drift denied: ${label}/${portableReference}`);
    const files = await validateTree(hostRoot);
    exactArray(files, hostManifest.files, `manual host-view file drift denied: ${label}`);
  }

  const codexPlugin = JSON.parse(await readFile(path.join(base, manifest.hosts.codex.manifest), 'utf8'));
  const claudePlugin = JSON.parse(await readFile(path.join(base, manifest.hosts.claudeCode.manifest), 'utf8'));
  for (const [label, plugin] of [['codex', codexPlugin], ['claude', claudePlugin]]) {
    for (const key of ['hooks', 'mcpServers', 'apps', 'commands', 'agents']) {
      if (key in plugin) throw new Error(`${label} active plugin surface denied: ${key}`);
    }
  }

  const archives = JSON.parse(await readFile(path.join(base, 'archives.json'), 'utf8'));
  if (!Array.isArray(archives) || archives.length !== 3) throw new Error('exactly three host archives required');
  for (const record of archives) {
    const archiveRelative = relSafe(record.archive);
    const checksumRelative = relSafe(record.checksum);
    if (!archiveRelative.startsWith('archives/') || checksumRelative !== `${archiveRelative}.sha256`) throw new Error('archive path contract denied');
    const archivePath = path.join(base, archiveRelative);
    const digest = sha256(await readFile(archivePath));
    if (record.sha256 !== digest) throw new Error(`archive digest drift denied: ${archiveRelative}`);
    const checksum = await readFile(path.join(base, checksumRelative), 'utf8');
    if (checksum !== `${digest}  ${path.basename(archiveRelative)}\n`) throw new Error(`archive sidecar drift denied: ${checksumRelative}`);
    const expectedRoot = path.basename(archiveRelative, '.tar.gz');
    await validateArchive(archivePath, expectedRoot);
  }
  return manifest;
}

const expected = await loadExpectedDistribution();

if (verifyOnly) {
  await verifyDistribution(outputRoot, expected);
  process.stdout.write(`verified ${outputRoot}\n`);
} else {
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true, mode: 0o755 });

const skillRecords = await copySkill(path.join(outputRoot, 'clawhub', 'kaleidosphere'), expected.bindingBytes);
const codexSkillRecords = await copySkill(path.join(outputRoot, 'codex', 'kaleidosphere-agent-skill', 'skills', 'kaleidosphere'), expected.bindingBytes);
const claudeSkillRecords = await copySkill(path.join(outputRoot, 'claude', 'kaleidosphere-agent-skill', 'skills', 'kaleidosphere'), expected.bindingBytes);
const contract = expected.skillContract;
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
  schemaVersion: 'kaleidosphere/agent-skill-distribution/v2',
  packageVersion: version,
  canonicalSource: canonicalSkill,
  canonicalFiles: digests,
  portableCompanionFiles: Object.fromEntries(expected.portableRecords.map((record) => [record.relative, record.digest])),
  portableReference: { path: portableReference, sha256: expected.bindingDigest },
  externalApiV2Intents: expectedRuntimeIntents,
  portableUtilityActions: expected.matrix.portableUtilityActions.map((item) => item.id),
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

await verifyDistribution(outputRoot, expected);

for (const record of archiveRecords) {
  process.stdout.write(`${record.sha256}  ${path.relative(outputRoot, record.archive).split(path.sep).join('/')}\n`);
}
}
