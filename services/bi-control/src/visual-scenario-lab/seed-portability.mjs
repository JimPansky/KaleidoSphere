import { readFile } from 'node:fs/promises';

const seedUrl = new URL('../../fixtures/visual-scenario-lab/portable-seed-v1.json', import.meta.url);
const engines = new Set(['mssql', 'oracle', 'sqlite']);
const identifier = /^[a-z][a-z0-9_]*$/;
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;

export async function loadPortableSeed() {
  const seed = JSON.parse(await readFile(seedUrl, 'utf8'));
  if (seed.schemaVersion !== 'chimpmaera.bi/portable-synthetic-seed/v1' || seed.synthetic !== true) throw new Error('PORTABLE_SEED_INVALID');
  if (!identifier.test(seed.table) || seed.columns.some((column) => !identifier.test(column))) throw new Error('PORTABLE_SEED_IDENTIFIER_INVALID');
  if (seed.rows.some((row) => row.length !== seed.columns.length)) throw new Error('PORTABLE_SEED_ROW_INVALID');
  return seed;
}

export function renderPortableSeed(seed, engine) {
  if (!engines.has(engine)) throw new Error('PORTABLE_SEED_ENGINE_UNSUPPORTED');
  const textType = engine === 'oracle' ? 'VARCHAR2(64)' : 'VARCHAR(64)';
  const numericType = engine === 'oracle' ? 'NUMBER(18, 4)' : 'DECIMAL(18, 4)';
  const dateValue = (value) => engine === 'oracle' ? `DATE ${quote(value)}` : quote(value);
  const create = `CREATE TABLE ${seed.table} (truth_key ${textType} NOT NULL, entity_key ${textType} NOT NULL, period_start DATE NOT NULL, period_end DATE NOT NULL, metric_key ${textType} NOT NULL, metric_value ${numericType} NOT NULL);`;
  const inserts = seed.rows.map((row) => `INSERT INTO ${seed.table} (${seed.columns.join(', ')}) VALUES (${quote(row[0])}, ${quote(row[1])}, ${dateValue(row[2])}, ${dateValue(row[3])}, ${quote(row[4])}, ${Number(row[5])});`);
  return `${create}\n${inserts.join('\n')}\n`;
}

export function semanticSeedProjection(seed) {
  return seed.rows.map(([truthKey, entityKey, periodStart, periodEnd, metricKey, metricValue]) => ({ truthKey, entityKey, periodStart, periodEnd, metricKey, metricValue }));
}
