import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  ADAPTIVE_REQUIRED_BASE_COMMIT,
  buildAdaptiveEvidencePack,
  buildAdaptiveHandlers,
  buildAdaptiveInvestigationGraphSpec,
  compareAdaptiveReplay,
  createAdaptiveInitialState,
  digest,
  executeAdaptiveGraph,
  graphToDot,
  graphToMermaid,
  loadJson,
  validateAdaptiveGraphSpec,
} from '../services/bi-control/src/graph-pilot/bi-adaptive-investigation-graph.mjs';
import { validateOrThrow } from '../services/bi-control/src/graph-pilot/schema-validator.mjs';

const graphSchema = await loadJson(resolve('contracts/bi-adaptive-investigation-graph/v1/graph-spec.schema.json'));
const stateSchema = await loadJson(resolve('contracts/bi-adaptive-investigation-graph/v1/state.schema.json'));
const receiptSchema = await loadJson(resolve('contracts/bi-adaptive-investigation-graph/v1/receipt.schema.json'));
const evidencePackSchema = await loadJson(resolve('contracts/bi-adaptive-investigation-graph/v1/evidence-pack.schema.json'));
const sealedDoc = await loadJson(resolve('services/bi-control/fixtures/graph-adaptive-v1/sealed-neutral-packs.json'));
const packs = sealedDoc.packs;

function candidateFreeze(spec = buildAdaptiveInvestigationGraphSpec()) {
  const freeze = {
    schemaVersion: 'chimpmaera.bi/adaptive-investigation-candidate-freeze/v1',
    frozenBeforeSealedRun: true,
    baseCommit: ADAPTIVE_REQUIRED_BASE_COMMIT,
    modelRoute: 'offline-deterministic-fixtures',
    liveModelUsed: false,
    implementationDigest: digest({ graphSpec: spec, sealedInputDigests: packs.map((pack) => digest(pack.input)) }),
  };
  freeze.sha256 = digest(freeze);
  return freeze;
}

test('adaptive v1 graph contract validates and fails closed for branch/probe/schema drift', () => {
  const spec = buildAdaptiveInvestigationGraphSpec();
  assert.equal(validateAdaptiveGraphSpec(spec, graphSchema), true);
  assert.throws(() => validateAdaptiveGraphSpec({ ...spec, owners: { ...spec.owners, mutationAuthority: true } }, graphSchema), /SCHEMA_VALIDATION_FAILED/);
  assert.throws(() => validateAdaptiveGraphSpec({ ...spec, adaptivePolicy: { ...spec.adaptivePolicy, pHackingDenied: false } }, graphSchema), /SCHEMA_VALIDATION_FAILED/);
  const cyclic = { ...spec, edges: [...spec.edges, { from: 'BI-G7_terminal_manifest', to: 'BI-G2_adaptive_contracts', guard: 'bad', onFailure: 'fail_closed' }] };
  assert.throws(() => validateAdaptiveGraphSpec(cyclic, graphSchema), /ADAPTIVE_GRAPH_CYCLE_DENIED/);
});

test('adaptive schemas version typed uncertainty, budgets, pause replay, privacy and fail-closed fields', () => {
  assert.match(JSON.stringify(graphSchema), /allowedProbeKinds/);
  assert.match(JSON.stringify(graphSchema), /maxBranchesPerCase/);
  assert.match(JSON.stringify(graphSchema), /maxProbesPerCase/);
  assert.match(JSON.stringify(graphSchema), /pauseResume/);
  assert.match(JSON.stringify(stateSchema), /sampleValuesPersisted/);
  assert.match(JSON.stringify(receiptSchema), /receiptHash/);
  assert.match(JSON.stringify(evidencePackSchema), /candidateFreeze/);
});

test('sealed neutral packs are new profile summaries with hidden oracle separated from candidate input', () => {
  assert.equal(sealedDoc.privacy.profileSummariesOnly, true);
  assert.equal(sealedDoc.privacy.sourceRowsIncluded, false);
  assert.equal(packs.length, 6);
  assert.equal(packs.filter((pack) => pack.tier === 'hard').length, 2);
  for (const pack of packs) {
    assert(!JSON.stringify(pack.input).includes('hiddenOracle'));
    assert(pack.hiddenOracle.domain);
    assert.equal(typeof pack.input.profile.rowCountBucket, 'string');
  }
});

