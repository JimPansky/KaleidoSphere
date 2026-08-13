import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { identitySha256, normalizeJsonValue } from './core.mjs';

export const SOURCE_REGISTRY_SCHEMA = 'chimpmaera.db/source-registry/v1';
export const OPERATION_PROFILE_REF_SCHEMA = 'chimpmaera.db/operation-profile-ref/v1';
export const OPERATION_RESOLUTION_SCHEMA = 'chimpmaera.db/operation-resolution/v1';

const fail = (code) => {
  const error = new Error(code);
  error.code = code;
  throw error;
};

const exactKeys = (value, keys) => value
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));

const id = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{2,63}$/.test(value);
const semver = (value) => typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value);
const name = (value) => typeof value === 'string' && value.length > 0 && value.length <= 128
  && value === value.normalize('NFC') && !/[\u0000-\u001f\u007f]/.test(value);
const basename = (value) => typeof value === 'string' && value === path.basename(value) && value !== '.' && value !== '..';
const same = (left, right) => identitySha256(left) === identitySha256(right);

function validateScope(scope) {
  if (!exactKeys(scope, ['database', 'container', 'schemas'])
    || !name(scope.database)
    || !(scope.container === null || name(scope.container))
    || !Array.isArray(scope.schemas) || scope.schemas.length === 0
    || scope.schemas.some((schema) => !name(schema))
    || new Set(scope.schemas).size !== scope.schemas.length) fail('DB_REGISTRY_SCOPE_INVALID');
  return scope;
}

function validatePolicy(policy) {
  if (!exactKeys(policy, ['access', 'allowRowSamples', 'maxQueryTimeoutMs'])
    || policy.access !== 'READ_ONLY' || policy.allowRowSamples !== false
    || !Number.isInteger(policy.maxQueryTimeoutMs) || policy.maxQueryTimeoutMs < 1) {
    fail('DB_REGISTRY_POLICY_INVALID');
  }
  return policy;
}

function validateCapabilityPack(pack) {
  if (!exactKeys(pack, ['capabilityPackId', 'capabilityPackVersion', 'engines', 'queryPackVersion', 'normalizerVersion', 'capabilities'])
    || !id(pack.capabilityPackId) || !semver(pack.capabilityPackVersion)
    || !Array.isArray(pack.engines) || pack.engines.length !== 2
    || !same([...pack.engines].sort(), ['mssql', 'oracle'])
    || pack.queryPackVersion !== 'v1' || pack.normalizerVersion !== 'v1'
    || !Array.isArray(pack.capabilities) || pack.capabilities.length === 0
    || pack.capabilities.some((capability) => typeof capability !== 'string' || !/^[A-Z][A-Z0-9_]{2,63}$/.test(capability))
    || new Set(pack.capabilities).size !== pack.capabilities.length) fail('DB_REGISTRY_CAPABILITY_PACK_INVALID');
  return pack;
}

function validateAdapter(engine, adapter) {
  if (!exactKeys(adapter, ['kind', 'host', 'port', 'principal', 'transport'])
    || adapter.kind !== engine || !name(adapter.host)
    || !Number.isInteger(adapter.port) || adapter.port < 1 || adapter.port > 65535
    || !name(adapter.principal)
    || !exactKeys(adapter.transport, ['encrypt', 'trustServerCertificate'])
    || adapter.transport.encrypt !== true
    || typeof adapter.transport.trustServerCertificate !== 'boolean') fail('DB_REGISTRY_ADAPTER_INVALID');
  return adapter;
}

function validateCredentialProvider(provider) {
  if (!exactKeys(provider, ['kind', 'reference']) || provider.kind !== 'ENV'
    || typeof provider.reference !== 'string' || !/^[A-Z][A-Z0-9_]{2,127}$/.test(provider.reference)) {
    fail('DB_REGISTRY_CREDENTIAL_PROVIDER_INVALID');
  }
  return provider;
}

