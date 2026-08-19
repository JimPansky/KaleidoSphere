import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {canonicalJson, identitySha256, normalizeJsonValue} from './core.mjs';
import {
  buildPostgresqlWave2RulePlan,
  runPostgresqlWave2Profiles,
  runPostgresqlWave2Relationships,
  validatePostgresqlWave2Manifest,
} from './postgresql-wave2.mjs';
import {runAnalyzeProfile} from './workflow.mjs';

export const POSTGRESQL_WAVE2_EVIDENCE_STORE_SCHEMA = 'kaleidosphere.analysis/evidence-store/v1';
export const POSTGRESQL_WAVE2_MACHINE_REPORT_SCHEMA = 'kaleidosphere.analysis/postgresql-wave2-report/v1';
export const POSTGRESQL_WAVE2_PROBLEM_SCHEMA = 'kaleidosphere.analysis/postgresql-problem-receipt/v1';
export const POSTGRESQL_WAVE2_REACTION_SCHEMA = 'kaleidosphere.analysis/agent-reaction-proposal/v1';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const fail = (code) => {
  const error = new Error(code);
  error.code = code;
  throw error;
};

const exactKeys = (value, keys) => value
  && typeof value === 'object'
  && !Array.isArray(value)
  && canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort());

const sha256Value = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const methodRef = (method) => `${method.id}@${method.version}`;

async function loadWave2Pack(repositoryRoot) {
  const directory = path.join(repositoryRoot, 'query-packs', 'db-analyzer', 'v1', 'postgresql');
  const manifest = JSON.parse(await readFile(path.join(directory, 'analysis-wave2-manifest.json'), 'utf8'));
  const sqlByMethodId = Object.fromEntries(await Promise.all(manifest.methods.map(async (method) => [
    method.id, await readFile(path.join(directory, method.file), 'utf8'),
  ])));
  validatePostgresqlWave2Manifest(manifest, sqlByMethodId);
  return {manifest, sqlByMethodId};
}

function evidenceEntries(profileEvidence, relationshipEvidence) {
  return [
    ...profileEvidence.facts.map((fact) => ({...fact, evidenceId: fact.factSha256})),
    ...relationshipEvidence.observations.map((fact) => ({...fact, evidenceId: fact.factSha256})),
    ...relationshipEvidence.computations.map((fact) => ({...fact, evidenceId: fact.factSha256})),
    ...relationshipEvidence.candidates.map((fact) => ({...fact, evidenceId: fact.candidateSha256})),
  ].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
}

function buildEvidenceStore({profile, structureEvidence, profileEvidence, relationshipEvidence, manifest}) {
  const facts = evidenceEntries(profileEvidence, relationshipEvidence);
  const snapshotBody = normalizeJsonValue({
    structureSnapshotSha256: structureEvidence.snapshotSha256,
    profileEvidenceSha256: profileEvidence.profileEvidenceSha256,
    relationshipEvidenceSha256: relationshipEvidence.relationshipEvidenceSha256,
  });
  const snapshotSha256 = identitySha256(snapshotBody);
  const body = normalizeJsonValue({
    schemaVersion: POSTGRESQL_WAVE2_EVIDENCE_STORE_SCHEMA,
    assetId: profile.profileId,
    engine: 'postgresql',
    runtimeValidation: 'RUNTIME_VALIDATED',
    snapshot: {...snapshotBody, snapshotSha256},
    methodRegistry: {
      packId: manifest.packId,
      packVersion: manifest.packVersion,
      manifestSha256: identitySha256(manifest),
      allowedMethodRefs: manifest.methods.map(methodRef).sort(),
    },
    coverage: {
      structureCoverageSha256: identitySha256(structureEvidence.coverageLedger),
      profileCoverageSha256: profileEvidence.coverage.coverageSha256,
      relationshipCoverageSha256: relationshipEvidence.coverage.coverageSha256,
      structureComplete: structureEvidence.coverageLedger.allComplete,
      profileComplete: profileEvidence.coverage.allComplete,
      relationshipComplete: relationshipEvidence.coverage.allComplete,
    },
    factCount: facts.length,
    facts,
    disclosure: {aggregateCountsOnly: true, rowMaterialPersisted: false, credentialsPersisted: false, dsnPersisted: false},
    authority: {proposalOnly: true, executionAuthority: 'NONE', mutationAuthority: 'NONE'},
  });
  const evidenceStoreSha256 = identitySha256(body);
  return {...body, evidenceStoreId: `ks_store_${evidenceStoreSha256.slice(0, 24)}`, evidenceStoreSha256};
}

function bindPlan(evidenceStore, plan) {
  const {planSha256: _previousHash, ...planBody} = plan;
  const body = normalizeJsonValue({
    ...planBody,
    evidenceStoreRef: {
      evidenceStoreId: evidenceStore.evidenceStoreId,
      evidenceStoreSha256: evidenceStore.evidenceStoreSha256,
    },
  });
  return {...body, planSha256: identitySha256(body)};
}

