import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson, identitySha256, normalizeSql, sha256, validateQueryManifest } from './core.mjs';

export const OUTPUT_MANIFEST_SCHEMA = 'chimpmaera.db/structure-map-output-manifest/v1';
export const STRUCTURE_MAP_SCHEMA = 'chimpmaera.db/structure-map/v1';
export const SUPERSET_PROJECTION_SCHEMA = 'chimpmaera.db/superset-structure-projection/v1';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

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

const compare = (left, right) => Buffer.compare(Buffer.from(String(left ?? ''), 'utf8'), Buffer.from(String(right ?? ''), 'utf8'));

function queryBindings({ evidence, manifest, sqlByQueryId }) {
  if (manifest.engine !== evidence.engine || manifest.packId !== evidence.packId || manifest.packVersion !== evidence.packVersion) {
    fail('DB_OUTPUT_PACK_BINDING_INVALID');
  }
  const extracts = new Map(evidence.extracts?.map((entry) => [entry.queryId, entry]));
  if (extracts.size !== manifest.queries.length) fail('DB_OUTPUT_QUERY_BINDING_INVALID');
  return manifest.queries.map((query) => {
    const extract = extracts.get(query.id);
    const sql = sqlByQueryId[query.id];
    let sourceUrl;
    try {
      sourceUrl = new URL(query.provenance.url);
    } catch {
      fail('DB_OUTPUT_QUERY_BINDING_INVALID');
    }
    if (!extract || typeof sql !== 'string' || sha256(normalizeSql(sql)) !== extract.querySha256 || sourceUrl.protocol !== 'https:') fail('DB_OUTPUT_QUERY_BINDING_INVALID');
    return {
      queryId: query.id,
      category: query.category,
      querySha256: extract.querySha256,
      provenance: {
        sourceKind: 'OFFICIAL_CATALOG_REFERENCE',
        url: query.provenance.url,
        spdx: query.provenance.spdx,
        copiedCode: query.provenance.copiedCode,
      },
    };
  });
}

const objectName = (category, row) => {
  if (category === 'schemas') return row.schema_name;
  if (category === 'relations') return row.relation_name;
  if (category === 'columns') return row.column_name;
  if (category === 'constraints') return row.constraint_name;
  if (category === 'indexes') return row.index_name;
  if (category === 'sequences') return row.sequence_name;
  if (category === 'synonyms') return row.synonym_name;
  return null;
};

function projectionEnvelope(kind, evidence, sourceBindingSha256, rows) {
  return {
    schemaVersion: SUPERSET_PROJECTION_SCHEMA,
    projectionKind: kind,
    source: {
      kind: 'CANONICAL_STRUCTURE_EVIDENCE',
      engine: evidence.engine,
      snapshotSha256: evidence.snapshotSha256,
      sourceBindingSha256,
      directSourceDatabaseConnection: false,
    },
    readOnly: true,
    rows,
  };
}

function buildInventory(evidence, bindings) {
  const byQuery = new Map(bindings.map((binding) => [binding.queryId, binding]));
  return evidence.extracts
    .filter((extract) => extract.category !== 'preflight')
    .flatMap((extract) => extract.rows.map((row) => {
      const binding = byQuery.get(extract.queryId);
      const { objectSha256, ...details } = row;
      return {
        objectKind: extract.category.toUpperCase(),
        objectSha256,
        schemaName: row.schema_name ?? null,
        relationName: row.relation_name ?? null,
        objectName: objectName(extract.category, row),
        detailJson: canonicalJson(details).trimEnd(),
        sourceQueryId: binding.queryId,
        sourceQuerySha256: binding.querySha256,
        sourceReferenceUrl: binding.provenance.url,
      };
    }))
    .sort((left, right) => compare(left.objectKind, right.objectKind)
      || compare(left.schemaName, right.schemaName)
      || compare(left.relationName, right.relationName)
      || compare(left.objectName, right.objectName)
      || compare(left.objectSha256, right.objectSha256));
}

