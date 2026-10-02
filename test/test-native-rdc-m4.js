import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NativeRdcConnectionOwner } from '../cloudflare/native-rdc-gateway/src/index.js';
import {
  assertInstallPrerequisites,
  safeLifecycleStatus,
} from '../dist/native-remote/lifecycle.js';
import {
  saveProtectedMachineCredential,
  loadProtectedMachineCredential,
} from '../dist/native-remote/windows-credential-store.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

class MemoryStorage {
  constructor() { this.map = new Map(); }
  async get(key) { return this.map.get(key); }
  async put(key, value) { this.map.set(key, structuredClone(value)); }
  async delete(key) { this.map.delete(key); }
  async list({ prefix } = {}) {
    return new Map([...this.map.entries()].filter(([key]) => !prefix || key.startsWith(prefix)));
  }
}

function ownerFixture() {
  const storage = new MemoryStorage();
  const ctx = { storage, getWebSockets: () => [] };
  return { storage, owner: new NativeRdcConnectionOwner(ctx, { DEVICE_ID: 'device-1' }) };
}
test('package exposes stable native-rdc lifecycle CLI', async () => {
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.bin['native-rdc'], 'dist/native-remote/lifecycle.js');
  assert.match(pkg.scripts['native-rdc:lifecycle'], /lifecycle\.js/);
});

