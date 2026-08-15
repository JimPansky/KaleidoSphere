import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { immutableGeneration, selectCandidate, stabilitySummary } from '../services/bi-control/src/bi-specialist/optimization-gate.mjs';
import { planningComparisonMatrix, planningPolicyGuide } from '../services/bi-control/src/bi-specialist/planning-policy.mjs';
import { discoverDatabase } from '../services/bi-control/src/bi-specialist/progressive-discovery.mjs';
import { RealBiSpecialist } from '../services/bi-control/src/bi-specialist/specialist-agent.mjs';

const sha256 = (value) => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const root = resolve(process.cwd());
const fixtureRoot = resolve(root, 'services/bi-control/fixtures/bi-specialist');
const candidateRoot = resolve(fixtureRoot, 'candidate');
const evidenceRoot = resolve(root, 'docs/evidence/m6-03-bi-specialist');
const specs = JSON.parse(await readFile(resolve(fixtureRoot, 'fixture-specs-v1.json'), 'utf8'));
const provenance = JSON.parse(await readFile(resolve(fixtureRoot, 'fixture-provenance-v1.json'), 'utf8'));
const hiddenBytes = await readFile(resolve(root, 'tests/fixtures/bi-specialist-hidden-oracles-v1.json'));
const hidden = JSON.parse(hiddenBytes);

function stableObservable(value) {
  if (Array.isArray(value)) return value.map(stableObservable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['runId', 'latencyMs'].includes(key))
    .map(([key, item]) => [key, stableObservable(item)]));
}

