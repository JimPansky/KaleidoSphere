#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { buildPromotionBundle, inspectPromotionBundle, preflightPromotionBundle, writePromotionBundle } from './promotion-bundle.mjs';

function fail(message) {
  process.stderr.write(`KaleidoSphere promotion bundle ERROR: ${message}\n`);
  process.exit(2);
}

function args(values) {
  const result = { _: [] };
  for (let index = 0; index < values.length; index += 1) {
    if (!values[index].startsWith('--')) result._.push(values[index]);
    else {
      const key = values[index].slice(2);
      const value = values[index + 1];
      if (!value || value.startsWith('--')) fail(`missing value for --${key}`);
      result[key] = value;
      index += 1;
    }
  }
  return result;
}

function render(report, human) {
  if (!human) return `${JSON.stringify(report, null, 2)}\n`;
  const inspection = report.inspection ?? report;
  return [
    `Status: ${report.status}`,
    `Contract: ${report.contract_version}`,
    `Bundle: ${inspection.bundle_id ?? 'unavailable'}`,
    `Archive SHA-256: ${inspection.archive_sha256 ?? 'unavailable'}`,
    `Assets: ${inspection.asset_count ?? 'unavailable'}`,
    `Mutation performed: ${report.mutation_performed}`,
    ...(report.reasons?.length ? [`Reasons: ${report.reasons.join(', ')}`] : []),
  ].join('\n') + '\n';
}

const parsed = args(process.argv.slice(2));
const command = parsed._[0];
const human = parsed.human === 'true';
const now = parsed.now ? new Date(parsed.now) : new Date();

if (command === 'build') {
  if (!parsed.input || !parsed.output) fail('usage: promotion-bundle build --input INPUT.json --output REVIEW.zip [--now ISO] [--human true]');
  const input = JSON.parse(await readFile(parsed.input, 'utf8'));
  const result = await buildPromotionBundle(input, { contractDir: path.resolve('contracts/superset-promotion-bundle/v1'), now });
  const written = await writePromotionBundle(result, parsed.output);
  process.stdout.write(render({ ...result.inspection, output: written }, human));
} else if (command === 'inspect' || command === 'preflight') {
  if (!parsed.bundle) fail(`usage: promotion-bundle ${command} --bundle REVIEW.zip [--now ISO] [--human true]`);
  const archive = await readFile(parsed.bundle);
  const report = command === 'inspect' ? inspectPromotionBundle(archive, { now }) : preflightPromotionBundle(archive, { now });
  process.stdout.write(render(report, human));
  if (report.status === 'BLOCKED') process.exitCode = 2;
} else fail('usage: promotion-bundle {build|inspect|preflight} ...');