export function validateSourceRegistry(registry) {
  if (!exactKeys(registry, ['schemaVersion', 'registryId', 'registryVersion', 'capabilityPacks', 'sources'])
    || registry.schemaVersion !== SOURCE_REGISTRY_SCHEMA || !id(registry.registryId)
    || !semver(registry.registryVersion)
    || !Array.isArray(registry.capabilityPacks) || registry.capabilityPacks.length === 0
    || !Array.isArray(registry.sources) || registry.sources.length === 0) fail('DB_SOURCE_REGISTRY_INVALID');
  const packs = new Map();
  for (const pack of registry.capabilityPacks) {
    validateCapabilityPack(pack);
    const key = `${pack.capabilityPackId}@${pack.capabilityPackVersion}`;
    if (packs.has(key)) fail('DB_REGISTRY_CAPABILITY_PACK_DUPLICATE');
    packs.set(key, pack);
  }
  const sources = new Set();
  for (const source of registry.sources) {
    if (!exactKeys(source, ['sourceId', 'engine', 'scope', 'policy', 'capabilityPackRef', 'enabledCapabilities', 'adapter', 'credentialProvider'])
      || !id(source.sourceId) || sources.has(source.sourceId)
      || !['mssql', 'oracle'].includes(source.engine)
      || !exactKeys(source.capabilityPackRef, ['capabilityPackId', 'capabilityPackVersion'])) fail('DB_REGISTRY_SOURCE_INVALID');
    sources.add(source.sourceId);
    validateScope(source.scope);
    validatePolicy(source.policy);
    validateAdapter(source.engine, source.adapter);
    validateCredentialProvider(source.credentialProvider);
    const pack = packs.get(`${source.capabilityPackRef.capabilityPackId}@${source.capabilityPackRef.capabilityPackVersion}`);
    if (!pack || !pack.engines.includes(source.engine)) fail('DB_REGISTRY_CAPABILITY_BINDING_INVALID');
    if (!Array.isArray(source.enabledCapabilities) || source.enabledCapabilities.length === 0
      || source.enabledCapabilities.some((capability) => !pack.capabilities.includes(capability))
      || new Set(source.enabledCapabilities).size !== source.enabledCapabilities.length) fail('DB_REGISTRY_CAPABILITY_WIDENING_DENIED');
  }
  return registry;
}

export function resolveOperationProfile({ profileRef, registry }) {
  validateSourceRegistry(registry);
  if (!exactKeys(profileRef, ['schemaVersion', 'profileId', 'registryFile', 'sourceId', 'expected'])
    || profileRef.schemaVersion !== OPERATION_PROFILE_REF_SCHEMA || !id(profileRef.profileId)
    || !basename(profileRef.registryFile) || !id(profileRef.sourceId)
    || !exactKeys(profileRef.expected, ['engine', 'scope', 'policy', 'capabilityPackRef'])) fail('DB_OPERATION_PROFILE_REF_INVALID');
  const source = registry.sources.find((entry) => entry.sourceId === profileRef.sourceId);
  if (!source) fail('DB_REGISTRY_SOURCE_NOT_FOUND');
  if (profileRef.expected.engine !== source.engine
    || !same(profileRef.expected.scope, source.scope)
    || !same(profileRef.expected.policy, source.policy)
    || !same(profileRef.expected.capabilityPackRef, source.capabilityPackRef)) fail('DB_OPERATION_PROFILE_BINDING_DRIFT');
  const pack = registry.capabilityPacks.find((entry) => same(source.capabilityPackRef, {
    capabilityPackId: entry.capabilityPackId,
    capabilityPackVersion: entry.capabilityPackVersion,
  }));
  if (!pack) fail('DB_REGISTRY_CAPABILITY_BINDING_INVALID');
  const body = normalizeJsonValue({
    schemaVersion: OPERATION_RESOLUTION_SCHEMA,
    profileId: profileRef.profileId,
    registry: { registryId: registry.registryId, registryVersion: registry.registryVersion },
    source: {
      sourceId: source.sourceId,
      engine: source.engine,
      scope: source.scope,
      policy: source.policy,
      adapter: source.adapter,
      credentialProvider: source.credentialProvider,
    },
    capabilityPack: {
      capabilityPackId: pack.capabilityPackId,
      capabilityPackVersion: pack.capabilityPackVersion,
      queryPackVersion: pack.queryPackVersion,
      normalizerVersion: pack.normalizerVersion,
      enabledCapabilities: [...source.enabledCapabilities].sort(),
    },
    runtimeValidation: 'NOT_EXECUTED',
    claims: { credentialsResolved: false, sourceConnected: false, runtimeCompatibilityValidated: false },
  });
  return { ...body, resolutionSha256: identitySha256(body) };
}

export async function loadAndResolveOperationProfile(profileFile) {
  const resolvedProfile = path.resolve(profileFile);
  const profileRef = JSON.parse(await readFile(resolvedProfile, 'utf8'));
  if (!basename(profileRef.registryFile)) fail('DB_OPERATION_PROFILE_REF_INVALID');
  const registry = JSON.parse(await readFile(path.join(path.dirname(resolvedProfile), profileRef.registryFile), 'utf8'));
  return resolveOperationProfile({ profileRef, registry });
}
