import { randomUUID } from 'crypto';
import {
  ToolCallSchema,
  terminalMessageSchema,
  type TerminalToolMessage,
} from './protocol.js';

export class NativeM1HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: any,
  ) {
    super(body?.message || body?.code || `Native RDC M1 gateway returned HTTP ${status}`);
  }
}

export interface CloudflareRemoteClientOptions {
  gatewayUrl: string;
  clientToken: string;
  deviceId: string;
  timeoutMs?: number;
}

export interface CloudflareCallEvidence {
  cfRay: string | null;
  gateway: string | null;
  callSource: string | null;
}

export interface CloudflareCallResult {
  terminal: TerminalToolMessage;
  evidence: CloudflareCallEvidence;
}

export class CloudflareRemoteClient {
  constructor(private readonly options: CloudflareRemoteClientOptions) {}

  async status(): Promise<{ body: any; evidence: CloudflareCallEvidence }> {
    return this.request('/v1/client/status', { method: 'GET' });
  }

  async getConfig(
    callId: string = randomUUID(),
    timeoutMs = this.options.timeoutMs ?? 30_000,
  ): Promise<CloudflareCallResult> {
    const now = Date.now();
    const call = ToolCallSchema.parse({
      type: 'TOOL_CALL',
      call_id: callId,
      device_id: this.options.deviceId,
      tool_name: 'get_config',
      arguments: {},
      created_at: new Date(now).toISOString(),
      deadline_at: new Date(now + timeoutMs).toISOString(),
    });
    const response = await this.request('/v1/client/call', {
      method: 'POST',
      body: JSON.stringify(call),
    });
    return {
      terminal: terminalMessageSchema.parse(response.body),
      evidence: response.evidence,
    };
  }

  private async request(path: string, init: RequestInit): Promise<{ body: any; evidence: CloudflareCallEvidence }> {
    const response = await fetch(new URL(path, this.options.gatewayUrl), {
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
    const evidence = {
      cfRay: response.headers.get('cf-ray'),
      gateway: response.headers.get('x-native-rdc-gateway'),
      callSource: response.headers.get('x-native-rdc-call-source'),
    };
    if (!response.ok) throw new NativeM1HttpError(response.status, body);
    return { body, evidence };
  }
}
