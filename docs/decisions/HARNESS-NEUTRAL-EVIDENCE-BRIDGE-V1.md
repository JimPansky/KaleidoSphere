# Harness-neutral closed-intent Evidence Bridge v1

## Decision

KaleidoSphere maps only verified External API v2 terminal results into existing
M6-00 `tool.execution.receipt` events. The adapter is an inactive local module:
it opens no endpoint, discovers no harness, imports no third-party package and
owns no handler or mutation authority.

The accepted action set is exactly `status`, `discovery`, `analyze`, `plan`,
`preview`, and `readback`. Product/contract/capability attestation, request/action
correlation and the response integrity digest are verified before evidence is
built. The event carries only safe IDs, authority, digests and the existing M6
receipt; the external result body is not copied into evidence.

## Safety properties

- Trusted apply/readback/rollback capabilities remain `externalIntent=false`.
- Free SQL, arbitrary endpoints, credentials, raw/source rows, internal
  Superset responses and reasoning cannot enter adapter evidence.
- Timeout and cancellation are explicit terminal states. Outcome-unknown is
  permitted only for the reversible local discovery-evidence effect and forbids
  blind retry.
- The pure builder is deterministic for repeatable evidence. The stateful
  consumer rejects a repeated request/result terminal key.
- Unknown action, contract, product version, capability set, authority, digest,
  correlation or terminal code fails closed before evidence append/dispatch.

## Non-claims

This contract does not prove DSH or any other harness compatibility, publisher
authenticity, network authentication, production readiness or semantic truth. It
does not install plugins, run foreign code, accept credentials, expose SQL, add
an apply intent or connect the adapter to runtime routes.

## Rollback

Before merge, discard only the feature branch. After merge, a protected
successor reverts the additive module, fixture, tests and documentation. External
API v2, M6-00 and all historical receipts remain valid; there is no runtime state
to stop.
