const fail = (code, details) => {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  throw error;
};

function checkType(value, expected) {
  if (expected === 'array') return Array.isArray(value);
  if (expected === 'integer') return Number.isInteger(value);
  if (expected === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (expected === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
  return typeof value === expected;
}

function resolveRef(schema, ref) {
  if (!ref.startsWith('#/$defs/')) fail('SCHEMA_REF_UNSUPPORTED', { ref });
  const key = ref.slice('#/$defs/'.length);
  if (!schema.$defs?.[key]) fail('SCHEMA_REF_MISSING', { ref });
  return schema.$defs[key];
}

function validateNode(root, schema, value, path, errors) {
  if (schema.$ref) return validateNode(root, resolveRef(root, schema.$ref), value, path, errors);
  if (Object.hasOwn(schema, 'const') && value !== schema.const) errors.push(`${path}:const`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}:enum`);
  if (schema.type && !checkType(value, schema.type)) {
    errors.push(`${path}:type:${schema.type}`);
    return;
  }
  if (schema.type === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}:minLength`);
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) errors.push(`${path}:pattern`);
  }
  if (schema.type === 'integer' || schema.type === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}:minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}:maximum`);
  }
  if (schema.type === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}:minItems`);
    if (schema.items) value.forEach((item, index) => validateNode(root, schema.items, item, `${path}/${index}`, errors));
  }
  if (schema.type === 'object') {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${path}/${key}:required`);
    const allowed = new Set(Object.keys(schema.properties ?? {}));
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${path}/${key}:additional`);
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) validateNode(root, child, value[key], `${path}/${key}`, errors);
    }
  }
}

export function validateOrThrow(value, schema, label = 'document') {
  const errors = [];
  validateNode(schema, schema, value, label, errors);
  if (errors.length) fail('SCHEMA_VALIDATION_FAILED', { label, errors });
  return true;
}

export function assertNoForbiddenPersistence(value, forbiddenFields, path = '$') {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenPersistence(item, forbiddenFields, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, '_');
    if (forbiddenFields.some((field) => normalized === field || normalized.includes(field))) fail('FORBIDDEN_PERSISTED_FIELD', { path: `${path}.${key}` });
    if (typeof child === 'string' && /\b(bearer\s+[a-z0-9._:-]{8,}|password|secret|chain.?of.?thought|raw source row)\b/i.test(child)) fail('FORBIDDEN_PERSISTED_VALUE', { path: `${path}.${key}` });
    assertNoForbiddenPersistence(child, forbiddenFields, `${path}.${key}`);
  }
}
