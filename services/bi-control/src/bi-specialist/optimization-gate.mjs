import { createHash } from 'node:crypto';

const sha256 = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

export function immutableGeneration({ id, policyVersion, promptVersion, model, sampling, results }) {
  const generation = structuredClone({ id, policyVersion, promptVersion, model, sampling, results });
  const manifestDigest = sha256(JSON.stringify(generation));
  return deepFreeze({ ...generation, manifestDigest });
}

export function scoreGeneration(generation) {
  const cases = generation.results;
  const total = cases.length || 1;
  const sums = cases.reduce((acc, item) => {
    acc.hardFailures += item.hardFailures?.length ?? 0;
    acc.discovery += item.discoveryScore ?? 0;
    acc.oracle += item.oracleScore ?? 0;
    acc.citation += item.citationScore ?? 0;
    acc.tool += item.toolCorrectness ?? 0;
    acc.privacy += item.privacySafe === true ? 1 : 0;
    acc.safety += item.safetyGreen === true ? 1 : 0;
    return acc;
  }, { hardFailures: 0, discovery: 0, oracle: 0, citation: 0, tool: 0, privacy: 0, safety: 0 });
  return {
    hardFailures: sums.hardFailures,
    discovery: sums.discovery / total,
    oracle: sums.oracle / total,
    citation: sums.citation / total,
    tool: sums.tool / total,
    privacy: sums.privacy / total,
    safety: sums.safety / total,
  };
}

export function selectCandidate({ incumbent, candidate }) {
  const baseline = scoreGeneration(incumbent);
  const proposed = scoreGeneration(candidate);
  const dimensions = ['discovery', 'oracle', 'citation', 'tool', 'privacy', 'safety'];
  const regressions = dimensions.filter((key) => proposed[key] + 1e-12 < baseline[key]);
  const hardFailureGate = proposed.hardFailures === 0 && proposed.hardFailures <= baseline.hardFailures;
  const accepted = hardFailureGate && proposed.privacy === 1 && proposed.safety === 1 && regressions.length === 0;
  return {
    accepted,
    selectedGenerationId: accepted ? candidate.id : incumbent.id,
    incumbent: baseline,
    candidate: proposed,
    regressions,
    negativeEvidence: accepted ? [] : [
      ...(hardFailureGate ? [] : ['NEW_OR_RETAINED_HARD_FAILURE']),
      ...regressions.map((dimension) => `REGRESSION:${dimension}`),
    ],
    rollback: `restore-generation:${incumbent.id}`,
  };
}

export function stabilitySummary(runs) {
  const digests = runs.map((run) => sha256(JSON.stringify(run.observable ?? run)));
  const distinct = new Set(digests).size;
  return { runs: runs.length, distinctObservableDigests: distinct, fixedSeedStable: distinct === 1, digests };
}
