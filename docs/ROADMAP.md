# Roadmap

This roadmap describes capability stages in product language. It is not a
delivery promise, release schedule, or production compatibility claim.

## Released capability stages

### Portable local stack

The repository provides a standalone Docker Compose stack with KaleidoSphere,
bi-control, Apache Superset, local runtime directories, file secrets, tests, and
release archive checks.

### Oracle runtime foundation

Oracle metadata analysis runs through `node-oracledb` Thin mode with scoped
read-only principals, identity and rights preflight, bounded timeouts, and
evidence that source rows are not sampled.

### Oracle technical inventory

Oracle inventory expanded from structural metadata to technical metadata such
as comments hashes, constraints, indexes, partitions, LOBs, tablespaces,
statistics freshness, stored logic metadata, scheduler metadata, materialized
view refresh, and credential-free DB-link metadata.

### Local technical catalog and Q&A

Analysis receipts can be ingested into a versioned local SQLite catalog.
Deterministic search and bounded Q&A answer from the local catalog with receipt,
snapshot, scope, and coverage provenance. Fixed managed Superset technical
overview dashboards read only local projection tables.

### Guided BI requirements discovery

Discovery sessions collect audience role, business questions, KPI candidates,
dimensions, time grain, filters/segments, drilldowns, freshness needs,
access/confidentiality, open assumptions, confirmation state, and exportable
Markdown/JSON briefs. Suggestions are catalog-bound and do not create Superset
assets.

### Superset runtime fingerprint

The current stack can collect a read-only Apache Superset 6.1.0 runtime
fingerprint with sanitized target identity, OpenAPI canonical SHA-256,
feature-flag capability status, provenance, freshness policy, compatibility
verdict, limitations, and nonclaims. A fail-closed planning gate blocks future
write/import/export/promotion planning when fingerprint evidence is missing,
stale, incompatible, target-mismatched, or drifted.

### Review-only promotion ZIP contract

The repository can build, inspect, and preflight deterministic review-only ZIP
artifacts under `chimpmaera.bi/superset-promotion-bundle/v1`. Bundles bind a
confirmed Discovery brief, catalog provenance and coverage, a compatible fresh
Superset fingerprint, stable UUID review assets, per-file hashes, disclosure,
limitations, and nonclaims. This stage does not import or mutate Superset.

## Candidate next capabilities

These are candidates for later reviewed work. They are not implemented claims:

- Human-approved materialization from a confirmed brief into Superset assets.
- Deeper Superset-native dependency-graph validation for dataset/chart/dashboard
  and native/cross-filter references before any later import path.
- Additional clean-room and public-rendering validation for documentation and
  release assets.
- Clearer product packaging and repo metadata after protected review.
- A reviewed harness adapter and thin Superset overlay using the M6-00 event,
  capability, approval, and reversible `ui-action/v1` contracts.
- A BI-Control persistent revision workflow with preview/diff, trusted visual
  approval, apply, readback, and rollback. Voice-only approval stays excluded.

## Explicit non-goals today

- Free-form SQL generation or SQL Lab enablement.
- Source-row sampling, business-row export, or model access to source rows.
- Dynamic Superset dataset/chart/dashboard generation without a reviewed
  promotion contract.
- Superset import or promotion execution from the current review-only bundle.
- Direct Superset-to-source Oracle or MSSQL credentials.
- Production, customer, SSO, HA, Kubernetes, or managed multi-tenant operation.
- DeepSeek Harness/Cordis integration, runtime plugin installation/HMR,
  arbitrary MCP servers, direct DOM/JavaScript agent control, or voice-only
  approval of persistent changes.
