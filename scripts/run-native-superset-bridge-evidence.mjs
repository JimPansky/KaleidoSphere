import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  FAIL_CLOSED_NATIVE_ACTIONS,
  MANAGED_BY,
  NATIVE_ASSETS,
  SUPPORTED_NATIVE_ACTIONS,
  clientFromEnvironment,
  provisionNativeAssets,
  runNativeGoldenSuite,
} from '../services/bi-control/src/visual-scenario-lab/native-superset-bridge.mjs';
import { evaluateVisualDiversity, VISUAL_DIVERSITY_RUBRIC } from '../services/bi-control/src/visual-scenario-lab/view-compositions.mjs';

const evidenceRoot = resolve(process.env.NATIVE_EVIDENCE_ROOT ?? 'docs/evidence/m6-02-native');
await mkdir(evidenceRoot, { recursive: true });
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const client = await clientFromEnvironment();
const executionId = process.env.NATIVE_EXECUTION_ID ?? `native-${new Date().toISOString().replace(/[-:.]/g, '').replace('Z', 'Z')}`;
const firstProvision = await provisionNativeAssets(client);
const secondProvision = await provisionNativeAssets(client);
if (firstProvision.counts.databases !== secondProvision.counts.databases
  || firstProvision.counts.datasets !== secondProvision.counts.datasets
  || firstProvision.counts.charts !== secondProvision.counts.charts
  || firstProvision.counts.dashboards !== secondProvision.counts.dashboards) {
  throw new Error('NATIVE_PROVISION_IDEMPOTENCY_MISMATCH');
}

const runs = [];
for (const suffix of ['live-1', 'live-2']) {
  const id = `${executionId}-${suffix}`;
  const run = await runNativeGoldenSuite({ client, provisioned: secondProvision, runId: id });
  if (!run.allPassed || run.scenarios.length !== 8) throw new Error(`NATIVE_LIVE_RUN_FAILED:${id}`);
  runs.push(run);
}
if (runs[0].scenarios.map((item) => item.scenarioId).join('|') !== runs[1].scenarios.map((item) => item.scenarioId).join('|')) {
  throw new Error('NATIVE_REPEAT_SCENARIO_ORDER_MISMATCH');
}

const scenarioEntries = runs[1].scenarios.map((item) => ({ scenarioId: item.scenarioId, ...item }));
const visualDiversity = evaluateVisualDiversity(scenarioEntries);
if (!visualDiversity.passed) throw new Error('NATIVE_VISUAL_DIVERSITY_FAILED');

const capabilityMatrix = JSON.parse(await readFile('services/bi-control/fixtures/native-superset-bridge/capability-matrix-v1.json', 'utf8'));
const projection = await readFile('.runtime/projection/analytics.db');
const manifest = {
  schemaVersion: 'chimpmaera.bi/native-superset-bridge-evidence/v1',
  generatedAt: new Date().toISOString(),
  runtime: {
    projectName: process.env.COMPOSE_PROJECT_NAME ?? 'sba-m6-02-20260814-2002',
    baseUrl: client.baseUrl,
    product: capabilityMatrix.observedRuntime.product,
    version: capabilityMatrix.observedRuntime.version,
    image: capabilityMatrix.observedRuntime.image,
    loopbackOnly: true,
    syntheticFixtureId: 'northstar-components-synthetic-v1',
    syntheticRows: 12,
    projectionSha256: sha256(projection),
    customerData: false,
  },
  boundary: {
    managedBy: MANAGED_BY,
    interface: 'Apache Superset public REST API v1',
    supportedActions: SUPPORTED_NATIVE_ACTIONS,
    failClosedActions: FAIL_CLOSED_NATIVE_ACTIONS,
    directDomOrInjectedJavaScriptActions: 0,
    embeddedSdkClaimed: false,
    capabilityMatrix,
  },
  stableAssets: {
    databaseUuid: NATIVE_ASSETS.databaseUuid,
    datasetUuid: NATIVE_ASSETS.datasetUuid,
    dashboardUuids: Object.fromEntries(Object.entries(NATIVE_ASSETS.dashboards).map(([key, value]) => [key, value.uuid])),
    dashboardCharts: Object.fromEntries(Object.entries(secondProvision.chartRecordsByDashboard).map(([key, charts]) => [
      NATIVE_ASSETS.dashboards[key].uuid,
      charts.map(({ id, uuid, title, chartType, vizType }) => ({ id, uuid, title, chartType, vizType })),
    ])),
    counts: secondProvision.counts,
    assetReadback: secondProvision.assetReadback,
    independentReadbackDigest: secondProvision.independentReadbackDigest,
    provisionedTwiceIdempotently: true,
  },
  visualDiversityRubric: VISUAL_DIVERSITY_RUBRIC,
  visualDiversity,
  consecutiveFullGreenRuns: 2,
  runs,
  persistentScenarioMutations: 0,
  nonclaims: [
    'No speech-provider quality claim',
    'No OpenClaw, Hermes, Claude, or production deployment claim',
    'No unsupported Superset UI action is represented as native',
    'No M6-03 real model or content-analysis capability is included',
  ],
};

await writeFile(resolve(evidenceRoot, 'live-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`native bridge evidence: ${runs.length} full green runs, ${runs[1].scenarios.length} scenarios/run, ${visualDiversity.distinctLayoutFamilies} layouts, ${visualDiversity.distinctChartTypes} chart types\n`);
