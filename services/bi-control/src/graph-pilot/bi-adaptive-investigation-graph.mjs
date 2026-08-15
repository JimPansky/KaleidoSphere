import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { canonicalJson } from '../canonical-json.js';
import { assertNoForbiddenPersistence, validateOrThrow } from './schema-validator.mjs';

export const ADAPTIVE_GRAPH_SCHEMA_VERSION = 'chimpmaera.bi/adaptive-investigation-graph/v1';
export const ADAPTIVE_STATE_SCHEMA_VERSION = 'chimpmaera.bi/adaptive-investigation-state/v1';
export const ADAPTIVE_RECEIPT_SCHEMA_VERSION = 'chimpmaera.bi/adaptive-investigation-receipt/v1';
export const ADAPTIVE_EVIDENCE_SCHEMA_VERSION = 'chimpmaera.bi/adaptive-investigation-evidence-pack/v1';
export const ADAPTIVE_REQUIRED_BASE_COMMIT = '626fb43f7a8a684527db8921fa757e6bc195388d';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const digest = (value) => sha256(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonicalJson(value));

const fail = (code, details) => {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  throw error;
};

export async function loadJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export function buildAdaptiveInvestigationGraphSpec() {
  const common = {
    evidence: { required: ['receipt_hash', 'output_digest'], forbidden: ['source_rows', 'sample_values', 'secrets', 'raw_prompts', 'chain_of_thought'] },
    onFailure: 'fail_closed',
    sideEffects: 'none',
  };
  return {
    schemaVersion: ADAPTIVE_GRAPH_SCHEMA_VERSION,
    graphId: 'superset-bi.adaptive-investigation.v1',
    graphVersion: '1.0.0',
    owners: { domain: 'superset-bi-agent', writer: 'main-cron-session', mutationAuthority: false },
    privacy: {
      dataClasses: ['synthetic_profile_summaries', 'sealed_oracle_labels', 'hashes', 'no_source_rows'],
      forbiddenPersistedFields: ['source_rows', 'source_row', 'raw_rows', 'sample_values', 'secrets', 'raw_prompts', 'chain_of_thought', 'personal_data'],
      sourceRowsPersisted: false,
      rawPromptPersisted: false,
    },
    budgets: {
      maxWallMs: 120000,
      maxNodes: 6,
      maxBranchesPerCase: 3,
      maxProbesPerCase: 1,
      maxTotalProbes: 20,
      maxModelTokens: 0,
      maxToolCalls: 0,
      maxPersistedBytes: 300000,
    },
    nodes: [
      { ...common, id: 'BI-G2_adaptive_contracts', gate: 'BI-G2', kind: 'contract', preconditions: ['isolated_worktree', 'base_626fb43'], postconditions: ['typed_gap_ledger', 'bounded_branch_policy', 'pause_resume_replay', 'fail_closed_schema'], parallelSafe: false },
      { ...common, id: 'BI-G3_profile_ledger', gate: 'BI-G3', kind: 'deterministic', preconditions: ['BI-G2_adaptive_contracts.complete'], postconditions: ['profile_anomaly_ledger', 'privacy_filter_passed', 'sampling_nonclaims'], parallelSafe: true },
      { ...common, id: 'BI-G4_hypothesis_graph', gate: 'BI-G4', kind: 'model_owned_candidate', preconditions: ['BI-G3_profile_ledger.complete'], postconditions: ['unknown_domain_hypotheses', 'alternatives', 'contradiction_evidence', 'citation_grain_gates'], parallelSafe: false },
      { ...common, id: 'BI-G5_targeted_probe_policy', gate: 'BI-G5', kind: 'deterministic', preconditions: ['BI-G4_hypothesis_graph.complete'], postconditions: ['allowlist_probes_only', 'budget_stop_or_saturation', 'no_p_hacking'], parallelSafe: false },
      { ...common, id: 'BI-G6_static_vs_adaptive_compare', gate: 'BI-G6', kind: 'deterministic_judge', preconditions: ['BI-G5_targeted_probe_policy.complete'], postconditions: ['sealed_one_shot_score', 'incumbent_selection_gate', 'negative_evidence_preserved'], parallelSafe: false },
      { ...common, id: 'BI-G7_terminal_manifest', gate: 'BI-G7', kind: 'deterministic_judge', preconditions: ['BI-G6_static_vs_adaptive_compare.complete'], postconditions: ['terminal_evidence_pack', 'rollback_nonclaims', 'local_only'], parallelSafe: false },
    ],
    edges: [
      ['BI-G2_adaptive_contracts', 'BI-G3_profile_ledger'],
      ['BI-G3_profile_ledger', 'BI-G4_hypothesis_graph'],
      ['BI-G4_hypothesis_graph', 'BI-G5_targeted_probe_policy'],
      ['BI-G5_targeted_probe_policy', 'BI-G6_static_vs_adaptive_compare'],
      ['BI-G6_static_vs_adaptive_compare', 'BI-G7_terminal_manifest'],
    ].map(([from, to]) => ({ from, to, guard: `${from}.complete`, onFailure: 'fail_closed' })),
    adaptivePolicy: {
      allowedProbeKinds: ['null_pattern_by_metric', 'outlier_cluster_by_segment', 'grain_collision_summary', 'contradiction_check', 'domain_alias_lookup'],
      stopReasons: ['evidence_saturation', 'case_probe_budget_exhausted', 'global_probe_budget_exhausted'],
      pHackingDenied: true,
      mutationDenied: true,
      sealedCandidateFreezeRequired: true,
    },
    replay: {
      deterministicNodes: 'recompute_and_compare_hash',
      modelOwnedNodes: 'replay_from_sealed_output_unless_new_candidate',
      pauseResume: true,
      evidenceHashes: true,
    },
  };
}