test('runner supports pause/replay and emits no source rows, samples, mutations or model tokens', async () => {
  const spec = buildAdaptiveInvestigationGraphSpec();
  const freeze = candidateFreeze(spec);
  const initialState = createAdaptiveInitialState({ runId: 'adaptive-unit', sealedInputs: packs.map((pack) => ({ id: pack.id, tier: pack.tier, inputDigest: digest(pack.input) })) });
  validateOrThrow(initialState, stateSchema, 'adaptiveInitialState');
  const handlers = buildAdaptiveHandlers({ packs, candidateFreeze: freeze });
  const paused = await executeAdaptiveGraph({ spec, graphSchema, receiptSchema, initialState, handlers, pauseBefore: new Set(['BI-G4_hypothesis_graph']) });
  assert.equal(paused.status, 'paused');
  const state = await executeAdaptiveGraph({ spec, graphSchema, receiptSchema, initialState, handlers });
  const replayState = await executeAdaptiveGraph({ spec, graphSchema, receiptSchema, initialState, handlers });
  const replay = compareAdaptiveReplay(state, replayState);
  assert.equal(replay.deterministic, true);
  assert.equal(state.budgetUsage.modelTokens, 0);
  assert.equal(state.budgetUsage.toolCalls, 0);
  assert.equal(state.budgetUsage.mutations, 0);
  assert.equal(state.privacy.sourceRowsPersisted, false);
  assert.equal(state.privacy.sampleValuesPersisted, false);
  assert.match(graphToMermaid(spec), /flowchart TD/);
  assert.match(graphToDot(spec), /digraph/);
});

test('BI-G3 through BI-G5 classify anomalies, unknown-domain hypotheses and budgeted allowlist probes', async () => {
  const spec = buildAdaptiveInvestigationGraphSpec();
  const state = await executeAdaptiveGraph({
    spec,
    graphSchema,
    receiptSchema,
    initialState: createAdaptiveInitialState({ runId: 'adaptive-g3-g5', sealedInputs: packs.map((pack) => ({ id: pack.id, tier: pack.tier, inputDigest: digest(pack.input) })) }),
    handlers: buildAdaptiveHandlers({ packs, candidateFreeze: candidateFreeze(spec) }),
  });
  const profile = state.nodeOutputs['BI-G3_profile_ledger'];
  assert(profile.cases.some((item) => item.anomalyLabels.includes('material_missingness')));
  assert(profile.cases.some((item) => item.anomalyLabels.includes('corruption_signal')));
  assert(profile.cases.every((item) => item.nonclaims.includes('aggregate profile summary, not raw-row completeness')));
  const hypotheses = state.nodeOutputs['BI-G4_hypothesis_graph'];
  assert(hypotheses.cases.every((item) => item.alternatives.length >= 3));
  assert(hypotheses.cases.some((item) => item.grainGate === 'blocked_until_probe'));
  const probes = state.nodeOutputs['BI-G5_targeted_probe_policy'];
  assert.equal(probes.allowlistOnly, true);
  assert.equal(probes.cases.every((item) => item.probes.length <= spec.budgets.maxProbesPerCase), true);
  assert(probes.cases.flatMap((item) => item.probes).every((probe) => spec.adaptivePolicy.allowedProbeKinds.includes(probe.kind)));
});

test('G6 application-first sealed comparison accepts only candidate gap <= incumbent gap with no easy regression', async () => {
  const spec = buildAdaptiveInvestigationGraphSpec();
  const state = await executeAdaptiveGraph({
    spec,
    graphSchema,
    receiptSchema,
    initialState: createAdaptiveInitialState({ runId: 'adaptive-g6', sealedInputs: packs.map((pack) => ({ id: pack.id, tier: pack.tier, inputDigest: digest(pack.input) })) }),
    handlers: buildAdaptiveHandlers({ packs, candidateFreeze: candidateFreeze(spec) }),
  });
  const comparison = state.nodeOutputs['BI-G6_static_vs_adaptive_compare'].comparison;
  assert.equal(comparison.safety.candidateGapLeqIncumbent, true);
  assert.equal(comparison.safety.easyRegression, false);
  assert(comparison.hardTierGain >= 0.2 || comparison.reviewAmbiguityReduction >= 0.3);
  assert(comparison.additionalProbeRate <= 0.2);
  assert.equal(comparison.acceptance.accepted, true);
});

