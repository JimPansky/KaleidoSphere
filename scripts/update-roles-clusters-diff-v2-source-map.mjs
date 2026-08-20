import {createHash} from 'node:crypto';
import {readFile, rename, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const root = resolve(process.cwd());
const sourceMapPath = resolve(root, 'SOURCE-MAP.json');
const authoredFiles = [
  'README.md',
  'SOURCE-MAP.md',
  'docs/ARCHITECTURE.md',
  'docs/RELEASE_NOTES.md',
  'docs/ROADMAP.md',
  'docs/decisions/ROLES-CLUSTERS-DIFF-V2.md',
  'docs/evidence/ROLES_CLUSTERS_DIFF_V2.md',
  'package.json',
  'scripts/update-roles-clusters-diff-v2-source-map.mjs',
  'services/bi-control/fixtures/roles-clusters-diff-v2.json',
  'services/bi-control/src/db-analyzer/progressive-analysis-v1.mjs',
  'services/bi-control/src/db-analyzer/progressive-controller.mjs',
  'services/bi-control/src/db-analyzer/roles-clusters-diff-v2.mjs',
  'services/bi-control/src/db-analyzer/safe-analysis-methods.mjs',
  'tests/release.test.mjs',
  'tests/roles-clusters-diff-v2.test.mjs',
];

const sourceMap = JSON.parse(await readFile(sourceMapPath, 'utf8'));
for (const file of authoredFiles) {
  sourceMap.files[file] = createHash('sha256').update(await readFile(resolve(root, file))).digest('hex');
}
sourceMap.files = Object.fromEntries(Object.entries(sourceMap.files).sort(([left], [right]) => left.localeCompare(right)));
const temporary = `${sourceMapPath}.roles-clusters-diff-v2-${process.pid}.tmp`;
await writeFile(temporary, `${JSON.stringify(sourceMap, null, 2)}\n`, {flag: 'wx'});
await rename(temporary, sourceMapPath);
process.stdout.write(`Roles/clusters diff v2 source map updated: ${authoredFiles.length} authored files, ${Object.keys(sourceMap.files).length} total entries\n`);
