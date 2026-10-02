import assert from 'assert';
import {
  NativeRdcConnectionOwner,
  workerFetch,
} from '../cloudflare/native-rdc-gateway/src/index.js';

class FakeStorage {
  constructor() { this.map = new Map(); }
  async get(key) { return this.map.get(key); }
  async put(key, value) { this.map.set(key, structuredClone(value)); }
  async delete(key) { this.map.delete(key); }
  async list({ prefix = '' } = {}) {
    return new Map([...this.map].filter(([key]) => key.startsWith(prefix)));
  }
}

class FakeSocket {
  constructor(name) {
    this.name = name;
    this.readyState = 1;
    this.sent = [];
    this.closed = null;
    this.attachment = null;
  }
  send(value) { this.sent.push(value); }
  close(code, reason) {
    this.readyState = 3;
    this.closed = { code, reason };
  }
  serializeAttachment(value) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return this.attachment; }
}

class FakeContext {
  constructor() {
    this.storage = new FakeStorage();
    this.sockets = [];
  }
  acceptWebSocket(socket, tags = []) {
    socket.tags = tags;
    this.sockets.push(socket);
  }
  getWebSockets(tag) {
    return this.sockets.filter((socket) => !tag || socket.tags?.includes(tag));
  }
}

const deviceToken = 'device-token-abcdefghijklmnopqrstuvwxyz012345';
const clientToken = 'client-token-abcdefghijklmnopqrstuvwxyz012345';
const deviceId = 'native-rdc-windows-1';

function workerEnv() {
  const stub = { fetch: async () => new Response('{}', { status: 200 }) };
  return {
    DEVICE_TOKEN: deviceToken,
    CLIENT_TOKEN: clientToken,
    DEVICE_ID: deviceId,
    CONNECTION_OWNER: {
      idFromName: () => 'one',
      get: () => stub,
    },
  };
}

function call(id, timeoutMs = 5_000) {
  const now = Date.now();
  return {
    type: 'TOOL_CALL',
    call_id: id,
    device_id: deviceId,
    tool_name: 'get_config',
    arguments: {},
    created_at: new Date(now).toISOString(),
    deadline_at: new Date(now + timeoutMs).toISOString(),
  };
}

function terminal(id) {
  return {
    type: 'TOOL_RESULT'  ,
    call_id: id,
    device_id: deviceId,
    status: 'completed',
    result: { content: [{ type: 'text', text: 'config' }] },
    completed_at: new Date().toISOString(),
  };
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}:`, error);
  }
}

await test('unauthorised device rejected', async () => {
  const response = await workerFetch(new Request(
    `https://example.test/v1/device/connect?device_id=${deviceId}`,
    { headers: { Upgrade: 'websocket', Authorization: 'Bearer invalid-device-credential' } },
  ), workerEnv());
  assert.strictEqual(response.status, 401);
});

await test('unauthorised client rejected', async () => {
  const response = await workerFetch(new Request(
    'https://example.test/v1/client/status',
    { headers: { Authorization: 'Bearer invalid-client-credential' } },
 ), workerEnv());
  assert.strictEqual(response.status, 401);
});

await test('client credential cannot impersonate device', async () => {
  const response = await workerFetch(new Request(
    `https://example.test/v1/device/connect?device_id=${deviceId}`,
    { headers: { Upgrade: 'websocket', Authorization: `Bearer ${clientToken}` } },
  ), workerEnv());
  assert.strictEqual(response.status, 401);
});

await test('device credential cannot invoke client routes', async () => {
  const response = await workerFetch(new Request(
    'https://example.test/v1/client/status',
    { headers: { Authorization: `Bearer ${deviceToken}` } },
  ), workerEnv());
  assert.strictEqual(response.status, 401);
});

await test('malformed client payload rejected', async () => {
  const response = await workerFetch(new Request('https://example.test/v1/client/call', {
    method: 'POST',
    headers: { Authorization: `Bearer ${clientToken}` },
    body: '{bad json',
  }), workerEnv());
  assert.strictEqual(response.status, 400);
});

await test('unknown remote tool rejected', async () => {
  const bad = { ...call('unknown-tool'), tool_name: 'start_process' };
  const response = await workerFetch(new Request('https://example.test/v1/client/call', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${clientToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(bad),
  }), workerEnv());
  assert.strictEqual(response.status, 403);
});

await test('oversized client request rejected', async () => {
  const response = await workerFetch(new Request('https://example.test/v1/client/call', {
    method: 'POST',
    headers: { Authorization: `Bearer ${clientToken}` },
    body: JSON.stringify({ blob: 'x'.repeat(70_000) }),
  }), workerEnv());
  assert.strictEqual(response.status, 413);
});

await test('device offline state rejects calls', async () => {
  const owner = new NativeRdcConnectionOwner(new FakeContext(), { DEVICE_ID: deviceId });
  const response = await owner.handleCall(call('offline'));
  assert.strictEqual(response.status, 503);
});