function buildRelationships(evidence, bindings) {
  const byQuery = new Map(bindings.map((binding) => [binding.queryId, binding]));
  const rows = [];
  for (const extract of evidence.extracts) {
    const binding = byQuery.get(extract.queryId);
    if (extract.category === 'constraints') {
      for (const row of extract.rows.filter(({ constraint_kind: kind }) => kind === 'FOREIGN_KEY')) rows.push({
        relationshipKind: 'FOREIGN_KEY',
        relationshipName: row.constraint_name,
        fromSchemaName: row.schema_name,
        fromObjectName: row.relation_name,
        fromColumnName: row.column_name,
        toSchemaName: row.referenced_schema_name,
        toObjectName: row.referenced_relation_name,
        toColumnName: row.referenced_column_name,
        objectSha256: row.objectSha256,
        sourceQueryId: binding.queryId,
        sourceQuerySha256: binding.querySha256,
        sourceReferenceUrl: binding.provenance.url,
      });
    }
    if (extract.category === 'synonyms') {
      for (const row of extract.rows) rows.push({
        relationshipKind: 'SYNONYM_TARGET',
        relationshipName: row.synonym_name,
        fromSchemaName: row.schema_name,
        fromObjectName: row.synonym_name,
        fromColumnName: null,
        toSchemaName: row.target_schema_name,
        toObjectName: row.target_object_name ?? row.target_reference,
        toColumnName: null,
        objectSha256: row.objectSha256,
        sourceQueryId: binding.queryId,
        sourceQuerySha256: binding.querySha256,
        sourceReferenceUrl: binding.provenance.url,
      });
    }
  }
  return rows.sort((left, right) => compare(left.relationshipKind, right.relationshipKind)
    || compare(left.fromSchemaName, right.fromSchemaName)
    || compare(left.fromObjectName, right.fromObjectName)
    || compare(left.relationshipName, right.relationshipName));
}

function buildCoverage(evidence, bindings) {
  const byQuery = new Map(bindings.map((binding) => [binding.queryId, binding]));
  return evidence.coverageLedger.entries.map((entry) => {
    const binding = byQuery.get(entry.queryId);
    return {
      ...entry,
      querySha256: binding.querySha256,
      sourceReferenceUrl: binding.provenance.url,
      sourceSpdx: binding.provenance.spdx,
    };
  });
}

function table(id, title, rows, columns) {
  const header = columns.map(([key, label]) => `<th scope="col">${escapeHtml(label)}</th>`).join('');
  const body = rows.length === 0
    ? `<tr><td colspan="${columns.length}">No visible rows; consult coverage before interpreting this as empty.</td></tr>`
    : rows.map((row) => `<tr>${columns.map(([key]) => `<td>${escapeHtml(row[key])}</td>`).join('')}</tr>`).join('');
  return `<section id="${id}"><h2>${escapeHtml(title)}</h2><div class="scroll"><table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div></section>`;
}

