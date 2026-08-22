# Source map

Source repository (read-only):
[`JimPansky/ChimpMaera`](https://github.com/JimPansky/ChimpMaera)
at commit `cee9fd5835ac3527af54b5974b5d53414eac88d8`.

The M1 Oracle query pack was read-only sourced from the same public repository
at commit `7a483ad9db76f6233b166874447693d28e8ac942`. The local reproduction was
verified at that exact commit before copying; ChimpMaera was not mutated.
M5 does not copy new ChimpMaera code. The Superset fingerprint and promotion
bundle contracts, collector/builder/inspector, fail-closed gates, tests, and
evidence documentation are repository-authored for this public
KaleidoSphere release slice. The product
README refresh and Architecture, Configuration, Security, and Roadmap documents
are also repository-authored documentation.

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
- M5 authored repository files such as
  `services/bi-control/src/superset-fingerprint.mjs`,
  `services/bi-control/src/promotion-bundle.mjs`,
  `services/bi-control/src/promotion-cli.mjs`,
  `contracts/superset-promotion-bundle/v1/*`,
  `services/bi-control/fixtures/superset-fingerprint-runtime-v1.json`,
  `tests/superset-fingerprint.test.mjs`,
  `tests/promotion-bundle.test.mjs`,
  `docs/evidence/M5_SUPERSET_FINGERPRINT.md`, and
  `docs/evidence/M5_PROMOTION_BUNDLE.md`
- product documentation such as `docs/ARCHITECTURE.md`,
  `docs/CONFIGURATION.md`, `docs/SECURITY.md`, and `docs/ROADMAP.md`
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
Superset materializer, fingerprint, review-bundle, agent UI, tests, and documentation were
authored specifically for this repository.

The external capability-manifest v1 schema, runtime projection/validator,
additive read-only endpoint, and focused fail-closed tests are repository-authored
clean-room work. They project the existing External API v2 attestation and do
not copy code from the M0 reference repositories. The incumbent
`/v2/capabilities` and `/v2/intents` contracts remain unchanged.

M6-00 contract schemas, four assistant-foundation runtime modules, deterministic
fixtures, tests, ADR, evidence, and documentation updates are repository-authored
clean-room work. DeepSeek Harness commit
`47f943859bef60e4160492346772ded9b24f765a` and the exact architecture-note
paths listed in `docs/decisions/M6-00-CONTRACT-SECURITY-FOUNDATION.md` are
conceptual references only. No DSH/Cordis runtime, package, schema, artifact, or
code was copied. These files are recorded as ordinary repository-authored hashes
under `files` in `SOURCE-MAP.json`, not as derived files.

M6-01 visual-scenario-lab code, the wholly synthetic Northstar Components oracle
and portable seed, deterministic scenario engine, loopback shell/server, browser
evidence runner, tests, ADR, visual review, screenshots, and evidence report are
repository-authored clean-room work. Playwright Core and Chromium were used only
as preinstalled test tooling and are not copied or redistributed. The embedded
shell does not contain Apache Superset source or assets and makes no live-Superset
claim. M6-01 files are ordinary repository-authored hashes under `files`, not
derived files.

M6-02 native-Superset bridge code, capability matrix, deterministic projection
materializer, public REST API adapter, live evidence runners, direct pixel
review, screenshots, and evidence manifests are repository-authored clean-room
work against an isolated loopback Apache Superset 6.1.0 stack. The bridge uses
only supported public REST endpoints and deterministic synthetic data. It does
not copy Apache Superset source or assets, does not use source credentials, and
does not claim unsupported native UI actions.

M6-03 real-BI-specialist adapter/core, progressive read-only discovery, task-adaptive
planning/sampling policy, incumbent-selection gate, visible synthetic SQLite development corpus,
process-separated sealed evaluator packs and commitments, local Qwen conformance/evaluation
scripts, tests, decision record and evidence manifests are repository-authored clean-room work.
The first sealed result is retained as negative evidence; blind credit comes only from a wholly
new pack authored after the corrected candidate commitment. They use built-in Node facilities
and an externally installed local llama.cpp/Qwen runtime only for isolated evaluation; no
llama.cpp, Qwen, DeepSeek Harness, Hermes or OpenClaw runtime code/artifact is copied or
redistributed. M6-03 files are ordinary repository-authored hashes under `files`, not derived
files.

M6-04 trusted-workflow compiler, reviewed Superset executor, deterministic approval and
reconciliation boundaries, disposable-stack evidence runner, tests, decision record and
evidence manifests are repository-authored clean-room work. They compose the existing M6-00,
M6-02 and M6-03 interfaces without copying Apache Superset, model, OpenClaw, or third-party
runtime source. M6-04 files are ordinary repository-authored hashes under `files`, not derived
files.

The K2 closed-intent conformance pack, deterministic synthetic fixture, negative
matrix, focused tests and evidence documentation are repository-authored
clean-room work. They compose the existing External API v2 and K1 contracts
without copying or executing DeepSeek Harness, Cordis, plugin, model, provider
or third-party runtime code. K2 paths are ordinary repository-authored hashes
under `files`, not derived files.

Progressive Analysis v1 state, deterministic fixtures, tests, decision/evidence
records, and documentation updates are repository-authored clean-room work for
issue #37. They compose the existing Progressive Run Controller v1 without
copying third-party source or widening its database authority. These files are
ordinary repository-authored hashes under `files`, not derived files.

Issue #38 safe-analysis method manifests, bounded MSSQL/Oracle aggregate SQL,
controller pair-target accounting, canonical evidence/runtime code, deterministic
fixtures, tests and decision/evidence records are repository-authored clean-room
work. Official engine aggregate documentation is used as behavioral reference;
no reference query code is copied. These paths are ordinary repository-authored
hashes under `files`, not derived files.

Issue #39 proposal-only role and structural-cluster projection, extended evidence
diff, deterministic synthetic fixture, tests, decision/evidence records and
documentation are repository-authored clean-room work. They compose only the
existing #36-#38 contracts and do not copy or execute third-party model, database
or clustering code. These paths are ordinary repository-authored hashes under
`files`, not derived files.

K3 packages the exact OpenClaw Skill Workshop-generated KaleidoSphere
AgentSkill artifact with repository-authored host metadata, tests and a decision
record. The shared skill instructions, contract and validator were created and
applied through governed proposal `kaleidosphere-20260821-e90f51c924`; no
Leonxlnx/taste-skill, OpenClaw, Hermes, Claude Code or Codex executable source is
copied. The pinned taste-skill is a license/scope reference only. K3 paths are
ordinary repository-authored/distribution hashes under `files`, not derived
runtime files.

K4 adds repository-authored deterministic distribution machinery around the same
unchanged canonical AgentSkill bytes. `scripts/build-agent-skill-distribution.mjs`
derives ClawHub/OpenClaw/Hermes, Codex and Claude Code package layouts from
`agent-skills/kaleidosphere` and `package.json` version only, writes ignored
`dist/` artifacts, and emits release-ready archives plus SHA256 sidecars. The
Codex manifest follows the current Codex plugin structure and is validated with
the current `@plugin-creator` validator during focused tests. The Claude Code
manifest is limited to documented skills-only plugin metadata. K4 does not copy
OpenClaw, ClawHub, Codex, Claude Code, Hermes or third-party executable source
and does not claim public catalog listing or unavailable host runtime execution.
The generated ClawHub bundle may be MIT-0 on ClawHub as required by that catalog;
repository source and unrelated code remain Apache-2.0.

K4e.7 binds those three host layouts to the canonical Portable Companion v1
schemas/compatibility matrix and the canonical External API v2 schema without
copying runtime implementations into a host adapter. A byte-identical generated
reference records canonical input digests, the unchanged six runtime intents,
the closed portable utility vocabulary and offline authority boundaries. The
builder's local `--verify` readback rejects manual view drift, undeclared actions,
intent changes, secrets, active hook/MCP surfaces, executable-mode files and
archive traversal. Generated `dist/` trees and release archives remain derived,
ignored artifacts; host runtime execution, marketplace approval, remote services
and production readiness are not claimed.

K4e.0 adds the Portable Companion v1 contract foundation as repository-authored
clean-room work. The schema, compatibility matrix, validator module, decision
record, tests, release notes and source-map updates define closed offline utility
actions, claim classes, non-claims, threat model/source map and digest drift
checks without copying third-party runtime source or widening External API v2.
The six runtime intents remain exactly `status`, `discovery`, `analyze`, `plan`,
`preview` and `readback`; #82-#88 utility actions are reserved vocabulary only
and do not dispatch, deploy, accept credentials/free SQL/raw rows/provider
payloads, discover arbitrary endpoints, or claim hosted/SaaS, remote-MCP,
marketplace, customer-data, live-evidence or production readiness.
