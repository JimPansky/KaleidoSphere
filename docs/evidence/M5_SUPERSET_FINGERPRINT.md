# M5 Superset Fingerprint Evidence

M5-01 adds a read-only Superset Version/OpenAPI/Feature-Flag Fingerprint.
Contract: `chimpmaera.bi/superset-fingerprint/v1`.

## Scope

- Primary target: this repository's owned Apache Superset runtime.
- Secondary target: Preset-compatible deployments only after collecting their
  own fingerprint; no Preset production compatibility is claimed by this slice.
- No dataset, chart, dashboard, SQL Lab, ZIP import/export, promotion, or source
  database mutation is performed by fingerprint collection.
- No production, customer, source-row, or credential evidence is included.

## Evidence Sources

- Superset product version: Python package metadata for `apache-superset`.
- OpenAPI representation: Apache Superset Flask-AppBuilder OpenAPI spec for
  `/api/v1/_openapi`, collected through the internal Superset runtime bridge
  `GET /internal/fingerprint`.
- Feature-flag capabilities: local Superset runtime config `FEATURE_FLAGS`.
- Target identity: sanitized base URL only. Userinfo, query strings, fragments,
  auth headers, cookies, tokens, API keys, passwords, and DB credentials are
  rejected before a fingerprint is accepted.

The internal bridge is protected by the existing `control_token`, is available
only on the Compose internal control network, and is read-only. It invokes
Flask-AppBuilder's OpenAPI spec builder against the registered Superset `v1`
APIs; it does not call the materializer and does not write metadata.

## Canonicalization

The OpenAPI document is parsed as JSON or simple YAML, validated for OpenAPI
shape, then canonicalized with sorted-key canonical JSON
(`canonical-json/v1`). The fingerprint records the canonical byte length,
path count, parser, and SHA-256. Re-collection of the same representation is
idempotent and produces a stable hash.

## Feature Flags

Security-relevant required flags:

- `ENABLE_TEMPLATE_PROCESSING=false`
- `ALERT_REPORTS=false`
- `EMBEDDED_SUPERSET=false`

Observed optional capability:

- `HORIZONTAL_FILTER_BAR`

Unknown, missing, non-boolean, or mismatched required flags make the
compatibility verdict block future promotion/write planning.

## Fail-closed Planning Gate

Contract: `chimpmaera.bi/superset-planning-gate/v1`.

Future write/import/export/promotion planning must present a fresh compatible
fingerprint or use the stored latest fingerprint. The gate blocks/deferes on:

- missing fingerprint
- stale timestamp
- contract mismatch
- malformed or unsupported Superset version
- target mismatch
- OpenAPI hash mismatch or expected-hash drift
- unknown or mismatched required feature flag
- invalid planning request

The gate returns `mutation_performed=false` and does not create datasets,
charts, dashboards, exports, imports, or promotions.

## Negative Probes

Unit tests cover at least these fail-closed cases:

- missing fingerprint
- stale timestamp
- malformed version
- unexpected OpenAPI content type
- oversized OpenAPI
- malformed JSON
- malformed YAML
- expected OpenAPI drift
- hash mismatch
- wrong target
- userinfo URL
- query-secret URL
- token/header-like leakage
- unknown critical feature flag
- unavailable endpoint
- timeout
- write-like request despite missing fingerprint

Positive probes cover deterministic fixture re-collection and stable
canonicalization across object key order.

## Limits and Nonclaims

The M5-01 fingerprint is a compatibility and planning preflight artifact. It is
not production evidence, customer evidence, Superset promotion authorization, a
semantic-model contract, or a guarantee that a future ZIP import/export is safe.
SBA-M5-02 must define the promotion ZIP contract separately and bind it to this
fingerprint's target/version/OpenAPI/feature-flag evidence.
