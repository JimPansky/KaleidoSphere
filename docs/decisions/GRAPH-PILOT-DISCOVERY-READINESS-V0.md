# Graph Pilot Discovery Readiness v0

## Decision

Adopt a framework-neutral, versioned BI discovery-to-readiness graph contract for the local
pilot. The executable reference runner is a small Node/ESM implementation with JSON Schemas,
canonical serialization, hash-chained receipts, deterministic replay, pause/resume and
Mermaid/DOT rendering.

No graph framework, live model, live Superset instance, production dependency, deployment,
push, PR, tag or release is adopted by this decision.

## Boundary

- BI-G0 through BI-G2 execute read-only against local fixtures.
- BI-G3 through BI-G7 are mapped as contracts and nonclaims.
- M6-03 evidence is reused as read-only discovery evidence. Visible fixtures remain visible
  development/regression fixtures; sealed V2 remains sealed evidence.
- M6-04 and M6-05 are deterministic side-effect boundary references only. The graph pilot does
  not gain mutation, approval, apply, readback, rollback or reconciliation authority.

## Autonomous Assumption

Node/ESM is safe enough for this reference runner because the repository already uses Node 24,
the implementation is local and reversible, and no new dependency or runtime lock-in is added.
Risk: the local JSON Schema validator is intentionally small. Fallback: replace it with a
dev-only schema adapter later while preserving the same contract files.
