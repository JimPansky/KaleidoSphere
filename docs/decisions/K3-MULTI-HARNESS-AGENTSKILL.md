# K3 multi-harness AgentSkill

## Decision

Adopt one shared KaleidoSphere AgentSkill core and thin host installation
records. The capability contract remains the existing closed External API v2
surface: `status`, `discovery`, `analyze`, `plan`, `preview`, and `readback`.
The package adds no endpoint, plugin loader, provider, credential or mutation
authority.

The OpenClaw reference was created, scanned and applied through Skill Workshop
proposal `kaleidosphere-20260821-e90f51c924`. The repository package is the
exact applied artifact: SKILL SHA-256
`4c711c4d4111530a9c895070710c74be12711834daab19f3adc8267383d1ca2c`,
contract SHA-256
`9d964e02e2606a8f35c0e378bb1f3a5b353e20db5a5836c2677557bde99a7d71`,
and validator SHA-256
`20000bab047da9741bb338cd52fe0d33afef6cef84e9d7427f2ce54ec5651509`.

## Taste source audit and disposition

The evaluated source is `Leonxlnx/taste-skill` at exact commit
`dfb6f9f9e93a39f673b1827c0889cc28326d1800`, maintained on 2026-08-18 and
licensed MIT. Audited hashes were:

- LICENSE: `4575a543ab88dad12ccea7d97e563d0bce5b448b06072e65d3264497dad326df`
- main skill: `aa194351b246b8b4799099d4ed7b033d29eab6e6e3d58d8d2172978be7b3ec89`
- plugin manifest: `bc9ddf22f1025944447bf56197e35a65aef0f8921fc7e68c616d4599d3d8bbf4`
- marketplace manifest: `669b9a23f5b46326946465198829ff6d35a9b7fd36abc6b4a2ef652f02e615e2`

Its own target declaration excludes dashboards, data tables and multi-step
product UI. The bounded three-use-case decision is therefore:

1. PanSphaira UI/HMI: **Reject** as implementation authority; optional visual
   critique is explicitly non-binding.
2. Internal design review: **Adapt** visual hierarchy, typography, spacing,
   contrast, composition and motion as advisory inputs that cannot override
   deterministic product, evidence or accessibility gates.
3. KaleidoSphere/BI presentations: **Adapt** for narrative and visual clarity;
   data, claims, provenance and evidence remain independently verified.

Taste is never a BI truth, evidence, approval, accessibility, readiness or
deployment judge.

## Host evidence

- OpenClaw 2026.7.1-2: fresh Workshop apply, discovery and use passed. Six safe
  requests were accepted and eleven widening probes were denied before any
  dispatch or evidence acceptance. A bounded remove probe returned `not found`
  with the skill path absent, then the exact Workshop artifact was restored.
- Codex 0.144.1 and Claude Code packaging: the current `skills` installer
  copied the same package to `.agents/skills/kaleidosphere` and
  `.claude/skills/kaleidosphere`, listed one shared skill, then removed both.
  The final `skills-lock.json` had an empty `skills` object and neither host
  retained a skill file.
- Hermes: current public contract uses `~/.hermes/skills/<name>` with SKILL.md,
  scripts and references. The package is structurally compatible; no Hermes
  binary was installed, so runtime use is not claimed.

No marketplace presence is claimed without a separate public listing and
anonymous readback. The repository/release package is the public distribution
surface for this slice.