function buildReports({evidenceStore, relationshipEvidence, plan}) {
  const profileFacts = evidenceStore.facts.filter(({factKind}) => factKind === 'COLUMN_PROFILE');
  const candidates = relationshipEvidence.candidates;
  const summary = normalizeJsonValue({
    profiledColumnCount: profileFacts.length,
    columnsWithNulls: profileFacts.filter(({metrics}) => metrics.nullCount > 0).length,
    evaluatedRelationshipPairCount: relationshipEvidence.summary.evaluatedPairCount,
    relationshipCandidateCount: candidates.length,
    highConfidenceCandidateCount: candidates.filter(({confidence}) => confidence === 'HIGH').length,
    lowConfidenceRejectedCount: relationshipEvidence.summary.lowConfidenceRejectedCount,
    planStepCount: plan.stepCount,
  });
  const machineBody = normalizeJsonValue({
    schemaVersion: POSTGRESQL_WAVE2_MACHINE_REPORT_SCHEMA,
    runtimeValidation: 'RUNTIME_VALIDATED',
    evidenceStore: {id: evidenceStore.evidenceStoreId, sha256: evidenceStore.evidenceStoreSha256},
    plan: {sha256: plan.planSha256, plannerRef: plan.plannerRef, executionAuthority: 'NONE'},
    summary,
    relationshipCandidates: candidates.map((candidate) => ({
      candidateSha256: candidate.candidateSha256,
      source: candidate.source,
      target: candidate.target,
      confidence: candidate.confidence,
      confidenceBasisPoints: candidate.confidenceBasisPoints,
      reviewState: candidate.reviewState,
      limitations: candidate.limitations,
      evidenceRefs: candidate.evidenceRefs,
    })),
    coverage: evidenceStore.coverage,
    disclosure: evidenceStore.disclosure,
    authority: evidenceStore.authority,
    nonClaims: [
      'NO_AUTOMATIC_FOREIGN_KEY_OR_DDL',
      'NO_LIVE_AGENT_OR_PROVIDER_CALL',
      'NO_PRODUCTION_OR_CUSTOMER_DATABASE_EVIDENCE',
      'NO_SEMANTIC_RELATIONSHIP_TRUTH_CLAIM',
    ],
  });
  const machine = {...machineBody, reportSha256: identitySha256(machineBody)};
  const candidateLines = candidates.length === 0
    ? ['- No relationship candidate met the configured evidence threshold.']
    : candidates.map((candidate) => `- \`${candidate.source.schemaName}.${candidate.source.relationName}.${candidate.source.columnName}\` → \`${candidate.target.schemaName}.${candidate.target.relationName}.${candidate.target.columnName}\`: ${candidate.confidence} (${candidate.confidenceBasisPoints}/10000), review required.`);
  const human = [
    '# PostgreSQL Profiling and Relationship Evidence — Wave 2',
    '',
    '**Validation:** local runtime-validated aggregate evidence; proposals only.',
    '',
    `- Profiled columns: ${summary.profiledColumnCount}`,
    `- Columns with observed nulls: ${summary.columnsWithNulls}`,
    `- Relationship pairs evaluated: ${summary.evaluatedRelationshipPairCount}`,
    `- Relationship candidates: ${summary.relationshipCandidateCount} (high confidence: ${summary.highConfidenceCandidateCount})`,
    `- Low-confidence evaluations retained as negative evidence: ${summary.lowConfidenceRejectedCount}`,
    `- Rule-plan steps: ${summary.planStepCount}`,
    '',
    '## Proposal-only relationship candidates',
    '',
    ...candidateLines,
    '',
    'Only aggregate counts, evidence references, object identifiers and limitations are materialized. No source-row material, credentials or connection strings are included.',
    '',
    `Evidence Store: \`${evidenceStore.evidenceStoreId}\` / \`${evidenceStore.evidenceStoreSha256}\``,
    `Rule Plan: \`${plan.planSha256}\``,
    '',
  ].join('\n');
  return {machine, human};
}

export function buildPostgresqlWave2Result({profile, structureEvidence, profileEvidence, relationshipEvidence, manifest}) {
  const evidenceStore = buildEvidenceStore({profile, structureEvidence, profileEvidence, relationshipEvidence, manifest});
  const plan = bindPlan(evidenceStore, buildPostgresqlWave2RulePlan({profileEvidence, relationshipEvidence}));
  const reports = buildReports({evidenceStore, relationshipEvidence, plan});
  const body = normalizeJsonValue({
    schemaVersion: 'kaleidosphere.analysis/postgresql-wave2-result/v1',
    runtimeValidation: 'RUNTIME_VALIDATED',
    evidenceStore,
    profileEvidence,
    relationshipEvidence,
    plan,
    reports,
    providerCallPerformed: false,
    freeSqlAccepted: false,
  });
  return {...body, resultSha256: identitySha256(body)};
}