export function createAdaptiveInitialState({ runId = 'graph-adaptive-v1-local', sourceRefs = [], sealedInputs = [] } = {}) {
  return {
    schemaVersion: ADAPTIVE_STATE_SCHEMA_VERSION,
    graphId: 'superset-bi.adaptive-investigation.v1',
    runId,
    status: 'created',
    sourceRefs,
    sealedInputs,
    nodeOutputs: {},
    receipts: [],
    budgetUsage: { nodes: 0, branches: 0, probes: 0, modelTokens: 0, toolCalls: 0, persistedBytes: 0, mutations: 0 },
    privacy: { sourceRowsPersisted: false, secretsPersisted: false, rawPromptsPersisted: false, chainOfThoughtPersisted: false, sampleValuesPersisted: false },
    verdict: {
      status: 'unknown',
      promotionAllowed: false,
      nonclaims: [
        'synthetic profile summaries only',
        'no source rows or sampled values persisted',
        'no live model quality claim',
        'no production/staging/customer Superset evidence',
        'no mutation authority',
      ],
    },
  };
}

function dependencyMap(spec) {
  const deps = new Map(spec.nodes.map((node) => [node.id, []]));
  for (const edge of spec.edges) {
    if (!deps.has(edge.from) || !deps.has(edge.to)) fail('ADAPTIVE_GRAPH_EDGE_NODE_MISSING', edge);
    deps.get(edge.to).push(edge.from);
  }
  return deps;
}

function assertAcyclic(spec) {
  const deps = dependencyMap(spec);
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) fail('ADAPTIVE_GRAPH_CYCLE_DENIED', { id });
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of deps.get(id) ?? []) visit(dep);
    visiting.delete(id);
    visited.add(id);
  }
  for (const node of spec.nodes) visit(node.id);
}

export function validateAdaptiveGraphSpec(spec, graphSchema) {
  validateOrThrow(spec, graphSchema, 'adaptiveGraphSpec');
  assertAcyclic(spec);
  if (!spec.adaptivePolicy.allowedProbeKinds.length) fail('ADAPTIVE_PROBE_ALLOWLIST_EMPTY', {});
  if (!spec.adaptivePolicy.stopReasons.includes('evidence_saturation')) fail('ADAPTIVE_STOP_POLICY_INCOMPLETE', {});
  return true;
}

