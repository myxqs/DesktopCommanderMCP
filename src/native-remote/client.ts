import { randomUUID } from 'crypto';
import { ToolCallSchema, terminalMessageSchema, type TerminalToolMessage } from './protocol.js';

export class NativeRelayHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: any,
  ) {
    super(body?.message || `Native RDC relay returned HTTP ${status}`);
  }
}

export interface NativeRelayClientOptions {
  baseUrl: string;
  clientToken: string;
  deviceId: string;
  timeoutMs?: number;
}

export class NativeRelayClient {
  constructor(private readonly options: NativeRelayClientOptions) {}

  async listTools(): Promise<any> {
    return this.request('/v0/client/tools', { method: 'GET' });
  }

  async call(
    toolName: string,
    args: Record<string, unknown> = {},
    callId = randomUUID(),
    timeoutMs = this.options.timeoutMs ?? 30_000,
  ): Promise<TerminalToolMessage> {
    const now = Date.now();
    const call = ToolCallSchema.parse({
      type: 'TOOL_CALL',
      call_id: callId,
      device_id: this.options.deviceId,
      tool_name: toolName,
      arguments: args,
      created_at: new Date(now).toISOString(),
      deadline_at: new Date(now + timeoutMs).toISOString(),
    });

    const body = await this.request('/v0/client/call', {
      method: 'POST',
      body: JSON.stringify(call),
    });
    return terminalMessageSchema.parse(body);
  }

  private async request(path: string, init: RequestInit): Promise<any> {
    const response = await fetch(`${this.options.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.options.clientToken}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    const text = await response.text();
    let body: any = null;
    if (text) {
      try { body = JSON.parse(text); } catch { body = { message: text }; }
    }
    if (!response.ok) throw new NativeRelayHttpError(response.status, body);
    return body;
  }
}
