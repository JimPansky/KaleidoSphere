import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('mechanically copied source bytes match the content-addressed source map', async () => {
  const sourceMap = JSON.parse(await readFile('SOURCE-MAP.json', 'utf8'));
  assert.equal(sourceMap.sourceCommit, 'cee9fd5835ac3527af54b5974b5d53414eac88d8');
  for (const [file, expected] of Object.entries(sourceMap.files)) {
    const actual = createHash('sha256').update(await readFile(file)).digest('hex');
    assert.equal(actual, expected, file);
  }
});
