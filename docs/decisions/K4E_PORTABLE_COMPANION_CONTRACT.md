# K4e.0 Portable Companion Contract Foundation

Issue: #81

## Decision

KaleidoSphere adds `contracts/portable-companion/v1` as a separately versioned
Portable Companion foundation. It is an offline utility contract only. It does
not add a runtime action, endpoint, dispatcher, provider integration, Gateway
hook, model path, hosted service, remote MCP connector, marketplace behavior, or
production-readiness claim.

The External API v2 runtime intent set remains exactly:

```text
status, discovery, analyze, plan, preview, readback
```

The Portable Companion utility vocabulary is separate from those runtime
intents. Foundation actions owned by #81 are executable only as local validation
or metadata reads. Later K4e actions for #82-#88 are reserved in the contract so
their implementation can be added without widening External API v2.

## Contract Files

- `contracts/portable-companion/v1/portable-companion.schema.json` defines the
  closed v1 contract shape, request envelope, boundaries and claim classes.
- `contracts/portable-companion/v1/compatibility-matrix.json` maps the portable
  utility vocabulary to the unchanged six External API v2 runtime intents and
  records the threat model/source map.
- `services/bi-control/src/portable-companion/contract.mjs` provides local
  fail-closed validation, canonical digest checks and drift detection.
- `tests/portable-companion-contract.test.mjs` proves the positive contract and
  required negative probes.

## Utility Vocabulary

Foundation actions:

- `contract.describe`
- `compatibility.matrix.read`
- `threat-model.read`
- `source-map.verify`

Reserved follow-on actions:

- `doctor.readiness.check` (#82)
- `capability.explorer.read` (#83)
- `profile-template.validate` (#84)
- `receipt-envelope.verify` (#85)
- `synthetic-demo.run` (#86)
- `evidence-inspector.inspect` (#87)
- `cross-harness.verify` (#88)

Reserved actions are vocabulary commitments only. They do not dispatch or make
runtime, evidence, deployment, marketplace, customer-data, hosted/SaaS or
remote-MCP claims in this slice.

## Threat Model And Source Map

Trusted sources are the schema, compatibility matrix, validator module,
`SOURCE-MAP.json`, and deterministic package metadata in this repository.
Generated release artifacts are produced later by existing release scripts from
the canonical repository source. The rollback path before merge is closing the
PR; after merge it is a protected successor PR and regular successor release.
Released tags are immutable and must not be retagged.

Denied request surfaces:

- unknown utility action or request field
- unsupported or stale contract version
- oversized or overly deep JSON
- credential, token, secret, cookie or private-key fields and values
- free SQL, SQL Lab text or query fields
- arbitrary URL, endpoint, host or port discovery
- raw rows, records or provider payloads
- mutation, apply, deploy, publish, write or delete authority
- live evidence, production readiness, customer-data fitness, hosted/SaaS,
  remote-MCP or marketplace claims

## Claim Classes

- `observed-fact`: directly observed from deterministic local files or synthetic
  fixtures.
- `computed-fact`: derived by deterministic local validation, hashing, parsing
  or comparison.
- `inferred-candidate`: advisory guidance that requires later verification.
- `human-decision`: explicit trusted-owner or trusted-UI decision outside this
  foundation.
- `non-claim`: boundary, denial or documentation statement that asserts no
  runtime result.

## Non-Claims

This foundation does not claim runtime compatibility beyond the unchanged
External API v2 intent list, does not run a full KaleidoSphere runtime, does not
discover arbitrary endpoints, does not accept credentials, does not execute free
SQL, does not return raw rows/provider payloads, does not mutate or deploy
anything, and does not prove live evidence, hosted/SaaS, remote-MCP, production
or marketplace readiness.

## K4e.4 Signed Receipt Verification

Issue #85 implements `receipt-envelope.verify` as a local integrity verifier and
explainer. The envelope is immutable, size bounded, signed with the single
allowlisted `Ed25519` algorithm and bound to the Portable Companion contract
schema, canonical External API v2 capability manifest and repository source
map. A caller must supply an explicit local verification context; the verifier
does not discover or retrieve keys.

The initial fixture trust class is deliberately `synthetic-fixture-only`.
Successful verification is reported as `VERIFIED_INTEGRITY_ONLY`, never as live
evidence or a production trust decision. Observed facts, computed facts,
inferred candidates and non-claims remain separate in both the signed receipt
and verifier output. No claim crosses classes, and synthetic input with a live
observation claim fails closed.

The verifier contains no private key and grants no signing, runtime, evidence,
mutation, deployment, network, credential, remote-service or production trust
authority. Rollback remains a protected successor PR and regular successor
release; immutable release tags are never moved.

## K4e.5 Deterministic Synthetic Demo

Issue #86 implements `synthetic-demo.run` as a fixed, local-only composition of
the released doctor, capability explorer, profile-template validator and
receipt-envelope verifier. The single tiny fixture supplies a missing-runtime
snapshot, one preview guidance selection, a placeholder-only preview template
and a signed synthetic receipt whose verification time is fixed in the fixture.
No clock, network, runtime transport or customer source influences the result.

The canonical renderer produces byte-identical JSON on repeated runs. The root
report and all four flow layers carry the exact same machine-readable synthetic
classification and human-readable synthetic warning. Status remains
`RUNTIME_UNAVAILABLE`, guidance remains advisory, template values remain
placeholders, and receipt verification remains `VERIFIED_INTEGRITY_ONLY` with a
`synthetic-fixture-only` trust class.

Fixture and output validators fail closed when a synthetic label is missing or
altered, when secret-looking material, raw rows or customer-like identifiers are
introduced, when dispatch or network is requested, or when output claims live
evidence or runtime observation. The demo grants no runtime readback, benchmark,
signing/evidence, deployment, hosted, remote-MCP, marketplace or production
authority.
