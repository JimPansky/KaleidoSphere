# M5-02 Superset Promotion Review Bundle

Contract: `chimpmaera.bi/superset-promotion-bundle/v1`.

## Purpose and boundary

M5-02 materializes deterministic review evidence between confirmed Discovery
and any future Superset-native materialization/import work. It never imports,
exports, promotes, or mutates Superset; never connects Superset to Oracle or
MSSQL; never reads source rows; and never generates free-form or raw SQL.
The fixed existing technical-dashboard materializer is unchanged.

## Archive layout

```text
promotion-bundle.yaml
schemas/promotion-bundle.schema.json
schemas/review-asset.schema.json
evidence/discovery-brief.json
evidence/catalog-evidence.json
evidence/superset-fingerprint.json
assets/{database,dataset,chart,dashboard}/<stable-uuid>.yaml
```

The `.yaml` files are canonical JSON plus a final newline. JSON is a strict
subset of YAML 1.2, so the artifacts remain YAML-readable without ambiguous
implicit types, aliases, tags, or duplicate-key behavior.

## Evidence bindings

- Discovery must be an exported confirmed `chimpmaera.bi/discovery-brief/v1`.
- Receipt ID, snapshot SHA-256, exact scope, coverage/blind spots, and
  provenance must agree between Discovery and catalog evidence.
- Target identity is sanitized and content-addressed.
- Superset version, OpenAPI canonical SHA-256, required feature flags,
  fingerprint source hash, observation, and stale-after boundary are pinned.
- Every review asset has a stable UUID, a kind-specific allowlisted path, a
  content hash, and dependency UUIDs. UUIDs must be unique and references must
  be present, non-self, and acyclic.
- Every non-manifest file is allowlisted, counted, size-bound, and SHA-256
  listed. A portable `<bundle>.sha256` sidecar binds the complete archive.
- Disclosure states that source rows, raw SQL, and secrets are absent.
- Limitations, nonclaims, `REVIEW_ONLY`, and `mutation_performed=false` are
  mandatory.

## ZIP and semantic preflight

The parser validates EOCD/central/local headers, CRC-32, compression method,
path allowlist, traversal, duplicate names, symlink metadata, entry overlap,
multidisk/trailing data, count, per-entry bytes, total uncompressed bytes,
archive bytes, and compression ratio. Semantic validation then recomputes every
file/archive hash and verifies the schemas, evidence bindings, target,
fingerprint freshness/compatibility, feature flags, UUID graph, disclosure, and
secret/source-row/raw-SQL guards.

At least 33 semantic builder negatives and 16 malicious/post-build archive
negatives are covered by `tests/promotion-bundle.test.mjs`. A blocked preflight
returns one stable reason code and always reports `mutation_performed=false`.

## Integrity and authenticity

SHA-256 and CRC checks detect accidental or malicious byte changes. They do not
authenticate a publisher. Contract v1 therefore requires
`UNSIGNED_REVIEW_ARTIFACT` and `authenticity_claimed=false`. A future signing
trust model must use a new reviewed contract version; it must not reinterpret v1.

## Usage

```bash
./bin/bi promotion-bundle build --input review-input.json --output review.zip
./bin/bi promotion-bundle inspect --bundle review.zip
./bin/bi promotion-bundle preflight --bundle review.zip --human true
sha256sum -c review.zip.sha256
```

The builder uses create-new semantics and refuses to overwrite the ZIP or
sidecar. `--now` is reserved for deterministic fixture/clean-room checks.

## Next bounded slice

SBA-M5-03 should deepen dependency-graph preflight for Superset-native dataset,
chart, dashboard, native-filter, and cross-filter references. It must remain
pre-import and fail closed; this M5-02 evidence is not authorization to add an
import or mutation path.
