import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import WebSocket from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultNativeRdcStateDirectory,
  loadProtectedMachineCredential,
  saveProtectedMachineCredential,
  type NativeRdcMachineCredential,
} from './windows-credential-store.js';

export type DoctorLevel = 'PASS' | 'WARN' | 'FAIL';
export type DoctorCheck = { name: string; level: DoctorLevel; detail: string };

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WINDOWS_SCRIPT = path.join(REPO_ROOT, 'scripts', 'native-rdc-windows.ps1');
const SUPERVISOR_PATH = path.join(REPO_ROOT, 'dist', 'native-remote', 'windows-supervisor.js');
const LAST_GOOD_FILE = path.join(defaultNativeRdcStateDirectory(), 'last-good-head.txt');

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

function run(command: string, args: string[], options: { cwd?: string; input?: string } = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    input: options.input,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
  });
}

function safeDetail(value: unknown): string {
  return String(value ?? '').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 500);
}

export async function safeLifecycleStatus() {
  let credential: NativeRdcMachineCredential | null = null;
  try { credential = await loadProtectedMachineCredential(); } catch {}
  let health: any = null;
  try {
    health = JSON.parse(await readFile(path.join(defaultNativeRdcStateDirectory(), 'health.json'), 'utf8'));
  } catch {}
  return {
    credentialConfigured: Boolean(credential),
    gatewayOrigin: credential ? new URL(credential.gatewayUrl).origin : null,
    deviceId: credential?.deviceId ?? null,
    readRootCount: credential?.readRoots?.length ?? 0,
    writeRootCount: credential?.writeRoots?.length ?? 0,
    health: health && typeof health === 'object' ? {
      state: health.state ?? null,
      changedAt: health.changedAt ?? null,
      retryCount: health.retryCount ?? null,
      reason: health.reason ?? null,
    } : null,
  };
}
export async function doctorNativeRdc(): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  checks.push({
    name: 'windows',
    level: process.platform === 'win32' ? 'PASS' : 'FAIL',
    detail: process.platform === 'win32' ? 'Windows runtime detected' : 'Native RDC production lifecycle requires Windows',
  });
  checks.push({
    name: 'build',
    level: await exists(SUPERVISOR_PATH) ? 'PASS' : 'FAIL',
    detail: 'Compiled supervisor',
  });

  const status = await safeLifecycleStatus();
  checks.push({
    name: 'protected-credential',
    level: status.credentialConfigured ? 'PASS' : 'FAIL',
    detail: status.credentialConfigured ? 'DPAPI-protected machine credential is readable' : 'Protected machine credential is unavailable',
  });
  checks.push({
    name: 'health',
    level: status.health?.state === 'ONLINE' ? 'PASS' : status.health ? 'WARN' : 'FAIL',
    detail: status.health ? 'Supervisor state: ' + safeDetail(status.health.state) : 'No supervisor health state',
  });

  if (process.platform === 'win32') {
    const task = run('schtasks.exe', ['/Query', '/TN', 'Native RDC Device', '/FO', 'CSV', '/NH']);
    checks.push({
      name: 'scheduled-task',
      level: task.status === 0 ? 'PASS' : 'FAIL',
      detail: task.status === 0 ? 'Native RDC Device task is registered' : 'Native RDC Device task is not registered',
    });
  }

  if (process.platform === 'win32') {
    const probe = run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "$pids=@(Get-CimInstance Win32_Process | Where-Object {$_.CommandLine -match 'windows-supervisor.js|cloudflare-device-main.js'} | Select-Object -ExpandProperty ProcessId); $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {$pids -contains $_.OwningProcess}).Count; $rules=@(Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object {$_.DisplayName -match 'Native RDC'}).Count; Write-Output ($listeners.ToString()+','+$rules.ToString())"
    ]);
    const match = /^(\d+),(\d+)$/m.exec((probe.stdout || '').trim());
    const listeners = match ? Number(match[1]) : null;
    const rules = match ? Number(match[2]) : null;
    checks.push({
      name: 'network-exposure',
      level: listeners === 0 && rules === 0 ? 'PASS' : match ? 'FAIL' : 'WARN',
      detail: match ? `Native RDC listeners: ${listeners}; matching firewall rules: ${rules}` : 'Network exposure probe unavailable',
    });
  }

  if (status.gatewayOrigin) {
    try {
      const response = await fetch(status.gatewayOrigin + '/health', { signal: AbortSignal.timeout(5000) });
      checks.push({
        name: 'gateway-health',
        level: response.ok ? 'PASS' : 'FAIL',
        detail: 'Gateway HTTP ' + response.status,
      });
    } catch {
      checks.push({ name: 'gateway-health', level: 'FAIL', detail: 'Gateway health request failed' });
    }
  } else {
    checks.push({ name: 'gateway-health', level: 'FAIL', detail: 'Gateway origin unavailable' });
  }

  return checks;
}

