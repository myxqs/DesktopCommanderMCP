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
  const readRoots = (process.env.NATIVE_RDC_READ_ROOTS || '')
    .split(';')
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 16);
  const writeRoots = (process.env.NATIVE_RDC_WRITE_ROOTS || '')
    .split(';')
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 8);

  const client = new CloudflareDeviceClient({
    gatewayUrl,
    deviceToken,
    deviceId,
    deviceName: os.hostname(),
    readRoots,
    writeRoots,
  });
  await client.start();
  console.log(`Native RDC M1 device connected outbound as ${deviceId}`);
  console.log('Native RDC device enforces explicit read tools and approval-gated create_directory only. Official Desktop Commander Remote remains independent.');

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
