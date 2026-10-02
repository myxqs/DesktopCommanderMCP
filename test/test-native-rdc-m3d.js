import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ALLOWED_TOOLS,
  DEVICE_ALLOWED_TOOLS,
  validateToolCall,
} from '../cloudflare/native-rdc-gateway/src/core.js';
import { NativeRdcConnectionOwner } from '../cloudflare/native-rdc-gateway/src/index.js';
import {
  EXECUTE_APPROVED_ACTION_TOOL,
  MCP_WRITE_SCOPE,
  REQUEST_CREATE_DIRECTORY_TOOL,
} from '../cloudflare/native-rdc-gateway/src/mcp.js';
import {
  authorizeCreateDirectoryPath,
  validateRemoteWriteArguments,
} from '../dist/native-remote/safe-write-policy.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

class MemoryStorage {
  constructor() { this.map = new Map(); }
  async get(key) { return this.map.get(key); }
  async put(key, value) { this.map.set(key, structuredClone(value)); }
}

function ownerFixture() {
  const storage = new MemoryStorage();
  const ctx = { storage, getWebSockets: () => [] };
  return { storage, owner: new NativeRdcConnectionOwner(ctx, { DEVICE_ID: 'device-1' }) };
}

function approvalBody(pathValue = 'C:\\Approved\\new-folder') {
  return {
    ownerId: 'cloudflare-access:owner@example.test',
    action: 'create_directory',
    arguments: { path: pathValue },
  };
}
test('direct legacy client allowlist remains read-only', () => {
  assert.equal(ALLOWED_TOOLS.includes('create_directory'), false);
  assert.equal(DEVICE_ALLOWED_TOOLS.includes('create_directory'), true);
  const now = Date.now();
  const checked = validateToolCall({
    type: 'TOOL_CALL',
    call_id: 'x',
    device_id: 'device-1',
    tool_name: 'create_directory',
    arguments: { path: 'C:\\Approved\\x' },
    created_at: new Date(now).toISOString(),
    deadline_at: new Date(now + 1000).toISOString(),
  }, 'device-1', now);
  assert.equal(checked.ok, false);
  assert.equal(checked.code, 'TOOL_NOT_ALLOWED');
});

test('MCP exposes approval workflow but not direct create_directory', () => {
  assert.equal(REQUEST_CREATE_DIRECTORY_TOOL.name, 'request_create_directory');
  assert.equal(EXECUTE_APPROVED_ACTION_TOOL.name, 'execute_approved_action');
  assert.equal(REQUEST_CREATE_DIRECTORY_TOOL.securitySchemes[0].scopes[0], MCP_WRITE_SCOPE);
  assert.equal(EXECUTE_APPROVED_ACTION_TOOL.securitySchemes[0].scopes[0], MCP_WRITE_SCOPE);
  assert.notEqual(REQUEST_CREATE_DIRECTORY_TOOL.name, 'create_directory');
});

test('approval request binds exact owner action arguments and fingerprint', async () => {
  const { owner } = ownerFixture();
  const response = await owner.requestApproval(approvalBody());
  assert.equal(response.status, 201);
  const record = await response.json();
  assert.equal(record.state, 'REQUESTED');
  assert.equal(record.action, 'create_directory');
  assert.equal(record.arguments.path, 'C:\\Approved\\new-folder');
  assert.match(record.fingerprint, /^[0-9a-f]{64}$/);
});

