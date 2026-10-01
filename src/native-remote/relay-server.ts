import { randomUUID } from 'crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { ZodError } from 'zod';
import { isAuthorized, isLoopbackHost, type NativeRdcConfig } from './auth.js';
import { NativeCallStore } from './call-store.js';
import {
  CallAckSchema,
  DeviceHelloSchema,
  DeviceOfflineSchema,
  DeviceReadySchema,
  HeartbeatSchema,
  ToolCallSchema,
  ToolListSchema,
  terminalMessageSchema,
  type DeviceReady,
  type TerminalToolMessage,
  type ToolCall,
  type ToolDescriptor,
} from './protocol.js';

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
interface DeviceState {
  id: string;
  name: string;
  lastSeen: number;
  tools: ToolDescriptor[];
  ready: boolean;
}

export interface RelayAddress {
  host: string;
  port: number;
}

export class NativeRelayServer {
  private server: Server | null = null;
  private readonly relayId = randomUUID();
  private readonly eventStreams = new Set<ServerResponse>();
  private readonly store: NativeCallStore;
  private device: DeviceState | null = null;

  constructor(readonly config: NativeRdcConfig) {
    if (!isLoopbackHost(config.host)) {
      throw new Error('Native RDC v0 only supports loopback relay hosts');
    }
    this.store = new NativeCallStore(config.maxCalls, config.retentionMs);
  }

