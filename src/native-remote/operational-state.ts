import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { defaultNativeRdcStateDirectory } from './windows-credential-store.js';

export type NativeRdcHealthState =
  | 'STARTING'
  | 'CONNECTING'
  | 'ONLINE'
  | 'DEGRADED'
  | 'OFFLINE'
  | 'AUTH_FAILED';

export interface NativeRdcHealth {
  state: NativeRdcHealthState;
  changedAt: string;
  retryCount: number;
  reason?: string;
}

export interface NativeRdcAuditEvent {
  timestamp: string;
  event: string;
  outcome?: string;
  correlationId?: string;
  reason?: string;
}

const SECRET_PATTERN = /(bearer\s+\S+|token|secret|authorization|credential)/i;

function safeText(value: unknown, max = 160): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).slice(0, max);
  if (SECRET_PATTERN.test(text)) return '[REDACTED]';
  return text;
}

export function sanitizeAuditEvent(input: NativeRdcAuditEvent): NativeRdcAuditEvent {
  return {
    timestamp: input.timestamp,
    event: safeText(input.event, 80) || 'UNKNOWN',
    ...(input.outcome ? { outcome: safeText(input.outcome, 80) } : {}),
    ...(input.correlationId ? { correlationId: safeText(input.correlationId, 80) } : {}),
    ...(input.reason ? { reason: safeText(input.reason, 160) } : {}),
  };
}

async function atomicWrite(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temp = filePath + '.tmp-' + process.pid + '-' + Date.now();
  await writeFile(temp, text, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, filePath);
}

export class BoundedAuditLog {
  private events: NativeRdcAuditEvent[] = [];

  constructor(
    private readonly filePath = path.join(defaultNativeRdcStateDirectory(), 'audit.jsonl'),
    private readonly maxEvents = 256,
  ) {
    if (!Number.isInteger(maxEvents) || maxEvents < 1) throw new Error('maxEvents must be positive');
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.events = raw.split(/\r?\n/).filter(Boolean).flatMap((line) => {
        try { return [sanitizeAuditEvent(JSON.parse(line))]; } catch { return []; }
      }).slice(-this.maxEvents);
    } catch {
      this.events = [];
    }
  }

  async append(event: Omit<NativeRdcAuditEvent, 'timestamp'> & { timestamp?: string }): Promise<void> {
    this.events.push(sanitizeAuditEvent({
      ...event,
      timestamp: event.timestamp || new Date().toISOString(),
    }));
    this.events = this.events.slice(-this.maxEvents);
    await atomicWrite(this.filePath, this.events.map((item) => JSON.stringify(item)).join('\n') + '\n');
  }

  snapshot(): NativeRdcAuditEvent[] {
    return this.events.map((event) => ({ ...event }));
  }
}

export async function writeHealthState(
  health: NativeRdcHealth,
  filePath = path.join(defaultNativeRdcStateDirectory(), 'health.json'),
): Promise<void> {
  const safe: NativeRdcHealth = {
    state: health.state,
    changedAt: health.changedAt,
    retryCount: Math.max(0, Math.floor(health.retryCount)),
    ...(health.reason ? { reason: safeText(health.reason, 160) } : {}),
  };
  await atomicWrite(filePath, JSON.stringify(safe) + '\n');
}

export function boundedBackoffMs(attempt: number): number {
  const schedule = [1000, 2000, 5000, 10000, 30000];
  const index = Math.max(0, Math.min(schedule.length - 1, Math.floor(attempt)));
  return schedule[index];
}
