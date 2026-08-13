import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson, identitySha256, normalizeJsonValue } from './core.mjs';
import {
  selectLastKnownGoodOperation,
  validateOperationHistory,
  validateOperationLifecycleStore,
} from './operation.mjs';

export const OPERATION_OUTPUT_MANIFEST_SCHEMA = 'chimpmaera.db/operation-output-manifest/v1';
export const OPERATION_SUMMARY_SCHEMA = 'chimpmaera.db/operation-summary/v1';
export const OPERATION_KNOWLEDGE_SCHEMA = 'chimpmaera.db/operation-knowledge/v1';
export const OPERATION_SUPERSET_SCHEMA = 'chimpmaera.db/operation-superset-result/v1';

const SHA256 = /^[a-f0-9]{64}$/;
const FILES = Object.freeze({
  operationalJson: 'operation-summary.json',
  html: 'operation-summary.html',
  knowledgeJson: 'operation-knowledge.json',
  supersetJson: 'operation-superset.json',
  manifestJson: 'operation-output-manifest.json',
});

const fail = (code) => {
  const error = new Error(code);
  error.code = code;
  throw error;
};

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const containsSecretMaterial = (value) => {
  if (Array.isArray(value)) return value.some(containsSecretMaterial);
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, child]) => (
      /(?:password|secret|token|credentialValue|apiKey|privateKey)$/i.test(key)
      || containsSecretMaterial(child)
    ));
  }
  return typeof value === 'string'
    && /(?:password|secret|token|credentialValue)\s*[=:]\s*\S+/i.test(value);
};

const withDigest = (body, key) => ({ ...body, [key]: identitySha256(body) });

function validateSourceRecords({ store, history, resolution }) {
  const markerSha256 = history.source.markerSha256;
  const records = store.records.filter((record) => record.markerSha256 === markerSha256);
  const resolutionRecords = records.filter(({ artifactKind }) => artifactKind === 'RESOLUTION');
  const historyRecords = records.filter(({ artifactKind }) => artifactKind === 'HISTORY');
  if (resolutionRecords.length !== 1
    || resolutionRecords[0].artifactId !== resolution.resolutionSha256
    || resolutionRecords[0].payloadSha256 !== identitySha256(resolution)
    || historyRecords.length !== 1
    || historyRecords[0].artifactId !== history.historySha256
    || historyRecords[0].payloadSha256 !== identitySha256(history)) {
    fail('DB_OPERATION_OUTPUT_SOURCE_UNBOUND');
  }
  return records;
}

