import {
  canonicalJson,
  identitySha256,
  normalizeJsonValue,
  sha256,
  validateAnalyzeProfile,
  validatePostgresqlWave2Policy,
} from './core.mjs';
import {assertPostgresqlReadOnlySession, buildPostgresqlConnectionOptions} from './postgresql-adapter.mjs';

export const POSTGRESQL_WAVE2_MANIFEST_SCHEMA = 'kaleidosphere.analysis/postgresql-wave2-method-manifest/v1';
export const POSTGRESQL_WAVE2_PROFILE_EVIDENCE_SCHEMA = 'kaleidosphere.analysis/postgresql-profile-evidence/v1';
export const POSTGRESQL_WAVE2_RELATIONSHIP_EVIDENCE_SCHEMA = 'kaleidosphere.analysis/postgresql-relationship-evidence/v1';
export const POSTGRESQL_WAVE2_RULE_PLAN_SCHEMA = 'kaleidosphere.analysis/postgresql-rule-plan/v1';

const SESSION_PROOF_SQL = `SELECT
  current_setting('transaction_read_only') AS transaction_read_only,
  current_setting('default_transaction_read_only') AS default_transaction_read_only;`;

const fail = (code, cause) => {
  const error = new Error(code, cause === undefined ? undefined : {cause});
  error.code = code;
  throw error;
};

const exactKeys = (value, keys) => value
  && typeof value === 'object'
  && !Array.isArray(value)
  && canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort());

const identifier = (value) => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(value);
const sha256Value = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const compare = (left, right) => Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
const targetKey = (target) => `${target.schemaName}\u0000${target.relationName}\u0000${target.columnName}`;
const quoteIdentifier = (value) => {
  if (!identifier(value)) fail('DB_WAVE2_IDENTIFIER_INVALID');
  return `"${value.replaceAll('"', '""')}"`;
};

const FORBIDDEN_SQL = /\b(?:ALTER|CALL|COPY|CREATE|DELETE|DO|DROP|EXEC(?:UTE)?|GRANT|INSERT|MERGE|REVOKE|TRUNCATE|UPDATE)\b/i;
const TEMPLATE_MARKERS = new Set(['SCHEMA', 'RELATION', 'COLUMN', 'SOURCE_SCHEMA', 'SOURCE_RELATION', 'SOURCE_COLUMN', 'TARGET_SCHEMA', 'TARGET_RELATION', 'TARGET_COLUMN']);

