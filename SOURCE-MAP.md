# Source map

Source repository (read-only):
[`JimPansky/ChimpMaera`](https://github.com/JimPansky/ChimpMaera)
at commit `cee9fd5835ac3527af54b5974b5d53414eac88d8`.

The M1 Oracle query pack was read-only sourced from the same public repository
at commit `7a483ad9db76f6233b166874447693d28e8ac942`. The local reproduction was
verified at that exact commit before copying; ChimpMaera was not mutated.

The M0 baseline was mechanically copied byte-for-byte as recorded by its source
hashes; files changed for M1 are explicitly listed under `derivedFiles`. M2
extends the Oracle pack with CM-authored technical-inventory SELECTs. M3 adds
repository-authored catalog, agent, Superset, tests, and evidence files with
updated file hashes:

- `LICENSE` → `LICENSE`
- `NOTICE` → `NOTICE`
- `THIRD_PARTY_NOTICES.md` → `THIRD_PARTY_NOTICES.md`
- M3 authored repository files such as `README.md`, `package.json`, `bin/bi`,
  `services/bi-control/src/catalog.mjs`, `services/bi-control/src/server.mjs`,
  `services/bi-agent/src/server.mjs`, `services/superset/runtime/materialize.py`,
  `tests/catalog.test.mjs`, `tests/smoke.sh`, and
  `docs/evidence/M3_LOCAL_TECHNICAL_CATALOG.md`
- `packages/contracts/src/canonical-json.js` →
  `services/bi-control/src/canonical-json.js`
- `scripts/lib/db-analyzer/*.mjs` →
  `services/bi-control/src/db-analyzer/*.mjs`
- `query-packs/db-analyzer/v1/mssql/*` →
  `services/bi-control/query-packs/db-analyzer/v1/mssql/*`
- the Oracle `manifest.json`, identity preflight, seven M1 structure SELECTs,
  and M2 technical-inventory SELECTs →
  `services/bi-control/query-packs/db-analyzer/v1/oracle/*`

The copied analyzer is invoked with an explicit standalone `repositoryRoot`.
M1 derives the analyzer core, query-safety allowlist, and workflow for the Oracle
Thin runtime. It derives the identity preflight for the Oracle AI Database product
name and `oracle/preflight-rights.sql` to detect system,
direct-object, and enabled-role object privileges before structure discovery.
`SOURCE-MAP.json` records repository SHA-256 values plus the original SHA-256 and
change marker for each derived file. M2/M3 query-pack and catalog additions
collect only technical metadata: comments/source/error text are hash-only,
DB-link hosts are hash-only, scheduler action text is omitted, and catalog Q&A is
answered from local safe projections only. New Compose, control, catalog,
Superset materializer, agent UI, tests, and documentation were authored
specifically for this repository.
