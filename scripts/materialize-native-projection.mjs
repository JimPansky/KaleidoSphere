import { createHash } from 'node:crypto';
import { mkdir, readFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const destination = resolve(process.argv[2] ?? '.runtime/projection/analytics.db');
const fixture = JSON.parse(await readFile(resolve('services/bi-control/fixtures/visual-scenario-lab/portable-seed-v1.json'), 'utf8'));
if (fixture.schemaVersion !== 'chimpmaera.bi/portable-synthetic-seed/v1' || fixture.synthetic !== true || fixture.rows.length !== 12) throw new Error('NATIVE_PROJECTION_FIXTURE_DENIED');
await mkdir(dirname(destination), { recursive: true });
const temporary = `${destination}.${process.pid}.tmp`;
const dimensions = {
  executive_q2: { product: 'Atlas Drive', customer: 'Futura Retail' },
  quality_spike: { plant: 'Werk 3', line: 'Linie C', supplier_batch: 'SB-X17' },
  inventory_risk: { plant: 'Werk 2', component: 'Rotor-7' },
  maintenance_q2: { asset_class: 'Press' },
  cross_domain_q2: { product: 'Atlas Drive' },
};
const database = new DatabaseSync(temporary);
try {
  database.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
    CREATE TABLE northstar_scenario_oracle (
      truth_key TEXT NOT NULL, entity_key TEXT NOT NULL, period_start DATE NOT NULL, period_end DATE NOT NULL,
      metric_key TEXT NOT NULL, metric_value REAL NOT NULL, plant TEXT, line TEXT, product TEXT,
      customer TEXT, component TEXT, asset_class TEXT, supplier_batch TEXT,
      fixture_id TEXT NOT NULL CHECK(fixture_id='northstar-components-synthetic-v1'),
      managed_by TEXT NOT NULL CHECK(managed_by='sba-m6-02-native-bridge')
    );`);
  const insert = database.prepare('INSERT INTO northstar_scenario_oracle VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const [truthKey, entityKey, from, to, metricKey, metricValue] of fixture.rows) {
    const value = dimensions[truthKey] ?? {};
    insert.run(truthKey, entityKey, from, to, metricKey, Number(metricValue), value.plant ?? null, value.line ?? null,
      value.product ?? null, value.customer ?? null, value.component ?? null, value.asset_class ?? null,
      value.supplier_batch ?? null, fixture.fixtureId, 'sba-m6-02-native-bridge');
  }
  const readback = database.prepare('SELECT COUNT(*) count, COUNT(DISTINCT truth_key) truths, MIN(fixture_id) fixture_id, MIN(managed_by) managed_by FROM northstar_scenario_oracle').get();
  if (readback.count !== 12 || readback.truths !== 5 || readback.fixture_id !== fixture.fixtureId || readback.managed_by !== 'sba-m6-02-native-bridge') throw new Error('NATIVE_PROJECTION_READBACK_MISMATCH');
} finally { database.close(); }
await rename(temporary, destination);
const bytes = await readFile(destination);
process.stdout.write(`${JSON.stringify({status:'MATERIALIZED_SYNTHETIC', fixtureId:fixture.fixtureId, rows:12, sha256:createHash('sha256').update(bytes).digest('hex')})}\n`);
