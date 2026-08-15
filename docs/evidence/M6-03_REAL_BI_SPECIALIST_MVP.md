# M6-03 Real BI Specialist MVP evidence

## Outcome

M6-03 implements a local, harness-neutral BI specialist behind the frozen M6 assistant
contracts. Its deterministic evidence core discovers a database from an objective without
table hints, while a replaceable local Qwen3.6 Q6 adapter handles bounded structured
synthesis and typed tool calls. Candidate databases, hidden oracles, model runtime and
evaluation are separate. The initially named holdouts were found visible to the implementation
lane during terminal audit and are therefore classified only as development/adversarial
regression fixtures.

Terminal credit is granted only when `terminal-manifest.json`, the complete repository test
suite, content-addressed source map, runtime teardown and clean local commit all agree.

## Gate evidence

1. **Serial foundation.** The isolated branch/worktree starts at exact clean M6-02 commit
   `76f0bd3f1b06aa14960cdee5b304f94a98e20ae7`. The contract, owner checkpoint, rollback and
   no-competing-writer inventory are recorded.
2. **Qwen conformance.** Qwen3.6-28B-REAP20-A3B Q6_K ran through the built-in Node adapter on
   isolated loopback port 18103. Eleven live checks passed: model/normal/JSON, typed tool call,
   timeout, streaming cancellation, restart/idempotency reconciliation, input/output budgets,
   paired sampling, specialist development fixtures and privacy-safe traces. Mock-provider tests separately
   force bounded retry and malformed, unknown and extra tool arguments.
3. **Progressive discovery.** Every result contains the twelve required phases from risk
   preflight through trusted apply/readback/rollback. SQLite opens read-only; metadata,
   profiling and targeted relationship probes are bounded by tables, queries, rows and time.
   No source rows are persisted in evidence.
4. **Blind generalization.** The original two training plus three semantically named cases are
   visible development/regression evidence only (5/5 exact, zero hard/privacy failure). A source
   commitment was then recorded before authoring a new sealed pack. Sealed V1 ran once in a
   separate candidate process and honestly failed 0/3 on the KPI-grain hard gate. After the
   general duration-KPI invariant was corrected, candidate V2 was frozen before a wholly new
   neutral pack was authored. Its single no-feedback A/B scored candidate 3/3 exact with zero
   hard, leakage, mutation, budget, grain or causality failure; the bounded incumbent scored
   0/3 exact with seven hard failures. V1 remains immutable negative evidence.
5. **Planning and sampling.** The versioned guide maps eight task classes to direct,
   plan-check, hypothesis-test-revise, hierarchical, synthesis, preview/critique, repair and
   trusted-apply patterns. A paired live temperature ablation executed twice at 0.0, 0.1, 0.2,
   0.4, 0.6 and 0.8 with fixed prompt, model, quantization, top-p, seed and token budget; all
   12/12 outputs satisfied the JSON/evidence schema. The 0.8 profile remains preview-only.
6. **Incumbent selection.** The measured three-table incumbent scored 0.7143 discovery/oracle
   with ten missed-oracle hard failures. The full bounded candidate scored 1.0 with zero hard
   failure and no citation/tool/privacy/safety regression, so it was accepted. An explicit bad
   ablation regressed oracle/privacy, added a hard failure, and was rejected with rollback to
   the incumbent. Normalized deterministic-core replay was stable on 5/5 cases.
7. **Terminal repository.** Focused/full tests, evidence digests, direct manifest review,
   redaction probes, `git diff --check`, Source-Map validation, runtime teardown and clean local
   commit are bound in the terminal manifest/checkpoint; no external publication occurs.

## Direct review and negative evidence

- Development core review: 5 fixtures, 2 training, 3 development, exact regression score 5/5,
  hard failures 0, privacy failures 0, normalized repeatability 5/5.
- Sealed review: V1 candidate 0/3 with three grain hard failures and no leakage/mutation failure;
  V2 candidate 3/3 exact and zero hard/leakage/mutation/budget/grain/causality failure, versus
  bounded incumbent 0/3 exact and seven hard failures.
- Qwen manifest review: live checks 11/11; specialist schema/table grounding 5/5; sampling
  matrix 12/12 valid; persistent mutations 0.
- Fixed-seed Qwen outputs were schema-stable but byte-identical in 0/6 final paired profiles.
  Runtime determinism is therefore explicitly not claimed.
- One first-pass planning profile requested 1,280 output tokens against the adapter's 1,024
  ceiling. The call failed closed, the policy was corrected to 1,024, and the complete live
  specialist suite was rerun green.
- The uniquely named transient service disappeared once between evidence iterations. Port,
  process and service state were rechecked before one isolated restart; the final complete live
  sequence passed and the service was then deliberately stopped. This is operational negative
  evidence, not hidden from the result.
- The previous cron lane created local commit `f038e8e3cac089d9003e9f6a28680177dfbbd0a9`
  at 06:21:47, eleven seconds before this recovery lane's first write/commitment. The recovery
  lane did not rewrite it: the four reported concurrent files were reviewed, focused invariants
  were replayed, and all audit remediation is a separate follow-up commit. No later competing
  writer or reflog transition was observed.
- The standalone `sqlite3` CLI was unavailable during terminal review. The same integrity check
  was completed with Node 24's built-in `node:sqlite` read-only handles across all eleven
  development and sealed databases; every `PRAGMA integrity_check` returned `ok`.

## PDCA summary

- **G1:** pin serial source and isolation; verify exact commit/exclusivity; advance, rejecting
  reuse of the M6-02 worktree.
- **G2:** prove the smallest adapter against mock failures and live Q6; correct the profile
  budget mismatch; retain Q6 and reject a framework/dependency install.
- **G3/G4:** build generic bounded discovery; reject the visible corpus as blind evidence during
  audit; preserve the failed sealed V1, correct the general grain invariant, then pass a newly
  committed and wholly new sealed V2 pack without intermediate feedback.
- **G5:** compare policies and a paired temperature-only ablation; retain task-specific
  sampling, while rejecting one global temperature and high-temperature persistence.
- **G6:** replay actual incumbent/candidate generations; accept only the no-regression candidate
  and preserve the explicit rejected ablation as negative evidence.
- **G7:** rerun all checks after final bytes, refresh hashes, tear down the owned runtime, commit
  locally, and reject push/PR/release or production activation.

## Nonclaims

No production/customer database was accessed. No source DB, external service, personal
OpenClaw/Gateway/provider, native Superset asset or customer dashboard was changed. There is no
claim of causal proof, raw-row completeness, Qwen support beyond the tested local configuration,
byte determinism, rendered-UI acceptance, deployment, push, PR, tag or release.