function renderHtml({ summary, knowledge, superset }) {
  const historyRows = superset.dataset.rows.map((row) => `<tr><td>${row.sequence}</td><td>${escapeHtml(row.recordedAt)}</td><td>${escapeHtml(row.outcomeState)}</td><td>${escapeHtml(row.driftState)}</td><td><code>${row.receiptSha256}</code></td></tr>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ChimpMaera repeatable database operation</title><style>body{font:15px system-ui,sans-serif;max-width:90rem;margin:auto;padding:1.5rem;color:#172033}code{font-size:.82em;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccd3df;padding:.45rem;text-align:left}.notice{border-left:.35rem solid #2855a6;padding:.75rem;background:#eef5ff}</style></head><body data-summary-sha256="${summary.summarySha256}"><h1>Repeatable database operation</h1><p class="notice">Disconnected, read-only operational evidence. No source-database route, credentials, row samples, automatic publication or runtime-compatibility claim is included.</p><dl><dt>Engine</dt><dd>${escapeHtml(summary.source.engine)}</dd><dt>Source</dt><dd>${escapeHtml(summary.source.sourceId)}</dd><dt>History</dt><dd>${summary.operation.totalEntries} entries; ${escapeHtml(summary.operation.latestOutcomeState)}</dd><dt>Last known good</dt><dd><code>${summary.operation.lastKnownGoodEntrySha256}</code></dd><dt>Knowledge</dt><dd><code>${knowledge.knowledgeSha256}</code></dd></dl><table><thead><tr><th>Sequence</th><th>Recorded</th><th>Outcome</th><th>Drift</th><th>Receipt</th></tr></thead><tbody>${historyRows}</tbody></table></body></html>
`;
}

export function buildOperationOutputBundle({ resolution, history, lifecycleStore }) {
  const verifiedHistory = validateOperationHistory({ history, resolution });
  const verifiedStore = validateOperationLifecycleStore(lifecycleStore);
  if (verifiedHistory.source.resolutionSha256 !== resolution.resolutionSha256
    || verifiedHistory.source.engine !== resolution.source.engine
    || !SHA256.test(verifiedHistory.source.markerSha256 ?? '')) {
    fail('DB_OPERATION_OUTPUT_SOURCE_INVALID');
  }
  const records = validateSourceRecords({ store: verifiedStore, history: verifiedHistory, resolution });
  const selected = selectLastKnownGoodOperation({ history: verifiedHistory, resolution });
  const artifactBindings = records.map(({ artifactKind, artifactId, payloadSha256 }) => ({
    artifactKind, artifactId, payloadSha256,
  }));
  const summaryBody = normalizeJsonValue({
    schemaVersion: OPERATION_SUMMARY_SCHEMA,
    source: {
      registryId: verifiedHistory.source.registryId,
      sourceId: verifiedHistory.source.sourceId,
      engine: verifiedHistory.source.engine,
      markerSha256: verifiedHistory.source.markerSha256,
      resolutionSha256: resolution.resolutionSha256,
      scopeSha256: verifiedHistory.source.scopeSha256,
      capabilityPackVersion: verifiedHistory.source.capabilityPackVersion,
      queryPackVersion: verifiedHistory.source.queryPackVersion,
      normalizerVersion: verifiedHistory.source.normalizerVersion,
    },
    operation: {
      workflow: selected.receipt.workflow,
      historySha256: verifiedHistory.historySha256,
      totalEntries: verifiedHistory.totalEntries,
      retainedEntries: verifiedHistory.entries.length,
      prunedEntries: verifiedHistory.prunedEntries,
      latestOutcomeState: verifiedHistory.entries.at(-1).receipt.outcome.state,
      latestDriftState: verifiedHistory.entries.at(-1).drift.state,
      lastKnownGoodEntrySha256: selected.entrySha256,
      lastKnownGoodReceiptSha256: selected.receipt.receiptSha256,
      resumableCheckpointCount: verifiedHistory.entries.filter(({ resumeCheckpoint }) => resumeCheckpoint !== null).length,
    },
    persistence: {
      lifecycleStoreSha256: verifiedStore.storeSha256,
      lifecycleStoreRevision: verifiedStore.revision,
      sourceArtifactCount: records.length,
      artifactBindings,
    },
    evidenceBoundary: {
      runtimeValidation: 'SYNTHETIC_UNVALIDATED',
      credentialsIncluded: false,
      rowSamplesIncluded: false,
      sourceDatabaseWritten: false,
      schedulerStarted: false,
      productionCompatibilityEstablished: false,
    },
  });
  const summary = withDigest(summaryBody, 'summarySha256');
  const knowledgeBody = normalizeJsonValue({
    schemaVersion: OPERATION_KNOWLEDGE_SCHEMA,
    state: 'CURATED_OPERATIONAL_SUMMARY',
    source: {
      summarySha256: summary.summarySha256,
      historySha256: verifiedHistory.historySha256,
      lifecycleStoreSha256: verifiedStore.storeSha256,
    },
    facts: [
      { fact: 'WORKFLOW', value: selected.receipt.workflow },
      { fact: 'RETAINED_HISTORY_ENTRIES', value: verifiedHistory.entries.length },
      { fact: 'LAST_KNOWN_GOOD_SEQUENCE', value: selected.sequence },
      { fact: 'LAST_KNOWN_GOOD_DRIFT', value: selected.drift.state },
      { fact: 'SOURCE_ARTIFACTS', value: records.length },
    ],
    claims: {
      derivedFromBoundEvidenceOnly: true,
      runtimeCompatibilityEstablished: false,
      businessSemanticsEstablished: false,
      productionAuthority: false,
    },
  });
  const knowledge = withDigest(knowledgeBody, 'knowledgeSha256');
  const supersetBody = normalizeJsonValue({
    schemaVersion: OPERATION_SUPERSET_SCHEMA,
    state: 'DISCONNECTED_CURATED_RESULT',
    source: {
      knowledgeSha256: knowledge.knowledgeSha256,
      summarySha256: summary.summarySha256,
      directSourceDatabaseConnection: false,
      sourceConnection: null,
      sourceSql: null,
    },
    dataset: {
      datasetId: `${resolution.source.sourceId}-operation-history`,
      readOnly: true,
      rows: verifiedHistory.entries.map((entry) => ({
        sequence: entry.sequence,
        recordedAt: entry.recordedAt,
        outcomeState: entry.receipt.outcome.state,
        driftState: entry.drift.state,
        receiptSha256: entry.receipt.receiptSha256,
        entrySha256: entry.entrySha256,
      })),
    },
    dashboard: {
      dashboardId: `${resolution.source.sourceId}-repeatable-operation`,
      charts: ['RUN_OUTCOME', 'DRIFT_STATE'],
      automaticPublication: false,
      drillThroughSourceRoute: null,
    },
  });
  const superset = withDigest(supersetBody, 'supersetResultSha256');
  const html = renderHtml({ summary, knowledge, superset });
  const artifacts = {
    operationalJson: canonicalJson(summary),
    html,
    knowledgeJson: canonicalJson(knowledge),
    supersetJson: canonicalJson(superset),
  };
  if (containsSecretMaterial(artifacts)) fail('DB_OPERATION_OUTPUT_SECRET_MATERIAL_DENIED');
  const manifestBody = normalizeJsonValue({
    schemaVersion: OPERATION_OUTPUT_MANIFEST_SCHEMA,
    source: summary.source,
    bindings: {
      summarySha256: summary.summarySha256,
      knowledgeSha256: knowledge.knowledgeSha256,
      supersetResultSha256: superset.supersetResultSha256,
    },
    artifactDigests: Object.fromEntries(Object.entries(artifacts).map(([key, value]) => [key, identitySha256(value)])),
    outputFiles: FILES,
    securityBoundary: {
      fixedMarkerScopedPaths: true,
      credentialsIncluded: false,
      rowSamplesIncluded: false,
      directSupersetSourceDatabaseConnection: false,
      automaticPublication: false,
    },
  });
  const manifest = withDigest(manifestBody, 'manifestSha256');
  const bundle = { ...artifacts, manifestJson: canonicalJson(manifest), summary, knowledge, superset, manifest };
  if (containsSecretMaterial(bundle)) fail('DB_OPERATION_OUTPUT_SECRET_MATERIAL_DENIED');
  return bundle;
}

async function writeExact(file, content) {
  try {
    await writeFile(file, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    if (await readFile(file, 'utf8') !== content) fail('DB_OPERATION_OUTPUT_EXISTING_FILE_DRIFT');
  }
}

export async function writeOperationOutputBundle({ rootDir, resolution, history, lifecycleStore }) {
  if (typeof rootDir !== 'string' || !path.isAbsolute(rootDir)) fail('DB_OPERATION_OUTPUT_ROOT_INVALID');
  const bundle = buildOperationOutputBundle({ resolution, history, lifecycleStore });
  const markerSha256 = bundle.summary.source.markerSha256;
  const root = path.resolve(rootDir);
  const outputDirectory = path.join(root, `source-${markerSha256}`);
  if (path.dirname(outputDirectory) !== root) fail('DB_OPERATION_OUTPUT_SCOPE_INVALID');
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const contents = {
    operationalJson: bundle.operationalJson,
    html: bundle.html,
    knowledgeJson: bundle.knowledgeJson,
    supersetJson: bundle.supersetJson,
    manifestJson: bundle.manifestJson,
  };
  await Promise.all(Object.entries(contents).map(([key, content]) => writeExact(
    path.join(outputDirectory, FILES[key]), content,
  )));
  return normalizeJsonValue({
    markerSha256,
    relativeDirectory: `source-${markerSha256}`,
    relativeFiles: FILES,
    manifestSha256: bundle.manifest.manifestSha256,
  });
}
