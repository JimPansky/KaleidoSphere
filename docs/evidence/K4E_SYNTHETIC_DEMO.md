# K4e.5 Deterministic Synthetic Demo

Issue: #86

The demo is a local, source-controlled fixture projection. It is intentionally
synthetic at every machine and human output layer and cannot dispatch a runtime,
use a network, read a database, inspect customer records or create runtime
evidence.

## Deterministic Run

```sh
node --input-type=module -e "import { renderPortableSyntheticDemo } from './services/bi-control/src/portable-companion/synthetic-demo.mjs'; process.stdout.write(renderPortableSyntheticDemo())"
```

The renderer consumes only
`services/bi-control/fixtures/portable-companion/synthetic-demo-v1.json`. The
fixture fixes the verification time and composes four already released offline
contracts:

1. Doctor status: local utility ready, runtime unavailable.
2. Capability guidance: one preview capability, advisory only.
3. Profile template: placeholder-only preview validation.
4. Receipt: synthetic envelope integrity verification only.

The test suite runs the renderer twice and compares the bytes directly. It also
rejects missing or altered synthetic labels, secret-looking values, raw rows,
customer-like identifiers, runtime dispatch, network requests, live-evidence or
runtime-observation claims, and canonical integrity drift.

## Authority Boundary

The exact External API v2 intent list remains `status`, `discovery`, `analyze`,
`plan`, `preview`, `readback`. The demo does not invoke any intent and grants no
runtime readback, benchmark, BI correctness, signing/evidence, mutation,
deployment, hosted/SaaS, remote-MCP, marketplace or production authority.
