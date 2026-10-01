import { createHash, randomBytes, timingSafeEqual } from 'crypto';

export interface NativeRdcConfig {
  host: string;
  port: number;
  deviceToken: string;
  clientToken: string;
  maxBodyBytes: number;
  callTimeoutMs: number;
  heartbeatTtlMs: number;
  maxCalls: number;
  retentionMs: number;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 47777;

export function generateNativeRdcToken(bytes = 32): string {
  if (!Number.isInteger(bytes) || bytes < 24 || bytes > 128) {
    throw new Error('Token size must be an integer between 24 and 128 bytes');
  }
  return randomBytes(bytes).toString('base64url');
}

function parsePositiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === '127.0.0.1'
    || normalized === 'localhost'
    || normalized === '::1'
    || normalized === '[::1]';
}

export function loadNativeRdcConfig(env: NodeJS.ProcessEnv = process.env): NativeRdcConfig {
  const deviceToken = env.NATIVE_RDC_DEVICE_TOKEN?.trim() ?? '';
  const clientToken = env.NATIVE_RDC_CLIENT_TOKEN?.trim() ?? '';
  if (!deviceToken || !clientToken) {
    throw new Error('NATIVE_RDC_DEVICE_TOKEN and NATIVE_RDC_CLIENT_TOKEN are required');
  }
  if (deviceToken === clientToken) {
    throw new Error('Device and client tokens must be different');
  }

  const host = (env.NATIVE_RDC_HOST || DEFAULT_HOST).trim();
  if (!isLoopbackHost(host)) {
    throw new Error('Native RDC v0 refuses non-loopback NATIVE_RDC_HOST values');
  }

  const port = parsePositiveInt('NATIVE_RDC_PORT', env.NATIVE_RDC_PORT, DEFAULT_PORT);
  if (port > 65535) throw new Error('NATIVE_RDC_PORT must be <= 65535');

  return {
    host,
    port,
    deviceToken,
    clientToken,
    maxBodyBytes: parsePositiveInt('NATIVE_RDC_MAX_BODY_BYTES', env.NATIVE_RDC_MAX_BODY_BYTES, 1_048_576),
    callTimeoutMs: parsePositiveInt('NATIVE_RDC_CALL_TIMEOUT_MS', env.NATIVE_RDC_CALL_TIMEOUT_MS, 30_000),
    heartbeatTtlMs: parsePositiveInt('NATIVE_RDC_HEARTBEAT_TTL_MS', env.NATIVE_RDC_HEARTBEAT_TTL_MS, 20_000),
    maxCalls: parsePositiveInt('NATIVE_RDC_MAX_CALLS', env.NATIVE_RDC_MAX_CALLS, 512),
    retentionMs: parsePositiveInt('NATIVE_RDC_RETENTION_MS', env.NATIVE_RDC_RETENTION_MS, 10 * 60_000),
  };
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function secureTokenEqual(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  return timingSafeEqual(digest(provided), digest(expected));
}

export function extractBearerToken(header: string | string[] | undefined): string | null {
  if (Array.isArray(header) || typeof header !== 'string') return null;
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(header);
  return match?.[1] ?? null;
}

export function isAuthorized(header: string | string[] | undefined, expected: string): boolean {
  const provided = extractBearerToken(header);
  return provided !== null && secureTokenEqual(provided, expected);
}
