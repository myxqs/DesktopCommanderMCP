import os from 'os';
import WebSocket from 'ws';
import { DesktopCommanderIntegration } from '../remote-device/desktop-commander-integration.js';
import {
  CallAckSchema,
  DeviceHelloSchema,
  DeviceOfflineSchema,
  HeartbeatSchema,
  ToolCallSchema,
  ToolErrorSchema,
  ToolListSchema,
  ToolResultSchema,
  type TerminalToolMessage,
  type ToolCall,
} from './protocol.js';
import type { NativeExecutor } from './device-client.js';
import {
  REMOTE_READ_TOOLS,
  validateRemoteReadArguments,
} from './safe-read-policy.js';

const MAX_DEVICE_MESSAGE_BYTES = 1024 * 1024;

export interface CloudflareDeviceClientOptions {
  gatewayUrl: string;
  deviceToken: string;
  deviceId: string;
  deviceName?: string;
  heartbeatMs?: number;
  reconnectMs?: number;
  connectTimeoutMs?: number;
  executor?: NativeExecutor;
  readRoots?: string[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class CloudflareDeviceClient {
  private readonly deviceName: string;
  private readonly heartbeatMs: number;
  private readonly reconnectMs: number;
  private readonly connectTimeoutMs: number;
  private readonly executor: NativeExecutor;
  private readonly ownsExecutor: boolean;
  private running = false;
  private socket: WebSocket | null = null;
  private loopPromise: Promise<void> | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private firstReadyResolve: (() => void) | null = null;
  private firstReadyReject: ((error: Error) => void) | null = null;
  private readonly inFlight = new Set<string>();
  private readonly terminalCache = new Map<string, TerminalToolMessage>();

  constructor(private readonly options: CloudflareDeviceClientOptions) {
    this.deviceName = options.deviceName || os.hostname();
    this.heartbeatMs = options.heartbeatMs ?? 5_000;
    this.reconnectMs = options.reconnectMs ?? 750;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 30_000;
    this.executor = options.executor ?? new DesktopCommanderIntegration();
    this.ownsExecutor = !options.executor;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.executor.initialize();
      const firstReady = new Promise<void>((resolve, reject) => {
        this.firstReadyResolve = resolve;
        this.firstReadyReject = reject;
      });
      this.loopPromise = this.connectLoop();
      await Promise.race([
        firstReady,
        new Promise<void>((_, reject) => setTimeout(
          () => reject(new Error('Timed out waiting for Native RDC M1 gateway connection')),
          this.connectTimeoutMs,
        )),
      ]);
    } catch (error) {
      this.running = false;
      this.closeSocket();
      await this.safeExecutorShutdown();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.clearHeartbeat();
    if (this.socket?.readyState === WebSocket.OPEN) {
      try {
        this.send(DeviceOfflineSchema.parse({
          type: 'DEVICE_OFFLINE',
          device_id: this.options.deviceId,
          reason: 'M1 device stopping',
          sent_at: new Date().toISOString(),
        }));
      } catch {}
    }
    this.closeSocket();
    try { await this.loopPromise; } catch {}
    this.loopPromise = null;
    await this.safeExecutorShutdown();
  }

  private async safeExecutorShutdown(): Promise<void> {
    try {
      await this.executor.shutdown();
    } catch (error) {
      if (this.ownsExecutor) {
        console.error('[native-rdc-m1] executor shutdown failed:', error instanceof Error ? error.message : String(error));
      }
    }
  }

  private gatewayWebSocketUrl(): string {
    const url = new URL('/v1/device/connect', this.options.gatewayUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('device_id', this.options.deviceId);
    return url.toString();
  }

  private async connectLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.connectOnce();
      } catch (error) {
        if (!this.running) break;
        if (this.firstReadyReject && !this.firstReadyResolve) {
          this.firstReadyReject(error instanceof Error ? error : new Error(String(error)));
        }
      }
      if (this.running) await sleep(this.reconnectMs);
    }
  }