function renderHtml({ evidence, bindings, projections, sourceBindingSha256 }) {
  const inventoryColumns = [['objectKind', 'Kind'], ['schemaName', 'Schema'], ['relationName', 'Relation'], ['objectName', 'Object'], ['sourceQueryId', 'Source query'], ['objectSha256', 'Object SHA-256']];
  const relationshipColumns = [['relationshipKind', 'Kind'], ['relationshipName', 'Name'], ['fromSchemaName', 'From schema'], ['fromObjectName', 'From object'], ['toSchemaName', 'To schema'], ['toObjectName', 'To object'], ['sourceQueryId', 'Source query']];
  const coverageColumns = [['queryId', 'Query'], ['category', 'Category'], ['state', 'State'], ['visibility', 'Visibility'], ['rowCount', 'Rows'], ['emptyInterpretation', 'Empty interpretation'], ['querySha256', 'Query SHA-256']];
  const references = bindings.map((binding) => `<li><code>${escapeHtml(binding.queryId)}</code> — <a href="${escapeHtml(binding.provenance.url)}">official catalog reference</a> — <code>${binding.querySha256}</code></li>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ChimpMaera ${escapeHtml(evidence.engine)} structure map</title>
<style>body{font:15px system-ui,sans-serif;max-width:110rem;margin:auto;padding:1.5rem;color:#172033}nav a{margin-right:1rem}code{font-size:.82em;overflow-wrap:anywhere}.scroll{overflow:auto}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccd3df;padding:.45rem;text-align:left;vertical-align:top}th{background:#eef2f7}section{margin-top:2rem}.notice{border-left:.35rem solid #2855a6;padding:.75rem;background:#eef5ff}</style></head>
<body data-source-snapshot-sha256="${evidence.snapshotSha256}" data-source-binding-sha256="${sourceBindingSha256}"><header><h1>ChimpMaera ${escapeHtml(evidence.engine)} structure map</h1><p class="notice">Read-only metadata projection. Superset receives these files only and has no source-database connection. Coverage states remain authoritative.</p><dl><dt>Engine</dt><dd>${escapeHtml(evidence.engine)}</dd><dt>Snapshot SHA-256</dt><dd><code>${evidence.snapshotSha256}</code></dd><dt>Runtime validation</dt><dd>${escapeHtml(evidence.runtimeValidation)}</dd><dt>Scope</dt><dd>${escapeHtml(evidence.profile?.scope?.schemas?.join(', ') ?? 'not declared')}</dd></dl><nav aria-label="Structure map"><a href="#inventory">Inventory</a><a href="#relationships">Relationships</a><a href="#coverage">Coverage</a><a href="#sources">Sources</a></nav></header>
${table('inventory', `Inventory (${projections.inventory.rows.length})`, projections.inventory.rows, inventoryColumns)}
${table('relationships', `Relationships (${projections.relationships.rows.length})`, projections.relationships.rows, relationshipColumns)}
${table('coverage', `Coverage (${projections.coverage.rows.length})`, projections.coverage.rows, coverageColumns)}
<section id="sources"><h2>Source query and provenance bindings</h2><ol>${references}</ol></section></body></html>
`;
}

export function buildStructureMapOutputs({ evidence, manifest, sqlByQueryId }) {
  validateQueryManifest(manifest);
  if (!/^[a-f0-9]{64}$/.test(evidence?.snapshotSha256 ?? '')) fail('DB_OUTPUT_EVIDENCE_INVALID');
  const { snapshotSha256, ...evidenceBody } = evidence;
  if (identitySha256(evidenceBody) !== snapshotSha256) fail('DB_OUTPUT_EVIDENCE_INVALID');
  const evidenceJson = canonicalJson(evidence);
  const bindings = queryBindings({ evidence, manifest, sqlByQueryId });
  const sourceBindingSha256 = sha256({ evidenceSha256: sha256(evidenceJson), queryBindings: bindings });
  const projections = {
    inventory: projectionEnvelope('INVENTORY', evidence, sourceBindingSha256, buildInventory(evidence, bindings)),
    relationships: projectionEnvelope('RELATIONSHIPS', evidence, sourceBindingSha256, buildRelationships(evidence, bindings)),
    coverage: projectionEnvelope('COVERAGE', evidence, sourceBindingSha256, buildCoverage(evidence, bindings)),
  };
  const structureMap = {
    schemaVersion: STRUCTURE_MAP_SCHEMA,
    sourceEvidence: evidence,
    sourceBindingSha256,
    queryBindings: bindings,
    summaries: {
      inventory: projections.inventory,
      relationships: projections.relationships,
      coverage: projections.coverage,
    },
  };
  const structureMapJson = canonicalJson(structureMap);
  const html = renderHtml({ evidence, bindings, projections, sourceBindingSha256 });
  const artifactDigests = {
    evidenceSha256: sha256(evidenceJson),
    canonicalJsonSha256: sha256(structureMapJson),
    htmlSha256: sha256(html),
    inventorySha256: sha256(canonicalJson(projections.inventory)),
    relationshipsSha256: sha256(canonicalJson(projections.relationships)),
    coverageSha256: sha256(canonicalJson(projections.coverage)),
  };
  const outputManifest = {
    schemaVersion: OUTPUT_MANIFEST_SCHEMA,
    engine: evidence.engine,
    sourceSnapshotSha256: evidence.snapshotSha256,
    sourceBindingSha256,
    queryBindings: bindings,
    artifactDigests,
    securityBoundary: {
      readOnly: true,
      rowSamples: false,
      credentials: false,
      directSupersetSourceDatabaseConnection: false,
    },
  };
  return { evidenceJson, structureMapJson, html, projections, outputManifest };
}

export async function loadStructureMapOutputs(profileFile, evidence, options = {}) {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? REPOSITORY_ROOT);
  const profile = JSON.parse(await readFile(path.resolve(profileFile), 'utf8'));
  const directory = path.join(repositoryRoot, 'query-packs', 'db-analyzer', profile.queryPack.version, profile.engine);
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  const sqlByQueryId = Object.fromEntries(await Promise.all(manifest.queries.map(async (query) => [query.id, await readFile(path.join(directory, query.file), 'utf8')])));
  return buildStructureMapOutputs({ evidence, manifest, sqlByQueryId });
}

export async function writeStructureMapOutputs(outputDirectory, outputs) {
  const target = path.resolve(outputDirectory);
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(path.join(parent, '.cm-db-analyzer-output-'));
  try {
    await mkdir(path.join(temporary, 'superset'));
    await writeFile(path.join(temporary, 'evidence.json'), outputs.evidenceJson, { mode: 0o600 });
    await writeFile(path.join(temporary, 'structure-map.json'), outputs.structureMapJson, { mode: 0o600 });
    await writeFile(path.join(temporary, 'structure-map.html'), outputs.html, { mode: 0o600 });
    await writeFile(path.join(temporary, 'manifest.json'), canonicalJson(outputs.outputManifest), { mode: 0o600 });
    await Promise.all(Object.entries(outputs.projections).map(([name, projection]) => writeFile(path.join(temporary, 'superset', `${name}.json`), canonicalJson(projection), { mode: 0o600 })));
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}
