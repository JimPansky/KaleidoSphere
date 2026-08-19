# Harness-neutral Evidence Bridge v1 evidence

Evidence date: 2026-08-19. Repository base:
`2c5376bedf86f030b59460a886381fd8edd7732b`.

## Implemented boundary

- Six of six External API v2 intents map to their exact runtime-attested
  capability and authority.
- Product, contract, capability set, request/action correlation, attestation
  digest and result-integrity digest are checked before M6-00 evidence creation.
- Output contains safe IDs, canonical digests and the existing M6-00 receipt;
  the external result body is not copied.
- The module is inactive: no server route, network client, runtime handler,
  plugin loader, third-party package or credential access is added.

## Local gates

- Focused K1 suite: 7/7 passed, including 6/6 intent mapping, deterministic
  repeat, replay denial, timeout/cancel/outcome-unknown and tamper/unsafe-field
  negatives.
- Full repository suite: 226/226 passed.
- Source Map: 345/345 content-addressed entries passed after sealing.
- `git diff --check`: passed.

Exact authored-file SHA-256 at the evidence run:

- Bridge module: `113117eeb5ccc796c565cf1fd4fa8e067e2c23c373d8e15fdc134cd6c063d5ac`
- Fixture: `e73fa0a027c51d2e4fe55a75ad1a20a1f3457137c7b9933fe64bb2a211b2871d`
- Focused test: `9899272755c76bc2f564d0d9a4fcc30c933e0bc79f8ed7be3d2991fa28a8c7fd`

## Negative evidence and non-claims

Unknown actions, trusted apply, contract/product/capability drift, tampered or
forged results, correlation mismatch, replay, raw rows, credential-shaped data,
SQL/query/endpoint surfaces, invalid terminal codes and blind retry fail closed.

These local synthetic gates do not claim real-harness E2E compatibility,
publisher authenticity, network authentication, production/customer readiness,
plugin safety, BI-semantic truth, mutation or deployment.
