import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  buildStoredLogicImpactReport,
  canonicalJson,
  identitySha256,
  sha256,
  verifyStoredLogicEvidence,
} from './core.mjs';

export const STORED_LOGIC_OUTPUT_MANIFEST_SCHEMA = 'chimpmaera.db/stored-logic-output-manifest/v1';
export const STORED_LOGIC_REPORT_SCHEMA = 'chimpmaera.db/stored-logic-report/v1';
export const STORED_LOGIC_PROJECTION_SCHEMA = 'chimpmaera.db/superset-stored-logic-projection/v1';

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

const table = (id, title, rows, columns) => {
  const header = columns.map(([key, label]) => `<th scope="col">${escapeHtml(label)}</th>`).join('');
  const body = rows.length === 0
    ? `<tr><td colspan="${columns.length}">No proven rows. Review coverage and blind spots.</td></tr>`
    : rows.map((row) => `<tr>${columns.map(([key]) => `<td>${escapeHtml(row[key])}</td>`).join('')}</tr>`).join('');
  return `<section id="${id}"><h2>${escapeHtml(title)}</h2><div class="scroll"><table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div></section>`;
};

function projectionEnvelope(kind, sources, sourceBindingSha256, rows, reviewRequired) {
  return {
    schemaVersion: STORED_LOGIC_PROJECTION_SCHEMA,
    projectionKind: kind,
    source: {
      kind: 'CANONICAL_STORED_LOGIC_EVIDENCE',
      engine: sources.after.engine,
      storedLogicSha256: sources.after.storedLogicSha256,
      lineageSha256: sources.after.lineage.lineageSha256,
      impactReportSha256: sources.impactReport.impactReportSha256,
      sourceBindingSha256,
      sourceConnection: null,
      sourceSql: null,
      sourceRoute: null,
      directSourceDatabaseConnection: false,
    },
    readOnly: true,
    reviewRequired,
    rows,
  };
}

function inventoryRows(evidence) {
  return evidence.objects.map((object) => ({
    objectIdentitySha256: object.objectIdentitySha256,
    objectSha256: object.objectSha256,
    schemaName: object.schemaName,
    objectName: object.objectName,
    objectKind: object.objectKind,
    parentSchemaName: object.parentSchemaName,
    parentObjectName: object.parentObjectName,
    enablementState: object.enablementState,
    definitionVisibility: object.definitionVisibility,
    definitionFingerprintSha256: object.definitionFingerprintSha256,
  }));
}

function lineageRows(evidence) {
  return evidence.lineage.relationships.map((relationship) => ({ ...relationship }));
}

function blindSpotRows(evidence, impactReport) {
  const impactRelevant = new Set(impactReport.impactBlindSpots.map(({ blindSpotSha256 }) => blindSpotSha256));
  return evidence.lineage.blindSpots.map((blindSpot) => ({
    ...blindSpot,
    impactRelevant: impactRelevant.has(blindSpot.blindSpotSha256),
  }));
}

function impactRows(impactReport) {
  return [
    ...impactReport.changedObjects.map((change) => ({
      recordKind: 'CHANGED_STORED_OBJECT',
      reviewState: 'REVIEW_REQUIRED',
      recordSha256: change.changeSha256,
      sourceObjectIdentitySha256: change.objectIdentitySha256,
      schemaName: change.schemaName,
      objectName: change.objectName,
      objectKind: change.objectKind,
      changeType: change.changeType,
      candidateSha256: null,
      candidateType: null,
      targetSchemaName: null,
      targetRelationName: null,
      targetColumnName: null,
      impactClass: null,
      relationshipSha256: null,
    })),
    ...impactReport.affectedBi.map((impact) => ({
      recordKind: 'AFFECTED_APPROVED_BI',
      reviewState: 'REVIEW_REQUIRED',
      recordSha256: impact.impactSha256,
      sourceObjectIdentitySha256: impact.sourceObjectIdentitySha256,
      schemaName: null,
      objectName: null,
      objectKind: null,
      changeType: null,
      candidateSha256: impact.candidateSha256,
      candidateType: impact.candidateType,
      targetSchemaName: impact.target.schemaName,
      targetRelationName: impact.target.relationName,
      targetColumnName: impact.target.columnName,
      impactClass: impact.impactClass,
      relationshipSha256: impact.relationshipSha256,
    })),
  ];
}