await test('new connection replaces stale connection without stale close winning', async () => {
  const ctx = new FakeContext();
  const owner = new NativeRdcConnectionOwner(ctx, { DEVICE_ID: deviceId });
  const oldSocket = new FakeSocket('old');
  const newSocket = new FakeSocket('new');
  await owner.replaceDeviceConnection(oldSocket, 'old-connection');
  await owner.replaceDeviceConnection(newSocket, 'new-connection');
  assert.strictEqual(oldSocket.closed?.code, 4001);
  await owner.webSocketClose(oldSocket);
  const state = await ctx.storage.get('device');
  assert.strictEqual(state.connectionId, 'new-connection');
  assert.strictEqual(state.connected, true);
});

async function readyOwner() {
  const ctx = new FakeContext();
  const owner = new NativeRdcConnectionOwner(ctx, { DEVICE_ID: deviceId });
  const socket = new FakeSocket('device');
  await owner.replaceDeviceConnection(socket, 'connection-1');
  await owner.webSocketMessage(socket, JSON.stringify({
    type: 'DEVICE_HELLO',
    protocol_version: 1,
    device_id: deviceId,
    device_name: 'test-device',
    sent_at: new Date().toISOString(),
  }));
  await owner.webSocketMessage(socket, JSON.stringify({
    type: 'TOOL_LIST',
    device_id: deviceId,
    tools: [{ name: 'get_config' }],
    sent_at: new Date().toISOString(),
  }));
  return { ctx, owner, socket };
}

await test('duplicate completed call is served from durable cache without redispatch', async () => {
  const { owner, socket } = await readyOwner();
  const request = call('duplicate');
  const firstPromise = owner.handleCall(request);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.strictEqual(socket.sent.length, 1);
  await owner.webSocketMessage(socket, JSON.stringify(terminal('duplicate')));
  const first = await firstPromise;
  assert.strictEqual(first.status, 200);
  const second = await owner.handleCall(request);
  assert.strictEqual(second.status, 200);
  assert.strictEqual(second.headers.get('x-native-rdc-call-source'), 'durable-cache');
  assert.strictEqual(socket.sent.length, 1);
});

await test('pending duplicate returns conflict instead of redispatch', async () => {
  const { owner, socket } = await readyOwner();
  const request = call('pending-duplicate', 2_000);
  const firstPromise = owner.handleCall(request);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const duplicate = await owner.handleCall(request);
  assert.strictEqual(duplicate.status, 409);
  assert.strictEqual(socket.sent.length, 1);
  await owner.webSocketMessage(socket, JSON.stringify(terminal('pending-duplicate')));
  await firstPromise;
});

await test('timeout does not claim cancellation and late result becomes durable', async () => {
  const { owner, socket } = await readyOwner();
  const request = call('late-result', 40);
  const timedOut = await owner.handleCall(request);
  assert.strictEqual(timedOut.status, 504);
  const timeoutBody = await timedOut.json();
  assert.match(timeoutBody.message, /may still complete/i);
  assert.strictEqual(socket.sent.length, 1);
  await owner.webSocketMessage(socket, JSON.stringify(terminal('late-result')));
  const replay = await owner.handleCall(request);
  assert.strictEqual(replay.status, 200);
  assert.strictEqual(replay.headers.get('x-native-rdc-call-source'), 'durable-cache');
});

await test('malformed device message is rejected', async () => {
  const { owner, socket } = await readyOwner();
  await owner.webSocketMessage(socket, '{bad json');
  assert.strictEqual(socket.closed?.code, 1007);
});

await test('oversized device result is rejected at transport boundary', async () => {
  const { owner, socket } = await readyOwner();
  await owner.webSocketMessage(socket, 'x'.repeat(1024 * 1024 + 1));
  assert.strictEqual(socket.closed?.code, 1009);
});

await test('disconnect and reconnect restore ready state', async () => {
  const { ctx, owner, socket } = await readyOwner();
  await owner.webSocketClose(socket);
  assert.strictEqual((await ctx.storage.get('device')).ready, false);
  const replacement = new FakeSocket('replacement');
  await owner.replaceDeviceConnection(replacement, 'connection-2');
  await owner.webSocketMessage(replacement, JSON.stringify({
    type: 'DEVICE_HELLO',
    protocol_version: 1,
    device_id: deviceId,
    device_name: 'test-device',
    sent_at: new Date().toISOString(),
  }));
  await owner.webSocketMessage(replacement, JSON.stringify({
    type: 'TOOL_LIST',
    device_id: deviceId,
    tools: [{ name: 'get_config' }],
    sent_at: new Date().toISOString(),
  }));
  assert.strictEqual((await ctx.storage.get('device')).ready, true);
});

console.log(`Native RDC M1 gateway tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
