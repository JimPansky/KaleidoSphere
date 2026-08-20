# Proposal-only roles, clusters and extended evidence diff v2

Status: accepted local candidate for Issue #39; external delivery remains gated.

## Decision

Issue #39 is implemented as a deterministic projection over the sealed Issue
#37 `REPORT` state and Issue #38 safe-method evidence. The projection does not
dispatch probes. Every accepted evidence item must retain its exact controller
probe key, reservation, outcome, receipt state, engine and scope binding.

The snapshot exposes six independently diffable surfaces: coverage, safe
profiles, relationship candidates, hypotheses, role proposals and structural
clusters. It emits only these closed role kinds:

- `KEY_CANDIDATE`;
- `TEMPORAL_AXIS_CANDIDATE`;
- `QUALITY_REVIEW_CANDIDATE`;
- `RELATIONSHIP_LINK_CANDIDATE`.

All roles are `proposalOnly: true` and `automaticBusinessTruth: false`.
Clusters are deterministic connected components over supported relationship
proposals, not learned, causal or organizational groupings. Counterevidence-only
relationships cannot create link roles or merge components.

An engine-neutral semantic projection has its own SHA-256. The containing
snapshot retains the engine and explicit engine-difference notes, so equivalent
MSSQL and Oracle evidence can be compared without pretending their envelopes
are byte-identical.

## Diff semantics

The extended diff requires the exact prior snapshot hash, a greater ordinal,
and identical scope and engine. Structural disappearance is `REMOVED` only when
the current source query succeeded with complete visibility. `DENIED`,
`UNSUPPORTED` and unknown visibility remain `VISIBILITY_LOSS`; missing safe
evidence for a still-visible target is `EVIDENCE_NOT_REOBSERVED`. None is
converted to deletion.

Each surface retains stable IDs, before/after hashes, a classification, semantic
meaning and reason code. Support evidence, counterevidence and source receipt
references stay explicit. Raw values, source rows, credentials, free SQL,
automatic foreign keys and automatic semantic promotion remain outside the
contract. Restart validators re-check closed keys, nested hashes, bounds,
non-claims and safety flags instead of trusting a recomputed outer digest.

## Conservative assumptions and rollback

The conservative local assumption is that connected components are useful only
as review navigation. Risk: consumers could over-read a proposal as a domain or
causal model. Mitigation: closed labels, explicit non-claims, negative fixtures,
and no mutation/export authority. Review marker: validate names and thresholds
before any protected merge. Rollback is a successor commit that removes this
projection module and its documentation; the #36-#38 state and evidence formats
remain unchanged.

## Rejected alternatives

- Automatic key, relationship or business-role promotion: bounded aggregate
  evidence is not semantic truth.
- Treating a denied or unsupported current query as deletion: loss of
  visibility is not observed removal.
- Cross-engine or cross-scope diffs: the contracts and visibility domains are
  not interchangeable.
- Graph/ML clustering: it would introduce opaque thresholds and unsupported
  causal or domain implications.

No production/customer access, performance claim, deployment, release or
external Issue/PR mutation is part of this local decision.
