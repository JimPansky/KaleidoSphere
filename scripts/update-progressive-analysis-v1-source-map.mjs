import {createHash} from 'node:crypto';
import {access, readFile, rename, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const root = resolve(process.cwd());
const sourceMapPath = resolve(root, 'SOURCE-MAP.json');
const authoredFiles = [
  'README.md',
  'SOURCE-MAP.md',
  'docs/ARCHITECTURE.md',
  'docs/CONFIGURATION.md',
  'docs/RELEASE_NOTES.md',
  'docs/decisions/PROGRESSIVE-ANALYSIS-V1.md',
  'docs/evidence/PROGRESSIVE_ANALYSIS_V1.md',
  'package.json',
  'scripts/update-progressive-analysis-v1-source-map.mjs',
  'scripts/run-external-api-v2-clean-room.mjs',
  'services/bi-agent/package.json',
  'services/bi-control/fixtures/progressive-analysis-v1.json',
  'services/bi-control/src/db-analyzer/progressive-analysis-v1.mjs',
  'tests/progressive-analysis-v1.test.mjs',
  'tests/external-api-v2.test.mjs',
  'tests/release.test.mjs',
];

const sourceMap = JSON.parse(await readFile(sourceMapPath, 'utf8'));
for (const file of authoredFiles) {
  try { await access(resolve(root, file)); } catch { continue; }
  sourceMap.files[file] = createHash('sha256').update(await readFile(resolve(root, file))).digest('hex');
}
sourceMap.files = Object.fromEntries(Object.entries(sourceMap.files).sort(([left], [right]) => left.localeCompare(right)));
const temporary = `${sourceMapPath}.progressive-analysis-v1-${process.pid}.tmp`;
await writeFile(temporary, `${JSON.stringify(sourceMap, null, 2)}\n`, {flag: 'wx'});
await rename(temporary, sourceMapPath);
process.stdout.write(`Progressive Analysis v1 source map updated: ${authoredFiles.length} authored files, ${Object.keys(sourceMap.files).length} total entries\n`);
