import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const canonicalOwner = 'JoFe2';
const formerOwner = ['Jim', 'Pansky'].join('');
const formerOwnerPattern = new RegExp(formerOwner, 'i');

test('active KaleidoSphere repository links use the canonical owner', async () => {
  const readme = await readFile('README.md', 'utf8');
  const expectedTargets = [
    `https://github.com/${canonicalOwner}/KaleidoSphere/actions/workflows/ci.yml/badge.svg`,
    `https://github.com/${canonicalOwner}/KaleidoSphere/actions/workflows/ci.yml`,
    `https://img.shields.io/github/v/release/${canonicalOwner}/KaleidoSphere?sort=semver`,
    `https://github.com/${canonicalOwner}/KaleidoSphere/releases/latest`,
    `https://img.shields.io/github/license/${canonicalOwner}/KaleidoSphere`,
    `https://github.com/${canonicalOwner}/KaleidoSphere.git`,
  ];

  for (const target of expectedTargets) assert.match(readme, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(readme, formerOwnerPattern);
});

test('every former-owner reference is an exact preserved provenance, schema, or funding identity', async () => {
  const expected = [
    ['.github/FUNDING.yml', `github: ${formerOwner} # Replace with up to 4 GitHub Sponsors-enabled usernames e.g., [user1, user2]`],
    ['.github/FUNDING.yml', `buy_me_a_coffee: ${formerOwner.toLowerCase()}`],
    ['SOURCE-MAP.md', `[\`${formerOwner}/ChimpMaera\`](https://github.com/${formerOwner}/ChimpMaera)`],
    ['contracts/external-api/v2/external-bi-api.schema.json', `  "$id": "https://github.com/${formerOwner}/Superset_BI_Agent/contracts/external-api/v2/external-bi-api.schema.json",`],
  ];
  const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const observed = [];

  for (const file of tracked) {
    const contents = await readFile(file);
    if (contents.includes(0)) continue;
    for (const line of contents.toString('utf8').split(/\r?\n/)) {
      if (formerOwnerPattern.test(line)) observed.push([file, line]);
    }
  }

  assert.deepEqual(observed.sort(), expected.sort());
});
