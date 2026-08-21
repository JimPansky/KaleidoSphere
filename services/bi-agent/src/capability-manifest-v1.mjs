import {
  canonicalJson,
  capabilityAttestationV2,
  SBA_EXTERNAL_CAPABILITIES,
  sha256Digest,
} from './external-api-v2.mjs';

export const KS_CAPABILITY_MANIFEST_SCHEMA = 'kaleidosphere.external/capability-manifest/v1';
export const KS_CAPABILITY_MANIFEST_VERSION = '1.0.0';

const externalCapabilities = SBA_EXTERNAL_CAPABILITIES.filter((item) => item.externalIntent !== false);
const expectedIds = new Set(externalCapabilities.map((item) => item.id));

const fail = (code) => {
  const error = new Error(code);
  error.code = code;
  throw error;
};

function exact(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) fail('CAPABILITY_MANIFEST_INVALID');
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key))) {
    fail('CAPABILITY_MANIFEST_SURFACE_DENIED');
  }
}

function projectedCapability(item) {
  return {
    id: item.id,
    action: item.action,
    executable: true,
    authority: item.authority,
    sideEffect: item.authority === 'local-evidence-write' ? 'reversible-local-evidence' : 'none',
    evidence: {
      attestationBindingRequired: true,
      resultIntegrityDigestRequired: true,
      executionReceiptRequired: true,
    },
  };
}

function manifestBody(attestation) {
  return {
    schemaVersion: KS_CAPABILITY_MANIFEST_SCHEMA,
    manifestVersion: KS_CAPABILITY_MANIFEST_VERSION,
    product: attestation.product,
    contract: attestation.contract,
    attestation: {
      schemaVersion: attestation.schemaVersion,
      digest: attestation.attestation.digest,
    },
    capabilities: externalCapabilities.map(projectedCapability),
    boundaries: {
      externalIntentOnly: true,
      sourceDatabaseCredentialsAccepted: false,
      freeSqlAccepted: false,
      rawSourceRowsReturned: false,
      modelMutationAuthority: false,
      directSupersetMutationIntentAccepted: false,
      persistentSupersetWorkflow: attestation.boundaries.persistentSupersetWorkflow,
    },
  };
}

export function capabilityManifestV1() {
  const body = manifestBody(capabilityAttestationV2());
  return Object.freeze({
    ...body,
    integrity: Object.freeze({algorithm: 'sha256-canonical-json', digest: sha256Digest(body)}),
  });
}

export function validateCapabilityManifestV1(value, expectedAttestation = capabilityAttestationV2()) {
  exact(value, ['schemaVersion', 'manifestVersion', 'product', 'contract', 'attestation', 'capabilities', 'boundaries', 'integrity']);
  exact(value.product, ['id', 'version', 'component']);
  exact(value.contract, ['id', 'version']);
  exact(value.attestation, ['schemaVersion', 'digest']);
  exact(value.boundaries, [
    'externalIntentOnly',
    'sourceDatabaseCredentialsAccepted',
    'freeSqlAccepted',
    'rawSourceRowsReturned',
    'modelMutationAuthority',
    'directSupersetMutationIntentAccepted',
    'persistentSupersetWorkflow',
  ]);
  exact(value.integrity, ['algorithm', 'digest']);
  if (!Array.isArray(value.capabilities)) fail('CAPABILITY_MANIFEST_INVALID');

  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'integrity'));
  if (value.integrity.algorithm !== 'sha256-canonical-json'
    || value.integrity.digest !== sha256Digest(body)) fail('CAPABILITY_MANIFEST_INTEGRITY_DENIED');
  if (value.schemaVersion !== KS_CAPABILITY_MANIFEST_SCHEMA
    || value.manifestVersion !== KS_CAPABILITY_MANIFEST_VERSION) fail('CAPABILITY_MANIFEST_VERSION_DENIED');

  const expectedBody = manifestBody(expectedAttestation);
  if (canonicalJson(value.product) !== canonicalJson(expectedBody.product)
    || canonicalJson(value.contract) !== canonicalJson(expectedBody.contract)
    || canonicalJson(value.attestation) !== canonicalJson(expectedBody.attestation)) {
    fail('CAPABILITY_MANIFEST_STALE_DENIED');
  }

  const seen = new Set();
  for (const item of value.capabilities) {
    exact(item, ['id', 'action', 'executable', 'authority', 'sideEffect', 'evidence']);
    exact(item.evidence, ['attestationBindingRequired', 'resultIntegrityDigestRequired', 'executionReceiptRequired'], []);
    if (!expectedIds.has(item.id)) fail('CAPABILITY_MANIFEST_UNKNOWN_CAPABILITY_DENIED');
    if (seen.has(item.id)) fail('CAPABILITY_MANIFEST_DUPLICATE_CAPABILITY_DENIED');
    seen.add(item.id);
    if (item.executable !== true) fail('CAPABILITY_MANIFEST_CAPABILITY_NOT_EXECUTABLE');
    if (item.evidence.attestationBindingRequired !== true
      || item.evidence.resultIntegrityDigestRequired !== true
      || item.evidence.executionReceiptRequired !== true) {
      fail('CAPABILITY_MANIFEST_EVIDENCE_MISSING_DENIED');
    }
    const expected = expectedBody.capabilities.find((candidate) => candidate.id === item.id);
    if (canonicalJson(item) !== canonicalJson(expected)) fail('CAPABILITY_MANIFEST_CAPABILITY_DRIFT_DENIED');
  }
  if (seen.size !== expectedIds.size) fail('CAPABILITY_MANIFEST_CAPABILITY_SET_DENIED');
  if (canonicalJson(value.boundaries) !== canonicalJson(expectedBody.boundaries)) {
    fail('CAPABILITY_MANIFEST_BOUNDARY_DRIFT_DENIED');
  }
  return value;
}

export function requireExternalCapabilityV1(value, capabilityId, action) {
  const manifest = validateCapabilityManifestV1(value);
  const capability = manifest.capabilities.find((item) => item.id === capabilityId);
  if (!capability) fail('CAPABILITY_MANIFEST_UNKNOWN_CAPABILITY_DENIED');
  if (action !== undefined && capability.action !== action) fail('CAPABILITY_MANIFEST_ACTION_BINDING_DENIED');
  return capability;
}
