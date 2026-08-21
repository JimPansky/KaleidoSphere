import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  EXTERNAL_API_V2_RUNTIME_INTENTS,
  validatePortableUtilityRequestV1,
} from '../services/bi-control/src/portable-companion/contract.mjs';
import {
  PORTABLE_PROFILE_TEMPLATE_SCHEMA,
  portableProfileTemplateRequest,
  validatePortableProfileTemplate,
  validatePortableProfileTemplateReport,
  validatePortableProfileTemplateRequest,
} from '../services/bi-control/src/portable-companion/template-validator.mjs';

async function fixture(name) {
  return JSON.parse(await readFile(`services/bi-control/fixtures/portable-companion/${name}.json`, 'utf8'));
}

const secretLike = /(?:sk-[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9_]{20,}|bearer\s+[a-z0-9._:-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:postgres(?:ql)?|mysql|mssql|oracle|mongodb(?:\+srv)?|jdbc):\/\/|https?:\/\/|wss?:\/\/|"dispatch":true)/i;

test('K4e.3 validates placeholder-only analysis profile template', async () => {
  const template = await fixture('template-analysis');
  const report = validatePortableProfileTemplateReport(validatePortableProfileTemplate(template));

  assert.equal(template.schemaVersion, PORTABLE_PROFILE_TEMPLATE_SCHEMA);
  assert.equal(report.validation.status, 'VALID_PLACEHOLDER_ONLY');
  assert.equal(report.template.templateKind, 'analysis-profile');
  assert.equal(report.template.selectedRuntimeIntent, 'analyze');
  assert.deepEqual(report.externalApiV2.runtimeIntents, EXTERNAL_API_V2_RUNTIME_INTENTS);
  assert.equal(report.externalApiV2.selectedRuntimeIntent, 'analyze');
  assert.equal(report.boundaries.runtimeDispatchAccepted, false);
  assert.equal(report.boundaries.credentialsAccepted, false);
  assert.equal(report.boundaries.freeSqlAccepted, false);
  assert(report.template.secretReferences.every((item) => /^\$\{[A-Z][A-Z0-9_]{2,80}\}$/.test(item.ref)));
});

test('K4e.3 validates preview and readback placeholder templates without dispatch authority', async () => {
  for (const name of ['template-preview', 'template-readback']) {
    const report = validatePortableProfileTemplateReport(validatePortableProfileTemplate(await fixture(name)));
    assert.equal(report.template.constraints.dispatch, false);
    assert.equal(report.template.constraints.allowRuntimeDispatch, false);
    assert.equal(report.template.constraints.allowArbitraryEndpoints, false);
    assert.equal(report.template.constraints.allowRawRows, false);
    assert.doesNotMatch(JSON.stringify(report), secretLike);
  }
});

test('K4e.3 validator request remains a reserved empty-input Portable Companion utility', () => {
  assert.throws(() => validatePortableUtilityRequestV1(portableProfileTemplateRequest()), /PORTABLE_COMPANION_RESERVED_ACTION_DENIED/);
  assert.equal(validatePortableProfileTemplateRequest(portableProfileTemplateRequest()).action, 'profile-template.validate');
  assert.throws(() => validatePortableProfileTemplateRequest({ ...portableProfileTemplateRequest(), input: { templateId: 'template.analysis.placeholder' } }), /PORTABLE_COMPANION_REQUEST_INPUT_DENIED/);
});

test('K4e.3 profile-template schema is closed and placeholder-only', async () => {
  const schema = JSON.parse(await readFile('contracts/portable-companion/v1/profile-template.schema.json', 'utf8'));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.schemaVersion.const, PORTABLE_PROFILE_TEMPLATE_SCHEMA);
  assert.equal(schema.properties.placeholders.additionalProperties, false);
  assert.equal(schema.properties.secretReferences.items.additionalProperties, false);
  assert.equal(schema.properties.constraints.properties.dispatch.const, false);
  assert.equal(schema.properties.constraints.properties.allowRuntimeDispatch.const, false);
  assert.equal(schema.properties.constraints.properties.allowCredentialValues.const, false);
  assert.equal(schema.properties.constraints.properties.allowArbitraryEndpoints.const, false);
  assert.equal(schema.properties.constraints.properties.allowFreeSql.const, false);
  assert.equal(schema.properties.constraints.properties.allowRawRows.const, false);
  assert.equal(schema.$defs.EnvPlaceholder.pattern, '^\\$\\{[A-Z][A-Z0-9_]{2,80}\\}$');
});

