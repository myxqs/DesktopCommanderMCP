import os from 'os';
import { NativeDeviceClient } from './device-client.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const baseUrl = required('NATIVE_RDC_URL').replace(/\/$/, '');
  const deviceToken = required('NATIVE_RDC_DEVICE_TOKEN');
  const deviceId = process.env.NATIVE_RDC_DEVICE_ID?.trim() || os.hostname();

  const client = new NativeDeviceClient({
    baseUrl,
    deviceToken,
    deviceId,
    deviceName: os.hostname(),
  });

  await client.start();
  console.log(`Native RDC device connected as ${deviceId}`);
  console.log('Official Desktop Commander Remote remains independent.');

  const stop = async (signal: string) => {
    console.log(`Native RDC device stopping (${signal})`);
    await client.stop();
    process.exit(0);
  };

  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('SIGTERM', () => void stop('SIGTERM'));
}

main().catch((error) => {
  console.error('Native RDC device failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
