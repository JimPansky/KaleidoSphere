import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  REQUIRED_BASE_COMMIT,
  buildBiHandlers,
  buildDiscoveryReadinessGraphSpec,
  buildEvidencePack,
  compareReplay,
  createInitialGraphState,
  executeGraph,
  graphToDot,
  graphToMermaid,
  loadSchema,
  validateGraphSpec,
} from '../services/bi-control/src/graph-pilot/bi-discovery-readiness-graph.mjs';
import { validateOrThrow } from '../services/bi-control/src/graph-pilot/schema-validator.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const root = resolve(process.cwd());
const evidenceDir = resolve(root, 'docs/evidence/graph-pilot');
const checkOnly = process.argv.includes('--check');
const graphSchema = await loadSchema(resolve(root, 'contracts/bi-discovery-readiness-graph/v0/graph-spec.schema.json'));
const receiptSchema = await loadSchema(resolve(root, 'contracts/bi-discovery-readiness-graph/v0/receipt.schema.json'));
const evidencePackSchema = await loadSchema(resolve(root, 'contracts/bi-discovery-readiness-graph/v0/evidence-pack.schema.json'));

const sealedV2 = JSON.parse(await readFile(resolve(root, 'docs/evidence/m6-03-bi-specialist/sealed-blind-v2-manifest.json'), 'utf8'));
const candidateRoot = resolve(root, 'services/bi-control/fixtures/bi-specialist/candidate');
const sealedRoot = resolve(root, 'tests/evaluator-sealed/m6-03/pack-v2');

const visibleTargets = [
  ['known_schema_order_to_cash', 'fixture_visible', resolve(candidateRoot, 'training-order-to-cash.sqlite'), 'Assess known order-to-cash KPIs, quality risks and readiness'],
  ['unknown_schema_supplier', 'fixture_visible', resolve(candidateRoot, 'training-production-supplier.sqlite'), 'Discover entities, supplier performance KPIs and readiness without table hints'],
  ['ambiguous_grain_adversarial', 'fixture_visible', resolve(candidateRoot, 'holdout-underspecified-adversarial.sqlite'), 'Assess ambiguous grain and deny false readiness where semantics are underspecified'],
];
const sealedTargets = sealedV2.results.slice(0, 3).map((item) => [`sealed_${item.caseId}`, 'sealed', resolve(sealedRoot, item.databaseFilename), 'Discover unknown-domain BI readiness without feedback before scoring']);
const targets = [];
for (const [id, classification, databasePath, objective] of [...visibleTargets, ...sealedTargets]) {
  targets.push({
    id,
    classification,
    databasePath,
    objective,
    databaseSha256: sha256(await readFile(databasePath)),
  });
}

const evidenceFiles = {
  'm6-03-terminal': resolve(root, 'docs/evidence/m6-03-bi-specialist/terminal-manifest.json'),
  'm6-03-sealed-v2': resolve(root, 'docs/evidence/m6-03-bi-specialist/sealed-blind-v2-manifest.json'),
  'm6-04-terminal': resolve(root, 'docs/evidence/m6-04-trusted-workflow/terminal-manifest.json'),
  'm6-05-terminal': resolve(root, 'docs/evidence/m6-05-ambiguous-outcome-reconciliation/terminal-manifest.json'),
};

const baseline = {
  assemblyMinutes: 30,
  reviewAmbiguityPoints: targets.length * 6,
  basis: 'predeclared prose/checkpoint baseline: manual checkpoint review has objective/table scope, evidence boundary, sealed-status, mutation authority, and replay ambiguity per case',
};

const spec = buildDiscoveryReadinessGraphSpec();
validateGraphSpec(spec, graphSchema);
const initialState = createInitialGraphState({
  runId: 'graph-pilot-discovery-readiness-v0-local',
  sourceRefs: targets.map((target) => ({ id: target.id, path: target.databasePath, sha256: target.databaseSha256, classification: target.classification })),
  discoveryTargets: targets.map((target) => ({ id: target.id, classification: target.classification })),
});
const handlers = buildBiHandlers({ targets, evidenceFiles, baseline });
const state = await executeGraph({ spec, graphSchema, receiptSchema, initialState, handlers });
const replayState = await executeGraph({ spec, graphSchema, receiptSchema, initialState, handlers });
const replay = compareReplay(state, replayState);
const pack = buildEvidencePack({ runId: initialState.runId, state, replay, targets, baseline });
validateOrThrow(pack, evidencePackSchema, 'evidencePack');

if (!checkOnly) {
  await mkdir(evidenceDir, { recursive: true });
  const artifacts = {
    'discovery-readiness-v0.mmd': graphToMermaid(spec),
    'discovery-readiness-v0.dot': graphToDot(spec),
    'terminal-state.json': `${JSON.stringify(state, null, 2)}\n`,
    'terminal-manifest.json': `${JSON.stringify(pack, null, 2)}\n`,
  };
  for (const [name, body] of Object.entries(artifacts)) {
    const finalPath = resolve(evidenceDir, name);
    const tempPath = `${finalPath}.${process.pid}.tmp`;
    await writeFile(tempPath, body, { flag: 'wx' });
    await rename(tempPath, finalPath);
  }
}
process.stdout.write(`graph pilot evidence${checkOnly ? ' check' : ''}: accepted=${pack.acceptance.accepted} replay=${pack.acceptance.deterministicReplayRate} sourceRows=${pack.acceptance.sourceRowsPersisted} mutations=${pack.acceptance.mutations} base=${REQUIRED_BASE_COMMIT}\n`);
