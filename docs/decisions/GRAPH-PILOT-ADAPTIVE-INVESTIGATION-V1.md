# Graph Pilot Adaptive Investigation v1

Status: accepted locally
Date: 2026-08-15
Base: `626fb43f7a8a684527db8921fa757e6bc195388d`

## Decision

Add a framework-neutral adaptive BI investigation graph for BI-G3 through BI-G5 and a sealed BI-G6 comparison against the static v0 incumbent.

The v1 graph stays local, synthetic, read-only, and review-only. It does not add a graph runtime dependency and does not use a live model for this slice. The model-owned hypothesis node is represented as an offline deterministic candidate so the graph contract, privacy boundary, sealed scoring, and incumbent-selection policy can be tested without touching OpenClaw, Qwen, vLLM, Advisor, Superset, staging, production, or customer data.

## Scope

- G2: versioned adaptive contracts under `contracts/bi-adaptive-investigation-graph/v1/`.
- G3: deterministic anomaly/profile ledger for missingness, nulls, outliers, format noise, corruption signals, and grain conflicts.
- G4: unknown-domain hypothesis graph with uncertainty, alternatives, contradiction evidence, and citation/grain gates.
- G5: allowlist-only targeted probes bounded by per-case and global budgets.
- G6: application-first sealed comparison between static v0-style incumbent and adaptive v1 candidate on a new easy/medium/hard curriculum.
- G7: terminal evidence pack, source-map hashes, tests, scans, commit, replay, teardown, and cron removal.

## Evidence

- Terminal manifest: `docs/evidence/graph-adaptive-v1/terminal-manifest.json`
- Terminal state: `docs/evidence/graph-adaptive-v1/terminal-state.json`
- Candidate freeze: `docs/evidence/graph-adaptive-v1/candidate-freeze.json`
- Graph renders: `docs/evidence/graph-adaptive-v1/adaptive-investigation-v1.mmd`, `docs/evidence/graph-adaptive-v1/adaptive-investigation-v1.dot`
- Sealed packs: `services/bi-control/fixtures/graph-adaptive-v1/sealed-neutral-packs.json`

## Acceptance Summary

- Verdict: `ACCEPTED`
- Deterministic replay: `1`
- Hard-tier exactness gain: `1`
- Review ambiguity reduction: `0.875`
- Candidate probes: `4`
- Additional probe rate: `0.2`
- Source rows persisted: `0`
- Sample values persisted: `0`
- Mutations: `0`
- Safety/privacy/mutation hard failures: `0`

## Nonclaims

- No live Qwen or hosted model quality claim.
- No production, staging, customer data, or real Superset evidence.
- No persistent Superset mutation, push, PR, release, or deployment.
- Synthetic aggregate profile summaries do not prove raw-row completeness.
- The v1 graph contract does not choose or require a final graph framework.

## Rollback

Remove the local branch/worktree artifacts for v1. The v0 incumbent on `graph-pilot-discovery-readiness-v0` remains untouched and accepted.
