import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  loadProtectedMachineCredential,
  saveProtectedMachineCredential,
} from '../dist/native-remote/windows-credential-store.js';
import {
  BoundedAuditLog,
  boundedBackoffMs,
  sanitizeAuditEvent,
} from '../dist/native-remote/operational-state.js';
import { runWindowsSupervisor } from '../dist/native-remote/windows-supervisor.js';
import { trustedAuthorizationOwner } from '../cloudflare/native-rdc-gateway/src/auth.js';
import { GET_CONFIG_TOOL } from '../cloudflare/native-rdc-gateway/src/mcp.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const reversibleCodec = {
  protect(plaintext) {
    return Buffer.from([...plaintext].reverse());
  },
  unprotect(ciphertext) {
    return Buffer.from([...ciphertext].reverse());
  },
};

async function tempState() {
  return mkdtemp(path.join(os.tmpdir(), 'native-rdc-m3a-'));
}

test('protected credential round trip uses codec and stores no plaintext token', async () => {
  const dir = await tempState();
  try {
    const filePath = path.join(dir, 'credential.json');
    const token = 'synthetic-device-token-abcdefghijklmnopqrstuvwxyz';
    await saveProtectedMachineCredential({
      gatewayUrl: 'https://gateway.example.test',
      deviceId: 'device-test-1',
      deviceToken: token,
    }, { filePath, codec: reversibleCodec });
    const raw = await readFile(filePath, 'utf8');
    assert.equal(raw.includes(token), false);
    const loaded = await loadProtectedMachineCredential({ filePath, codec: reversibleCodec });
    assert.equal(loaded.deviceToken, token);
    assert.equal(loaded.deviceId, 'device-test-1');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('missing protected credential fails closed', async () => {
  const dir = await tempState();
  try {
    await assert.rejects(
      () => loadProtectedMachineCredential({ filePath: path.join(dir, 'missing.json'), codec: reversibleCodec }),
      /missing or unreadable/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('corrupt protected credential fails closed', async () => {
  const dir = await tempState();
  try {
    const filePath = path.join(dir, 'credential.json');
    await writeFile(filePath, '{"version":1,"protected":"%%%"}');
    await assert.rejects(
      () => loadProtectedMachineCredential({ filePath, codec: reversibleCodec }),
      /could not be decrypted|payload is invalid/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('bounded backoff reaches 30 seconds and never exceeds it', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 99].map(boundedBackoffMs), [
    1000, 2000, 5000, 10000, 30000, 30000,
  ]);
});

test('audit sanitizer redacts secret-like reason text', () => {
  const safe = sanitizeAuditEvent({
    timestamp: new Date(0).toISOString(),
    event: 'DEVICE_AUTH_FAILED',
    reason: 'Bearer synthetic-secret-value',
  });
  assert.equal(safe.reason, '[REDACTED]');
  assert.equal(JSON.stringify(safe).includes('synthetic-secret-value'), false);
});

test('bounded audit retention keeps only the newest entries', async () => {
  const dir = await tempState();
  try {
    const audit = new BoundedAuditLog(path.join(dir, 'audit.jsonl'), 2);
    await audit.load();
    await audit.append({ event: 'ONE' });
    await audit.append({ event: 'TWO' });
    await audit.append({ event: 'THREE' });
    assert.deepEqual(audit.snapshot().map((event) => event.event), ['TWO', 'THREE']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('supervisor prevents a duplicate active instance', async () => {
  const dir = await tempState();
  const firstController = new AbortController();
  let firstStartedResolve;
  const firstStarted = new Promise((resolve) => { firstStartedResolve = resolve; });
  const first = runWindowsSupervisor(firstController.signal, {
    stateDirectory: dir,
    loadCredential: async () => ({
      gatewayUrl: 'https://gateway.example.test',
      deviceId: 'device-test-1',
      deviceToken: 'synthetic-device-token-abcdefghijklmnopqrstuvwxyz',
    }),
    createClient: () => ({
      async start() { firstStartedResolve(); },
      async stop() {},
    }),
  });
  try {
    await firstStarted;
    await assert.rejects(
      () => runWindowsSupervisor(new AbortController().signal, {
        stateDirectory: dir,
        loadCredential: async () => ({
          gatewayUrl: 'https://gateway.example.test',
          deviceId: 'device-test-1',
          deviceToken: 'synthetic-device-token-abcdefghijklmnopqrstuvwxyz',
        }),
        createClient: () => ({ async start() {}, async stop() {} }),
      }),
      /already running/,
    );
  } finally {
    firstController.abort();
    await first;
    await rm(dir, { recursive: true, force: true });
  }
});

test('supervisor retries startup failure with bounded backoff and respects graceful stop', async () => {
  const dir = await tempState();
  const controller = new AbortController();
  let starts = 0;
  const delays = [];
  try {
    await runWindowsSupervisor(controller.signal, {
      stateDirectory: dir,
      loadCredential: async () => ({
        gatewayUrl: 'https://gateway.example.test',
        deviceId: 'device-test-1',
        deviceToken: 'synthetic-device-token-abcdefghijklmnopqrstuvwxyz',
      }),
      createClient: () => ({
        async start() {
          starts += 1;
          if (starts === 1) throw new Error('synthetic transient failure');
          controller.abort();
        },
        async stop() {},
      }),
      sleep: async (ms) => { delays.push(ms); },
    });
    assert.equal(starts, 2);
    assert.deepEqual(delays, [1000]);
    const health = JSON.parse(await readFile(path.join(dir, 'health.json'), 'utf8'));
    assert.equal(health.state, 'OFFLINE');
    assert.equal(health.reason, 'graceful stop');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Cloudflare Access expected owner is accepted and wrong or absent identity is denied', async () => {
  const access = { async getIdentity() { return { email: 'owner@example.test' }; } };
  assert.ok(await trustedAuthorizationOwner({ OWNER_EMAIL: 'OWNER@example.test' }, { access }));
  assert.equal(await trustedAuthorizationOwner({ OWNER_EMAIL: 'other@example.test' }, { access }), null);
  assert.equal(await trustedAuthorizationOwner({ OWNER_EMAIL: 'owner@example.test' }, {}), null);
});

test('source network identity alone is insufficient for owner authorization', async () => {
  const fakeContext = {};
  assert.equal(
    await trustedAuthorizationOwner({ OWNER_EMAIL: 'owner@example.test' }, fakeContext),
    null,
  );
});

test('M3A remote MCP descriptor remains get_config only and read-only', () => {
  assert.equal(GET_CONFIG_TOOL.name, 'get_config');
  assert.equal(GET_CONFIG_TOOL.annotations.readOnlyHint, true);
  assert.equal(GET_CONFIG_TOOL.annotations.destructiveHint, false);
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

console.log('Native RDC M3A tests: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exitCode = 1;
