import { createHash } from 'node:crypto';
import { access, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(process.cwd());
const sourceMapPath = resolve(root, 'SOURCE-MAP.json');
const authoredFiles = [
  'package.json',
  'contracts/bi-adaptive-investigation-graph/v1/evidence-pack.schema.json',
  'contracts/bi-adaptive-investigation-graph/v1/graph-spec.schema.json',
  'contracts/bi-adaptive-investigation-graph/v1/receipt.schema.json',
  'contracts/bi-adaptive-investigation-graph/v1/state.schema.json',
  'docs/decisions/GRAPH-PILOT-ADAPTIVE-INVESTIGATION-V1.md',
  'docs/evidence/graph-adaptive-v1/adaptive-investigation-v1.dot',
  'docs/evidence/graph-adaptive-v1/adaptive-investigation-v1.mmd',
  'docs/evidence/graph-adaptive-v1/candidate-freeze.json',
  'docs/evidence/graph-adaptive-v1/terminal-manifest.json',
  'docs/evidence/graph-adaptive-v1/terminal-state.json',
  'scripts/run-graph-adaptive-v1-evidence.mjs',
  'scripts/update-graph-adaptive-v1-source-map.mjs',
  'services/bi-control/fixtures/graph-adaptive-v1/sealed-neutral-packs.json',
  'services/bi-control/src/graph-pilot/bi-adaptive-investigation-graph.mjs',
  'tests/graph-adaptive-v1.test.mjs',
];

const sourceMap = JSON.parse(await readFile(sourceMapPath, 'utf8'));
for (const file of authoredFiles) {
  try { await access(resolve(root, file)); } catch { continue; }
  sourceMap.files[file] = createHash('sha256').update(await readFile(resolve(root, file))).digest('hex');
}
sourceMap.files = Object.fromEntries(Object.entries(sourceMap.files).sort(([left], [right]) => left.localeCompare(right)));
const temporary = `${sourceMapPath}.graph-adaptive-v1-${process.pid}.tmp`;
await writeFile(temporary, `${JSON.stringify(sourceMap, null, 2)}\n`, { flag: 'wx' });
await rename(temporary, sourceMapPath);
process.stdout.write(`Graph adaptive v1 source map updated: ${authoredFiles.filter((file) => Object.hasOwn(sourceMap.files, file)).length} authored files, ${Object.keys(sourceMap.files).length} total entries\n`);