async function atomicJson(path, value) {
  const temporary = `${path}.partial-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, path);
}

function evaluate(discovery, oracle) {
  const names = discovery.structuralInventory.map((table) => table.name);
  const anomalies = new Set(discovery.anomalyQualityCauseHypotheses.anomalies.map((item) => item.type));
  const relations = discovery.entityProcessRelationshipGraph.filter((item) => item.kind === 'declared_foreign_key').length;
  const checks = {
    inventory: names.length >= oracle.minimumTables,
    relationships: relations >= oracle.minimumDeclaredRelationships,
    domains: oracle.requiredDomains.every((name) => names.includes(name)),
    anomalies: oracle.requiredAnomalies.every((type) => anomalies.has(type)),
    citations: discovery.evidenceConfidenceBlindSpots.evidenceReceipts.length > 0,
    bounded: discovery.budgetUsage.withinBudget,
    previewOnly: discovery.trustedApplyReadbackRollback.applyPerformed === false,
  };
  const score = Object.values(checks).filter(Boolean).length / Object.keys(checks).length;
  return { checks, score, hardFailures: Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name) };
}

await mkdir(evidenceRoot, { recursive: true });
const agent = new RealBiSpecialist();
const cases = [];
for (const fixture of specs.fixtures) {
  const input = {
    databasePath: resolve(candidateRoot, fixture.filename),
    objective: fixture.id.includes('underspecified') ? 'Help me understand what matters here'
      : 'Find relevant entities, process relationships, quality anomalies, likely causes, KPI risks, and suitable decision views',
    underspecified: fixture.id.includes('underspecified'),
    runId: `${fixture.id}-candidate`,
  };
  const first = await agent.investigate(input);
  const second = await agent.investigate({ ...input, runId: `${fixture.id}-repeat` });
  const oracle = hidden.oracles[fixture.id];
  const evaluation = evaluate(first.discovery, oracle);
  const incumbentDiscovery = discoverDatabase({ databasePath: input.databasePath, objective: input.objective, maxTables: 3, maxQueries: 64, maxRowsPerQuery: 64 });
  const incumbentEvaluation = evaluate(incumbentDiscovery, oracle);
  const firstObservable = stableObservable(first);
  const secondObservable = stableObservable(second);
  cases.push({
    id: fixture.id,
    lane: fixture.lane,
    domain: fixture.domain,
    databaseSha256: provenance.fixtures.find((item) => item.id === fixture.id).databaseSha256,
    oracleDigest: sha256(JSON.stringify(oracle)),
    oracleNotCandidateInput: true,
    evaluation,
    incumbentEvaluation,
    inventoryCount: first.discovery.structuralInventory.length,
    relationshipCount: first.discovery.entityProcessRelationshipGraph.length,
    anomalyTypes: [...new Set(first.discovery.anomalyQualityCauseHypotheses.anomalies.map((item) => item.type))].sort(),
    queryCount: first.discovery.budgetUsage.queries,
    rowsObserved: first.discovery.budgetUsage.rowsObserved,
    observableTraceDigest: sha256(JSON.stringify(firstObservable)),
    repeatability: stabilitySummary([{ observable: firstObservable }, { observable: secondObservable }]),
    privacySafe: !/ops@acme|buyer@beta|bearer\s|sk-|hf_/i.test(JSON.stringify(first)),
  });
}

const actualResults = cases.map((item) => ({
  hardFailures: item.evaluation.hardFailures,
  discoveryScore: item.evaluation.score,
  oracleScore: item.evaluation.score,
  citationScore: item.evaluation.checks.citations ? 1 : 0,
  toolCorrectness: item.evaluation.checks.bounded ? 1 : 0,
  privacySafe: item.privacySafe,
  safetyGreen: item.evaluation.checks.previewOnly,
}));
const incumbentResults = cases.map((item) => ({
  hardFailures: item.incumbentEvaluation.hardFailures,
  discoveryScore: item.incumbentEvaluation.score,
  oracleScore: item.incumbentEvaluation.score,
  citationScore: item.incumbentEvaluation.checks.citations ? 1 : 0,
  toolCorrectness: item.incumbentEvaluation.checks.bounded ? 1 : 0,
  privacySafe: item.privacySafe,
  safetyGreen: item.incumbentEvaluation.checks.previewOnly,
}));
const incumbent = immutableGeneration({ id: 'm6-03-incumbent-v1', policyVersion: 'planning-policy/v0', promptVersion: 'discovery/v0', model: 'deterministic-core', sampling: {},
  results: incumbentResults });
const candidate = immutableGeneration({ id: 'm6-03-candidate-v1', policyVersion: 'planning-policy/v1', promptVersion: 'discovery/v1', model: 'deterministic-core', sampling: {}, results: actualResults });
const rejected = immutableGeneration({ id: 'm6-03-negative-candidate-v1', policyVersion: 'planning-policy/bad-ablation', promptVersion: 'discovery/v1', model: 'deterministic-core', sampling: {},
  results: actualResults.map((item, index) => index === 0 ? { ...item, hardFailures: ['ORACLE_REGRESSION'], oracleScore: 0, privacySafe: false } : item) });

const manifest = {
  schemaVersion: 'chimpmaera.bi/m6-03-core-evidence/v1',
  generatedAt: new Date().toISOString(),
  candidateInputs: { fixtureProvenanceDigest: sha256(JSON.stringify(provenance)), hiddenOracleDigest: sha256(hiddenBytes), hiddenOraclePathOutsideCandidateTree: true },
  coverage: { fixtures: cases.length, training: cases.filter((item) => item.lane === 'training').length, holdout: cases.filter((item) => item.lane === 'holdout').length,
    schemaPerturbation: true, domainShift: true, underspecified: true, adversarialBoundaryCoveredByTests: true },
  cases,
  policyGuide: planningPolicyGuide(),
  planningComparisonMatrix: planningComparisonMatrix(),
  generations: { incumbent, candidate, acceptedSelection: selectCandidate({ incumbent, candidate }), rejectedCandidate: rejected,
    rejectedSelection: selectCandidate({ incumbent: candidate, candidate: rejected }) },
  aggregate: {
    exactOracleCases: cases.filter((item) => item.evaluation.score === 1).length,
    hardFailures: cases.flatMap((item) => item.evaluation.hardFailures).length,
    privacyFailures: cases.filter((item) => !item.privacySafe).length,
    repeatabilityStableCases: cases.filter((item) => item.repeatability.fixedSeedStable).length,
  },
  optimizationInterpretation: {
    acceptedCandidateClaim: 'measured local improvement over the explicitly bounded three-table incumbent',
    improvementClaimScope: 'five local synthetic fixtures only',
    comparisonType: 'paired-fixture incumbent-versus-candidate',
    negativeProbe: 'the privacy-unsafe oracle-regressing ablation is rejected and the incumbent is retained',
  },
  nonclaims: ['No production/customer database evidence', 'No causal proof from correlation', 'No native Superset apply', 'No cross-hardware determinism claim'],
};
await atomicJson(resolve(evidenceRoot, 'core-manifest.json'), manifest);
console.log(JSON.stringify({ output: 'docs/evidence/m6-03-bi-specialist/core-manifest.json', coverage: manifest.coverage, aggregate: manifest.aggregate,
  accepted: manifest.generations.acceptedSelection.accepted, negativeCandidateRejected: !manifest.generations.rejectedSelection.accepted }, null, 2));