function renderHtml({ sources, projections, sourceBindingSha256 }) {
  const inventoryColumns = [['objectKind', 'Kind'], ['schemaName', 'Schema'], ['objectName', 'Object'], ['enablementState', 'State'], ['definitionVisibility', 'Definition visibility'], ['objectIdentitySha256', 'Object identity SHA-256']];
  const lineageColumns = [['relationshipClass', 'Class'], ['proofState', 'Proof'], ['sourceObjectIdentitySha256', 'Source identity'], ['targetSchemaName', 'Target schema'], ['targetObjectName', 'Target object'], ['targetColumnName', 'Target column']];
  const blindSpotColumns = [['blindSpotClass', 'Class'], ['sourceObjectIdentitySha256', 'Source identity'], ['evidenceKind', 'Evidence'], ['impactRelevant', 'Impact relevant'], ['blindSpotSha256', 'Blind-spot SHA-256']];
  const impactColumns = [['recordKind', 'Kind'], ['reviewState', 'Review'], ['schemaName', 'Schema'], ['objectName', 'Object'], ['changeType', 'Change'], ['candidateType', 'BI candidate'], ['targetRelationName', 'BI relation'], ['impactClass', 'Impact class']];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ChimpMaera ${escapeHtml(sources.after.engine)} stored logic and impact</title>
<style>body{font:15px system-ui,sans-serif;max-width:110rem;margin:auto;padding:1.5rem;color:#172033}nav a{margin-right:1rem}code{font-size:.82em;overflow-wrap:anywhere}.scroll{overflow:auto}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccd3df;padding:.45rem;text-align:left;vertical-align:top}th{background:#eef2f7}section{margin-top:2rem}.notice{border-left:.35rem solid #a65d00;padding:.75rem;background:#fff5e8}</style></head>
<body data-stored-logic-sha256="${sources.after.storedLogicSha256}" data-impact-report-sha256="${sources.impactReport.impactReportSha256}" data-source-binding-sha256="${sourceBindingSha256}"><header><h1>ChimpMaera ${escapeHtml(sources.after.engine)} stored logic and impact</h1><p class="notice">Disconnected, read-only projection. Impact is review-required, not causal proof. Superset receives these files only and has no source-database connection or source route.</p><dl><dt>Runtime validation</dt><dd>${escapeHtml(sources.after.runtimeValidation)}</dd><dt>Stored-logic evidence</dt><dd><code>${sources.after.storedLogicSha256}</code></dd><dt>Impact report</dt><dd><code>${sources.impactReport.impactReportSha256}</code></dd></dl><nav aria-label="Stored logic"><a href="#inventory">Inventory</a><a href="#lineage">Lineage</a><a href="#blind-spots">Blind spots</a><a href="#impact">Impact review</a></nav></header>
${table('inventory', `Stored-object inventory (${projections.inventory.rows.length})`, projections.inventory.rows, inventoryColumns)}
${table('lineage', `Lineage (${projections.lineage.rows.length})`, projections.lineage.rows, lineageColumns)}
${table('blind-spots', `Blind spots (${projections.blindSpots.rows.length})`, projections.blindSpots.rows, blindSpotColumns)}
${table('impact', `Review-required impact (${projections.impact.rows.length})`, projections.impact.rows, impactColumns)}
</body></html>
`;
}

function unsafeMaterial(value) {
  return /"(?:sourceText|source_text|definitionText|definition_text|rawDefinition|raw_definition|password|credential)"\s*:|CREATE\s+(?:PROCEDURE|FUNCTION|TRIGGER)|(?:sourceConnection|sourceSql|sourceRoute)"\s*:\s*"/i.test(value);
}

export function buildStoredLogicOutputs(sources) {
  verifyStoredLogicEvidence(sources?.before);
  verifyStoredLogicEvidence(sources?.after);
  const impactReport = buildStoredLogicImpactReport(sources);
  const boundSources = { ...sources, impactReport };
  const sourceBinding = {
    engine: sources.after.engine,
    beforeStoredLogicSha256: sources.before.storedLogicSha256,
    afterStoredLogicSha256: sources.after.storedLogicSha256,
    lineageSha256: sources.after.lineage.lineageSha256,
    impactReportSha256: impactReport.impactReportSha256,
    structureSnapshotSha256: impactReport.source.structureSnapshotSha256,
    knowledgePackSha256: impactReport.source.knowledgePackSha256,
    supersetResultSha256: impactReport.source.supersetResultSha256,
  };
  const sourceBindingSha256 = identitySha256(sourceBinding);
  const projections = {
    inventory: projectionEnvelope('STORED_OBJECT_INVENTORY', boundSources, sourceBindingSha256, inventoryRows(sources.after), false),
    lineage: projectionEnvelope('LINEAGE', boundSources, sourceBindingSha256, lineageRows(sources.after), false),
    blindSpots: projectionEnvelope('BLIND_SPOTS', boundSources, sourceBindingSha256, blindSpotRows(sources.after, impactReport), true),
    impact: projectionEnvelope('REVIEW_REQUIRED_IMPACT', boundSources, sourceBindingSha256, impactRows(impactReport), true),
  };
  const report = {
    schemaVersion: STORED_LOGIC_REPORT_SCHEMA,
    engine: sources.after.engine,
    runtimeValidation: sources.after.runtimeValidation,
    sourceBinding,
    sourceBindingSha256,
    summary: {
      storedObjectCount: projections.inventory.rows.length,
      lineageRelationshipCount: projections.lineage.rows.length,
      blindSpotCount: projections.blindSpots.rows.length,
      changedObjectCount: impactReport.summary.changedObjectCount,
      affectedApprovedBiCount: impactReport.summary.affectedApprovedBiCount,
      reviewRequired: true,
    },
    projections,
    authority: {
      productionAuthority: false,
      automaticPublication: false,
      directSourceDatabaseAccess: false,
    },
    claims: {
      causalImpactEstablished: false,
      completeProceduralSemantics: false,
      rawDefinitionsIncluded: false,
      sourceRoutesIncluded: false,
    },
  };
  const reportJson = canonicalJson(report);
  const html = renderHtml({ sources: boundSources, projections, sourceBindingSha256 });
  const artifactDigests = {
    reportJsonSha256: sha256(reportJson),
    htmlSha256: sha256(html),
    inventorySha256: sha256(canonicalJson(projections.inventory)),
    lineageSha256: sha256(canonicalJson(projections.lineage)),
    blindSpotsSha256: sha256(canonicalJson(projections.blindSpots)),
    impactSha256: sha256(canonicalJson(projections.impact)),
  };
  const outputManifest = {
    schemaVersion: STORED_LOGIC_OUTPUT_MANIFEST_SCHEMA,
    engine: sources.after.engine,
    sourceBindingSha256,
    artifactDigests,
    securityBoundary: {
      readOnly: true,
      rawDefinitions: false,
      rowSamples: false,
      credentials: false,
      sourceRoutes: false,
      directSupersetSourceDatabaseConnection: false,
      automaticPublication: false,
    },
  };
  const serialized = canonicalJson({ report, outputManifest });
  if (unsafeMaterial(serialized) || unsafeMaterial(html)) fail('DB_STORED_LOGIC_OUTPUT_UNSAFE_MATERIAL_DENIED');
  return { report, reportJson, html, projections, outputManifest };
}

export function verifyStoredLogicOutputs(outputs, sources) {
  const expected = buildStoredLogicOutputs(sources);
  if (canonicalJson(outputs) !== canonicalJson(expected)) fail('DB_STORED_LOGIC_OUTPUT_TAMPERED');
  return outputs;
}

export async function writeStoredLogicOutputs(outputDirectory, outputs) {
  const target = path.resolve(outputDirectory);
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(path.join(parent, '.cm-db-stored-logic-output-'));
  try {
    await mkdir(path.join(temporary, 'superset'));
    await writeFile(path.join(temporary, 'stored-logic.json'), outputs.reportJson, { mode: 0o600 });
    await writeFile(path.join(temporary, 'stored-logic.html'), outputs.html, { mode: 0o600 });
    await writeFile(path.join(temporary, 'manifest.json'), canonicalJson(outputs.outputManifest), { mode: 0o600 });
    await Promise.all(Object.entries(outputs.projections).map(([name, projection]) =>
      writeFile(path.join(temporary, 'superset', `${name}.json`), canonicalJson(projection), { mode: 0o600 })));
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}
