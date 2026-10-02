import { CloudflareRemoteClient } from './cloudflare-client.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const gatewayUrl = required('NATIVE_RDC_M1_GATEWAY_URL').replace(/\/$/, '');
  const clientToken = required('NATIVE_RDC_M1_CLIENT_TOKEN');
  const deviceId = process.env.NATIVE_RDC_M1_DEVICE_ID?.trim() || 'native-rdc-windows-1';
  const mode = process.argv[2] || 'get_config';
  const client = new CloudflareRemoteClient({ gatewayUrl, clientToken, deviceId });

  if (mode === 'status') {
    const status = await client.status();
    console.log(JSON.stringify({
      status: status.body,
      cf_ray_present: Boolean(status.evidence.cfRay),
      gateway: status.evidence.gateway,
    }));
    return;
  }
  if (mode !== 'get_config') throw new Error('Only status and get_config are supported by the M1 proof client');

  const callId = process.argv[3];
  const result = await client.getConfig(callId);
  if (result.terminal.type !== 'TOOL_RESULT' || result.terminal.status !== 'completed') {
    throw new Error('Remote get_config did not return a completed TOOL_RESULT');
  }
  console.log('NATIVE RDC PRIVATE REMOTE E2E: PASS');
  console.log(JSON.stringify({
    tool: 'get_config',
    call_id: result.terminal.call_id,
    cf_ray_present: Boolean(result.evidence.cfRay),
    gateway: result.evidence.gateway,
    call_source: result.evidence.callSource,
  }));
}

main().catch((error) => {
  console.error('Native RDC M1 client failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