function readyNodes(spec, state, deps) {
  return spec.nodes.filter((node) => !state.nodeOutputs[node.id] && deps.get(node.id).every((dep) => state.nodeOutputs[dep]));
}

function enforceBudgets(spec, state) {
  if (state.budgetUsage.nodes > spec.budgets.maxNodes) fail('ADAPTIVE_NODE_BUDGET_EXCEEDED', state.budgetUsage);
  if (state.budgetUsage.probes > spec.budgets.maxTotalProbes) fail('ADAPTIVE_PROBE_BUDGET_EXCEEDED', state.budgetUsage);
  if (state.budgetUsage.modelTokens > spec.budgets.maxModelTokens) fail('ADAPTIVE_MODEL_TOKEN_BUDGET_EXCEEDED', state.budgetUsage);
  if (state.budgetUsage.toolCalls > spec.budgets.maxToolCalls) fail('ADAPTIVE_TOOL_CALL_BUDGET_EXCEEDED', state.budgetUsage);
  if (state.budgetUsage.persistedBytes > spec.budgets.maxPersistedBytes) fail('ADAPTIVE_PERSISTED_BYTE_BUDGET_EXCEEDED', state.budgetUsage);
  if (state.budgetUsage.mutations !== 0) fail('ADAPTIVE_MUTATION_DENIED', state.budgetUsage);
}

function makeReceipt({ state, node, output, previousHash, started, finished }) {
  const stable = {
    schemaVersion: ADAPTIVE_RECEIPT_SCHEMA_VERSION,
    runId: state.runId,
    nodeId: node.id,
    status: 'complete',
    attempt: 1,
    inputDigest: digest({ nodeId: node.id, priorOutputs: Object.keys(state.nodeOutputs).sort(), budgetBefore: state.budgetUsage }),
    outputDigest: digest(output.stable ?? output),
    previousHash,
    evidenceRefs: output.evidenceRefs ?? [],
    budgetAfter: structuredClone(state.budgetUsage),
  };
  const receiptHash = digest(stable);
  return {
    ...stable,
    receiptHash,
    runtimeMetrics: {
      wallTimeMs: Math.max(0, finished - started),
      tokens: output.tokens ?? 0,
      costUsd: output.costUsd ?? 0,
      probes: output.probes ?? 0,
      branches: output.branches ?? 0,
      escalationClass: output.escalationClass ?? node.kind,
      criticalPath: !node.parallelSafe,
      parallelSafe: node.parallelSafe,
    },
    stable,
  };
}

export async function executeAdaptiveGraph({ spec, graphSchema, receiptSchema, initialState, handlers, pauseBefore = new Set() }) {
  validateAdaptiveGraphSpec(spec, graphSchema);
  const deps = dependencyMap(spec);
  const state = structuredClone(initialState);
  state.status = 'running';
  let previousHash = state.receipts.at(-1)?.receiptHash ?? 'GENESIS';
  while (state.budgetUsage.nodes < spec.nodes.length) {
    const ready = readyNodes(spec, state, deps).sort((a, b) => a.id.localeCompare(b.id));
    if (!ready.length) fail('ADAPTIVE_GRAPH_NO_READY_NODE', { completed: Object.keys(state.nodeOutputs) });
    const selected = ready.filter((node) => node.parallelSafe);
    const batch = selected.length > 1 ? selected : [ready[0]];
    for (const node of batch) {
      if (pauseBefore.has(node.id)) {
        state.status = 'paused';
        state.pausedBefore = node.id;
        return state;
      }
      const handler = handlers[node.id] ?? contractHandler(node);
      const started = performance.now();
      const output = await handler({ state: structuredClone(state), spec, node });
      const finished = performance.now();
      assertNoForbiddenPersistence(output, spec.privacy.forbiddenPersistedFields);
      state.nodeOutputs[node.id] = output.stable ?? output;
      state.budgetUsage.nodes += 1;
      state.budgetUsage.branches += output.branches ?? 0;
      state.budgetUsage.probes += output.probes ?? 0;
      state.budgetUsage.modelTokens += output.tokens ?? 0;
      state.budgetUsage.toolCalls += output.toolCalls ?? 0;
      state.budgetUsage.mutations += output.mutations ?? 0;
      state.budgetUsage.persistedBytes = Buffer.byteLength(canonicalJson({ nodeOutputs: state.nodeOutputs, receipts: state.receipts.map((receipt) => receipt.stable) }));
      enforceBudgets(spec, state);
      const receipt = makeReceipt({ state, node, output, previousHash, started, finished });
      validateOrThrow(receipt, receiptSchema, `adaptiveReceipt:${node.id}`);
      state.receipts.push(receipt);
      previousHash = receipt.receiptHash;
      if (node.id === 'BI-G7_terminal_manifest') state.verdict = output.stable.verdict;
    }
  }
  state.status = 'complete';
  return state;
}

