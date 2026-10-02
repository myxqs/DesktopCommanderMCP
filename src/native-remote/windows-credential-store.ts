import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const STORE_VERSION = 1;
const DEFAULT_FILE = 'device-credential.json';

export interface NativeRdcMachineCredential {
  gatewayUrl: string;
  deviceId: string;
  deviceToken: string;
  readRoots?: string[];
  writeRoots?: string[];
}

export interface DpapiCodec {
  protect(plaintext: Buffer): Buffer;
  unprotect(ciphertext: Buffer): Buffer;
}

type StoreEnvelope = {
  version: number;
  protected: string;
};

const PROTECT_SCRIPT = [
  'Add-Type -AssemblyName System.Security;',
  '$inputBytes=[Convert]::FromBase64String([Console]::In.ReadToEnd());',
  '$output=[Security.Cryptography.ProtectedData]::Protect($inputBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);',
  '[Console]::Out.Write([Convert]::ToBase64String($output));',
].join(' ');

const UNPROTECT_SCRIPT = [
  'Add-Type -AssemblyName System.Security;',
  '$inputBytes=[Convert]::FromBase64String([Console]::In.ReadToEnd());',
  '$output=[Security.Cryptography.ProtectedData]::Unprotect($inputBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);',
  '[Console]::Out.Write([Convert]::ToBase64String($output));',
].join(' ');

function runDpapi(script: string, input: Buffer): Buffer {
  if (process.platform !== 'win32') {
    throw new Error('Windows DPAPI is available only on Windows');
  }
  const result = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ], {
    input: input.toString('base64'),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
  });
  if (result.status !== 0 || result.error) {
    throw new Error('Windows DPAPI operation failed');
  }
  const output = String(result.stdout || '').trim();
  if (!output) throw new Error('Windows DPAPI returned no protected data');
  try {
    return Buffer.from(output, 'base64');
  } catch {
    throw new Error('Windows DPAPI returned malformed protected data');
  }
}

export const windowsDpapi: DpapiCodec = {
  protect: (plaintext) => runDpapi(PROTECT_SCRIPT, plaintext),
  unprotect: (ciphertext) => runDpapi(UNPROTECT_SCRIPT, ciphertext),
};

export function defaultNativeRdcStateDirectory(): string {
  const base = process.env.LOCALAPPDATA?.trim()
    || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'NativeRDC');
}

export function defaultNativeRdcCredentialPath(): string {
  return path.join(defaultNativeRdcStateDirectory(), DEFAULT_FILE);
}

function validateCredential(value: unknown): NativeRdcMachineCredential {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Native RDC protected credential payload is invalid');
  }
  const raw = value as Record<string, unknown>;
  const gatewayUrl = typeof raw.gatewayUrl === 'string' ? raw.gatewayUrl.trim() : '';
  const deviceId = typeof raw.deviceId === 'string' ? raw.deviceId.trim() : '';
  const deviceToken = typeof raw.deviceToken === 'string' ? raw.deviceToken.trim() : '';
  if (!/^https:\/\//i.test(gatewayUrl)) throw new Error('Native RDC gateway URL is invalid');
  if (!deviceId) throw new Error('Native RDC device ID is missing');
  if (deviceToken.length < 24) throw new Error('Native RDC device credential is invalid');
  const readRoots = raw.readRoots === undefined
    ? []
    : Array.isArray(raw.readRoots)
      ? raw.readRoots.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
      : null;
  if (readRoots === null || readRoots.length > 16) {
    throw new Error('Native RDC read roots are invalid');
  }
  const writeRoots = raw.writeRoots === undefined
    ? []
    : Array.isArray(raw.writeRoots)
      ? raw.writeRoots.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
      : null;
  if (writeRoots === null || writeRoots.length > 8) {
    throw new Error('Native RDC write roots are invalid');
  }
  return {
    gatewayUrl: gatewayUrl.replace(/\/$/, ''),
    deviceId,
    deviceToken,
    readRoots,
    writeRoots,
  };
}

export async function saveProtectedMachineCredential(
  credential: NativeRdcMachineCredential,
  options: { filePath?: string; codec?: DpapiCodec } = {},
): Promise<string> {
  const checked = validateCredential(credential);
  const filePath = options.filePath ?? defaultNativeRdcCredentialPath();
  const codec = options.codec ?? windowsDpapi;
  const plaintext = Buffer.from(JSON.stringify(checked), 'utf8');
  let ciphertext: Buffer;
  try {
    ciphertext = codec.protect(plaintext);
  } finally {
    plaintext.fill(0);
  }
  const envelope: StoreEnvelope = {
    version: STORE_VERSION,
    protected: ciphertext.toString('base64'),
  };
  ciphertext.fill(0);
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = filePath + '.tmp-' + process.pid + '-' + Date.now();
  await writeFile(tempPath, JSON.stringify(envelope) + '\n', { encoding: 'utf8', mode: 0o600 });
  try { await chmod(tempPath, 0o600); } catch {}
  await rename(tempPath, filePath);
  try { await chmod(filePath, 0o600); } catch {}
  return filePath;
}

export async function loadProtectedMachineCredential(
  options: { filePath?: string; codec?: DpapiCodec } = {},
): Promise<NativeRdcMachineCredential> {
  const filePath = options.filePath ?? defaultNativeRdcCredentialPath();
  const codec = options.codec ?? windowsDpapi;
  let envelope: StoreEnvelope;
  try {
    const raw = await readFile(filePath, 'utf8');
    envelope = JSON.parse(raw) as StoreEnvelope;
  } catch {
    throw new Error('Native RDC protected credential is missing or unreadable');
  }
  if (envelope?.version !== STORE_VERSION || typeof envelope.protected !== 'string' || !envelope.protected) {
    throw new Error('Native RDC protected credential envelope is invalid');
  }
  let ciphertext: Buffer;
  let plaintext: Buffer;
  try {
    ciphertext = Buffer.from(envelope.protected, 'base64');
    if (!ciphertext.length) throw new Error('empty ciphertext');
    plaintext = codec.unprotect(ciphertext);
  } catch {
    throw new Error('Native RDC protected credential could not be decrypted');
  }
  try {
    return validateCredential(JSON.parse(plaintext.toString('utf8')));
  } catch {
    throw new Error('Native RDC protected credential payload is invalid');
  } finally {
    ciphertext!.fill(0);
    plaintext!.fill(0);
  }
}