function runWindowsAction(action: string): void {
  if (process.platform !== 'win32') throw new Error('Native RDC lifecycle action requires Windows');
  const result = run('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', WINDOWS_SCRIPT, '-Action', action,
  ]);
  if (result.status !== 0) throw new Error('Native RDC Windows action failed: ' + safeDetail(result.stderr));
  if (result.stdout) process.stdout.write(result.stdout);
}

export async function assertInstallPrerequisites(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Native RDC production install requires Windows');
  if (!(await exists(SUPERVISOR_PATH))) throw new Error('Compiled Native RDC supervisor is unavailable');
  try {
    await loadProtectedMachineCredential();
  } catch {
    throw new Error('Protected Native RDC machine credential is unavailable');
  }
}

export async function installNativeRdc(): Promise<void> {
  await assertInstallPrerequisites();
  runWindowsAction('Install');
}

function git(args: string[]) {
  const result = run('git', args, { cwd: REPO_ROOT });
  if (result.status !== 0) throw new Error('Git lifecycle operation failed: ' + safeDetail(result.stderr));
  return (result.stdout || '').trim();
}

function validateUpdateCandidate(): string | null {
  const build = run('npm.cmd', ['run', 'build'], { cwd: REPO_ROOT });
  if (build.status !== 0) return 'build failed: ' + safeDetail(build.stderr);
  for (const testFile of ['test/test-native-rdc-m3d.js', 'test/test-native-rdc-m4.js']) {
    const test = run(process.execPath, [testFile], { cwd: REPO_ROOT });
    if (test.status !== 0) return path.basename(testFile) + ' failed: ' + safeDetail(test.stderr || test.stdout);
  }
  return null;
}

function restoreUpdateHead(oldHead: string): void {
  git(['reset', '--hard', oldHead]);
  const restore = run('npm.cmd', ['run', 'build'], { cwd: REPO_ROOT });
  if (restore.status !== 0) {
    throw new Error('Update validation failed and the previous revision could not be rebuilt: ' + safeDetail(restore.stderr));
  }
}

export async function updateNativeRdc(): Promise<void> {
  if (git(['status', '--porcelain'])) throw new Error('Refusing update with a dirty worktree');
  const oldHead = git(['rev-parse', 'HEAD']);
  await mkdir(path.dirname(LAST_GOOD_FILE), { recursive: true });
  await writeFile(LAST_GOOD_FILE, oldHead + '\n', { encoding: 'utf8', mode: 0o600 });
  git(['pull', '--ff-only']);
  const validationError = validateUpdateCandidate();
  if (validationError) {
    restoreUpdateHead(oldHead);
    throw new Error('Update validation failed; repository restored to last known good commit: ' + validationError);
  }
  runWindowsAction('Restart');
}

export async function rollbackNativeRdc(): Promise<void> {
  if (git(['status', '--porcelain'])) throw new Error('Refusing rollback with a dirty worktree');
  const target = (await readFile(LAST_GOOD_FILE, 'utf8')).trim();
  if (!/^[0-9a-f]{40}$/i.test(target)) throw new Error('Last-known-good commit is invalid');
  git(['cat-file', '-e', target + '^{commit}']);
  git(['reset', '--hard', target]);
  const build = run('npm.cmd', ['run', 'build'], { cwd: REPO_ROOT });
  if (build.status !== 0) throw new Error('Rollback target failed to build');
  runWindowsAction('Restart');
}

function resolveWrangler(): string {
  const configured = process.env.NATIVE_RDC_WRANGLER_PATH?.trim();
  if (configured) return configured;
  const executable = process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler';
  const local = path.join(REPO_ROOT, 'node_modules', '.bin', executable);
  return existsSync(local) ? local : executable;
}

