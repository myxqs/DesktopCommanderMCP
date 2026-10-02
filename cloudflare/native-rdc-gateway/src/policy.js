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

const emptyInput = Object.freeze({
  type: 'object',
  properties: Object.freeze({}),
  additionalProperties: false,
});

const pathInput = Object.freeze({
  type: 'object',
  properties: Object.freeze({
    path: Object.freeze({ type: 'string', minLength: 1, maxLength: 4096 }),
  }),
  required: Object.freeze(['path']),
  additionalProperties: false,
});

const listDirectoryInput = Object.freeze({
  type: 'object',
  properties: Object.freeze({
    path: Object.freeze({ type: 'string', minLength: 1, maxLength: 4096 }),
    depth: Object.freeze({ type: 'integer', minimum: 1, maximum: 2, default: 1 }),
  }),
  required: Object.freeze(['path']),
  additionalProperties: false,
});

const readFileInput = Object.freeze({
  type: 'object',
  properties: Object.freeze({
    path: Object.freeze({ type: 'string', minLength: 1, maxLength: 4096 }),
    offset: Object.freeze({ type: 'integer', minimum: 0, maximum: 100000, default: 0 }),
    length: Object.freeze({ type: 'integer', minimum: 1, maximum: 200, default: 200 }),
  }),
  required: Object.freeze(['path']),
  additionalProperties: false,
});

function readPolicy({
  externalName,
  internalTool,
  permissionClass,
  title,
  description,
  inputSchema,
  resourceBoundary,
  auditCategory,
  sanitizerKey = 'boundedText',
  timeoutMs = 15_000,
}) {
  return Object.freeze({
    externalName,
    internalTool,
    permissionClass,
    approvalRequired: false,
    timeoutMs,
    replayPolicy: REPLAY_POLICIES.READ_REDISPATCH_ALLOWED,
    auditCategory,
    resourceBoundary,
    invokeKey: 'remoteRead',
    sanitizerKey,
    descriptor: Object.freeze({
      name: externalName,
      title,
      description,
      inputSchema,
      annotations: Object.freeze({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      }),
    }),
  });
}

export const GET_CONFIG_POLICY = readPolicy({
  externalName: 'get_config',
  internalTool: 'get_config',
  permissionClass: PERMISSION_CLASSES.READ_SAFE,
  title: 'Get Desktop Commander configuration',
  description: 'Inspect the sanitized Desktop Commander configuration and safety limits.',
  inputSchema: emptyInput,
  resourceBoundary: 'sanitized-config-only',
  auditCategory: 'configuration-read',
  sanitizerKey: 'getConfig',
});

export const LIST_PROCESSES_POLICY = readPolicy({
  externalName: 'list_processes',
  internalTool: 'list_processes',
  permissionClass: PERMISSION_CLASSES.READ_SENSITIVE,
  title: 'List running processes',
  description: 'List running processes on the trusted Windows device with bounded output.',
  inputSchema: emptyInput,
  resourceBoundary: 'process-summary-only',
  auditCategory: 'process-read',
});

export const LIST_DIRECTORY_POLICY = readPolicy({
  externalName: 'list_directory',
  internalTool: 'list_directory',
  permissionClass: PERMISSION_CLASSES.READ_SENSITIVE,
  title: 'List approved directory',
  description: 'List files within an explicitly approved Native RDC read root, at depth 1 or 2.',
  inputSchema: listDirectoryInput,
  resourceBoundary: 'approved-read-roots',
  auditCategory: 'filesystem-read',
});

export const GET_FILE_INFO_POLICY = readPolicy({
  externalName: 'get_file_info',
  internalTool: 'get_file_info',
  permissionClass: PERMISSION_CLASSES.READ_SENSITIVE,
  title: 'Get approved file metadata',
  description: 'Get metadata for a file or directory within an explicitly approved Native RDC read root.',
  inputSchema: pathInput,
  resourceBoundary: 'approved-read-roots',
  auditCategory: 'filesystem-read',
});

export const READ_FILE_POLICY = readPolicy({
  externalName: 'read_file',
  internalTool: 'read_file',
  permissionClass: PERMISSION_CLASSES.READ_SENSITIVE,
  title: 'Read approved text file',
  description: 'Read up to 200 lines of an approved text file inside an explicitly approved Native RDC read root.',
  inputSchema: readFileInput,
  resourceBoundary: 'approved-read-roots:text-only:200-lines',
  auditCategory: 'filesystem-read',
});

export const DEFAULT_POLICY_REGISTRY = Object.freeze({
  [GET_CONFIG_POLICY.externalName]: GET_CONFIG_POLICY,
  [LIST_PROCESSES_POLICY.externalName]: LIST_PROCESSES_POLICY,
  [LIST_DIRECTORY_POLICY.externalName]: LIST_DIRECTORY_POLICY,
  [GET_FILE_INFO_POLICY.externalName]: GET_FILE_INFO_POLICY,
  [READ_FILE_POLICY.externalName]: READ_FILE_POLICY,
});

export function validatePolicyRegistry(registry = DEFAULT_POLICY_REGISTRY) {
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
    throw new Error('Native RDC policy registry must be an object');
  }
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
    if (typeof policy.auditCategory !== 'string' || !policy.auditCategory
      || typeof policy.resourceBoundary !== 'string' || !policy.resourceBoundary) {
      throw new Error('Native RDC policy boundary metadata is invalid');
    }
    if (typeof policy.invokeKey !== 'string' || !policy.invokeKey
      || typeof policy.sanitizerKey !== 'string' || !policy.sanitizerKey) {
      throw new Error('Native RDC policy adapter mapping is invalid');
    }
    if (!policy.descriptor || policy.descriptor.name !== policy.externalName
      || !policy.descriptor.inputSchema) {
      throw new Error('Native RDC policy descriptor is invalid');
    }
  }
  return true;
}

validatePolicyRegistry(DEFAULT_POLICY_REGISTRY);

export function getPolicy(externalName, registry = DEFAULT_POLICY_REGISTRY) {
  if (typeof externalName !== 'string') return null;
  return registry[externalName] || null;
}

export function listPolicyDescriptors(registry = DEFAULT_POLICY_REGISTRY) {
  validatePolicyRegistry(registry);
  return Object.values(registry).map((policy) => policy.descriptor);
}