function auditAggregateSql(sql, expectedMarkers) {
  if (typeof sql !== 'string' || !/^\s*SELECT\b/i.test(sql) || FORBIDDEN_SQL.test(sql)
    || /--|\/\*/.test(sql) || /\bSELECT\s+\*/i.test(sql)) fail('DB_WAVE2_TEMPLATE_DENIED');
  const semicolons = sql.match(/;/g) ?? [];
  if (semicolons.length !== 1 || !/;\s*$/.test(sql)) fail('DB_WAVE2_TEMPLATE_DENIED');
  const markers = [...sql.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((match) => match[1]);
  if (markers.some((marker) => !TEMPLATE_MARKERS.has(marker))
    || canonicalJson([...new Set(markers)].sort()) !== canonicalJson([...expectedMarkers].sort())) {
    fail('DB_WAVE2_TEMPLATE_DENIED');
  }
  return true;
}

export function validatePostgresqlWave2Manifest(manifest, sqlByMethodId) {
  if (!exactKeys(manifest, ['schemaVersion', 'packId', 'packVersion', 'engine', 'methods', 'blindSpots'])
    || manifest.schemaVersion !== POSTGRESQL_WAVE2_MANIFEST_SCHEMA
    || manifest.packId !== 'kaleidosphere-postgresql-analysis-wave2'
    || manifest.packVersion !== '1.0.0'
    || manifest.engine !== 'postgresql'
    || !Array.isArray(manifest.methods) || manifest.methods.length === 0
    || !Array.isArray(manifest.blindSpots) || manifest.blindSpots.length === 0
    || manifest.blindSpots.some((entry) => typeof entry !== 'string' || !/^[A-Z][A-Z0-9_]{2,127}$/.test(entry))) {
    fail('DB_WAVE2_MANIFEST_INVALID');
  }
  const ids = new Set();
  for (const method of manifest.methods) {
    if (!exactKeys(method, [
      'id', 'version', 'kind', 'file', 'templateSha256', 'markers', 'outputColumns',
      'readOnly', 'aggregateOnly', 'rowValues', 'exampleValues', 'cost', 'timeoutMs', 'provenance',
    ]) || typeof method.id !== 'string' || !/^postgresql\.wave2\.[a-z-]+$/.test(method.id)
      || ids.has(method.id) || method.version !== '1.0.0'
      || !['PROFILE_COUNTS', 'RELATIONSHIP_OVERLAP'].includes(method.kind)
      || typeof method.file !== 'string' || method.file !== method.file.split(/[\\/]/).at(-1)
      || !sha256Value(method.templateSha256)
      || !Array.isArray(method.markers) || method.markers.length === 0
      || method.markers.some((marker) => !TEMPLATE_MARKERS.has(marker))
      || !Array.isArray(method.outputColumns) || method.outputColumns.length === 0
      || method.outputColumns.some((column) => !/^[a-z][a-z0-9_]{1,63}$/.test(column))
      || method.readOnly !== true || method.aggregateOnly !== true
      || method.rowValues !== false || method.exampleValues !== false
      || method.cost !== 'BOUNDED_SCAN'
      || !Number.isInteger(method.timeoutMs) || method.timeoutMs < 1000 || method.timeoutMs > 120000
      || !exactKeys(method.provenance, ['sourceType', 'referenceUrl', 'copiedCode'])
      || method.provenance.sourceType !== 'KALEIDOSPHERE_AUTHORED_AGGREGATE_TEMPLATE'
      || typeof method.provenance.referenceUrl !== 'string' || !method.provenance.referenceUrl.startsWith('https://www.postgresql.org/docs/')
      || method.provenance.copiedCode !== false) fail('DB_WAVE2_METHOD_INVALID');
    ids.add(method.id);
    if (sqlByMethodId !== undefined) {
      const sql = sqlByMethodId[method.id];
      if (typeof sql !== 'string' || sha256(sql) !== method.templateSha256) fail('DB_WAVE2_TEMPLATE_HASH_MISMATCH');
      auditAggregateSql(sql, method.markers);
    }
  }
  if (sqlByMethodId !== undefined
    && canonicalJson(Object.keys(sqlByMethodId).sort()) !== canonicalJson([...ids].sort())) fail('DB_WAVE2_TEMPLATE_SET_INVALID');
  return manifest;
}

const TYPE_FAMILIES = Object.freeze({
  bool: 'BOOLEAN',
  int2: 'NUMERIC', int4: 'NUMERIC', int8: 'NUMERIC', numeric: 'NUMERIC', float4: 'NUMERIC', float8: 'NUMERIC', money: 'NUMERIC',
  text: 'TEXT', varchar: 'TEXT', bpchar: 'TEXT', name: 'TEXT', uuid: 'TEXT',
  date: 'TEMPORAL', time: 'TEMPORAL', timetz: 'TEMPORAL', timestamp: 'TEMPORAL', timestamptz: 'TEMPORAL',
});

function assertStructureEvidence(profile, evidence) {
  if (evidence?.engine !== 'postgresql' || evidence.runtimeValidation !== 'RUNTIME_VALIDATED'
    || !sha256Value(evidence.snapshotSha256) || !Array.isArray(evidence.extracts)
    || evidence.profile?.profileId !== profile.profileId
    || canonicalJson(evidence.profile?.scope) !== canonicalJson(profile.scope)) fail('DB_WAVE2_STRUCTURE_EVIDENCE_INVALID');
  const {snapshotSha256, ...body} = evidence;
  if (identitySha256(body) !== snapshotSha256) fail('DB_WAVE2_STRUCTURE_EVIDENCE_TAMPERED');
  return evidence;
}

function compileTemplate(sql, replacements) {
  const statement = sql.replace(/\{\{([A-Z_]+)\}\}/g, (_match, marker) => {
    if (!Object.hasOwn(replacements, marker)) fail('DB_WAVE2_TEMPLATE_DENIED');
    return quoteIdentifier(replacements[marker]);
  });
  if (/\{\{/.test(statement)) fail('DB_WAVE2_TEMPLATE_DENIED');
  auditAggregateSql(statement, []);
  return statement;
}

export function compilePostgresqlWave2ProfileDispatches({profile, structureEvidence, manifest, sqlByMethodId}) {
  validateAnalyzeProfile(profile);
  const policy = validatePostgresqlWave2Policy(profile);
  assertStructureEvidence(profile, structureEvidence);
  validatePostgresqlWave2Manifest(manifest, sqlByMethodId);
  const method = manifest.methods.find(({kind}) => kind === 'PROFILE_COUNTS');
  if (!method || canonicalJson(method.outputColumns) !== canonicalJson(['row_count', 'null_count', 'distinct_count'])
    || method.timeoutMs > policy.budgets.maxQueryTimeoutMs) fail('DB_WAVE2_PROFILE_METHOD_INVALID');

  const columns = structureEvidence.extracts.find(({category}) => category === 'columns')?.rows ?? [];
  const columnByTarget = new Map(columns.map((column) => [targetKey({
    schemaName: column.schema_name,
    relationName: column.relation_name,
    columnName: column.column_name,
  }), column]));
  const sensitive = new Set(policy.sensitiveTargets.map(targetKey));
  const dispatches = policy.profileTargets.map((target) => {
    if (sensitive.has(targetKey(target))) fail('DB_WAVE2_SENSITIVE_TARGET_DENIED');
    const column = columnByTarget.get(targetKey(target));
    const typeFamily = TYPE_FAMILIES[column?.data_type];
    if (!column || !['TABLE', 'PARTITIONED_TABLE'].includes(column.relation_kind) || !typeFamily
      || !sha256Value(column.objectSha256)) fail('DB_WAVE2_PROFILE_TARGET_UNSUPPORTED');
    const statement = compileTemplate(sqlByMethodId[method.id], {
      SCHEMA: target.schemaName,
      RELATION: target.relationName,
      COLUMN: target.columnName,
    });
    const planBody = normalizeJsonValue({
      methodRef: `${method.id}@${method.version}`,
      target,
      typeFamily,
      nativeTypeOid: String(column.native_type_oid),
      structureObjectSha256: column.objectSha256,
      templateSha256: method.templateSha256,
      statementSha256: sha256(statement),
      timeoutMs: method.timeoutMs,
      outputColumns: method.outputColumns,
      parameterCount: 0,
      readOnly: true,
      aggregateOnly: true,
    });
    return {...planBody, planSha256: identitySha256(planBody), statement, values: []};
  }).sort((left, right) => compare(targetKey(left.target), targetKey(right.target)));
  if (dispatches.length > policy.budgets.maxProfileTargets || dispatches.length > policy.budgets.maxQueries) {
    fail('DB_WAVE2_BUDGET_EXCEEDED');
  }
  return dispatches;
}

const parseCount = (value) => {
  const source = typeof value === 'bigint' ? value.toString() : String(value);
  if (!/^(?:0|[1-9][0-9]*)$/.test(source)) fail('DB_WAVE2_PROFILE_RESULT_INVALID');
  const parsed = Number(source);
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail('DB_WAVE2_PROFILE_COUNT_OUT_OF_RANGE');
  return parsed;
};

const normalizedProblemCode = (error) => {
  const source = String(error?.code ?? 'POSTGRESQL_QUERY_FAILED').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  return /^[A-Z][A-Z0-9_]{1,127}$/.test(source) ? source : 'POSTGRESQL_QUERY_FAILED';
};

const driverPool = async (driver) => {
  const resolved = driver ?? await import('pg');
  const Pool = resolved.Pool ?? resolved.default?.Pool;
  if (typeof Pool !== 'function') fail('DB_WAVE2_POSTGRESQL_DRIVER_INVALID');
  return Pool;
};

export async function runPostgresqlWave2Profiles({profile, structureEvidence, manifest, sqlByMethodId, signal, driver}) {
  const dispatches = compilePostgresqlWave2ProfileDispatches({profile, structureEvidence, manifest, sqlByMethodId});
  const policy = validatePostgresqlWave2Policy(profile);
  const password = process.env[profile.adapter.passwordEnv];
  if (!password) fail('DB_ANALYZE_CREDENTIAL_MISSING');
  const Pool = await driverPool(driver);
  const pool = new Pool({
    ...buildPostgresqlConnectionOptions(profile, password),
    min: 0,
    max: 1,
    idleTimeoutMillis: 1000,
    allowExitOnIdle: true,
  });
  let client;
  const facts = [];
  try {
    client = await pool.connect();
    await client.query('BEGIN READ ONLY');
    assertPostgresqlReadOnlySession((await client.query(SESSION_PROOF_SQL)).rows);
    for (let index = 0; index < dispatches.length; index += 1) {
      if (signal?.aborted) fail('DB_ANALYZE_CANCELLED');
      const dispatch = dispatches[index];
      const savepoint = `ks_wave2_profile_${index}`;
      await client.query(`SAVEPOINT ${savepoint}`);
      let response;
      try {
        response = await client.query({text: dispatch.statement, values: dispatch.values, signal});
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`).catch(() => {});
        const problemCode = normalizedProblemCode(error);
        fail(problemCode === '57014' ? 'DB_WAVE2_PROFILE_TIMEOUT' : 'DB_WAVE2_PROFILE_QUERY_FAILED', error);
      }
      if (!Array.isArray(response?.rows) || response.rows.length !== 1) fail('DB_WAVE2_PROFILE_RESULT_INVALID');
      const rowCount = parseCount(response.rows[0].row_count);
      const nullCount = parseCount(response.rows[0].null_count);
      const distinctCount = parseCount(response.rows[0].distinct_count);
      if (nullCount > rowCount || distinctCount > rowCount - nullCount) fail('DB_WAVE2_PROFILE_RESULT_INVALID');
      const {statement: _statement, values: _values, ...plan} = dispatch;
      const factBody = normalizeJsonValue({
        factKind: 'COLUMN_PROFILE',
        observationKind: 'OBSERVED',
        claimStatus: 'MEASURED_AGGREGATE',
        target: dispatch.target,
        typeFamily: dispatch.typeFamily,
        metrics: {rowCount, nullCount, distinctCount},
        evidenceRefs: {
          structureSnapshotSha256: structureEvidence.snapshotSha256,
          structureObjectSha256: dispatch.structureObjectSha256,
          templateSha256: dispatch.templateSha256,
          statementSha256: dispatch.statementSha256,
          planSha256: dispatch.planSha256,
        },
        disclosure: {aggregateCountsOnly: true, rowMaterialPersisted: false, distributionsPersisted: false},
      });
      facts.push({...factBody, factSha256: identitySha256(factBody), plan});
    }
    await client.query('COMMIT');
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    if (client) client.release(true);
    await pool.end().catch(() => {});
  }

  facts.sort((left, right) => compare(targetKey(left.target), targetKey(right.target)));
  const coverageEntries = facts.map((fact) => normalizeJsonValue({
    target: fact.target,
    state: 'SUCCEEDED',
    reasonCode: null,
    factSha256: fact.factSha256,
    reviewState: 'REVIEW_REQUIRED',
  }));
  const coverageBody = normalizeJsonValue({
    total: coverageEntries.length,
    stateCounts: {SUCCEEDED: coverageEntries.length, TIMEOUT: 0, ERROR: 0, DENIED: 0},
    allComplete: true,
    entries: coverageEntries,
  });
  const body = normalizeJsonValue({
    schemaVersion: POSTGRESQL_WAVE2_PROFILE_EVIDENCE_SCHEMA,
    engine: 'postgresql',
    runtimeValidation: 'RUNTIME_VALIDATED',
    source: {
      structureSnapshotSha256: structureEvidence.snapshotSha256,
      policySha256: identitySha256(policy),
      methodManifestSha256: identitySha256(manifest),
    },
    coverage: {...coverageBody, coverageSha256: identitySha256(coverageBody)},
    factCount: facts.length,
    facts,
    disclosure: {aggregateCountsOnly: true, rowMaterialPersisted: false, labelsPersisted: false, distributionsPersisted: false},
    blindSpots: [...manifest.blindSpots, 'COUNTS_ABOVE_MAX_SAFE_INTEGER_FAIL_CLOSED'],
  });
  return {...body, profileEvidenceSha256: identitySha256(body)};
}

function assertProfileEvidence(structureEvidence, profileEvidence) {
  if (profileEvidence?.schemaVersion !== POSTGRESQL_WAVE2_PROFILE_EVIDENCE_SCHEMA
    || profileEvidence.runtimeValidation !== 'RUNTIME_VALIDATED'
    || !sha256Value(profileEvidence.profileEvidenceSha256)
    || profileEvidence.source?.structureSnapshotSha256 !== structureEvidence.snapshotSha256
    || !Array.isArray(profileEvidence.facts)
    || profileEvidence.factCount !== profileEvidence.facts.length) fail('DB_WAVE2_PROFILE_EVIDENCE_INVALID');
  const {profileEvidenceSha256, ...body} = profileEvidence;
  if (identitySha256(body) !== profileEvidenceSha256) fail('DB_WAVE2_PROFILE_EVIDENCE_TAMPERED');
  return profileEvidence;
}

const relationshipKey = ({source, target}) => `${targetKey(source)}\u0001${targetKey(target)}`;

export function compilePostgresqlWave2RelationshipDispatches({
  profile, structureEvidence, profileEvidence, manifest, sqlByMethodId,
}) {
  validateAnalyzeProfile(profile);
  const policy = validatePostgresqlWave2Policy(profile);
  assertStructureEvidence(profile, structureEvidence);
  assertProfileEvidence(structureEvidence, profileEvidence);
  validatePostgresqlWave2Manifest(manifest, sqlByMethodId);
  const method = manifest.methods.find(({kind}) => kind === 'RELATIONSHIP_OVERLAP');
  if (!method || canonicalJson(method.outputColumns) !== canonicalJson([
    'source_non_null_count', 'source_distinct_count', 'target_distinct_count', 'matched_distinct_count',
  ]) || method.timeoutMs > policy.budgets.maxQueryTimeoutMs) fail('DB_WAVE2_RELATIONSHIP_METHOD_INVALID');

  const constraints = structureEvidence.extracts.find(({category}) => category === 'constraints')?.rows ?? [];
  const constraintGroups = new Map();
  for (const row of constraints.filter(({constraint_kind: kind}) => ['PRIMARY_KEY', 'UNIQUE'].includes(kind))) {
    const key = `${row.schema_name}\u0000${row.relation_name}\u0000${row.constraint_name}`;
    const group = constraintGroups.get(key) ?? [];
    group.push(row);
    constraintGroups.set(key, group);
  }
  const uniqueTargets = [...constraintGroups.values()]
    .filter((rows) => rows.length === 1 && identifier(rows[0].column_name) && sha256Value(rows[0].objectSha256))
    .map(([row]) => ({
      target: {schemaName: row.schema_name, relationName: row.relation_name, columnName: row.column_name},
      constraintKind: row.constraint_kind,
      constraintName: row.constraint_name,
      constraintObjectSha256: row.objectSha256,
    }));
  const declaredForeignKeys = new Set(constraints
    .filter(({constraint_kind: kind}) => kind === 'FOREIGN_KEY')
    .map((row) => relationshipKey({
      source: {schemaName: row.schema_name, relationName: row.relation_name, columnName: row.column_name},
      target: {
        schemaName: row.referenced_schema_name,
        relationName: row.referenced_relation_name,
        columnName: row.referenced_column_name,
      },
    })));
  const profileByTarget = new Map(profileEvidence.facts.map((fact) => [targetKey(fact.target), fact]));
  const dispatches = [];
  for (const sourceFact of profileEvidence.facts) {
    for (const targetDescriptor of uniqueTargets) {
      const targetFact = profileByTarget.get(targetKey(targetDescriptor.target));
      if (!targetFact
        || targetKey(sourceFact.target) === targetKey(targetDescriptor.target)
        || sourceFact.target.columnName !== targetDescriptor.target.columnName
        || sourceFact.plan?.nativeTypeOid !== targetFact.plan?.nativeTypeOid) continue;
      const pair = {source: sourceFact.target, target: targetDescriptor.target};
      if (declaredForeignKeys.has(relationshipKey(pair))) continue;
      const statement = compileTemplate(sqlByMethodId[method.id], {
        SOURCE_SCHEMA: pair.source.schemaName,
        SOURCE_RELATION: pair.source.relationName,
        SOURCE_COLUMN: pair.source.columnName,
        TARGET_SCHEMA: pair.target.schemaName,
        TARGET_RELATION: pair.target.relationName,
        TARGET_COLUMN: pair.target.columnName,
      });
      const planBody = normalizeJsonValue({
        methodRef: `${method.id}@${method.version}`,
        source: pair.source,
        target: pair.target,
        targetConstraint: {kind: targetDescriptor.constraintKind, name: targetDescriptor.constraintName},
        evidenceRefs: {
          structureSnapshotSha256: structureEvidence.snapshotSha256,
          targetConstraintObjectSha256: targetDescriptor.constraintObjectSha256,
          sourceProfileFactSha256: sourceFact.factSha256,
          targetProfileFactSha256: targetFact.factSha256,
        },
        templateSha256: method.templateSha256,
        statementSha256: sha256(statement),
        timeoutMs: method.timeoutMs,
        outputColumns: method.outputColumns,
        parameterCount: 0,
        readOnly: true,
        aggregateOnly: true,
        proposalOnly: true,
      });
      dispatches.push({...planBody, planSha256: identitySha256(planBody), statement, values: []});
    }
  }
  dispatches.sort((left, right) => compare(relationshipKey(left), relationshipKey(right)));
  if (dispatches.length > policy.budgets.maxRelationshipCandidates
    || profileEvidence.factCount + dispatches.length > policy.budgets.maxQueries) fail('DB_WAVE2_BUDGET_EXCEEDED');
  return dispatches;
}

function buildRelationshipEvaluation({dispatch, row, structureEvidence, profileEvidence, policy}) {
  const sourceNonNullCount = parseCount(row.source_non_null_count);
  const sourceDistinctCount = parseCount(row.source_distinct_count);
  const targetDistinctCount = parseCount(row.target_distinct_count);
  const matchedDistinctCount = parseCount(row.matched_distinct_count);
  if (sourceDistinctCount > sourceNonNullCount || matchedDistinctCount > sourceDistinctCount
    || matchedDistinctCount > targetDistinctCount) fail('DB_WAVE2_RELATIONSHIP_RESULT_INVALID');
  const overlapBasisPoints = sourceDistinctCount === 0 ? 0 : Math.floor((matchedDistinctCount * 10000) / sourceDistinctCount);
  const targetCoverageBasisPoints = targetDistinctCount === 0 ? 0 : Math.floor((matchedDistinctCount * 10000) / targetDistinctCount);
  const eligible = sourceDistinctCount > 0 && overlapBasisPoints >= policy.relationshipCandidates.minimumConfidenceBasisPoints;
  const confidence = !eligible ? 'LOW' : overlapBasisPoints >= 9500 ? 'HIGH' : 'MEDIUM';
  const {statement: _statement, values: _values, ...plan} = dispatch;
  const observationBody = normalizeJsonValue({
    factKind: 'RELATIONSHIP_OVERLAP',
    observationKind: 'OBSERVED',
    claimStatus: 'MEASURED_AGGREGATE',
    source: dispatch.source,
    target: dispatch.target,
    metrics: {sourceNonNullCount, sourceDistinctCount, targetDistinctCount, matchedDistinctCount},
    evidenceRefs: {
      structureSnapshotSha256: structureEvidence.snapshotSha256,
      profileEvidenceSha256: profileEvidence.profileEvidenceSha256,
      sourceProfileFactSha256: dispatch.evidenceRefs.sourceProfileFactSha256,
      targetProfileFactSha256: dispatch.evidenceRefs.targetProfileFactSha256,
      targetConstraintObjectSha256: dispatch.evidenceRefs.targetConstraintObjectSha256,
      templateSha256: dispatch.templateSha256,
      statementSha256: dispatch.statementSha256,
      planSha256: dispatch.planSha256,
    },
    disclosure: {aggregateCountsOnly: true, rowMaterialPersisted: false},
  });
  const observation = {...observationBody, factSha256: identitySha256(observationBody), plan};
  const computationBody = normalizeJsonValue({
    factKind: 'RELATIONSHIP_SCORE',
    observationKind: 'COMPUTED',
    claimStatus: 'DETERMINISTIC_RULE_RESULT',
    source: dispatch.source,
    target: dispatch.target,
    metrics: {overlapBasisPoints, targetCoverageBasisPoints},
    rule: {
      ruleId: 'EXACT_NAME_TYPE_UNIQUE_TARGET_OVERLAP_V1',
      minimumConfidenceBasisPoints: policy.relationshipCandidates.minimumConfidenceBasisPoints,
      nameMatch: 'EXACT_COLUMN_NAME',
      nativeTypeMatch: true,
      singleColumnUniqueTarget: true,
    },
    eligible,
    confidence,
    evidenceRefs: {overlapFactSha256: observation.factSha256},
  });
  const computation = {...computationBody, factSha256: identitySha256(computationBody)};
  let candidate;
  if (eligible) {
    const candidateBody = normalizeJsonValue({
      factKind: 'RELATIONSHIP_CANDIDATE',
      observationKind: 'INFERRED',
      claimStatus: 'PROPOSAL_ONLY',
      reviewState: 'REVIEW_REQUIRED',
      executionAuthority: 'NONE',
      source: dispatch.source,
      target: dispatch.target,
      relationshipKind: 'FOREIGN_KEY_CANDIDATE',
      confidence,
      confidenceBasisPoints: overlapBasisPoints,
      evidenceRefs: {
        overlapFactSha256: observation.factSha256,
        computationFactSha256: computation.factSha256,
        sourceProfileFactSha256: dispatch.evidenceRefs.sourceProfileFactSha256,
        targetProfileFactSha256: dispatch.evidenceRefs.targetProfileFactSha256,
        targetConstraintObjectSha256: dispatch.evidenceRefs.targetConstraintObjectSha256,
      },
      limitations: [
        'AGGREGATE_EQUALITY_OVERLAP_ONLY',
        'CURRENT_LOCAL_SNAPSHOT_ONLY',
        'NULL_SOURCE_VALUES_EXCLUDED',
        'SEMANTIC_RELATIONSHIP_NOT_ESTABLISHED',
        'SINGLE_COLUMN_DECLARED_PK_OR_UNIQUE_TARGET_ONLY',
      ],
    });
    candidate = {...candidateBody, candidateSha256: identitySha256(candidateBody)};
  }
  return {observation, computation, candidate};
}

export async function runPostgresqlWave2Relationships({
  profile, structureEvidence, profileEvidence, manifest, sqlByMethodId, signal, driver,
}) {
  const dispatches = compilePostgresqlWave2RelationshipDispatches({
    profile, structureEvidence, profileEvidence, manifest, sqlByMethodId,
  });
  const policy = validatePostgresqlWave2Policy(profile);
  const password = process.env[profile.adapter.passwordEnv];
  if (!password) fail('DB_ANALYZE_CREDENTIAL_MISSING');
  const Pool = await driverPool(driver);
  const pool = new Pool({
    ...buildPostgresqlConnectionOptions(profile, password),
    min: 0,
    max: 1,
    idleTimeoutMillis: 1000,
    allowExitOnIdle: true,
  });
  let client;
  const evaluations = [];
  try {
    client = await pool.connect();
    await client.query('BEGIN READ ONLY');
    assertPostgresqlReadOnlySession((await client.query(SESSION_PROOF_SQL)).rows);
    for (let index = 0; index < dispatches.length; index += 1) {
      if (signal?.aborted) fail('DB_ANALYZE_CANCELLED');
      const dispatch = dispatches[index];
      const savepoint = `ks_wave2_relationship_${index}`;
      await client.query(`SAVEPOINT ${savepoint}`);
      let response;
      try {
        response = await client.query({text: dispatch.statement, values: dispatch.values, signal});
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`).catch(() => {});
        const problemCode = normalizedProblemCode(error);
        fail(problemCode === '57014' ? 'DB_WAVE2_RELATIONSHIP_TIMEOUT' : 'DB_WAVE2_RELATIONSHIP_QUERY_FAILED', error);
      }
      if (!Array.isArray(response?.rows) || response.rows.length !== 1) fail('DB_WAVE2_RELATIONSHIP_RESULT_INVALID');
      evaluations.push(buildRelationshipEvaluation({
        dispatch, row: response.rows[0], structureEvidence, profileEvidence, policy,
      }));
    }
    await client.query('COMMIT');
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    if (client) client.release(true);
    await pool.end().catch(() => {});
  }

  const observations = evaluations.map(({observation}) => observation);
  const computations = evaluations.map(({computation}) => computation);
  const candidates = evaluations.flatMap(({candidate}) => candidate === undefined ? [] : [candidate]);
  const coverageEntries = observations.map((observation) => normalizeJsonValue({
    source: observation.source,
    target: observation.target,
    state: 'SUCCEEDED',
    reasonCode: null,
    observationFactSha256: observation.factSha256,
  }));
  const coverageBody = normalizeJsonValue({
    total: coverageEntries.length,
    stateCounts: {SUCCEEDED: coverageEntries.length, TIMEOUT: 0, ERROR: 0, DENIED: 0},
    allComplete: true,
    entries: coverageEntries,
  });
  const body = normalizeJsonValue({
    schemaVersion: POSTGRESQL_WAVE2_RELATIONSHIP_EVIDENCE_SCHEMA,
    engine: 'postgresql',
    runtimeValidation: 'RUNTIME_VALIDATED',
    source: {
      structureSnapshotSha256: structureEvidence.snapshotSha256,
      profileEvidenceSha256: profileEvidence.profileEvidenceSha256,
      policySha256: identitySha256(policy),
      methodManifestSha256: identitySha256(manifest),
    },
    coverage: {...coverageBody, coverageSha256: identitySha256(coverageBody)},
    summary: {
      evaluatedPairCount: evaluations.length,
      eligibleCandidateCount: candidates.length,
      lowConfidenceRejectedCount: computations.filter(({eligible}) => !eligible).length,
      declaredForeignKeysExcluded: true,
    },
    observations,
    computations,
    candidates,
    authority: {proposalOnly: true, executionAuthority: 'NONE', mutationAuthority: 'NONE'},
    blindSpots: [
      'COMPOSITE_AND_EXPRESSION_KEYS_NOT_EVALUATED',
      'EXACT_COLUMN_NAME_MATCH_ONLY',
      'NO_SEMANTIC_RELATIONSHIP_CLAIM',
      'SINGLE_LOCAL_SNAPSHOT',
    ],
  });
  return {...body, relationshipEvidenceSha256: identitySha256(body)};
}

export function buildPostgresqlWave2RulePlan({profileEvidence, relationshipEvidence}) {
  if (profileEvidence?.schemaVersion !== POSTGRESQL_WAVE2_PROFILE_EVIDENCE_SCHEMA
    || relationshipEvidence?.schemaVersion !== POSTGRESQL_WAVE2_RELATIONSHIP_EVIDENCE_SCHEMA
    || !sha256Value(profileEvidence.profileEvidenceSha256)
    || !sha256Value(relationshipEvidence.relationshipEvidenceSha256)) fail('DB_WAVE2_PLAN_SOURCE_INVALID');
  const {profileEvidenceSha256, ...profileBody} = profileEvidence;
  const {relationshipEvidenceSha256, ...relationshipBody} = relationshipEvidence;
  if (identitySha256(profileBody) !== profileEvidenceSha256
    || identitySha256(relationshipBody) !== relationshipEvidenceSha256
    || relationshipEvidence.source.profileEvidenceSha256 !== profileEvidenceSha256) fail('DB_WAVE2_PLAN_SOURCE_TAMPERED');
  const known = new Set([
    ...profileEvidence.facts.map(({factSha256}) => factSha256),
    ...relationshipEvidence.observations.map(({factSha256}) => factSha256),
    ...relationshipEvidence.computations.map(({factSha256}) => factSha256),
    ...relationshipEvidence.candidates.map(({candidateSha256}) => candidateSha256),
  ]);
  const steps = [];
  for (const fact of profileEvidence.facts) {
    const stepBody = normalizeJsonValue({
      action: 'REVIEW_COLUMN_PROFILE',
      target: fact.target,
      evidenceRefs: [fact.factSha256],
      reviewState: 'REVIEW_REQUIRED',
      executionAuthority: 'NONE',
      mutationAuthority: 'NONE',
    });
    steps.push({...stepBody, stepSha256: identitySha256(stepBody)});
  }
  for (const candidate of relationshipEvidence.candidates) {
    const evidenceRefs = [candidate.candidateSha256, ...Object.values(candidate.evidenceRefs)].sort();
    if (evidenceRefs.some((ref) => !known.has(ref) && ref !== candidate.evidenceRefs.targetConstraintObjectSha256)) {
      fail('DB_WAVE2_PLAN_EVIDENCE_REF_MISSING');
    }
    const stepBody = normalizeJsonValue({
      action: 'REVIEW_RELATIONSHIP_CANDIDATE',
      source: candidate.source,
      target: candidate.target,
      confidence: candidate.confidence,
      evidenceRefs,
      reviewState: 'REVIEW_REQUIRED',
      executionAuthority: 'NONE',
      mutationAuthority: 'NONE',
    });
    steps.push({...stepBody, stepSha256: identitySha256(stepBody)});
  }
  steps.sort((left, right) => compare(`${left.action}\u0000${left.stepSha256}`, `${right.action}\u0000${right.stepSha256}`));
  const body = normalizeJsonValue({
    schemaVersion: POSTGRESQL_WAVE2_RULE_PLAN_SCHEMA,
    plannerRef: 'KALEIDOSPHERE_RULE_BASED@1.0.0',
    source: {profileEvidenceSha256, relationshipEvidenceSha256},
    stepCount: steps.length,
    steps,
    authority: {proposalOnly: true, executionAuthority: 'NONE', mutationAuthority: 'NONE'},
  });
  return {...body, planSha256: identitySha256(body)};
}
