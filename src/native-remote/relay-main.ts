import { loadNativeRdcConfig } from './auth.js';
import { NativeRelayServer } from './relay-server.js';

async function main(): Promise<void> {
  const config = loadNativeRdcConfig();
  const relay = new NativeRelayServer(config);
  const address = await relay.start();

  console.log(`Native RDC relay listening on http://${address.host}:${address.port}`);
  console.log('Loopback only. Official Desktop Commander Remote is unchanged.');

  const stop = async (signal: string) => {
    console.log(`Native RDC relay stopping (${signal})`);
    await relay.stop();
    process.exit(0);
  };

  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('SIGTERM', () => void stop('SIGTERM'));
}

main().catch((error) => {
  console.error('Native RDC relay failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
