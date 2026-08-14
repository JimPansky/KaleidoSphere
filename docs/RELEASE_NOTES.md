# Release Notes

## Next - Apache Superset 6.1.0 security/runtime upgrade

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