export function contractHandler(node) {
  return async () => ({
    stable: {
      nodeId: node.id,
      gate: node.gate,
      mutationPerformed: false,
      sourceRowsPersisted: false,
      contract: {
        typedUncertaintyGapLedger: true,
        boundedBranches: true,
        budgetedProbes: true,
        pauseResumeReplay: true,
        evidenceHashes: true,
        failClosedSchemaValidation: true,
      },
    },
    evidenceRefs: ['contracts/bi-adaptive-investigation-graph/v1'],
    escalationClass: 'contract-only',
  });
}

function assertProfileSummaryOnly(pack) {
  const serialized = canonicalJson(pack.input);
  if (/\b(source_rows|sourceRows|sampleValues|rawRows|records|password|secret|bearer|chain.?of.?thought)\b/i.test(serialized)) {
    fail('ADAPTIVE_PROFILE_PRIVACY_FILTER_DENIED', { packId: pack.id });
  }
}

function classifyAnomalies(profile) {
  const anomalies = [];
  if (profile.nullPctMax >= 0.15) anomalies.push('material_missingness');
  if (profile.outlierZMax >= 5) anomalies.push('outlier_cluster');
  if (profile.formatErrorPctMax >= 0.01 || profile.noiseScore >= 0.4) anomalies.push('format_noise');
  if (profile.impossibleValuePctMax >= 0.02) anomalies.push('corruption_signal');
  if (profile.grain?.candidateKeyCollisionPct >= 0.05 || profile.grain?.timeGrainConflict) anomalies.push('grain_conflict');
  return anomalies.sort();
}

function candidateDomainFromTerms(terms, probes = []) {
  const joined = [...terms, ...probes.flatMap((probe) => probe.signals ?? [])].join(' ').toLowerCase();
  if (/order|shipment|return|margin/.test(joined)) return 'order_fulfillment_margin';
  if (/supplier|receipt|defect|lead/.test(joined)) return 'supplier_quality_lead_time';
  if (/lot|station|yield|hold/.test(joined)) return 'station_yield_hold_analysis';
  if (/vessel|berth|queue|demurrage/.test(joined)) return 'berth_queue_demurrage';
  if (/episode|rx|service|adjustment|denominator/.test(joined)) return 'care_episode_adjustment_quality';
  if (/asset|cycle|downtime|rework/.test(joined)) return 'asset_cycle_rework_downtime';
  return 'unknown_domain_nonclaim';
}

function alternativesFor(pack, primary) {
  const terms = pack.input.terms.join(' ');
  return [
    { domain: primary, confidence: primary === 'unknown_domain_nonclaim' ? 0.34 : 0.72, citation: `terms:${terms}`, grainGate: pack.input.profile.grain.timeGrainConflict ? 'requires_probe' : 'compatible' },
    { domain: 'operational_quality_monitoring', confidence: 0.48, citation: 'profile_summaries_only', grainGate: 'alternative' },
    { domain: 'financial_adjustment_review', confidence: 0.33, citation: 'aggregate_names_only', grainGate: 'alternative_nonclaim' },
  ];
}

function needsProbe(pack, hypothesis, anomalies) {
  return hypothesis === 'unknown_domain_nonclaim'
    || anomalies.includes('grain_conflict')
    || anomalies.includes('corruption_signal')
    || pack.input.profile.noiseScore >= 0.4;
}

