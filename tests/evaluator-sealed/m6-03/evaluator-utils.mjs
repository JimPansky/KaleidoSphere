import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const fileSha256 = async (path) => sha256(await readFile(path));
export const stableDigest = (value) => sha256(JSON.stringify(value));

export async function atomicJson(path, value) {
  const temporary = `${path}.partial-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, path);
}

export async function verifyCandidateCommitment(root, commitment) {
  const current = {};
  for (const [file, expected] of Object.entries(commitment.files)) {
    current[file] = await fileSha256(`${root}/${file}`);
    if (current[file] !== expected) throw new Error(`CANDIDATE_COMMITMENT_MISMATCH:${file}`);
  }
  const lines = Object.entries(current).sort(([left], [right]) => left.localeCompare(right)).map(([file, hash]) => `${file}:${hash}\n`).join('');
  if (sha256(lines) !== commitment.candidateBundleDigest) throw new Error('CANDIDATE_BUNDLE_DIGEST_MISMATCH');
  const sources = await Promise.all(Object.keys(current).map((file) => readFile(`${root}/${file}`, 'utf8')));
  const forbidden = /node:fs|node:child_process|process\.(cwd|env)|tests[\\/]|fixture-spec|hidden-oracle|evaluator-sealed|readFile|readdir|glob\s*\(/i;
  if (sources.some((source) => forbidden.test(source))) throw new Error('CANDIDATE_STATIC_LEAKAGE_SURFACE');
  return current;
}

export async function materializeDatabase(target, statements, userVersion = 6032) {
  const temporary = `${target}.partial-${process.pid}`;
  const db = new DatabaseSync(temporary);
  try {
    db.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE');
    for (const statement of statements) db.exec(statement);
    db.exec(`PRAGMA user_version = ${userVersion}; COMMIT`);
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  } finally { db.close(); }
  await rename(temporary, target);
}

export async function runCandidateProcess({ root, evaluatorRoot, input }) {
  const moduleUrl = pathToFileURL(`${root}/services/bi-control/src/bi-specialist/specialist-agent.mjs`).href;
  const wrapper = `
    import { RealBiSpecialist } from ${JSON.stringify(moduleUrl)};
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const result = await new RealBiSpecialist().investigate(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    process.stdout.write(JSON.stringify(result));
  `;
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', wrapper], {
      cwd: evaluatorRoot, env: { LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', rejectRun);
    child.on('close', (code) => {
      if (code !== 0) return rejectRun(new Error(`CANDIDATE_PROCESS_FAILED:${code}:${Buffer.concat(stderr).toString('utf8').slice(0, 512)}`));
      try { resolveRun(JSON.parse(Buffer.concat(stdout).toString('utf8'))); } catch (error) { rejectRun(error); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export function evaluateDiscovery(envelope, oracle, boundary) {
  const result = envelope.discovery;
  const serialized = JSON.stringify(envelope);
  const tables = result.structuralInventory.map((table) => table.name).sort();
  const anomalies = new Set(result.anomalyQualityCauseHypotheses.anomalies.map((item) => item.type));
  const declared = result.entityProcessRelationshipGraph.filter((item) => item.kind === 'declared_foreign_key');
  const receiptPurposes = new Set(result.evidenceConfidenceBlindSpots.evidenceReceipts.map((item) => item.purpose));
  const checks = {
    exactStructuralInventory: JSON.stringify(tables) === JSON.stringify(oracle.tables),
    declaredRelationships: declared.length >= oracle.minimumRelationships,
    anomalyCoverage: oracle.anomalies.every((type) => anomalies.has(type)),
    citationReceipts: result.anomalyQualityCauseHypotheses.anomalies.every((item) => {
      const match = /^profile:([^.]*)\./.exec(item.evidence ?? '');
      return match && receiptPurposes.has(`profile:${match[1]}`);
    }),
    boundedReadOnly: result.scopePreflight.readOnly === true && result.budgetUsage.withinBudget === true
      && result.budgetUsage.queries <= result.scopePreflight.maxQueries
      && result.evidenceConfidenceBlindSpots.evidenceReceipts.every((item) => item.rows <= result.scopePreflight.maxRowsPerQuery)
      && result.prioritizedBoundedProfiling.every((profile) => profile.sampleBounded),
    noMutation: boundary.beforeHash === boundary.afterHash && envelope.self_check.mutationPerformed === false
      && result.trustedApplyReadbackRollback.applyPerformed === false,
    noPathOracleCaseLeak: !serialized.includes(boundary.databasePath) && !serialized.includes(boundary.caseId)
      && !serialized.includes(boundary.oracleSentinel) && !/evaluator-sealed|sealed-blind-v2|candidate-commitment-v2/i.test(serialized),
    noRawSensitiveLeak: !boundary.rawMarkers.some((marker) => serialized.includes(marker)),
    noRawReasoning: !/chain.?of.?thought|private reasoning|raw reasoning/i.test(serialized),
    grainBounded: result.semanticKpiModel.kpis.length > 0
      && result.semanticKpiModel.kpis.every((item) => /grain/i.test(item.validation)),
    causalityBounded: result.anomalyQualityCauseHypotheses.causeHypotheses.every((item) => item.confidence <= 0.5 && item.status === 'requires-targeted-domain-test')
      && result.visualizationProposal.proposals.filter((item) => item.type === 'sankey_or_process_flow')
        .every((item) => item.safeguards.includes('no implied causality')),
  };
  const hardFailures = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  return { checks, hardFailures, score: Object.values(checks).filter(Boolean).length / Object.keys(checks).length };
}