  private async connectOnce(): Promise<void> {
    const socket = new WebSocket(this.gatewayWebSocketUrl(), {
      headers: { Authorization: `Bearer ${this.options.deviceToken}` },
      handshakeTimeout: 10_000,
      maxPayload: MAX_DEVICE_MESSAGE_BYTES,
    });
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        socket.off('error', onErrorBeforeOpen);
        resolve();
      };
      const onErrorBeforeOpen = (error: Error) => {
        socket.off('open', onOpen);
        reject(error);
      };
      socket.once('open', onOpen);
      socket.once('error', onErrorBeforeOpen);
      socket.once('unexpected-response', (_request, response) => {
        reject(new Error(`Gateway WebSocket rejected device with HTTP ${response.statusCode}`));
      });
    });

    await this.register(socket);
    this.scheduleHeartbeat(socket);
    const ready = this.firstReadyResolve;
    this.firstReadyResolve = null;
    this.firstReadyReject = null;
    ready?.();

    await new Promise<void>((resolve) => {
      socket.on('message', (data, isBinary) => {
        if (isBinary) {
          socket.close(1003, 'text messages required');
          return;
        }
        const text = data.toString('utf8');
        if (Buffer.byteLength(text, 'utf8') > MAX_DEVICE_MESSAGE_BYTES) {
          socket.close(1009, 'message too large');
          return;
        }
        void this.handleGatewayMessage(text);
      });
      socket.once('close', (code, reason) => {
        if (this.running) {
          console.warn(`[native-rdc-m1] gateway websocket closed (${code}: ${reason.toString().slice(0, 160) || 'no reason'})`);
        }
        resolve();
      });
      socket.once('error', (error) => {
        if (this.running) {
          console.warn('[native-rdc-m1] gateway websocket error:', error.message);
        }
        resolve();
      });
    });

    if (this.socket === socket) this.socket = null;
    this.clearHeartbeat();
  }

  private async register(socket: WebSocket): Promise<void> {
    this.send(DeviceHelloSchema.parse({
      type: 'DEVICE_HELLO',
      protocol_version: 1,
      device_id: this.options.deviceId,
      device_name: this.deviceName,
      sent_at: new Date().toISOString(),
    }), socket);

    const capabilities = await this.executor.listClientTools();
    const allowedNames = new Set<string>(REMOTE_READ_TOOLS);
    const descriptors = capabilities.tools.filter((tool: any) => allowedNames.has(tool?.name));
    if (!descriptors.some((tool: any) => tool?.name === 'get_config')) {
      throw new Error('Local Desktop Commander does not expose get_config');
    }
    this.send(ToolListSchema.parse({
      type: 'TOOL_LIST',
      device_id: this.options.deviceId,
      tools: descriptors,
      sent_at: new Date().toISOString(),
    }), socket);
  }

  private scheduleHeartbeat(socket: WebSocket): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.running || socket.readyState !== WebSocket.OPEN) return;
      try {
        this.send(HeartbeatSchema.parse({
          type: 'HEARTBEAT',
          device_id: this.options.deviceId,
          sent_at: new Date().toISOString(),
        }), socket);
      } catch {}
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    try { socket.close(1000, 'client stopping'); } catch {}
    setTimeout(() => {
      if (socket.readyState !== WebSocket.CLOSED) {
        try { socket.terminate(); } catch {}
      }
    }, 500).unref?.();
  }

  private send(message: unknown, socket = this.socket): void {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Native RDC M1 gateway socket is not connected');
    }
    const wire = JSON.stringify(message);
    if (Buffer.byteLength(wire, 'utf8') > MAX_DEVICE_MESSAGE_BYTES) {
      throw new Error('Native RDC M1 device message exceeds size limit');
    }
    socket.send(wire);
  }

  private async handleGatewayMessage(text: string): Promise<void> {
    let call: ToolCall;
    try {
      call = ToolCallSchema.parse(JSON.parse(text));
    } catch {
      this.socket?.close(1008, 'malformed tool call');
      return;
    }
    if (call.device_id !== this.options.deviceId) {
      this.socket?.close(1008, 'wrong device');
      return;
    }
    let safeArguments: Record<string, unknown>;
    try {
      safeArguments = await validateRemoteReadArguments(
        call.tool_name,
        call.arguments,
        this.options.readRoots ?? [],
      );
    } catch (error) {
      const denied = ToolErrorSchema.parse({
        type: 'TOOL_ERROR',
        call_id: call.call_id,
        device_id: this.options.deviceId,
        status: 'failed',
        error: {
          message: error instanceof Error ? error.message.slice(0, 512) : 'Remote read policy denied the call',
          code: 'TOOL_NOT_ALLOWED',
        },
        completed_at: new Date().toISOString(),
      });
      this.rememberTerminal(denied);
      this.send(denied);
      return;
    }
    void this.handleCall({ ...call, arguments: safeArguments });
  }

  private async handleCall(call: ToolCall): Promise<void> {
    const cached = this.terminalCache.get(call.call_id);
    if (cached) {
      try { this.send(cached); } catch {}
      return;
    }
    if (this.inFlight.has(call.call_id)) return;
    this.inFlight.add(call.call_id);

    try {
      this.send(CallAckSchema.parse({
        type: 'CALL_ACK',
        call_id: call.call_id,
        device_id: this.options.deviceId,
        acknowledged_at: new Date().toISOString(),
      }));
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
      try { this.send(terminal); } catch {}
    } finally {
      this.inFlight.delete(call.call_id);
    }
  }

  private async execute(call: ToolCall): Promise<TerminalToolMessage> {
    try {
      const result = await this.executor.callClientTool(
        call.tool_name,
        call.arguments,
        { native_rdc_m1_call_id: call.call_id },
      );
      const terminal = ToolResultSchema.parse({
        type: 'TOOL_RESULT',
        call_id: call.call_id,
        device_id: this.options.deviceId,
        status: 'completed',
        result,
        completed_at: new Date().toISOString(),
      });
      if (Buffer.byteLength(JSON.stringify(terminal), 'utf8') > MAX_DEVICE_MESSAGE_BYTES) {
        return ToolErrorSchema.parse({
          type: 'TOOL_ERROR',
          call_id: call.call_id,
          device_id: this.options.deviceId,
          status: 'failed',
          error: { message: 'Tool result exceeded M1 transport limit', code: 'RESULT_TOO_LARGE' },
          completed_at: new Date().toISOString(),
        });
      }
      return terminal;
    } catch (error) {
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
  }

  private rememberTerminal(message: TerminalToolMessage): void {
    this.terminalCache.set(message.call_id, message);
    while (this.terminalCache.size > 256) {
      const oldest = this.terminalCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.terminalCache.delete(oldest);
    }
  }
}
