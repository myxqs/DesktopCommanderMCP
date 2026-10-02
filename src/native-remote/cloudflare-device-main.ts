import os from 'os';
import { CloudflareDeviceClient } from './cloudflare-device-client.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const gatewayUrl = required('NATIVE_RDC_M1_GATEWAY_URL').replace(/\/$/, '');
  const deviceToken = required('NATIVE_RDC_M1_DEVICE_TOKEN');
  const deviceId = process.env.NATIVE_RDC_M1_DEVICE_ID?.trim() || 'native-rdc-windows-1';

  const client = new CloudflareDeviceClient({
    gatewayUrl,
    deviceToken,
    deviceId,
    deviceName: os.hostname(),
  });
  await client.start();
  console.log(`Native RDC M1 device connected outbound as ${deviceId}`);
  console.log('Remote M1 policy permits get_config only. Official Desktop Commander Remote remains independent.');

  const stop = async (signal: string) => {
    console.log(`Native RDC M1 device stopping (${signal})`);
    await client.stop();
    process.exit(0);
  };
  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('SIGTERM', () => void stop('SIGTERM'));
}

main().catch((error) => {
  console.error('Native RDC M1 device failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