test('K4e.3 generated placeholder reports contain no secret-looking values or endpoints', async () => {
  for (const name of ['template-analysis', 'template-preview', 'template-readback']) {
    const report = validatePortableProfileTemplateReport(validatePortableProfileTemplate(await fixture(name)));
    assert.doesNotMatch(JSON.stringify(report), secretLike);
  }
});

const secretValueCases = [
  ['password value', { placeholders: { objectiveRef: 'password=hunter2' } }, /PORTABLE_PROFILE_TEMPLATE_SECRET_VALUE_DENIED/],
  ['API token value', { placeholders: { objectiveRef: `sk-${'a'.repeat(32)}` } }, /PORTABLE_PROFILE_TEMPLATE_SECRET_VALUE_DENIED/],
  ['bearer token value', { placeholders: { objectiveRef: `Bearer ${'a'.repeat(24)}` } }, /PORTABLE_PROFILE_TEMPLATE_SECRET_VALUE_DENIED/],
  ['DSN value', { placeholders: { objectiveRef: 'postgresql://user:pass@db.example.invalid:5432/app' } }, /PORTABLE_PROFILE_TEMPLATE_SECRET_VALUE_DENIED/],
  ['private key value', { placeholders: { objectiveRef: '-----BEGIN PRIVATE KEY-----' } }, /PORTABLE_PROFILE_TEMPLATE_SECRET_VALUE_DENIED/],
];

for (const [name, patch, expected] of secretValueCases) {
  test(`K4e.3 negative rejects ${name}`, async () => {
    const template = await fixture('template-analysis');
    Object.assign(template.placeholders, patch.placeholders);
    assert.throws(() => validatePortableProfileTemplate(template), expected);
  });
}

test('K4e.3 negative rejects raw database endpoint or arbitrary URL', async () => {
  const template = await fixture('template-analysis');
  template.placeholders.objectiveRef = 'https://db.example.invalid/probe';
  assert.throws(() => validatePortableProfileTemplate(template), /PORTABLE_PROFILE_TEMPLATE_ARBITRARY_ENDPOINT_DENIED/);
});

test('K4e.3 negative rejects unknown profile key', async () => {
  const template = await fixture('template-analysis');
  template.extraProfileKey = '${KS_EXTRA_REF}';
  assert.throws(() => validatePortableProfileTemplate(template), /PORTABLE_PROFILE_TEMPLATE_SURFACE_DENIED/);
});

test('K4e.3 negative rejects free SQL field', async () => {
  const template = await fixture('template-analysis');
  template.freeSql = 'select * from orders';
  assert.throws(() => validatePortableProfileTemplate(template), /PORTABLE_PROFILE_TEMPLATE_SURFACE_DENIED/);
});

test('K4e.3 negative rejects free SQL text in allowed placeholder slot', async () => {
  const template = await fixture('template-analysis');
  template.placeholders.objectiveRef = 'select * from orders';
  assert.throws(() => validatePortableProfileTemplate(template), /PORTABLE_PROFILE_TEMPLATE_FREE_SQL_DENIED/);
});

test('K4e.3 negative rejects runtime dispatch request', async () => {
  const template = await fixture('template-analysis');
  template.constraints.dispatch = true;
  assert.throws(() => validatePortableProfileTemplate(template), /PORTABLE_PROFILE_TEMPLATE_BOUNDARY_DENIED/);
});

test('K4e.3 negative rejects runtime-intent widening in generated report', async () => {
  const report = structuredClone(validatePortableProfileTemplate(await fixture('template-analysis')));
  report.externalApiV2.runtimeIntents.push('apply');
  assert.throws(() => validatePortableProfileTemplateReport(report), /PORTABLE_PROFILE_TEMPLATE_RUNTIME_INTENT_WIDENING_DENIED|PORTABLE_PROFILE_TEMPLATE_REPORT_INTEGRITY_DENIED/);
});