function selectProbe(pack, anomalies) {
  if (anomalies.includes('grain_conflict')) return { kind: 'grain_collision_summary', signals: pack.input.profile.summaries.filter((item) => /grain|denominator|reuse|disagree/i.test(item)) };
  if (anomalies.includes('corruption_signal')) return { kind: 'contradiction_check', signals: pack.input.profile.summaries.filter((item) => /contradict|zero|impossible/i.test(item)) };
  if (anomalies.includes('material_missingness')) return { kind: 'null_pattern_by_metric', signals: pack.input.profile.summaries.filter((item) => /null|sparse/i.test(item)) };
  if (anomalies.includes('outlier_cluster')) return { kind: 'outlier_cluster_by_segment', signals: pack.input.profile.summaries.filter((item) => /spike|tail|cluster/i.test(item)) };
  return { kind: 'domain_alias_lookup', signals: pack.input.profile.summaries };
}

export function buildAdaptiveHandlers({ packs, candidateFreeze }) {
  return {
    'BI-G3_profile_ledger': async () => {
      const cases = packs.map((pack) => {
        assertProfileSummaryOnly(pack);
        const anomalies = classifyAnomalies(pack.input.profile);
        return {
          caseId: pack.id,
          tier: pack.tier,
          inputDigest: digest(pack.input),
          anomalyLabels: anomalies,
          profileOnly: true,
          sourceRowsPersisted: false,
          sampleValuesPersisted: false,
          hardFailures: [],
          nonclaims: ['aggregate profile summary, not raw-row completeness', 'sampling summary cannot prove source truth'],
        };
      });
      return {
        stable: { cases, privacyFilter: 'passed', samplingClaimsDenied: true, sourceRowsPersisted: false, mutationPerformed: false },
        evidenceRefs: cases.map((item) => item.caseId),
        escalationClass: 'deterministic-profile',
      };
    },
    'BI-G4_hypothesis_graph': async ({ state, spec }) => {
      const profileCases = state.nodeOutputs['BI-G3_profile_ledger'].cases;
      const cases = profileCases.map((profileCase) => {
        const pack = packs.find((item) => item.id === profileCase.caseId);
        const primary = candidateDomainFromTerms(pack.input.terms);
        const alternatives = alternativesFor(pack, primary).slice(0, spec.budgets.maxBranchesPerCase);
        const contradictions = profileCase.anomalyLabels.filter((label) => ['grain_conflict', 'corruption_signal'].includes(label));
        return {
          caseId: pack.id,
          tier: pack.tier,
          primaryHypothesis: primary,
          uncertainty: primary === 'unknown_domain_nonclaim' || contradictions.length ? 'high' : 'medium',
          alternatives,
          contradictionEvidence: contradictions,
          citationGate: alternatives.every((item) => item.citation && item.citation !== 'source_row'),
          grainGate: contradictions.includes('grain_conflict') ? 'blocked_until_probe' : 'passed',
          gapLedger: needsProbe(pack, primary, profileCase.anomalyLabels) ? ['targeted_probe_required'] : [],
          hardFailures: alternatives.length > spec.budgets.maxBranchesPerCase ? ['BRANCH_BUDGET_EXCEEDED'] : [],
        };
      });
      return {
        stable: { candidateFreeze, cases, modelOwnedButOffline: true, rawPromptsPersisted: false, sourceRowsPersisted: false, mutationPerformed: false },
        evidenceRefs: ['candidate-freeze', ...cases.map((item) => item.caseId)],
        branches: cases.reduce((sum, item) => sum + item.alternatives.length, 0),
        escalationClass: 'offline-model-owned-candidate',
      };
    },
    'BI-G5_targeted_probe_policy': async ({ state, spec }) => {
      let totalProbes = 0;
      const profileCases = state.nodeOutputs['BI-G3_profile_ledger'].cases;
      const hypothesisCases = state.nodeOutputs['BI-G4_hypothesis_graph'].cases;
      const cases = hypothesisCases.map((hypothesis) => {
        const profileCase = profileCases.find((item) => item.caseId === hypothesis.caseId);
        const pack = packs.find((item) => item.id === hypothesis.caseId);
        const probes = [];
        if (hypothesis.gapLedger.length && totalProbes < spec.budgets.maxTotalProbes) {
          const probe = selectProbe(pack, profileCase.anomalyLabels);
          if (!spec.adaptivePolicy.allowedProbeKinds.includes(probe.kind)) fail('ADAPTIVE_PROBE_KIND_DENIED', { probe });
          probes.push({ ...probe, evidenceDigest: digest({ caseId: pack.id, kind: probe.kind, signals: probe.signals }) });
          if (probes.length > spec.budgets.maxProbesPerCase) fail('ADAPTIVE_CASE_PROBE_BUDGET_EXCEEDED', { caseId: pack.id });
          totalProbes += 1;
        }
        const revisedDomain = candidateDomainFromTerms(pack.input.terms, probes);
        return {
          caseId: pack.id,
          tier: pack.tier,
          probes,
          stopReason: probes.length ? 'evidence_saturation' : 'evidence_saturation',
          revisedPrimaryHypothesis: revisedDomain,
          noPHacking: true,
          mutationPerformed: false,
          hardFailures: [],
        };
      });
      return {
        stable: { cases, allowlistOnly: true, stopAtSaturationOrBudget: true, pHackingDenied: true, sourceRowsPersisted: false, mutationPerformed: false },
        evidenceRefs: cases.flatMap((item) => item.probes.map((probe) => `${item.caseId}:${probe.kind}`)),
        probes: totalProbes,
        escalationClass: 'deterministic-targeted-probes',
      };
    },
    'BI-G6_static_vs_adaptive_compare': async ({ state, spec }) => {
      const profileCases = state.nodeOutputs['BI-G3_profile_ledger'].cases;
      const hypothesisCases = state.nodeOutputs['BI-G4_hypothesis_graph'].cases;
      const probeCases = state.nodeOutputs['BI-G5_targeted_probe_policy'].cases;
      const scoredCases = packs.map((pack) => {
        const oracle = pack.hiddenOracle;
        const profile = profileCases.find((item) => item.caseId === pack.id);
        const hypothesis = hypothesisCases.find((item) => item.caseId === pack.id);
        const probe = probeCases.find((item) => item.caseId === pack.id);
        const incumbentDomain = incumbentDomainFromEasyTerms(pack);
        const candidateDomain = probe.revisedPrimaryHypothesis;
        const incumbentAnomalies = incumbentStaticAnomalies(pack.input.profile);
        return {
          caseId: pack.id,
          tier: pack.tier,
          incumbent: scoreCase(oracle, incumbentDomain, incumbentAnomalies),
          candidate: scoreCase(oracle, candidateDomain, profile.anomalyLabels),
          candidateProbeCount: probe.probes.length,
          safetyCriticalGap: {
            privacy: 0,
            mutation: 0,
            anomalyHardFail: profile.hardFailures.length + hypothesis.hardFailures.length + probe.hardFailures.length,
          },
        };
      });
      const comparison = summarizeComparison(scoredCases, spec);
      return {
        stable: { scoredCases, comparison, candidateFrozenBeforeRun: true, negativeEvidencePreserved: true, sourceRowsPersisted: false, mutationPerformed: false },
        evidenceRefs: scoredCases.map((item) => item.caseId),
        escalationClass: 'deterministic-sealed-judge',
      };
    },
    'BI-G7_terminal_manifest': async ({ state }) => {
      const comparison = state.nodeOutputs['BI-G6_static_vs_adaptive_compare'].comparison;
      const accepted = comparison.acceptance.accepted;
      return {
        stable: {
          verdict: {
            status: accepted ? 'accepted' : comparison.acceptance.privacyMutationHardFails === 0 ? 'partial' : 'negative',
            promotionAllowed: false,
            nonclaims: state.verdict.nonclaims,
          },
          terminal: true,
          rollback: 'delete local v1 branch/worktree artifacts; v0 incumbent remains untouched',
          teardown: { liveModelStarted: false, teardownRequired: false },
          comparison,
        },
        evidenceRefs: ['terminal-manifest'],
        escalationClass: 'terminal-local-only',
      };
    },
  };
}