export async function runPostgresqlAnalysisWave2(profileFile, options = {}) {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? REPOSITORY_ROOT);
  const profile = JSON.parse(await readFile(path.resolve(profileFile), 'utf8'));
  const {manifest, sqlByMethodId} = await loadWave2Pack(repositoryRoot);
  const structureEvidence = await runAnalyzeProfile(profileFile, {
    repositoryRoot,
    signal: options.signal,
    postgresqlDriver: options.postgresqlDriver,
  });
  const profileEvidence = await runPostgresqlWave2Profiles({
    profile, structureEvidence, manifest, sqlByMethodId,
    signal: options.signal, driver: options.postgresqlDriver,
  });
  const relationshipEvidence = await runPostgresqlWave2Relationships({
    profile, structureEvidence, profileEvidence, manifest, sqlByMethodId,
    signal: options.signal, driver: options.postgresqlDriver,
  });
  return buildPostgresqlWave2Result({profile, structureEvidence, profileEvidence, relationshipEvidence, manifest});
}

const REACTION_REASONS = Object.freeze({
  RETRY_METHOD: new Set(['TIMEOUT', 'TRANSIENT_QUERY_FAILURE']),
  SKIP_METHOD: new Set(['BUDGET_REJECTED', 'UNSUPPORTED_TYPE']),
  USE_FALLBACK: new Set(['INCOMPLETE_EVIDENCE', 'UNSUPPORTED_TYPE']),
  REQUEST_REVIEW: new Set(['INCOMPLETE_EVIDENCE', 'LOW_CONFIDENCE', 'VALIDATION_FAILED']),
});

export function buildPostgresqlWave2ProblemReceipt({methodRef: method, reasonCode, evidenceRefs, retryable}) {
  if (typeof method !== 'string' || !/^postgresql\.wave2\.[a-z-]+@1\.0\.0$/.test(method)
    || typeof reasonCode !== 'string' || !/^[A-Z][A-Z0-9_]{2,127}$/.test(reasonCode)
    || !Array.isArray(evidenceRefs) || evidenceRefs.length === 0
    || evidenceRefs.some((ref) => !sha256Value(ref)) || new Set(evidenceRefs).size !== evidenceRefs.length
    || typeof retryable !== 'boolean') fail('DB_WAVE2_PROBLEM_INVALID');
  const body = normalizeJsonValue({
    schemaVersion: POSTGRESQL_WAVE2_PROBLEM_SCHEMA,
    methodRef: method,
    reasonCode,
    evidenceRefs: [...evidenceRefs].sort(),
    retryable,
  });
  return {...body, problemSha256: identitySha256(body)};
}

export function validatePostgresqlWave2ReactionProposal({proposal, problemReceipt, evidenceStore, retryBudget}) {
  if (!exactKeys(proposal, ['schemaVersion', 'action', 'methodRef', 'reasonCode', 'evidenceRefs', 'retryAttempt'])
    || proposal.schemaVersion !== POSTGRESQL_WAVE2_REACTION_SCHEMA
    || !Object.hasOwn(REACTION_REASONS, proposal.action)
    || !REACTION_REASONS[proposal.action].has(proposal.reasonCode)
    || !Array.isArray(proposal.evidenceRefs) || proposal.evidenceRefs.length === 0
    || new Set(proposal.evidenceRefs).size !== proposal.evidenceRefs.length
    || !Number.isInteger(retryBudget) || retryBudget < 0) fail('DB_WAVE2_REACTION_INVALID');
  if (problemReceipt?.schemaVersion !== POSTGRESQL_WAVE2_PROBLEM_SCHEMA || !sha256Value(problemReceipt.problemSha256)) {
    fail('DB_WAVE2_PROBLEM_INVALID');
  }
  const {problemSha256, ...problemBody} = problemReceipt;
  if (identitySha256(problemBody) !== problemSha256
    || proposal.methodRef !== problemReceipt.methodRef
    || proposal.reasonCode !== problemReceipt.reasonCode
    || canonicalJson([...proposal.evidenceRefs].sort()) !== canonicalJson(problemReceipt.evidenceRefs)) {
    fail('DB_WAVE2_PROBLEM_TAMPERED');
  }
  if (evidenceStore?.schemaVersion !== POSTGRESQL_WAVE2_EVIDENCE_STORE_SCHEMA
    || !sha256Value(evidenceStore.evidenceStoreSha256)
    || !evidenceStore.methodRegistry.allowedMethodRefs.includes(proposal.methodRef)) fail('DB_WAVE2_REACTION_METHOD_DENIED');
  const knownEvidence = new Set(evidenceStore.facts.map(({evidenceId}) => evidenceId));
  if (proposal.evidenceRefs.some((ref) => !knownEvidence.has(ref))) fail('DB_WAVE2_REACTION_EVIDENCE_REF_MISSING');
  if (proposal.action === 'RETRY_METHOD') {
    if (problemReceipt.retryable !== true || !Number.isInteger(proposal.retryAttempt)
      || proposal.retryAttempt < 1 || proposal.retryAttempt > retryBudget) fail('DB_WAVE2_REACTION_RETRY_DENIED');
  } else if (proposal.retryAttempt !== null) fail('DB_WAVE2_REACTION_INVALID');
  return normalizeJsonValue({
    ...proposal,
    validationState: 'PROPOSAL_VALIDATED',
    queryAuthority: 'REGISTERED_METHOD_ONLY',
    executionAuthority: 'NONE',
    mutationAuthority: 'NONE',
    providerCallPerformed: false,
  });
}
