# K4 Single-Source AgentSkill Distribution

## Decision

Keep `agent-skills/kaleidosphere` as the only maintained KaleidoSphere AgentSkill source. All host packages are deterministic generated views built by `scripts/build-agent-skill-distribution.mjs`.

The canonical skill bytes remain the applied OpenClaw Skill Workshop proposal `kaleidosphere-20260821-e90f51c924`. K4 does not change `SKILL.md`, `references/contract.json`, or `scripts/validate-request.mjs`.

## Generated Views

- `clawhub/kaleidosphere`: exact AgentSkill folder for ClawHub, OpenClaw and Hermes consumption.
- `codex/kaleidosphere-agent-skill`: skills-only Codex plugin with `.codex-plugin/plugin.json` and `skills/kaleidosphere`.
- `claude/kaleidosphere-agent-skill`: skills-only Claude Code plugin with `.claude-plugin/plugin.json` and `skills/kaleidosphere`.

Generated artifacts are written under `dist/agent-skill-distribution` and are ignored by Git. `npm run dist:agent-skill` rebuilds them from the canonical files and package version.

## Gates

- Byte equality from canonical skill files into every host view.
- Digest manifest for the canonical files.
- Closed action contract and forbidden-authority assertions.
- No symlink, path escape, `.git`, `node_modules`, `.env`, secret-like values, or remote pipe-to-shell patterns.
- Codex plugin validation through the current `@plugin-creator` validator when running the focused test.
- Claude manifest limited to official documented skills-only metadata fields.
- Deterministic rebuild: manifests, archives, and SHA256 sidecars match across fresh output directories.
- Release archive build now also emits host-specific distribution archives and sidecars.

## License Boundary

The repository source remains Apache-2.0. ClawHub-published skill bundles are MIT-0 on ClawHub because ClawHub imposes that license for published skills. This boundary applies only to the generated ClawHub listing artifact and does not relicense unrelated repository code or the Codex/Claude archives.

## Non-Claims

K4a proves package generation only. Public ClawHub, OpenAI/Codex Directory, Claude marketplace listing, Hermes runtime execution, Claude runtime execution, and anonymous installability are separate K4b-K4d evidence gates.
