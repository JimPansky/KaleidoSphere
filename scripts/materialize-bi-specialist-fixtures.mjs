import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(process.cwd(), 'services/bi-control/fixtures/bi-specialist');
const candidateRoot = resolve(root, 'candidate');
const specs = JSON.parse(await readFile(resolve(root, 'fixture-specs-v1.json'), 'utf8'));
const digestFile = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
await mkdir(candidateRoot, { recursive: true });

const manifest = { schemaVersion: 'chimpmaera.bi/bi-specialist-fixture-provenance/v1', generatedBy: 'scripts/materialize-bi-specialist-fixtures.mjs',
  classification: 'visible development/adversarial regression corpus; not blind evaluation', fixtures: [] };
for (const fixture of specs.fixtures) {
  const target = resolve(candidateRoot, fixture.filename);
  try {
    await stat(target);
  } catch {
    const temporary = `${target}.partial-${process.pid}`;
    const db = new DatabaseSync(temporary);
    try {
      db.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE');
      for (const statement of fixture.statements) db.exec(statement);
      db.exec('PRAGMA user_version = 603; COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    } finally { db.close(); }
    await rename(temporary, target);
  }
  manifest.fixtures.push({ id: fixture.id, lane: fixture.lane, domain: fixture.domain, filename: fixture.filename,
    databaseSha256: await digestFile(target), candidateInputContainsOracle: false, optimizationSeen: fixture.lane === 'training' });
}
manifest.fixtures.sort((a, b) => a.id.localeCompare(b.id));
await writeFile(resolve(root, 'fixture-provenance-v1.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'w' });
console.log(JSON.stringify({ fixtures: manifest.fixtures.length, training: manifest.fixtures.filter((item) => item.lane === 'training').length,
  development: manifest.fixtures.filter((item) => item.lane === 'development').length }, null, 2));
