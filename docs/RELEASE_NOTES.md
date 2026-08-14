# Release Notes

## v0.7.0 - Promotion review bundle contract

M5-02 adds `chimpmaera.bi/superset-promotion-bundle/v1`: a deterministic,
review-only ZIP/YAML contract with repository-owned manifest and review-asset
schemas. It binds a confirmed Discovery brief, catalog receipt/snapshot/scope/
coverage, sanitized target identity, Superset version, fingerprint/OpenAPI/
feature-flag freshness, stable UUID asset inventory, file hashes, disclosure,
limitations, nonclaims, and `mutation_performed=false`.

`./bin/bi promotion-bundle build|inspect|preflight` provides machine-readable
JSON and optional human output. Mandatory SHA-256 establishes integrity; v1 is
explicitly unsigned and makes no signer-authenticity claim. The bounded ZIP
parser and semantic validator fail closed on traversal, archive bombs, hash and
schema drift, stale/incompatible fingerprint evidence, UUID/reference errors,
secrets, credentials, source rows, and raw SQL.

This capability creates review evidence only. It does not emit a Superset-native
import package, import/export assets, connect Superset to Oracle/MSSQL, access
source rows, generate SQL, call the materializer, or mutate Superset.

## 2026-08-14 - Product README and docs navigation refresh

The README now presents the repository as Superset BI Agent with a compact
product-oriented overview, fixture-first quickstart, visible workflow,
security-by-design summary, and explicit current boundaries. Operational detail
was moved into dedicated Architecture, Configuration, Security, and Roadmap
documents. This is documentation-only maintenance; no runtime behavior,
container configuration, query pack, Superset materializer, release asset, tag,
or version change is included.

## v0.6.1 - Apache Superset 6.1.0 security/runtime upgrade

The owned Superset runtime is pinned to Apache Superset 6.1.0 by immutable image
digest. Fingerprint fixtures, compatibility bounds, OpenAPI expectations, and
runtime smoke assertions now require 6.1.0 or a later 6.x version. The upgrade
procedure includes a metadata backup, forward migration, fresh-install check,
and restore rollback to the original 5.0.0 image without an in-place downgrade.

## v0.6.0 - Superset Fingerprint M5

M5 adds a read-only Superset Version/OpenAPI/Feature-Flag Fingerprint contract:
`chimpmaera.bi/superset-fingerprint/v1`.

The local stack can collect Apache Superset runtime version, Flask-AppBuilder
`/api/v1/_openapi` representation, canonical OpenAPI SHA-256,
security-relevant `FEATURE_FLAGS`, sanitized target identity, provenance,
freshness policy, compatibility verdict, limitations, and nonclaims. The
collector rejects
secret-like evidence, unsafe target URLs, unexpected content types, malformed
OpenAPI payloads, oversized OpenAPI documents, target mismatch, and incompatible
required feature flags.

M5 also adds `chimpmaera.bi/superset-planning-gate/v1` for later
write/import/export/promotion planning. The gate blocks missing, stale,
incomplete, target-mismatched, OpenAPI-drifted, version-incompatible, or
unknown-required-flag fingerprints and returns `mutation_performed=false`.

Apache Superset runtime evidence is primary. Preset-compatible deployments are
secondary and require target-specific fingerprints. This release does not create
dynamic datasets, charts, dashboards, imports, exports, ZIP promotions, SQL,
source queries, source-row samples, or production/customer evidence.

## v0.5.0 - Guided BI Discovery M4

M4 adds a local, deterministic BI Discovery dialog over the M3 technical catalog.
Discovery sessions are versioned and persisted in the local projection database,
with start/resume/status/answer/revise/confirm/export lifecycle operations.

The exported BI Discovery Brief is available as structured JSON plus Markdown
content. It includes audience role, business questions, confirmed KPI candidates,
dimensions, time grain, filters/segments, drilldowns, freshness needs,
access/confidentiality, open assumptions, coverage blind spots, and catalog
provenance.

All technical suggestions are derived only from the M3 catalog/projection rows
and carry receipt/snapshot/query provenance. The deterministic offline agent path
works with `LLM_MODE=stub`; optional OpenAI-compatible provider use remains
bounded and cannot trigger SQL execution or Superset mutation.

M5 is not included. This release does not create dynamic Superset datasets,
charts, dashboards, SQL, source queries, source-row samples, or semantic models
from Discovery results.
