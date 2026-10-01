import assert from 'node:assert/strict';
import {
  generateNativeRdcToken,
  NativeDeviceClient,
  NativeRelayClient,
  NativeRelayHttpError,
  NativeRelayServer,
} from '../dist/native-remote/index.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

class FakeExecutor {
  calls = new Map();
  initialized = false;

  async initialize() {
    this.initialized = true;
  }

  async listClientTools() {
    return { tools: [{ name: 'echo' }, { name: 'slow' }, { name: 'fail' }] };
  }

  async callClientTool(name, args) {
    this.calls.set(name, (this.calls.get(name) || 0) + 1);
    if (name === 'echo') return { echoed: args };
    if (name === 'slow') {
      await sleep(args.delay_ms ?? 150);
      return { delayed: true };
    }
    if (name === 'fail') throw new Error('synthetic executor unavailable');
    throw new Error('unexpected tool');
  }

  async shutdown() {
    this.initialized = false;
  }
}
function config(overrides = {}) {
  return {
    host: '127.0.0.1',
    port: 0,
    deviceToken: generateNativeRdcToken(),
    clientToken: generateNativeRdcToken(),
    maxBodyBytes: 64 * 1024,
    callTimeoutMs: 1_000,
    heartbeatTtlMs: 2_000,
    maxCalls: 64,
    retentionMs: 60_000,
    ...overrides,
  };
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error('condition timed out');
}

async function startRig(options = {}) {
  const relayConfig = config(options.config);
  const relay = new NativeRelayServer(relayConfig);
  const address = await relay.start();
  const baseUrl = `http://${address.host}:${address.port}`;
  const executor = options.executor || new FakeExecutor();
  const deviceId = options.deviceId || 'test-device';
  const device = new NativeDeviceClient({
    baseUrl,
    deviceToken: relayConfig.deviceToken,
    deviceId,
    deviceName: 'native-rdc-test',
    heartbeatMs: 100,
    reconnectMs: 50,
    executor,
  });
  await device.start();
  await waitFor(() => relay.snapshot().device_online);
  const client = new NativeRelayClient({
    baseUrl,
    clientToken: relayConfig.clientToken,
    deviceId,
    timeoutMs: 1_000,
  });
  return { relayConfig, relay, address, baseUrl, executor, deviceId, device, client };
}

async function stopRig(rig) {
  await rig.device.stop().catch(() => {});
  await rig.relay.stop().catch(() => {});
}

test('rejects unauthorised client', async () => {
  const rig = await startRig();
  try {
    const response = await fetch(`${rig.baseUrl}/v0/client/tools`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    assert.equal(response.status, 401);
  } finally {
    await stopRig(rig);
  }
});

test('rejects unauthorised device', async () => {
  const relayConfig = config();
  const relay = new NativeRelayServer(relayConfig);
  const address = await relay.start();
  try {
    const response = await fetch(`http://${address.host}:${address.port}/v0/device/hello`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 401);
  } finally {
    await relay.stop();
  }
});
test('routes a valid tool call', async () => {
  const rig = await startRig();
  try {
    const result = await rig.client.call('echo', { value: 42 }, 'valid-call');
    assert.equal(result.type, 'TOOL_RESULT');
    assert.deepEqual(result.result, { echoed: { value: 42 } });
    assert.equal(rig.executor.calls.get('echo'), 1);
  } finally {
    await stopRig(rig);
  }
});

test('rejects unknown tool before dispatch', async () => {
  const rig = await startRig();
  try {
    await assert.rejects(
      () => rig.client.call('not-advertised', {}, 'unknown-tool'),
      (error) => error instanceof NativeRelayHttpError && error.status === 404,
    );
  } finally {
    await stopRig(rig);
  }
});

test('rejects malformed tool call', async () => {
  const rig = await startRig();
  try {
    const response = await fetch(`${rig.baseUrl}/v0/client/call`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${rig.relayConfig.clientToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'TOOL_CALL', arguments: [] }),
    });
    assert.equal(response.status, 400);
  } finally {
    await stopRig(rig);
  }
});

test('rejects malformed arguments before dispatch', async () => {
  const rig = await startRig();
  try {
    const now = Date.now();
    const response = await fetch(`${rig.baseUrl}/v0/client/call`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${rig.relayConfig.clientToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'TOOL_CALL',
        call_id: 'malformed-arguments',
        device_id: rig.deviceId,
        tool_name: 'echo',
        arguments: [],
        created_at: new Date(now).toISOString(),
        deadline_at: new Date(now + 1_000).toISOString(),
      }),
    });
    assert.equal(response.status, 400);
    assert.equal(rig.executor.calls.get('echo'), undefined);
  } finally {
    await stopRig(rig);
  }
});

test('rejects oversized request bodies', async () => {
  const rig = await startRig();
  try {
    const response = await fetch(`${rig.baseUrl}/v0/client/call`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${rig.relayConfig.clientToken}`,
        'Content-Type': 'application/json',
      },
      body: 'x'.repeat(65 * 1024),
    });
    assert.equal(response.status, 413);
  } finally {
    await stopRig(rig);
  }
});

test('duplicate call id executes only once', async () => {
  const rig = await startRig();
  try {
    const first = rig.client.call('slow', { delay_ms: 200 }, 'duplicate-id', 900);
    await sleep(40);
    await assert.rejects(
      () => rig.client.call('slow', { delay_ms: 20 }, 'duplicate-id', 900),
      (error) => error instanceof NativeRelayHttpError && error.status === 409,
    );
    const result = await first;
    assert.equal(result.type, 'TOOL_RESULT');
    assert.equal(rig.executor.calls.get('slow'), 1);
  } finally {
    await stopRig(rig);
  }
});

test('expires a call that exceeds its deadline', async () => {
  const rig = await startRig({ config: { callTimeoutMs: 80 } });
  try {
    await assert.rejects(
      () => rig.client.call('slow', { delay_ms: 250 }, 'timeout-call', 80),
      (error) => error instanceof NativeRelayHttpError && error.status === 504,
    );
  } finally {
    await sleep(280);
    await stopRig(rig);
  }
});

test('returns executor failure as TOOL_ERROR', async () => {
  const rig = await startRig();
  try {
    const result = await rig.client.call('fail', {}, 'executor-fail');
    assert.equal(result.type, 'TOOL_ERROR');
    assert.equal(result.error.code, 'EXECUTOR_ERROR');
    assert.match(result.error.message, /synthetic executor unavailable/);
  } finally {
    await stopRig(rig);
  }
});
test('device reconnects after relay restart', async () => {
  const rig = await startRig();
  let relay2;
  try {
    const port = rig.address.port;
    await rig.relay.stop();
    relay2 = new NativeRelayServer({ ...rig.relayConfig, port });
    const address2 = await relay2.start();
    assert.equal(address2.port, port);
    await waitFor(() => relay2.snapshot().device_online, 3_000);

    const client2 = new NativeRelayClient({
      baseUrl: rig.baseUrl,
      clientToken: rig.relayConfig.clientToken,
      deviceId: rig.deviceId,
      timeoutMs: 1_000,
    });
    const result = await client2.call('echo', { after: 'restart' }, 'after-restart');
    assert.equal(result.type, 'TOOL_RESULT');
    assert.deepEqual(result.result, { echoed: { after: 'restart' } });
  } finally {
    await rig.device.stop().catch(() => {});
    await relay2?.stop().catch(() => {});
  }
});

async function main() {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (error) {
      failed++;
      console.error(`FAIL ${name}`);
      console.error(error);
    }
  }
  console.log(`Native RDC tests: ${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
