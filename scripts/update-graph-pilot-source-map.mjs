import { createHash } from 'node:crypto';
import { access, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(process.cwd());
const sourceMapPath = resolve(root, 'SOURCE-MAP.json');
const authoredFiles = [
  'package.json',
  'contracts/bi-discovery-readiness-graph/v0/evidence-pack.schema.json',
  'contracts/bi-discovery-readiness-graph/v0/graph-spec.schema.json',
  'contracts/bi-discovery-readiness-graph/v0/receipt.schema.json',
  'contracts/bi-discovery-readiness-graph/v0/state.schema.json',
  'docs/decisions/GRAPH-PILOT-DISCOVERY-READINESS-V0.md',
  'docs/evidence/graph-pilot/discovery-readiness-v0.dot',
  'docs/evidence/graph-pilot/discovery-readiness-v0.mmd',
  'docs/evidence/graph-pilot/terminal-manifest.json',
  'docs/evidence/graph-pilot/terminal-state.json',
  'scripts/run-graph-pilot-evidence.mjs',
  'scripts/update-graph-pilot-source-map.mjs',
  'services/bi-control/src/graph-pilot/bi-discovery-readiness-graph.mjs',
  'services/bi-control/src/graph-pilot/schema-validator.mjs',
  'tests/graph-pilot.test.mjs',
];

const sourceMap = JSON.parse(await readFile(sourceMapPath, 'utf8'));
for (const file of authoredFiles) {
  try { await access(resolve(root, file)); } catch { continue; }
  sourceMap.files[file] = createHash('sha256').update(await readFile(resolve(root, file))).digest('hex');
}
sourceMap.files = Object.fromEntries(Object.entries(sourceMap.files).sort(([left], [right]) => left.localeCompare(right)));
const temporary = `${sourceMapPath}.graph-pilot-${process.pid}.tmp`;
await writeFile(temporary, `${JSON.stringify(sourceMap, null, 2)}\n`, { flag: 'wx' });
await rename(temporary, sourceMapPath);
process.stdout.write(`Graph pilot source map updated: ${authoredFiles.filter((file) => Object.hasOwn(sourceMap.files, file)).length} authored files, ${Object.keys(sourceMap.files).length} total entries\n`);
