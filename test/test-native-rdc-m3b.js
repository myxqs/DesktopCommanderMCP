import assert from 'node:assert/strict';
import {
  DEFAULT_POLICY_REGISTRY,
  GET_CONFIG_POLICY,
  PERMISSION_CLASSES,
  REPLAY_POLICIES,
  getPolicy,
  listPolicyDescriptors,
  validatePolicyRegistry,
} from '../cloudflare/native-rdc-gateway/src/policy.js';
import { GET_CONFIG_TOOL } from '../cloudflare/native-rdc-gateway/src/mcp.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('permission classes are explicit and closed', () => {
  assert.deepEqual(Object.values(PERMISSION_CLASSES), [
    'READ_SAFE',
    'READ_SENSITIVE',
    'WRITE_REVERSIBLE',
    'WRITE_CONSEQUENTIAL',
    'SYSTEM_CONSEQUENTIAL',
  ]);
});

test('default registry validates and exposes only explicit registered tools', () => {
  assert.equal(validatePolicyRegistry(DEFAULT_POLICY_REGISTRY), true);
  assert.deepEqual(Object.keys(DEFAULT_POLICY_REGISTRY), [
    'get_config',
    'list_processes',
    'list_directory',
    'get_file_info',
    'read_file',
  ]);
  assert.deepEqual(listPolicyDescriptors().map((tool) => tool.name), Object.keys(DEFAULT_POLICY_REGISTRY));
});

test('get_config policy is explicit read safe and redispatchable', () => {
  assert.equal(GET_CONFIG_POLICY.externalName, 'get_config');
  assert.equal(GET_CONFIG_POLICY.internalTool, 'get_config');
  assert.equal(GET_CONFIG_POLICY.permissionClass, PERMISSION_CLASSES.READ_SAFE);
  assert.equal(GET_CONFIG_POLICY.approvalRequired, false);
  assert.equal(GET_CONFIG_POLICY.replayPolicy, REPLAY_POLICIES.READ_REDISPATCH_ALLOWED);
  assert.equal(GET_CONFIG_POLICY.resourceBoundary, 'sanitized-config-only');
});

test('unknown tools fail closed', () => {
  assert.equal(getPolicy('start_process'), null);
  assert.equal(getPolicy('write_file'), null);
  assert.equal(getPolicy('anything_else'), null);
});

test('unknown permission class is rejected', () => {
  const registry = {
    bad: {
      ...GET_CONFIG_POLICY,
      externalName: 'bad',
      descriptor: { ...GET_CONFIG_POLICY.descriptor, name: 'bad' },
      permissionClass: 'ROOT',
    },
  };
  assert.throws(() => validatePolicyRegistry(registry), /permission class is unknown/);
});

test('malformed policy is rejected', () => {
  assert.throws(() => validatePolicyRegistry({ broken: null }), /malformed/);
  assert.throws(() => validatePolicyRegistry([]), /must be an object/);
});

test('descriptor and registry remain aligned', () => {
  assert.equal(GET_CONFIG_TOOL.name, GET_CONFIG_POLICY.externalName);
  assert.deepEqual(GET_CONFIG_TOOL.inputSchema, GET_CONFIG_POLICY.descriptor.inputSchema);
  assert.equal(GET_CONFIG_TOOL.annotations.readOnlyHint, true);
});

test('consequential policy cannot be silently treated as read safe', () => {
  const proposed = {
    mutate: {
      ...GET_CONFIG_POLICY,
      externalName: 'mutate',
      internalTool: 'write_file',
      permissionClass: PERMISSION_CLASSES.WRITE_CONSEQUENTIAL,
      approvalRequired: true,
      replayPolicy: REPLAY_POLICIES.APPROVAL_SINGLE_USE,
      descriptor: {
        ...GET_CONFIG_POLICY.descriptor,
        name: 'mutate',
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: false,
        },
      },
    },
  };
  assert.equal(validatePolicyRegistry(proposed), true);
  assert.equal(proposed.mutate.approvalRequired, true);
  assert.equal(proposed.mutate.replayPolicy, REPLAY_POLICIES.APPROVAL_SINGLE_USE);
});

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log('PASS ' + name);
  } catch (error) {
    failed += 1;
    console.error('FAIL ' + name);
    console.error(error);
  }
}
console.log('Native RDC M3B tests: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exitCode = 1;