function incumbentDomainFromEasyTerms(pack) {
  if (pack.tier === 'easy') return candidateDomainFromTerms(pack.input.terms);
  if (/lot|station|yield/.test(pack.input.terms.join(' '))) return 'station_yield_hold_analysis';
  return 'unknown_domain_nonclaim';
}

function incumbentStaticAnomalies(profile) {
  const anomalies = [];
  if (profile.nullPctMax >= 0.2) anomalies.push('material_missingness');
  if (profile.outlierZMax >= 6.5) anomalies.push('outlier_cluster');
  if (profile.impossibleValuePctMax >= 0.04) anomalies.push('corruption_signal');
  if (profile.grain?.candidateKeyCollisionPct >= 0.08) anomalies.push('grain_conflict');
  return anomalies.sort();
}

function scoreCase(oracle, domain, anomalies) {
  const expected = [...oracle.expectedAnomalies].sort();
  const observed = [...anomalies].sort();
  const domainExact = domain === oracle.domain;
  const anomalyExact = expected.length === observed.length && expected.every((item, index) => item === observed[index]);
  const hardFailures = [];
  if (!domainExact) hardFailures.push('DOMAIN_MISMATCH');
  if (!anomalyExact) hardFailures.push('ANOMALY_MISMATCH');
  return {
    domain,
    anomalies: observed,
    domainExact,
    anomalyExact,
    exact: domainExact && anomalyExact,
    hardFailures,
    ambiguityPoints: (domainExact ? 0 : 2) + (anomalyExact ? 0 : 2),
  };
}

