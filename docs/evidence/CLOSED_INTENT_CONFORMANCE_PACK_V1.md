# Closed-intent conformance pack v1

Evidence date: 2026-08-19. This is a local, deterministic K2 conformance pack
for the existing External API v2 and K1 Evidence Bridge boundaries.

## Proved boundary

- A local harness-neutral stub obtains the runtime capability attestation,
  invokes exactly `status`, `discovery`, `analyze`, `plan`, `preview` and
  `readback`, and maps each verified result through K1.
- Independent runs produce byte-identical canonical reports and digests.
- Extra tools, trusted apply, free SQL, arbitrary URLs, credentials/raw rows,
  malformed/tampered/replayed responses, stale contracts and missing
  capabilities are denied with zero probe dispatches and zero accepted
  evidence.
- An absent or structurally incompatible consumer leaves the optional pack
  disabled with no dispatch and no evidence. Existing KaleidoSphere behavior
  is not wrapped or replaced.

The response-oriented negative probes use a cached local fixture response. The
replay probe also requires one previously accepted K1 baseline record. That one
setup dispatch and one setup evidence acceptance are excluded from the probes
and recorded explicitly in the negative report; every probe itself executes
zero consumer dispatches and accepts zero evidence.

## Trust and data boundary

The pack has no network client, endpoint discovery, dynamic import, plugin
loader, provider/database/Superset connection or credential access. It accepts
no `.secrets`, free SQL, arbitrary URL, raw source rows, trusted-apply intent or
foreign control token. The public-safe report contains only closed action and
request identifiers, K1 event/receipt identifiers, canonical digests and
explicit non-claims.

## Non-claims

This synthetic stub proves contract conformance only. It does not claim
DeepSeek Harness API, ABI, bundle or plugin compatibility; real-harness E2E;
runtime activation; publisher authenticity; network containment or
authentication; production provider/database/Superset connectivity; BI truth;
mutation authority; or production/customer fitness.

Rollback is a successor revert of this isolated runner, fixture, focused test
and evidence document. External API v2, K1, product data and runtime state are
unchanged.

## Local acceptance evidence

- Focused K2 tests: 7/7 passed.
- K2 + K1 + External API v2 tests: 33/33 passed.
- Full repository suite after inclusion in the default test command: 234/234
  passed.
- Positive canonical report:
  `sha256:4397a00c36ada65e7299cbf72ed116ae02b63a64a679036e295ef55a15fbe562`.
- Negative-matrix canonical report:
  `sha256:4bcdaca5813fd10baf5d914ae639376ff0640b0272220d81addc609af1e8e01c`.

These hashes bind the checked-in synthetic fixture and contract code. They are
regression evidence, not signatures, publisher identity or external-runtime
attestation.
