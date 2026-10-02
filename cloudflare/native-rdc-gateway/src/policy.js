export const PERMISSION_CLASSES = Object.freeze({
  READ_SAFE: 'READ_SAFE',
  READ_SENSITIVE: 'READ_SENSITIVE',
  WRITE_REVERSIBLE: 'WRITE_REVERSIBLE',
  WRITE_CONSEQUENTIAL: 'WRITE_CONSEQUENTIAL',
  SYSTEM_CONSEQUENTIAL: 'SYSTEM_CONSEQUENTIAL',
});

const KNOWN_PERMISSION_CLASSES = new Set(Object.values(PERMISSION_CLASSES));

export const REPLAY_POLICIES = Object.freeze({
  READ_REDISPATCH_ALLOWED: 'READ_REDISPATCH_ALLOWED',
  APPROVAL_SINGLE_USE: 'APPROVAL_SINGLE_USE',
});

export const GET_CONFIG_POLICY = Object.freeze({
  externalName: 'get_config',
  internalTool: 'get_config',
  permissionClass: PERMISSION_CLASSES.READ_SAFE,
  approvalRequired: false,
  timeoutMs: 15_000,
  replayPolicy: REPLAY_POLICIES.READ_REDISPATCH_ALLOWED,
  auditCategory: 'configuration-read',
  resourceBoundary: 'sanitized-config-only',
  invokeKey: 'getConfig',
  sanitizerKey: 'getConfig',
  descriptor: Object.freeze({
    name: 'get_config',
    title: 'Get Desktop Commander configuration',
    description: 'Use this when the user wants to inspect the current read-only Desktop Commander configuration and safety limits on their trusted Windows device.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({}),
      additionalProperties: false,
    }),
    annotations: Object.freeze({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    }),
  }),
});

export const DEFAULT_POLICY_REGISTRY = Object.freeze({
  [GET_CONFIG_POLICY.externalName]: GET_CONFIG_POLICY,
});

export function validatePolicyRegistry(registry = DEFAULT_POLICY_REGISTRY) {
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
    throw new Error('Native RDC policy registry must be an object');
  }
  const seenInternal = new Set();
  for (const [key, policy] of Object.entries(registry)) {
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
      throw new Error('Native RDC policy entry is malformed');
    }
    if (key !== policy.externalName || !/^[a-z][a-z0-9_]*$/.test(policy.externalName || '')) {
      throw new Error('Native RDC policy external name is invalid');
    }
    if (typeof policy.internalTool !== 'string' || !policy.internalTool) {
      throw new Error('Native RDC policy internal tool is invalid');
    }
    if (!KNOWN_PERMISSION_CLASSES.has(policy.permissionClass)) {
      throw new Error('Native RDC policy permission class is unknown');
    }
    if (typeof policy.approvalRequired !== 'boolean') {
      throw new Error('Native RDC policy approval requirement is invalid');
    }
    if (!Number.isInteger(policy.timeoutMs) || policy.timeoutMs < 1 || policy.timeoutMs > 30_000) {
      throw new Error('Native RDC policy timeout is invalid');
    }
    if (!Object.values(REPLAY_POLICIES).includes(policy.replayPolicy)) {
      throw new Error('Native RDC policy replay policy is invalid');
    }
    if (typeof policy.auditCategory !== 'string' || !policy.auditCategory) {
      throw new Error('Native RDC policy audit category is invalid');
    }
    if (typeof policy.resourceBoundary !== 'string' || !policy.resourceBoundary) {
      throw new Error('Native RDC policy resource boundary is invalid');
    }
    if (typeof policy.invokeKey !== 'string' || !policy.invokeKey
      || typeof policy.sanitizerKey !== 'string' || !policy.sanitizerKey) {
      throw new Error('Native RDC policy adapter mapping is invalid');
    }
    if (!policy.descriptor || policy.descriptor.name !== policy.externalName) {
      throw new Error('Native RDC policy descriptor is invalid');
    }
    if (seenInternal.has(policy.externalName + ':' + policy.internalTool)) {
      throw new Error('Native RDC policy mapping is duplicated');
    }
    seenInternal.add(policy.externalName + ':' + policy.internalTool);
  }
  return true;
}

validatePolicyRegistry(DEFAULT_POLICY_REGISTRY);

export function getPolicy(externalName, registry = DEFAULT_POLICY_REGISTRY) {
  if (typeof externalName !== 'string') return null;
  const policy = registry[externalName];
  return policy || null;
}

export function listPolicyDescriptors(registry = DEFAULT_POLICY_REGISTRY) {
  validatePolicyRegistry(registry);
  return Object.values(registry).map((policy) => policy.descriptor);
}
