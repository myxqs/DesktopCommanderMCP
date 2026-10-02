import { spawn, type ChildProcess } from 'node:child_process';
import { open, readFile, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultNativeRdcStateDirectory } from './windows-credential-store.js';
import { boundedBackoffMs } from './operational-state.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR_PATH = path.join(MODULE_DIR, 'windows-supervisor.js');

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function acquireLock(filePath: string): Promise<() => Promise<void>> {
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    const handle = await open(filePath, 'wx', 0o600);
    await handle.writeFile(String(process.pid), 'utf8');
    await handle.close();
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
    let existingPid = 0;
    try { existingPid = Number((await readFile(filePath, 'utf8')).trim()); } catch {}
    if (processAlive(existingPid)) throw new Error('Native RDC watchdog is already running');
    try { await unlink(filePath); } catch {}
    const handle = await open(filePath, 'wx', 0o600);
    await handle.writeFile(String(process.pid), 'utf8');
    await handle.close();
  }
  return async () => { try { await unlink(filePath); } catch {} };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export async function runWindowsWatchdog(signal: AbortSignal): Promise<void> {
  const stateDirectory = defaultNativeRdcStateDirectory();
  const release = await acquireLock(path.join(stateDirectory, 'watchdog.lock'));
  let child: ChildProcess | null = null;
  let attempt = 0;

  const stopChild = async () => {
    const active = child;
    child = null;
    if (!active || active.exitCode !== null) return;
    try { active.kill('SIGTERM'); } catch {}
    await Promise.race([
      new Promise<void>((resolve) => active.once('exit', () => resolve())),
      sleep(3000),
    ]);
    if (active.exitCode === null) {
      try { active.kill('SIGKILL'); } catch {}
    }
  };

  signal.addEventListener('abort', () => { void stopChild(); }, { once: true });

  try {
    while (!signal.aborted) {
      const startedAt = Date.now();
      child = spawn(process.execPath, [SUPERVISOR_PATH], {
        cwd: path.resolve(MODULE_DIR, '..', '..'),
        windowsHide: true,
        stdio: 'ignore',
        shell: false,
      });
      const exitCode = await new Promise<number | null>((resolve) => {
        child?.once('exit', (code) => resolve(code));
        child?.once('error', () => resolve(-1));
      });
      if (signal.aborted) break;

      const stable = Date.now() - startedAt >= 30_000;
      attempt = stable ? 0 : attempt + 1;
      const delay = boundedBackoffMs(Math.max(0, attempt - 1));
      await sleep(delay);
      child = null;

      // A clean unexpected exit is still restarted; only watchdog shutdown stops recovery.
      void exitCode;
    }
  } finally {
    await stopChild();
    await release();
  }
}
export async function main(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Native RDC Windows watchdog requires Windows');
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await runWindowsWatchdog(controller.signal);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('Native RDC watchdog failed:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  });
}
