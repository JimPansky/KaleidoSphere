# Source map

Source repository (read-only):
[`JimPansky/ChimpMaera`](https://github.com/JimPansky/ChimpMaera)
at commit `cee9fd5835ac3527af54b5974b5d53414eac88d8`.

Mechanically copied, byte-for-byte:

- `LICENSE` → `LICENSE`
- `NOTICE` → `NOTICE`
- `THIRD_PARTY_NOTICES.md` → `THIRD_PARTY_NOTICES.md`
- `packages/contracts/src/canonical-json.js` →
  `services/bi-control/src/canonical-json.js`
- `scripts/lib/db-analyzer/*.mjs` →
  `services/bi-control/src/db-analyzer/*.mjs`
- `query-packs/db-analyzer/v1/mssql/*` →
  `services/bi-control/query-packs/db-analyzer/v1/mssql/*`

The copied analyzer is invoked with an explicit standalone `repositoryRoot`.
Oracle bytes were intentionally not copied: M0 supports only the real MSSQL
path. New Compose, control, Superset materializer, agent UI, fixtures, tests,
and documentation were authored specifically for this standalone repository.
`SOURCE-MAP.json` records the per-file SHA-256 inventory.
