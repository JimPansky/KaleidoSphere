import { canonicalJson } from '../canonical-json.js';
import { sha256Digest } from './core-contracts.mjs';

export const PLUGIN_MANIFEST_VERSION = 'chimpmaera.bi/plugin-manifest/v1';
export const CAPABILITY_DESCRIPTOR_VERSION = 'chimpmaera.bi/capability-descriptor/v1';
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ID = /^[a-z][a-z0-9.-]{1,127}$/;
const FORBIDDEN_KEY = /^(installUrl|installSource|npmPackage|filesystemPath|path|dynamicImport|hmr|watcher|runtimeEnablement|enableAtRuntime)$/i;
const FORBIDDEN_VALUE = /^(?:https?:|file:|npm:)/i;
const fail = (code) => { const error = new Error(code); error.code = code; throw error; };

function rejectDynamicSource(value) {
  if (Array.isArray(value)) return value.forEach(rejectDynamicSource);
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && FORBIDDEN_VALUE.test(value)) fail('PLUGIN_INSTALL_SOURCE_DENIED');
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) fail('PLUGIN_DYNAMIC_FIELD_DENIED');
    rejectDynamicSource(item);
  }
}

export function assertCapabilityDescriptor(descriptor) {
  if (!descriptor || descriptor.schemaVersion !== CAPABILITY_DESCRIPTOR_VERSION || !ID.test(descriptor.capabilityId ?? '')) fail('CAPABILITY_DESCRIPTOR_INVALID');
  if (!/^v[1-9][0-9]*$/.test(descriptor.contractVersion ?? '')) fail('CAPABILITY_CONTRACT_INVALID');
  if (!['low', 'medium', 'high', 'critical'].includes(descriptor.risk)) fail('CAPABILITY_RISK_INVALID');
  if (!['none', 'reversible', 'persistent', 'external'].includes(descriptor.sideEffect)) fail('CAPABILITY_SIDE_EFFECT_INVALID');
  if (!['public', 'internal', 'confidential', 'restricted'].includes(descriptor.dataClass)) fail('CAPABILITY_DATA_CLASS_INVALID');
  for (const fact of ['approval', 'cancellation', 'idempotency', 'readback', 'rollback', 'concurrency', 'enforcement']) {
    if (typeof descriptor[fact] !== 'string' || descriptor[fact].length < 2) fail('CAPABILITY_ENFORCEMENT_FACT_MISSING');
  }
  rejectDynamicSource(descriptor);
  return descriptor;
}

export function assertPluginManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== PLUGIN_MANIFEST_VERSION || !ID.test(manifest.pluginId ?? '')) fail('PLUGIN_MANIFEST_INVALID');
  if (manifest.builtIn !== true) fail('PLUGIN_NOT_BUILT_IN');
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(manifest.pluginVersion ?? '') || !DIGEST.test(manifest.artifactDigest ?? '')) fail('PLUGIN_ARTIFACT_IDENTITY_INVALID');
  if (!Array.isArray(manifest.provides) || !Array.isArray(manifest.requires)) fail('PLUGIN_DEPENDENCIES_INVALID');
  if (manifest.provides.some((item) => !ID.test(item.capabilityId ?? '') || !/^v[1-9][0-9]*$/.test(item.contractVersion ?? ''))) fail('PLUGIN_PROVIDES_INVALID');
  if (manifest.requires.some((item) => !ID.test(item.capabilityId ?? '') || !/^v[1-9][0-9]*$/.test(item.contractVersion ?? ''))) fail('PLUGIN_REQUIRES_INVALID');
  rejectDynamicSource(manifest);
  return manifest;
}

export function resolveBuiltInRegistry({ manifests, capabilities, expectedDigests = {} }) {
  if (!Array.isArray(manifests) || !Array.isArray(capabilities)) fail('PLUGIN_REGISTRY_INVALID');
  const descriptors = new Map();
  for (const descriptor of capabilities) {
    assertCapabilityDescriptor(descriptor);
    if (descriptors.has(descriptor.capabilityId)) fail('CAPABILITY_DUPLICATE');
    descriptors.set(descriptor.capabilityId, descriptor);
  }
  const plugins = new Map();
  const providers = new Map();
  for (const manifest of manifests) {
    assertPluginManifest(manifest);
    if (plugins.has(manifest.pluginId)) fail('PLUGIN_DUPLICATE');
    if (expectedDigests[manifest.pluginId] === undefined) fail('PLUGIN_UNKNOWN');
    if (expectedDigests[manifest.pluginId] !== manifest.artifactDigest) fail('PLUGIN_DIGEST_MISMATCH');
    plugins.set(manifest.pluginId, manifest);
    for (const provided of manifest.provides) {
      const descriptor = descriptors.get(provided.capabilityId);
      if (!descriptor || descriptor.contractVersion !== provided.contractVersion) fail('CAPABILITY_CONTRACT_MISMATCH');
      if (providers.has(provided.capabilityId)) fail('CAPABILITY_PROVIDER_AMBIGUOUS');
      providers.set(provided.capabilityId, manifest.pluginId);
    }
  }
  const edges = new Map([...plugins.keys()].map((id) => [id, new Set()]));
  for (const manifest of manifests) {
    for (const requirement of manifest.requires) {
      const providerId = providers.get(requirement.capabilityId);
      const descriptor = descriptors.get(requirement.capabilityId);
      if (!providerId || !descriptor) fail('PLUGIN_DEPENDENCY_UNKNOWN');
      if (descriptor.contractVersion !== requirement.contractVersion) fail('CAPABILITY_CONTRACT_MISMATCH');
      edges.get(manifest.pluginId).add(providerId);
    }
  }
  const order = [];
  const temporary = new Set();
  const permanent = new Set();
  const visit = (id) => {
    if (temporary.has(id)) fail('PLUGIN_DEPENDENCY_CYCLE');
    if (permanent.has(id)) return;
    temporary.add(id);
    for (const dependency of edges.get(id)) visit(dependency);
    temporary.delete(id);
    permanent.add(id);
    order.push(id);
  };
  [...plugins.keys()].sort().forEach(visit);
  const dump = { schemaVersion: 'chimpmaera.bi/resolved-capability-registry/v1', plugins: order.map((id) => plugins.get(id)), capabilities: [...descriptors.values()].sort((a, b) => a.capabilityId.localeCompare(b.capabilityId)) };
  return Object.freeze({ order: Object.freeze(order), dump: canonicalJson(dump), hash: sha256Digest(dump) });
}
