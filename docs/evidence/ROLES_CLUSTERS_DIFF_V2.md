# Roles, clusters and extended evidence diff v2 evidence

Issue: #39. Evidence source: local deterministic synthetic MSSQL/Oracle inputs
composed through the public-main #36 controller, #37 progressive-analysis and
#38 safe-method contracts. No production or customer database was contacted.

## Acceptance evidence

- 5/5 focused tests cover deterministic restart, exact fixture hashes,
  cross-engine equivalence, counterevidence-only non-promotion, removal versus
  visibility loss, and fail-closed boundaries.
- The complete repository suite passes 239/239 after the final restart-validator
  hardening; the dedicated Source Map gate passes 1/1 and Security passes 7/7.
- Identical MSSQL fixtures repeat the exact snapshot SHA-256
  `222160e3738ee6adec8aaf4f16023bb104557bc3d8b3142953bb0af75a6f55d9`.
- Equivalent Oracle evidence retains an engine-specific snapshot SHA-256
  `c4c21028f4f5d55025cb5dc37f240672933f07f4bfa2687e550c96293a473d42`
  while sharing semantic projection SHA-256
  `dabe86ed1abfbfde24c95b80311c11e1685897ee85df2437e66ff9a278258d3c`.
- The supported two-table connected component is content-addressed as
  `991dedc810755a58d8d8f4b9f04b86948904e900f5b7267a67d169fc92c5bbe4`.
- Observed-removal diff SHA-256 is
  `80b6f08852a5a311128d55b2ade54fc14d25b991461ad8eded0d125fd560a018`;
  denied-visibility diff SHA-256 is
  `0c8337919e124fef02fde4be830158fedcacd8641a574c3b7357109fd8a2e3a2`.
- A deliberately misleading relationship result retains duplicate-target and
  unmatched-source counterevidence, emits no relationship-link role, and leaves
  both tables in separate clusters.
- Eleven fail-closed probes cover snapshot tamper, widened safety flags, invalid
  confidence bounds, diff safety tamper, stale ancestry, scope drift,
  unsupported versions, credential/raw-value fields, foreign controller
  binding, and a non-terminal controller phase.

## Commands

```text
npm run test:roles-clusters-diff
npm run test:progressive-controller
npm run test:progressive-analysis
npm run test:safe-analysis-parity
npm test
npm run test:source
npm run test:security
node scripts/build-release.mjs <isolated-output>
```

The terminal local delivery dossier records the exact candidate commit, complete
suite count, archive digest, source-map check, diff check and secret scan.

## Boundaries

The evidence is synthetic and local. Role labels and clusters are review-only
technical proposals, not organizational roles, a domain model, causal clusters,
automatic foreign keys or business truth. Visibility loss never proves
deletion. No source rows, raw/example values, credentials, customer system,
production performance, deployment, release or external publication is claimed.
