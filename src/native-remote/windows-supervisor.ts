import { open, readFile, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { CloudflareDeviceClient } from './cloudflare-device-client.js';
import {
  defaultNativeRdcStateDirectory,
  loadProtectedMachineCredential,
  type NativeRdcMachineCredential,
} from './windows-credential-store.js';
import {
  BoundedAuditLog,
  boundedBackoffMs,
  writeHealthState,
} from './operational-state.js';

type ClientLike = {
  start(): Promise<void>;
  stop(): Promise<void>;
};

export interface SupervisorDependencies {
  loadCredential?: () => Promise<NativeRdcMachineCredential>;
  createClient?: (credential: NativeRdcMachineCredential) => ClientLike;
  sleep?: (ms: number) => Promise<void>;
  processAlive?: (pid: number) => boolean;
  stateDirectory?: string;
  audit?: BoundedAuditLog;
  writeHealth?: typeof writeHealthState;
}

class SingleInstanceLock {
  private held = false;

  constructor(
    private readonly filePath: string,
    private readonly processAlive: (pid: number) => boolean,
  ) {}

  async acquire(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const handle = await open(this.filePath, 'wx', 0o600);
      try {
        await handle.writeFile(String(process.pid), 'utf8');
      } finally {
        await handle.close();
      }
      this.held = true;
      return;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
    }

    let existingPid = 0;
    try {
      existingPid = Number((await readFile(this.filePath, 'utf8')).trim());
    } catch {}
    if (existingPid > 0 && this.processAlive(existingPid)) {
      throw new Error('Native RDC supervisor is already running');
    }
    try { await unlink(this.filePath); } catch {}
    const handle = await open(this.filePath, 'wx', 0o600);
    try {
      await handle.writeFile(String(process.pid), 'utf8');
    } finally {
      await handle.close();
    }
    this.held = true;
  }

  async release(): Promise<void> {
    if (!this.held) return;
    this.held = false;
    try { await unlink(this.filePath); } catch {}
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function defaultProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultCreateClient(credential: NativeRdcMachineCredential): ClientLike {
  return new CloudflareDeviceClient({
    gatewayUrl: credential.gatewayUrl,
    deviceToken: credential.deviceToken,
    deviceId: credential.deviceId,
    readRoots: credential.readRoots ?? [],
  });
}

export async function runWindowsSupervisor(
  signal: AbortSignal,
  deps: SupervisorDependencies = {},
): Promise<void> {
  const stateDirectory = deps.stateDirectory ?? defaultNativeRdcStateDirectory();
  const audit = deps.audit ?? new BoundedAuditLog(path.join(stateDirectory, 'audit.jsonl'));
  const healthPath = path.join(stateDirectory, 'health.json');
  const writeHealth = deps.writeHealth ?? writeHealthState;
  const sleep = deps.sleep ?? defaultSleep;
  const processAlive = deps.processAlive ?? defaultProcessAlive;
  const loadCredential = deps.loadCredential ?? (() => loadProtectedMachineCredential());
  const createClient = deps.createClient ?? defaultCreateClient;
  const lock = new SingleInstanceLock(path.join(stateDirectory, 'supervisor.lock'), processAlive);

  await lock.acquire();
  await audit.load();
  await audit.append({ event: 'SUPERVISOR_STARTED', outcome: 'ok' });
  let client: ClientLike | null = null;
  let attempt = 0;

  try {
    while (!signal.aborted) {
      await writeHealth({
        state: attempt === 0 ? 'STARTING' : 'CONNECTING',
        changedAt: new Date().toISOString(),
        retryCount: attempt,
      }, healthPath);

      let credential: NativeRdcMachineCredential;
      try {
        credential = await loadCredential();
      } catch {
        await writeHealth({
          state: 'AUTH_FAILED',
          changedAt: new Date().toISOString(),
          retryCount: attempt,
          reason: 'protected credential unavailable',
        }, healthPath);
        await audit.append({ event: 'DEVICE_AUTH_FAILED', outcome: 'blocked', reason: 'protected credential unavailable' });
        throw new Error('Native RDC protected credential unavailable');
      }

      try {
        client = createClient(credential);
        await audit.append({ event: 'DEVICE_CONNECTING', outcome: 'attempt' });
        await client.start();
        attempt = 0;
        await writeHealth({
          state: 'ONLINE',
          changedAt: new Date().toISOString(),
          retryCount: 0,
        }, healthPath);
        await audit.append({ event: 'DEVICE_CONNECTED', outcome: 'ok' });

        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        break;
      } catch (error) {
        if (signal.aborted) break;
        const delay = boundedBackoffMs(attempt);
        await writeHealth({
          state: 'DEGRADED',
          changedAt: new Date().toISOString(),
          retryCount: attempt + 1,
          reason: 'connector start failed',
        }, healthPath);
        await audit.append({ event: 'DEVICE_RESTARTING', outcome: 'retry', reason: 'connector start failed' });
        attempt += 1;
        try { await client?.stop(); } catch {}
        client = null;
        await sleep(delay);
      }
    }
  } finally {
    try { await client?.stop(); } catch {}
    await writeHealth({
      state: 'OFFLINE',
      changedAt: new Date().toISOString(),
      retryCount: 0,
      reason: signal.aborted ? 'graceful stop' : 'supervisor exit',
    }, healthPath);
    await audit.append({ event: 'SUPERVISOR_STOPPED', outcome: signal.aborted ? 'graceful' : 'exit' });
    await lock.release();
  }
}

export async function main(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Native RDC Windows supervisor requires Windows');
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await runWindowsSupervisor(controller.signal);
}

if (import.meta.url === new URL(process.argv[1] || '', 'file:///').href) {
  main().catch((error) => {
    console.error('Native RDC supervisor failed:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  });
}
