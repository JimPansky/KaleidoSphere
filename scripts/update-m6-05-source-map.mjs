import { createHash } from 'node:crypto';
import { access, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(process.cwd());
const sourceMapPath = resolve(root, 'SOURCE-MAP.json');
const authoredFiles = [
  'package.json',
  'docs/evidence/m6-05-ambiguous-outcome-reconciliation/committed-response-lost-journal.json',
  'docs/evidence/m6-05-ambiguous-outcome-reconciliation/live-manifest.json',
  'docs/evidence/m6-05-ambiguous-outcome-reconciliation/unchanged-safe-to-retry-journal.json',
  'scripts/run-ambiguous-outcome-reconciliation-evidence.mjs',
  'scripts/update-m6-05-source-map.mjs',
  'services/bi-control/src/trusted-workflow/ambiguous-outcome-reconciliation.mjs',
  'tests/ambiguous-outcome-reconciliation.test.mjs',
  'tests/superset-fingerprint.test.mjs',
];

const sourceMap = JSON.parse(await readFile(sourceMapPath, 'utf8'));
for (const file of authoredFiles) {
  try { await access(resolve(root, file)); } catch { continue; }
  sourceMap.files[file] = createHash('sha256').update(await readFile(resolve(root, file))).digest('hex');
}
sourceMap.files = Object.fromEntries(Object.entries(sourceMap.files).sort(([left], [right]) => left.localeCompare(right)));
const temporary = `${sourceMapPath}.m6-05-${process.pid}.tmp`;
await writeFile(temporary, `${JSON.stringify(sourceMap, null, 2)}\n`, { flag: 'wx' });
await rename(temporary, sourceMapPath);
process.stdout.write(`M6-05 source map updated: ${authoredFiles.filter((file) => Object.hasOwn(sourceMap.files, file)).length} authored files, ${Object.keys(sourceMap.files).length} total entries\n`);