test('wrong owner or fingerprint cannot approve', async () => {
  const { owner } = ownerFixture();
  const request = await (await owner.requestApproval(approvalBody())).json();
  const wrongOwner = await owner.decideApproval({
    ownerId: 'cloudflare-access:attacker@example.test',
    id: request.id, fingerprint: request.fingerprint, decision: 'approve',
  });
  assert.equal(wrongOwner.status, 403);
  const wrongFingerprint = await owner.decideApproval({
    ownerId: approvalBody().ownerId,
    id: request.id, fingerprint: '0'.repeat(64), decision: 'approve',
  });
  assert.equal(wrongFingerprint.status, 403);
});
test('denial permanently prevents execution', async () => {
  const { owner } = ownerFixture();
  const req = await (await owner.requestApproval(approvalBody())).json();
  const denied = await owner.decideApproval({
    ownerId: approvalBody().ownerId, id: req.id, fingerprint: req.fingerprint, decision: 'deny',
  });
  assert.equal((await denied.json()).state, 'DENIED');
  const consume = await owner.consumeApproval({
    ownerId: approvalBody().ownerId, id: req.id, fingerprint: req.fingerprint,
  });
  assert.equal(consume.status, 409);
  assert.equal((await consume.json()).state, 'DENIED');
});

test('approved capability is consumed once before dispatch', async () => {
  const { owner } = ownerFixture();
  const req = await (await owner.requestApproval(approvalBody())).json();
  await owner.decideApproval({
    ownerId: approvalBody().ownerId, id: req.id, fingerprint: req.fingerprint, decision: 'approve',
  });
  const first = await owner.consumeApproval({
    ownerId: approvalBody().ownerId, id: req.id, fingerprint: req.fingerprint,
  });
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.equal(body.state, 'DISPATCHED');
  assert.equal(body.operation_id, 'approval-' + req.id);
  const replay = await owner.consumeApproval({
    ownerId: approvalBody().ownerId, id: req.id, fingerprint: req.fingerprint,
  });
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).state, 'DISPATCHED');
});

test('dispatched approval finalizes but cannot be consumed again', async () => {
  const { owner } = ownerFixture();
  const req = await (await owner.requestApproval(approvalBody())).json();
  await owner.decideApproval({
    ownerId: approvalBody().ownerId, id: req.id, fingerprint: req.fingerprint, decision: 'approve',
  });
  await owner.consumeApproval({ ownerId: approvalBody().ownerId, id: req.id, fingerprint: req.fingerprint });
  const final = await owner.finalizeApproval({ id: req.id, state: 'COMPLETED' });
  assert.equal((await final.json()).state, 'COMPLETED');
  const replay = await owner.consumeApproval({ ownerId: approvalBody().ownerId, id: req.id, fingerprint: req.fingerprint });
  assert.equal(replay.status, 409);
});
test('expired approval is not executable', async () => {
  const { owner, storage } = ownerFixture();
  const req = await (await owner.requestApproval(approvalBody())).json();
  const key = 'approval:' + req.id;
  const stored = await storage.get(key);
  stored.expiresAt = Date.now() - 1;
  stored.state = 'APPROVED';
  await storage.put(key, stored);
  const consume = await owner.consumeApproval({ ownerId: approvalBody().ownerId, id: req.id, fingerprint: req.fingerprint });
  assert.equal(consume.status, 410);
  assert.equal((await consume.json()).state, 'EXPIRED');
});

test('create_directory path is constrained to existing-parent approved root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-rdc-m3d-'));
  try {
    const requested = path.join(root, 'new-directory');
    const safe = await authorizeCreateDirectoryPath(requested, [root]);
    assert.equal(path.normalize(safe), path.normalize(requested));
    const args = await validateRemoteWriteArguments('create_directory', { path: requested }, [root]);
    assert.equal(path.normalize(args.path), path.normalize(requested));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('write outside approved root is denied', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-rdc-m3d-root-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'native-rdc-m3d-outside-'));
  try {
    await assert.rejects(
      () => authorizeCreateDirectoryPath(path.join(outside, 'x'), [root]),
      /outside approved roots/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('arbitrary write action is denied on device policy', async () => {
  await assert.rejects(
    () => validateRemoteWriteArguments('write_file', { path: 'x' }, []),
    /not permitted/,
  );
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
console.log('Native RDC M3D approval tests: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exitCode = 1;