function putWorkerSecret(secretName: string, value: string) {
  const wrangler = resolveWrangler();
  const cwd = path.join(REPO_ROOT, 'cloudflare', 'native-rdc-gateway');
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(wrangler)) {
    const commandLine = '"' + wrangler + '" secret put ' + secretName + ' --name native-rdc-gateway';
    return spawnSync(commandLine, {
      cwd,
      input: value + '\n',
      encoding: 'utf8',
      windowsHide: true,
      shell: true,
    });
  }
  return run(wrangler, ['secret', 'put', secretName, '--name', 'native-rdc-gateway'], {
    cwd,
    input: value + '\n',
  });
}

async function deviceCredentialAccepted(gatewayUrl: string, deviceId: string, token: string): Promise<boolean> {
  const url = new URL('/v1/device/connect', gatewayUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('device_id', deviceId);
  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const socket = new WebSocket(url, {
      headers: { Authorization: 'Bearer ' + token },
      handshakeTimeout: 7000,
      maxPayload: 4096,
    });
    const timer = setTimeout(() => {
      try { socket.terminate(); } catch {}
      fail(new Error('Device credential rejection probe timed out'));
    }, 8000);
    socket.once('open', () => {
      try { socket.terminate(); } catch {}
      finish(true);
    });
    socket.once('unexpected-response', (_request, response) => {
      const status = response.statusCode ?? 0;
      response.resume();
      try { socket.terminate(); } catch {}
      if (status === 401 || status === 403) finish(false);
      else fail(new Error('Device credential rejection probe returned HTTP ' + status));
    });
    socket.once('error', (error) => {
      try { socket.terminate(); } catch {}
      if (!settled) fail(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

async function waitForDeviceCredentialRejection(
  gatewayUrl: string,
  deviceId: string,
  oldToken: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (!await deviceCredentialAccepted(gatewayUrl, deviceId, oldToken)) return true;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return false;
}

export async function rotateDeviceCredential(): Promise<void> {
  const current = await loadProtectedMachineCredential();
  const nextToken = randomBytes(32).toString('base64url');
  const next = { ...current, deviceToken: nextToken };
  await saveProtectedMachineCredential(next);
  const result = putWorkerSecret('DEVICE_TOKEN', nextToken);
  if (result.status !== 0) {
    await saveProtectedMachineCredential(current);
    throw new Error('Cloudflare credential rotation failed; local protected credential restored');
  }

  try {
    if (!await waitForDeviceCredentialRejection(current.gatewayUrl, current.deviceId, current.deviceToken)) {
      throw new Error('Superseded device credential remained accepted beyond the verification window');
    }
  } catch (error) {
    const rollback = putWorkerSecret('DEVICE_TOKEN', current.deviceToken);
    await saveProtectedMachineCredential(current);
    if (rollback.status !== 0) {
      throw new Error('Credential rejection proof failed and Cloudflare rollback also failed; manual recovery required');
    }
    throw new Error('Credential rotation verification failed; previous credential restored: ' + safeDetail(error instanceof Error ? error.message : error));
  }

  runWindowsAction('Restart');
  console.log(JSON.stringify({
    rotated: true,
    secret: 'DEVICE_TOKEN',
    oldCredentialRejected: true,
    tokenPrinted: false,
  }));
}
export async function lifecycleMain(argv = process.argv.slice(2)): Promise<void> {
  const command = (argv[0] || 'status').toLowerCase();
  if (command === 'status') {
    console.log(JSON.stringify(await safeLifecycleStatus(), null, 2));
    return;
  }
  if (command === 'doctor' || command === 'diagnostics') {
    const checks = await doctorNativeRdc();
    console.log(JSON.stringify({ checks }, null, 2));
    if (checks.some((check) => check.level === 'FAIL')) process.exitCode = 1;
    return;
  }
  if (command === 'install') return installNativeRdc();
  if (command === 'start') return runWindowsAction('Start');
  if (command === 'stop') return runWindowsAction('Stop');
  if (command === 'restart') return runWindowsAction('Restart');
  if (command === 'uninstall') return runWindowsAction('Uninstall');
  if (command === 'update') return updateNativeRdc();
  if (command === 'rollback') return rollbackNativeRdc();
  if (command === 'rotate-credential') return rotateDeviceCredential();
  throw new Error('Usage: native-rdc [status|doctor|install|start|stop|restart|update|rollback|rotate-credential|uninstall]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  lifecycleMain().catch((error) => {
    console.error('Native RDC lifecycle command failed:', safeDetail(error instanceof Error ? error.message : error));
    process.exitCode = 1;
  });
}
