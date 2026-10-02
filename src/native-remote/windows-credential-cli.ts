import {
  defaultNativeRdcCredentialPath,
  loadProtectedMachineCredential,
  saveProtectedMachineCredential,
  type NativeRdcMachineCredential,
} from './windows-credential-store.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function safeStatus(credential: NativeRdcMachineCredential) {
  return {
    configured: true,
    gatewayOrigin: new URL(credential.gatewayUrl).origin,
    deviceId: credential.deviceId,
    tokenPresent: credential.deviceToken.length >= 24,
    credentialPath: defaultNativeRdcCredentialPath(),
  };
}

async function main(): Promise<void> {
  const command = process.argv[2] || 'status';
  if (command === 'status') {
    try {
      const credential = await loadProtectedMachineCredential();
      console.log(JSON.stringify(safeStatus(credential), null, 2));
      return;
    } catch {
      console.log(JSON.stringify({
        configured: false,
        credentialPath: defaultNativeRdcCredentialPath(),
      }, null, 2));
      process.exitCode = 1;
      return;
    }
  }

  if (command === 'store') {
    const input = JSON.parse(await readStdin()) as NativeRdcMachineCredential;
    const storedAt = await saveProtectedMachineCredential(input);
    console.log(JSON.stringify({ stored: true, credentialPath: storedAt }));
    return;
  }

  throw new Error('Usage: windows-credential-cli.js [status|store]');
}

main().catch((error) => {
  console.error('Native RDC credential command failed:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
});