test('lifecycle source does not embed machine tokens in command arguments', async () => {
  const source = await fs.readFile(new URL('../src/native-remote/lifecycle.ts', import.meta.url), 'utf8');
  assert.equal(/--token|Bearer\s+\$?\w+|DEVICE_TOKEN=.*deviceToken/.test(source), false);
  assert.match(source, /input:\s*nextToken\s*\+\s*['"]\\n/);
  assert.match(source, /test-native-rdc-m3d\.js/);
  assert.match(source, /test-native-rdc-m4\.js/);
});

test('safe lifecycle status never contains protected device token', async () => {
  const encoded = JSON.stringify(await safeLifecycleStatus());
  assert.equal(encoded.includes('deviceToken'), false);
  assert.equal(encoded.includes('CLIENT_TOKEN'), false);
  assert.equal(encoded.includes('DEVICE_TOKEN'), false);
});

test('install preflight fails closed without a protected machine credential', async () => {
  const original = process.env.LOCALAPPDATA;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'native-rdc-install-preflight-'));
  process.env.LOCALAPPDATA = dir;
  try {
    await assert.rejects(
      () => assertInstallPrerequisites(),
      /Protected Native RDC machine credential is unavailable/,
    );
  } finally {
    if (original === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = original;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('approval retention prunes terminal records but preserves active approvals', async () => {
  const { owner, storage } = ownerFixture();
  for (let i = 0; i < 260; i += 1) {
    await storage.put('approval:terminal-' + String(i).padStart(4, '0'), {
      state: 'COMPLETED',
      updatedAt: i,
      completedAt: i,
    });
  }
  await storage.put('approval:active-requested', {
    state: 'REQUESTED',
    expiresAt: Date.now() + 60_000,
    updatedAt: 10_000,
  });
  await storage.put('approval:active-unknown', {
    state: 'UNKNOWN',
    updatedAt: 10_001,
  });
  await owner.prunePrefix('approval:', 256);
  const records = await storage.list({ prefix: 'approval:' });
  assert.equal(records.size, 256);
  assert.equal(records.has('approval:active-requested'), true);
  assert.equal(records.has('approval:active-unknown'), true);
  assert.equal(records.has('approval:terminal-0000'), false);
});

test('approval capacity refuses overflow instead of evicting active approvals', async () => {
  const { owner, storage } = ownerFixture();
  for (let i = 0; i < 256; i += 1) {
    const response = await owner.requestApproval({
      ownerId: 'cloudflare-access:owner@example.test',
      action: 'create_directory',
      arguments: { path: 'C:\\Approved\\active-' + i },
    });
    assert.equal(response.status, 201);
  }
  const overflow = await owner.requestApproval({
    ownerId: 'cloudflare-access:owner@example.test',
    action: 'create_directory',
    arguments: { path: 'C:\\Approved\\overflow' },
  });
  assert.equal(overflow.status, 503);
  const records = await storage.list({ prefix: 'approval:' });
  assert.equal(records.size, 256);
  assert.equal([...records.values()].every((record) => record.state === 'REQUESTED'), true);
});
test('call retention helper is bounded to requested maximum', async () => {
  const { owner, storage } = ownerFixture();
  for (let i = 0; i < 530; i += 1) {
    await storage.put('call:' + String(i).padStart(4, '0'), {
      state: 'terminal',
      updatedAt: i,
      terminal: { type: 'TOOL_RESULT', status: 'completed' },
    });
  }
  await owner.prunePrefix('call:', 512);
  const records = await storage.list({ prefix: 'call:' });
  assert.equal(records.size, 512);
  assert.equal(records.has('call:0000'), false);
  assert.equal(records.has('call:0529'), true);
});

test('call capacity preserves pending calls and refuses overflow', async () => {
  const { owner, storage } = ownerFixture();
  for (let i = 0; i < 512; i += 1) {
    await storage.put('call:pending-' + String(i).padStart(4, '0'), {
      state: 'pending',
      updatedAt: i,
      call: { deadline_at: new Date(Date.now() + 60_000).toISOString() },
    });
  }
  const available = await owner.ensureStorageCapacity('call:', 512);
  assert.equal(available, false);
  const records = await storage.list({ prefix: 'call:' });
  assert.equal(records.size, 512);
  assert.equal([...records.values()].every((record) => record.state === 'pending'), true);
});

test('approval burn-in remains single-use across repeated cycles', async () => {
  const { owner } = ownerFixture();
  for (let i = 0; i < 100; i += 1) {
    const request = await (await owner.requestApproval({
      ownerId: 'cloudflare-access:owner@example.test',
      action: 'create_directory',
      arguments: { path: 'C:\\Approved\\burn-' + i },
    })).json();
    const decision = await owner.decideApproval({
      ownerId: 'cloudflare-access:owner@example.test',
      id: request.id,
      fingerprint: request.fingerprint,
      decision: 'approve',
    });
    assert.equal(decision.status, 200);
    const first = await owner.consumeApproval({
      ownerId: 'cloudflare-access:owner@example.test',
      id: request.id,
      fingerprint: request.fingerprint,
    });
    assert.equal(first.status, 200);
    const replay = await owner.consumeApproval({
      ownerId: 'cloudflare-access:owner@example.test',
      id: request.id,
      fingerprint: request.fingerprint,
    });
    assert.equal(replay.status, 409);
    const final = await owner.finalizeApproval({ id: request.id, state: 'COMPLETED' });
    assert.equal(final.status, 200);
  }
});
test('protected credential round-trip preserves read and write roots', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'native-rdc-m4-'));
  const filePath = path.join(dir, 'credential.json');
  const codec = {
    protect: (value) => Buffer.from(value.map((byte) => byte ^ 0x5a)),
    unprotect: (value) => Buffer.from(value.map((byte) => byte ^ 0x5a)),
  };
  try {
    await saveProtectedMachineCredential({
      gatewayUrl: 'https://example.test',
      deviceId: 'device-1',
      deviceToken: 'x'.repeat(32),
      readRoots: ['C:\\Read'],
      writeRoots: ['C:\\Write'],
    }, { filePath, codec });
    const loaded = await loadProtectedMachineCredential({ filePath, codec });
    assert.deepEqual(loaded.readRoots, ['C:\\Read']);
    assert.deepEqual(loaded.writeRoots, ['C:\\Write']);
    const raw = await fs.readFile(filePath, 'utf8');
    assert.equal(raw.includes('x'.repeat(32)), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
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
console.log('Native RDC M4 production-readiness tests: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exitCode = 1;
