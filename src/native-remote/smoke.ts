import { generateNativeRdcToken, type NativeRdcConfig } from './auth.js';
import { NativeRelayClient } from './client.js';
import { NativeDeviceClient } from './device-client.js';
import { NativeRelayServer } from './relay-server.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForOnline(relay: NativeRelayServer, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (relay.snapshot().device_online) return;
    await sleep(50);
  }
  throw new Error('Native RDC device did not become reachable before timeout');
}

async function main(): Promise<void> {
  const deviceToken = generateNativeRdcToken();
  const clientToken = generateNativeRdcToken();
  const config: NativeRdcConfig = {
    host: '127.0.0.1',
    port: 0,
    deviceToken,
    clientToken,
    maxBodyBytes: 1_048_576,
    callTimeoutMs: 15_000,
    heartbeatTtlMs: 10_000,
    maxCalls: 64,
    retentionMs: 60_000,
  };
  const relay = new NativeRelayServer(config);
  const address = await relay.start();
  const baseUrl = `http://${address.host}:${address.port}`;
  const deviceId = 'native-rdc-smoke-device';
  const device = new NativeDeviceClient({
    baseUrl,
    deviceToken,
    deviceId,
    deviceName: 'native-rdc-smoke',
    heartbeatMs: 1_000,
    reconnectMs: 100,
  });

  try {
    await device.start();
    await waitForOnline(relay);

    const client = new NativeRelayClient({
      baseUrl,
      clientToken,
      deviceId,
      timeoutMs: 12_000,
    });
    const result = await client.call('get_config', {}, 'native-rdc-smoke-get-config', 12_000);
    if (result.type !== 'TOOL_RESULT') {
      throw new Error(`Smoke call failed: ${result.error.message}`);
    }

    console.log('NATIVE RDC LOCAL END-TO-END: PASS');
    console.log('tool=get_config');
    console.log(`call_id=${result.call_id}`);
  } finally {
    await device.stop().catch(() => {});
    await relay.stop().catch(() => {});
  }
}

main().catch((error) => {
  console.error('NATIVE RDC LOCAL END-TO-END: FAIL');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
