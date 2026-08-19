# Safe-analysis method parity evidence

Issue: #38. Evidence source: local deterministic synthetic MSSQL/Oracle facts
only; no live, production or customer database was contacted.

## Acceptance matrix

- 4/4 semantic methods exist for both engines and all eight templates pass the
  content-hash, typed-marker, bounded-source and SELECT-only audit.
- Equivalent column and relationship fixture facts produce matching cross-engine
  semantic SHA-256 values; engine envelopes intentionally differ. The sealed
  column-summary semantic hash is
  `7326606979f062c71dd47241583b9c1c0db601240e3c66c8d4b4576328516a8d`;
  relationship-overlap is
  `2be97c8d59d2ca446ab87ceed1dd1d7313809417a08f29be111ef55dc2d9cf28`.
- Relationship reservations debit two #36 object counters and one #37 source
  table plus hypothesis counter before the read-only session is invoked.
- Evidence separates `OBSERVED`, `COMPUTED`, `INFERRED/PROPOSAL_ONLY` and
  counterevidence. Negative uniqueness/overlap evidence produces no proposal.
- Aggregate output is exactly one row. Raw/sample/example/credential-shaped
  output is rejected.
- `DENIED`, `UNSUPPORTED`, `PARTIAL`, timeout/cancel and unknown outcomes retain
  explicit state and `NOT_CLAIMED` absence semantics.
- 21 fail-closed negative probes cover free SQL, DDL pack forgery, manifest
  tamper, scope/identifier escape, row caps, type capability, inconsistent
  counts, raw/sample/example/credential output, non-read-only/credential-bearing
  sessions, timeout, Oracle Boolean unsupported, misleading relationship
  promotion, pair-object overspend and stale #37 reservation CAS.

## Commands

```text
npm run test:safe-analysis-parity
npm run test:progressive-controller
npm run test:progressive-analysis
npm test
npm run test:source
node scripts/build-release.mjs <isolated-output>
```

The terminal delivery report records exact test counts, semantic hashes, source
map readback, PR/head/main CI, merge and release identifiers. A release decision
is required after protected merge; merge alone is not a release claim.

## Boundaries

The query packs cap inspected source rows but do not claim deterministic row
ordering, whole-table completeness or performance. Temporal extrema are bounded
aggregates, not universal freshness semantics. Key and relationship candidates
remain review-only proposals. No source row, label distribution, example,
credential, free SQL, write, automatic FK, production/customer access,
deployment or certification is included.
