# M6-04 Trusted Specialist-to-Superset Workflow evidence

## Result

The local workflow connects M6-03 specialist evidence to deterministic preview/diff, M6-00
one-shot approval, M6-02 public-REST apply/readback, and exact rollback. The live proof used a
uniquely named disposable Superset 6.1.0 stack and synthetic fixtures only.

## Gate evidence

- G1: clean exact base `74b80d6850a249afcbd246b9a15342b920ce0aa5`, isolated worktree/branch, sole writer, durable checkpoint.
- G2: canonical plan binds discovery, target fingerprint, capabilities, asset snapshot, stable UUIDs, dependencies, before/after values, limitations, nonclaims, and preview digest. Unsupported, free-SQL, unsafe-value, capability-gap, before-drift, unbound, cyclic, and over-budget inputs fail closed.
- G3: exact trusted approval binds actor/session/target/capabilities/snapshot/preview/action set/expiry/idempotency and consumes once. Stale, replayed, mismatched, partial, voice, model-generated, inferred, and drifted cases fail closed.
- G4: six real public-REST actions on the disposable fixture: dataset, three charts, dashboard, filter. Three distinct chart types, exact UUID/dependency/readback fidelity, no-dispatch idempotent replay, and unauthorized denial.
- G5: six-action reverse rollback and post-rollback readback; restored executor reconciliation; cancellation/timeout probes; single-use rollback; concurrent-drift denial; real partial failure compensated 2/2.
- G6: allowlisted parser/value/tool/network/path boundaries, duration/action budgets, authorization revalidation, substitution/idempotency denial, source-record/response/model-transcript/CoT exclusions, secret scan, syntax checks, and manifest integrity checks.
- G7: see the terminal manifest for final post-commit tests, hashes, source-map readback, clean status, and runtime teardown.

## Negative evidence retained

- The first focused run failed 0/4 because the forbidden-key matcher also matched `description`; the matcher was narrowed to normalized exact dangerous keys.
- The first setup invocation failed safely because no reviewed `.env` existed.
- The first real workflow run hit HTTP 400 when it attempted an unknown dashboard metadata field; four completed actions compensated 4/4. The layout marker was moved to a supported reviewed field.
- A later successful apply/rollback run failed only during evidence serialization because a Buffer was passed to the plain-JSON canonicalizer; byte hashing was corrected and the whole workflow replayed.

No failed run was rewritten into success. The final manifest was created only after a new full
apply/readback/rollback/partial-compensation cycle passed.

## Evidence artifacts

- `docs/evidence/m6-04-trusted-workflow/live-manifest.json`
- `docs/evidence/m6-04-trusted-workflow/terminal-manifest.json`
- `tests/trusted-workflow.test.mjs`
- `scripts/run-trusted-superset-workflow-evidence.mjs`

## Nonclaims

No Delivery, production/customer/personal Superset, organizational independence, causal proof,
network-outcome recovery proof, cross-hardware determinism, broad provider support, deployment,
external publication, push, PR, tag, or release.