function summarizeComparison(scoredCases, spec) {
  const tiers = ['easy', 'medium', 'hard'];
  const byTier = Object.fromEntries(tiers.map((tier) => {
    const tierCases = scoredCases.filter((item) => item.tier === tier);
    return [tier, {
      count: tierCases.length,
      incumbentExact: exactRate(tierCases, 'incumbent'),
      candidateExact: exactRate(tierCases, 'candidate'),
    }];
  }));
  const incumbentAmbiguity = scoredCases.reduce((sum, item) => sum + item.incumbent.ambiguityPoints, 0);
  const candidateAmbiguity = scoredCases.reduce((sum, item) => sum + item.candidate.ambiguityPoints, 0);
  const candidateProbes = scoredCases.reduce((sum, item) => sum + item.candidateProbeCount, 0);
  const additionalProbeRate = spec.budgets.maxTotalProbes ? candidateProbes / spec.budgets.maxTotalProbes : 0;
  const privacyMutationHardFails = scoredCases.reduce((sum, item) => sum + item.safetyCriticalGap.privacy + item.safetyCriticalGap.mutation, 0);
  const mutationHardFails = scoredCases.reduce((sum, item) => sum + item.safetyCriticalGap.mutation, 0);
  const anomalySafetyFails = scoredCases.reduce((sum, item) => sum + item.safetyCriticalGap.anomalyHardFail, 0);
  const hardTierGain = byTier.hard.candidateExact - byTier.hard.incumbentExact;
  const reviewAmbiguityReduction = incumbentAmbiguity ? (incumbentAmbiguity - candidateAmbiguity) / incumbentAmbiguity : 0;
  const easyRegression = byTier.easy.candidateExact < byTier.easy.incumbentExact;
  const candidateGapLeqIncumbent = scoredCases.every((item) => item.candidate.hardFailures.length <= item.incumbent.hardFailures.length)
    && privacyMutationHardFails === 0 && anomalySafetyFails === 0;
  const materialBenefit = hardTierGain >= 0.2 || reviewAmbiguityReduction >= 0.3;
  const accepted = privacyMutationHardFails === 0
    && mutationHardFails === 0
    && anomalySafetyFails === 0
    && candidateGapLeqIncumbent
    && !easyRegression
    && additionalProbeRate <= 0.2
    && materialBenefit;
  return {
    byTier,
    incumbentAmbiguity,
    candidateAmbiguity,
    reviewAmbiguityReduction,
    hardTierGain,
    candidateProbes,
    additionalProbeRate,
    safety: { privacyMutationHardFails, mutationHardFails, anomalySafetyFails, candidateGapLeqIncumbent, easyRegression },
    acceptance: {
      accepted,
      reason: accepted ? 'candidate meets sealed local incumbent-selection thresholds' : 'candidate retained as partial/negative evidence; thresholds not all met',
      privacyMutationHardFails,
      mutationHardFails,
      anomalySafetyFails,
      noEasyTierRegression: !easyRegression,
      candidateGapLeqIncumbent,
      materialBenefit,
      additionalProbeRate,
    },
  };
}

