import os from 'os';
import { DesktopCommanderIntegration } from '../remote-device/desktop-commander-integration.js';
import {
  CallAckSchema,
  DeviceHelloSchema,
  DeviceOfflineSchema,
  DeviceReadySchema,
  HeartbeatSchema,
  ToolCallSchema,
  ToolErrorSchema,
  ToolListSchema,
  ToolResultSchema,
  type TerminalToolMessage,
  type ToolCall,
} from './protocol.js';

export interface NativeExecutor {
  initialize(): Promise<void>;
  listClientTools(): Promise<{ tools: any[] }>;
  callClientTool(toolName: string, args: any, metadata?: any): Promise<any>;
  shutdown(): Promise<void>;
}

export interface NativeDeviceClientOptions {
  baseUrl: string;
  deviceToken: string;
  deviceId: string;
  deviceName?: string;
  heartbeatMs?: number;
  reconnectMs?: number;
  executor?: NativeExecutor;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export class NativeDeviceClient {
  private readonly deviceName: string;
  private readonly heartbeatMs: number;
  private readonly reconnectMs: number;
  private readonly executor: NativeExecutor;
  private readonly ownsExecutor: boolean;
  private running = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private streamAbort: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;
  private readonly inFlight = new Set<string>();
  private readonly terminalCache = new Map<string, TerminalToolMessage>();

  constructor(private readonly options: NativeDeviceClientOptions) {
    this.deviceName = options.deviceName || os.hostname();
    this.heartbeatMs = options.heartbeatMs ?? 5_000;
    this.reconnectMs = options.reconnectMs ?? 500;
    this.executor = options.executor ?? new DesktopCommanderIntegration();
    this.ownsExecutor = !options.executor;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.executor.initialize();
      await this.register();
      this.scheduleHeartbeat();
      this.loopPromise = this.consumeLoop();
    } catch (error) {
      this.running = false;
      await this.safeExecutorShutdown();
      throw error;
    }
  }
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.streamAbort?.abort();
    this.streamAbort = null;

    try {
      await this.postJson('/v0/device/offline', DeviceOfflineSchema.parse({
        type: 'DEVICE_OFFLINE',
        device_id: this.options.deviceId,
        reason: 'device client stopping',
        sent_at: new Date().toISOString(),
      }));
    } catch { /* relay may already be gone */ }

    try { await this.loopPromise; } catch { /* stopping aborts the stream */ }
    this.loopPromise = null;
    await this.safeExecutorShutdown();
  }

  private async safeExecutorShutdown(): Promise<void> {
    try {
      await this.executor.shutdown();
    } catch (error) {
      if (this.ownsExecutor) {
        console.error('[native-rdc] executor shutdown failed:', error instanceof Error ? error.message : String(error));
      }
    }
  }

  private async register(): Promise<void> {
    const now = new Date().toISOString();
    const hello = DeviceHelloSchema.parse({
      type: 'DEVICE_HELLO',
      protocol_version: 1,
      device_id: this.options.deviceId,
      device_name: this.deviceName,
      sent_at: now,
    });
    DeviceReadySchema.parse(await this.postJson('/v0/device/hello', hello));
    const capabilities = await this.executor.listClientTools();
    const list = ToolListSchema.parse({
      type: 'TOOL_LIST',
      device_id: this.options.deviceId,
      tools: capabilities.tools,
      sent_at: new Date().toISOString(),
    });
    await this.postJson('/v0/device/tools', list);
  }

  private scheduleHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (!this.running) return;
      const heartbeat = HeartbeatSchema.parse({
        type: 'HEARTBEAT',
        device_id: this.options.deviceId,
        sent_at: new Date().toISOString(),
      });
      void this.postJson('/v0/device/heartbeat', heartbeat).catch(() => {
        // The SSE loop owns reconnect. A missed heartbeat alone must not spawn loops.
      });
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  private async consumeLoop(): Promise<void> {
    let first = true;
    while (this.running) {
      try {
        if (!first) await this.register();
        first = false;
        await this.consumeEvents();
      } catch (error) {
        if (!this.running) break;
        await sleep(this.reconnectMs);
      }
    }
  }
  private async consumeEvents(): Promise<void> {
    this.streamAbort = new AbortController();
    const response = await fetch(
      `${this.options.baseUrl}/v0/device/events?device_id=${encodeURIComponent(this.options.deviceId)}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.options.deviceToken}` },
        signal: this.streamAbort.signal,
      },
    );
    if (!response.ok || !response.body) {
      throw new Error(`Device event stream failed with HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (this.running) {
        const { done, value } = await reader.read();
        if (done) throw new Error('Device event stream closed');
        buffer += decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
          if (!dataLine) continue;
          const call = ToolCallSchema.parse(JSON.parse(dataLine.slice(6)));
          void this.handleCall(call);
        }
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
      this.streamAbort = null;
    }
  }
  private async handleCall(call: ToolCall): Promise<void> {
    const cached = this.terminalCache.get(call.call_id);
    if (cached) {
      await this.postJson('/v0/device/result', cached).catch(() => { /* retry on replay */ });
      return;
    }
    if (this.inFlight.has(call.call_id)) return;
    this.inFlight.add(call.call_id);

    const ack = CallAckSchema.parse({
      type: 'CALL_ACK',
      call_id: call.call_id,
      device_id: this.options.deviceId,
      acknowledged_at: new Date().toISOString(),
    });
    try {
      await this.postJson('/v0/device/ack', ack);
      let terminal: TerminalToolMessage;
      if (Date.parse(call.deadline_at) <= Date.now()) {
        terminal = ToolErrorSchema.parse({
          type: 'TOOL_ERROR',
          call_id: call.call_id,
          device_id: this.options.deviceId,
          status: 'failed',
          error: { message: 'Tool call arrived after its deadline', code: 'CALL_TIMEOUT' },
          completed_at: new Date().toISOString(),
        });
      } else {
        terminal = await this.execute(call);
      }
      this.rememberTerminal(terminal);
      await this.postJson('/v0/device/result', terminal);
    } catch (error) {
      const terminal = this.errorMessage(call, error);
      this.rememberTerminal(terminal);
      await this.postJson('/v0/device/result', terminal).catch(() => { /* relay may be restarting */ });
    } finally {
      this.inFlight.delete(call.call_id);
    }
  }
  private async execute(call: ToolCall): Promise<TerminalToolMessage> {
    try {
      const result = await this.executor.callClientTool(
        call.tool_name,
        call.arguments,
        { native_rdc_call_id: call.call_id },
      );
      return ToolResultSchema.parse({
        type: 'TOOL_RESULT',
        call_id: call.call_id,
        device_id: this.options.deviceId,
        status: 'completed',
        result,
        completed_at: new Date().toISOString(),
      });
    } catch (error) {
      return this.errorMessage(call, error);
    }
  }

  private errorMessage(call: ToolCall, error: unknown): TerminalToolMessage {
    const raw = error instanceof Error ? error.message : String(error);
    return ToolErrorSchema.parse({
      type: 'TOOL_ERROR',
      call_id: call.call_id,
      device_id: this.options.deviceId,
      status: 'failed',
      error: { message: raw.slice(0, 4096) || 'Unknown executor error', code: 'EXECUTOR_ERROR' },
      completed_at: new Date().toISOString(),
    });
  }

  private rememberTerminal(message: TerminalToolMessage): void {
    this.terminalCache.set(message.call_id, message);
    while (this.terminalCache.size > 256) {
      const oldest = this.terminalCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.terminalCache.delete(oldest);
    }
  }
  private async postJson(path: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${this.options.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.deviceToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Native RDC relay HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : null;
  }
}