test('negative probes fail closed for profile leakage, probe budget, tamper and missed acceptance', async () => {
  const spec = buildAdaptiveInvestigationGraphSpec();
  const freeze = candidateFreeze(spec);
  const initialState = createAdaptiveInitialState({ runId: 'adaptive-negative', sealedInputs: packs.map((pack) => ({ id: pack.id, tier: pack.tier, inputDigest: digest(pack.input) })) });
  await assert.rejects(executeAdaptiveGraph({
    spec,
    graphSchema,
    receiptSchema,
    initialState,
    handlers: buildAdaptiveHandlers({ packs: [{ ...packs[0], input: { ...packs[0].input, source_rows: [] } }], candidateFreeze: freeze }),
  }), /ADAPTIVE_PROFILE_PRIVACY_FILTER_DENIED|FORBIDDEN_PERSISTED_FIELD/);
  await assert.rejects(executeAdaptiveGraph({
    spec: { ...spec, budgets: { ...spec.budgets, maxProbesPerCase: 0 } },
    graphSchema,
    receiptSchema,
    initialState,
    handlers: buildAdaptiveHandlers({ packs, candidateFreeze: freeze }),
  }), /ADAPTIVE_CASE_PROBE_BUDGET_EXCEEDED|SCHEMA_VALIDATION_FAILED/);
  const state = await executeAdaptiveGraph({ spec, graphSchema, receiptSchema, initialState, handlers: buildAdaptiveHandlers({ packs, candidateFreeze: freeze }) });
  const tampered = structuredClone(state);
  tampered.receipts[2].receiptHash = '0'.repeat(64);
  assert.equal(compareAdaptiveReplay(state, tampered).deterministic, false);
  const pack = buildAdaptiveEvidencePack({
    runId: 'missed',
    state,
    replay: { rate: 0.5, first: [], second: [] },
    packs,
    candidateFreeze: freeze,
    hashes: {},
  });
  assert.equal(pack.verdict, 'PARTIAL');
  assert.equal(pack.acceptance.accepted, false);
});

test('terminal adaptive v1 evidence is accepted, replayable, sealed, local-only and privacy-clean', async () => {
  const manifest = JSON.parse(await readFile('docs/evidence/graph-adaptive-v1/terminal-manifest.json', 'utf8'));
  validateOrThrow(manifest, evidencePackSchema, 'adaptiveTerminalManifest');
  assert.equal(manifest.baseCommit, ADAPTIVE_REQUIRED_BASE_COMMIT);
  assert.equal(manifest.verdict, 'ACCEPTED');
  assert.equal(manifest.acceptance.accepted, true);
  assert.equal(manifest.acceptance.deterministicReplayRate, 1);
  assert.equal(manifest.acceptance.sourceRowsPersisted, 0);
  assert.equal(manifest.acceptance.sampleValuesPersisted, 0);
  assert.equal(manifest.acceptance.mutations, 0);
  assert.equal(manifest.cases.length, 6);
  assert(manifest.cases.every((item) => item.sealed === true));
  assert.equal(manifest.candidateFreeze.frozenBeforeSealedRun, true);
  assert.equal(manifest.candidateFreeze.liveModelUsed, false);
  assert.equal(manifest.hashes.candidateFreezeCanonical, manifest.candidateFreeze.sha256);
  assert.match(manifest.hashes.candidateFreezeFile, /^[a-f0-9]{64}$/);
  assert.equal(manifest.negativeEvidence.length, 3);
  assert(manifest.negativeEvidence.every((item) => item.includes(':PASS:')));
  assert(manifest.nonclaims.includes('no live model quality claim'));
});
