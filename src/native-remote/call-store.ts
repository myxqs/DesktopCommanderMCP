import type { TerminalToolMessage, ToolCall } from './protocol.js';

export type CallState = 'pending' | 'running' | 'completed' | 'failed' | 'expired';

export interface CallRecord {
  call: ToolCall;
  state: CallState;
  createdAt: number;
  updatedAt: number;
  terminal?: TerminalToolMessage;
}

interface Waiter {
  resolve: (record: CallRecord) => void;
}

export class NativeCallStore {
  private readonly calls = new Map<string, CallRecord>();
  private readonly waiters = new Map<string, Set<Waiter>>();

  constructor(
    private readonly maxCalls = 512,
    private readonly retentionMs = 10 * 60_000,
  ) {}

  create(call: ToolCall): CallRecord {
    this.prune();
    if (this.calls.has(call.call_id)) {
      throw new Error('DUPLICATE_CALL_ID');
    }
    if (this.calls.size >= this.maxCalls) {
      this.prune(true);
    }
    if (this.calls.size >= this.maxCalls) {
      throw new Error('CALL_STORE_FULL');
    }

    const now = Date.now();
    const record: CallRecord = {
      call,
      state: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    this.calls.set(call.call_id, record);
    return record;
  }

  get(callId: string): CallRecord | undefined {
    return this.calls.get(callId);
  }

  markRunning(callId: string): CallRecord | undefined {
    const record = this.calls.get(callId);
    if (!record || record.state !== 'pending') return record;
    record.state = 'running';
    record.updatedAt = Date.now();
    return record;
  }

  complete(callId: string, terminal: TerminalToolMessage): CallRecord | undefined {
    const record = this.calls.get(callId);
    if (!record) return undefined;
    if (record.state === 'completed' || record.state === 'failed' || record.state === 'expired') {
      return record;
    }
    record.state = terminal.type === 'TOOL_RESULT' ? 'completed' : 'failed';
    record.terminal = terminal;
    record.updatedAt = Date.now();
    this.resolveWaiters(record);
    return record;
  }

  expire(callId: string, terminal: TerminalToolMessage): CallRecord | undefined {
    const record = this.calls.get(callId);
    if (!record || record.state === 'completed' || record.state === 'failed') return record;
    record.state = 'expired';
    record.terminal = terminal;
    record.updatedAt = Date.now();
    this.resolveWaiters(record);
    return record;
  }

  waitForTerminal(callId: string): Promise<CallRecord> {
    const record = this.calls.get(callId);
    if (!record) return Promise.reject(new Error('UNKNOWN_CALL_ID'));
    if (record.terminal) return Promise.resolve(record);

    return new Promise<CallRecord>((resolve) => {
      const set = this.waiters.get(callId) ?? new Set<Waiter>();
      set.add({ resolve });
      this.waiters.set(callId, set);
    });
  }

  listPending(deviceId?: string): ToolCall[] {
    return [...this.calls.values()]
      .filter((record) => (record.state === 'pending' || record.state === 'running')
        && (!deviceId || record.call.device_id === deviceId))
      .map((record) => record.call);
  }
  size(): number {
    return this.calls.size;
  }

  private resolveWaiters(record: CallRecord): void {
    const set = this.waiters.get(record.call.call_id);
    if (!set) return;
    this.waiters.delete(record.call.call_id);
    for (const waiter of set) waiter.resolve(record);
  }

  private prune(forceOldest = false): void {
    const now = Date.now();
    for (const [id, record] of this.calls) {
      const terminal = record.state === 'completed' || record.state === 'failed' || record.state === 'expired';
      if (terminal && now - record.updatedAt >= this.retentionMs) {
        this.calls.delete(id);
        this.waiters.delete(id);
      }
    }

    if (!forceOldest || this.calls.size < this.maxCalls) return;
    const removable = [...this.calls.entries()]
      .filter(([, record]) => record.state === 'completed' || record.state === 'failed' || record.state === 'expired')
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    while (this.calls.size >= this.maxCalls && removable.length) {
      const [id] = removable.shift()!;
      this.calls.delete(id);
      this.waiters.delete(id);
    }
  }
}