  async start(): Promise<RelayAddress> {
    if (this.server) throw new Error('Relay already started');
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((error) => this.handleError(res, error));
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server!.once('error', onError);
      this.server!.listen(this.config.port, this.config.host, () => {
        this.server!.off('error', onError);
        resolve();
      });
    });

    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Relay did not expose a TCP address');
    return { host: this.config.host, port: address.port };
  }

  async stop(): Promise<void> {
    for (const stream of this.eventStreams) {
      try { stream.end(); } catch { /* already closed */ }
    }
    this.eventStreams.clear();
    this.device = null;
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  snapshot() {
    return {
      relay_id: this.relayId,
      device_online: this.isDeviceOnline(),
      device_id: this.device?.id ?? null,
      tool_count: this.device?.tools.length ?? 0,
      calls: this.store.size(),
    };
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method || 'GET';
    const url = new URL(req.url || '/', 'http://localhost');

    if (method === 'GET' && url.pathname === '/health') {
      this.writeJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname.startsWith('/v0/device/')) {
      this.requireAuth(req, 'device');
    } else if (url.pathname.startsWith('/v0/client/')) {
      this.requireAuth(req, 'client');
    } else {
      throw new HttpError(404, 'NOT_FOUND', 'Endpoint not found');
    }

    if (method === 'POST' && url.pathname === '/v0/device/hello') {
      const hello = DeviceHelloSchema.parse(await this.readJson(req));
      if (this.device && this.device.id !== hello.device_id && this.isDeviceOnline()) {
        throw new HttpError(409, 'DEVICE_ALREADY_CONNECTED', 'Another device is already active');
      }
      this.device = {
        id: hello.device_id,
        name: hello.device_name,
        lastSeen: Date.now(),
        tools: this.device?.id === hello.device_id ? this.device.tools : [],
        ready: false,
      };
      const ready: DeviceReady = DeviceReadySchema.parse({
        type: 'DEVICE_READY',
        protocol_version: 1,
        device_id: hello.device_id,
        accepted: true,
        relay_id: this.relayId,
        sent_at: new Date().toISOString(),
      });
      this.writeJson(res, 200, ready);
      return;
    }
    if (method === 'POST' && url.pathname === '/v0/device/tools') {
      const list = ToolListSchema.parse(await this.readJson(req));
      this.requireCurrentDevice(list.device_id);
      this.device!.tools = list.tools;
      this.device!.lastSeen = Date.now();
      this.device!.ready = true;
      this.writeJson(res, 200, { ok: true });
      return;
    }

    if (method === 'POST' && url.pathname === '/v0/device/heartbeat') {
      const heartbeat = HeartbeatSchema.parse(await this.readJson(req));
      this.requireCurrentDevice(heartbeat.device_id);
      this.device!.lastSeen = Date.now();
      this.writeJson(res, 200, { ok: true });
      return;
    }

    if (method === 'GET' && url.pathname === '/v0/device/events') {
      const deviceId = url.searchParams.get('device_id') || '';
      this.requireCurrentDevice(deviceId);
      this.openEventStream(req, res);
      return;
    }

    if (method === 'POST' && url.pathname === '/v0/device/ack') {
      const ack = CallAckSchema.parse(await this.readJson(req));
      this.requireCurrentDevice(ack.device_id);
      const record = this.store.get(ack.call_id);
      if (!record || record.call.device_id !== ack.device_id) {
        throw new HttpError(404, 'UNKNOWN_CALL_ID', 'Call not found');
      }
      this.store.markRunning(ack.call_id);
      this.writeJson(res, 200, { ok: true });
      return;
    }
    if (method === 'POST' && url.pathname === '/v0/device/result') {
      const terminal = terminalMessageSchema.parse(await this.readJson(req));
      this.requireCurrentDevice(terminal.device_id);
      const record = this.store.get(terminal.call_id);
      if (!record || record.call.device_id !== terminal.device_id) {
        throw new HttpError(404, 'UNKNOWN_CALL_ID', 'Call not found');
      }
      this.store.complete(terminal.call_id, terminal);
      this.writeJson(res, 200, { ok: true });
      return;
    }

    if (method === 'POST' && url.pathname === '/v0/device/offline') {
      const offline = DeviceOfflineSchema.parse(await this.readJson(req));
      this.requireCurrentDevice(offline.device_id);
      this.device!.ready = false;
      this.device!.lastSeen = 0;
      this.writeJson(res, 200, { ok: true });
      return;
    }

    if (method === 'GET' && url.pathname === '/v0/client/tools') {
      if (!this.device || !this.isDeviceOnline()) {
        throw new HttpError(503, 'DEVICE_OFFLINE', 'Device is offline');
      }
      this.writeJson(res, 200, { device_id: this.device.id, tools: this.device.tools });
      return;
    }

    if (method === 'POST' && url.pathname === '/v0/client/call') {
      await this.handleClientCall(req, res);
      return;
    }

    throw new HttpError(404, 'NOT_FOUND', 'Endpoint not found');
  }
  private async handleClientCall(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const call = ToolCallSchema.parse(await this.readJson(req));
    const now = Date.now();
    const deadline = Date.parse(call.deadline_at);
    if (!Number.isFinite(deadline) || deadline <= now) {
      throw new HttpError(408, 'CALL_EXPIRED', 'Call deadline has already passed');
    }
    if (!this.device || call.device_id !== this.device.id || !this.isDeviceOnline()) {
      throw new HttpError(503, 'DEVICE_OFFLINE', 'Target device is not reachable');
    }
    if (!this.device.tools.some((tool) => tool.name === call.tool_name)) {
      throw new HttpError(404, 'UNKNOWN_TOOL', 'Tool is not advertised by the device');
    }
    if (this.eventStreams.size === 0) {
      throw new HttpError(503, 'DEVICE_OFFLINE', 'Device event stream is not connected');
    }

    try {
      this.store.create(call);
    } catch (error: any) {
      if (error?.message === 'DUPLICATE_CALL_ID') {
        throw new HttpError(409, 'DUPLICATE_CALL_ID', 'Call ID already exists');
      }
      if (error?.message === 'CALL_STORE_FULL') {
        throw new HttpError(503, 'CALL_STORE_FULL', 'Call store is full');
      }
      throw error;
    }

    this.emitToDevice(call);
    const timeoutMs = Math.max(1, Math.min(this.config.callTimeoutMs, deadline - now));
    const timer = setTimeout(() => {
      this.store.expire(call.call_id, this.timeoutMessage(call));
    }, timeoutMs);
    const record = await this.store.waitForTerminal(call.call_id);
    clearTimeout(timer);
    if (!record.terminal) {
      throw new HttpError(500, 'CALL_STATE_INVALID', 'Terminal call state had no result');
    }
    const statusCode = record.state === 'expired' ? 504 : 200;
    this.writeJson(res, statusCode, record.terminal);
  }

  private timeoutMessage(call: ToolCall): TerminalToolMessage {
    return {
      type: 'TOOL_ERROR',
      call_id: call.call_id,
      device_id: call.device_id,
      status: 'failed',
      error: { message: 'Tool call deadline exceeded', code: 'CALL_TIMEOUT' },
      completed_at: new Date().toISOString(),
    };
  }

  private openEventStream(req: IncomingMessage, res: ServerResponse): void {
    for (const prior of this.eventStreams) {
      try { prior.end(); } catch { /* ignore */ }
    }
    this.eventStreams.clear();

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
    });
    res.write(': native-rdc connected\n\n');
    this.eventStreams.add(res);
    if (this.device) {
      this.device.lastSeen = Date.now();
      this.device.ready = true;
      for (const pending of this.store.listPending(this.device.id)) this.emitToDevice(pending);
    }
    const cleanup = () => {
      this.eventStreams.delete(res);
      if (this.device && this.eventStreams.size === 0) this.device.ready = false;
    };
    req.once('close', cleanup);
    res.once('close', cleanup);
  }

  private emitToDevice(call: ToolCall): void {
    const payload = `event: message\ndata: ${JSON.stringify(call)}\n\n`;
    for (const stream of [...this.eventStreams]) {
      try {
        stream.write(payload);
      } catch {
        this.eventStreams.delete(stream);
      }
    }
  }

  private isDeviceOnline(): boolean {
    return Boolean(
      this.device
      && this.device.ready
      && this.eventStreams.size > 0
      && Date.now() - this.device.lastSeen <= this.config.heartbeatTtlMs,
    );
  }

  private requireCurrentDevice(deviceId: string): void {
    if (!this.device || this.device.id !== deviceId) {
      throw new HttpError(409, 'DEVICE_ID_MISMATCH', 'Device is not registered');
    }
  }

  private requireAuth(req: IncomingMessage, role: 'device' | 'client'): void {
    const expected = role === 'device' ? this.config.deviceToken : this.config.clientToken;
    if (!isAuthorized(req.headers.authorization, expected)) {
      throw new HttpError(401, 'UNAUTHORIZED', 'Bearer authentication required');
    }
  }
  private async readJson(req: IncomingMessage): Promise<unknown> {
    const lengthHeader = req.headers['content-length'];
    if (typeof lengthHeader === 'string' && Number(lengthHeader) > this.config.maxBodyBytes) {
      req.resume();
      throw new HttpError(413, 'REQUEST_TOO_LARGE', 'Request body exceeds the configured limit');
    }

    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > this.config.maxBodyBytes) {
        throw new HttpError(413, 'REQUEST_TOO_LARGE', 'Request body exceeds the configured limit');
      }
      chunks.push(buffer);
    }

    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) throw new HttpError(400, 'EMPTY_BODY', 'JSON body is required');
    try {
      return JSON.parse(raw);
    } catch {
      throw new HttpError(400, 'INVALID_JSON', 'Request body must be valid JSON');
    }
  }

  private writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
    if (res.headersSent) return;
    const payload = JSON.stringify(body);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(payload);
  }
  private handleError(res: ServerResponse, error: unknown): void {
    if (res.headersSent) {
      try { res.end(); } catch { /* ignore */ }
      return;
    }

    if (error instanceof HttpError) {
      this.writeJson(res, error.statusCode, { error: error.code, message: error.message });
      return;
    }

    if (error instanceof ZodError) {
      this.writeJson(res, 400, {
        error: 'INVALID_MESSAGE',
        message: 'Message failed protocol validation',
        issues: error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code })),
      });
      return;
    }

    console.error('[native-rdc] relay request failed:', error instanceof Error ? error.message : String(error));
    this.writeJson(res, 500, { error: 'INTERNAL_ERROR', message: 'Internal relay error' });
  }
}