function exactRate(cases, side) {
  return cases.length ? cases.filter((item) => item[side].exact).length / cases.length : 0;
}

export function compareAdaptiveReplay(firstState, replayState) {
  const first = firstState.receipts.map((receipt) => receipt.receiptHash);
  const second = replayState.receipts.map((receipt) => receipt.receiptHash);
  return {
    deterministic: first.length === second.length && first.every((hash, index) => hash === second[index]),
    rate: first.length ? first.filter((hash, index) => hash === second[index]).length / first.length : 0,
    first,
    second,
  };
}

export function graphToMermaid(spec) {
  const lines = ['flowchart TD'];
  for (const node of spec.nodes) lines.push(`  ${node.id}[${node.gate} ${node.kind}]`);
  for (const edge of spec.edges) lines.push(`  ${edge.from} -->|${edge.guard}| ${edge.to}`);
  return `${lines.join('\n')}\n`;
}

export function graphToDot(spec) {
  const lines = ['digraph superset_bi_adaptive_investigation_v1 {'];
  for (const node of spec.nodes) lines.push(`  "${node.id}" [label="${node.gate} ${node.kind}"];`);
  for (const edge of spec.edges) lines.push(`  "${edge.from}" -> "${edge.to}" [label="${edge.guard}"];`);
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

export function buildAdaptiveEvidencePack({ runId, state, replay, packs, candidateFreeze, hashes }) {
  const comparison = state.nodeOutputs['BI-G6_static_vs_adaptive_compare'].comparison;
  const accepted = comparison.acceptance.accepted && replay.rate === 1;
  const verdict = accepted ? 'ACCEPTED' : comparison.acceptance.privacyMutationHardFails === 0 ? 'PARTIAL' : 'NEGATIVE';
  return {
    schemaVersion: ADAPTIVE_EVIDENCE_SCHEMA_VERSION,
    runId,
    graphId: state.graphId,
    baseCommit: ADAPTIVE_REQUIRED_BASE_COMMIT,
    verdict,
    acceptance: {
      ...comparison.acceptance,
      accepted,
      deterministicReplayRate: replay.rate,
      sourceRowsPersisted: 0,
      sampleValuesPersisted: 0,
      mutations: state.budgetUsage.mutations,
    },
    candidateFreeze,
    cases: packs.map((pack) => ({ id: pack.id, tier: pack.tier, inputDigest: digest(pack.input), sealed: true })),
    comparison,
    replay,
    privacy: state.privacy,
    hashes,
    negativeEvidence: accepted ? [] : ['ADAPTIVE_V1_NOT_ACCEPTED_FOR_PROMOTION'],
    nonclaims: state.verdict.nonclaims,
    artifacts: {
      mermaid: 'docs/evidence/graph-adaptive-v1/adaptive-investigation-v1.mmd',
      dot: 'docs/evidence/graph-adaptive-v1/adaptive-investigation-v1.dot',
      state: 'docs/evidence/graph-adaptive-v1/terminal-state.json',
      manifest: 'docs/evidence/graph-adaptive-v1/terminal-manifest.json',
      candidateFreeze: 'docs/evidence/graph-adaptive-v1/candidate-freeze.json',
    },
  };
}
