import {
  ALLOWED_TOOL,
  MAX_CALL_TIMEOUT_MS,
  MAX_DEVICE_MESSAGE_BYTES,
  authorized,
  jsonResponse,
  readJsonBounded,
  utf8Size,
  validateDeviceMessage,
  validateToolCall,
} from './core.js';

const INSTANCE_NAME = 'primary';
const CALL_PREFIX = 'call:';

function secretsConfigured(env) {
  return typeof env.DEVICE_TOKEN === 'string'
    && env.DEVICE_TOKEN.length >= 24
    && typeof env.CLIENT_TOKEN === 'string'
    && env.CLIENT_TOKEN.length >= 24
    && env.DEVICE_TOKEN !== env.CLIENT_TOKEN
    && typeof env.DEVICE_ID === 'string'
    && env.DEVICE_ID.length > 0;
}

function connectionOwner(env) {
  const id = env.CONNECTION_OWNER.idFromName(INSTANCE_NAME);
  return env.CONNECTION_OWNER.get(id);
}

function withGatewayHeader(response) {
  const wrapped = new Response(response.body, response);
  wrapped.headers.set('x-native-rdc-gateway', 'cloudflare-durable-object');
  return wrapped;
}

export async function workerFetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/health' && request.method === 'GET') {
    return jsonResponse({ ok: true, service: 'native-rdc-gateway' });
  }
  if (!secretsConfigured(env)) {
    return jsonResponse({ code: 'GATEWAY_NOT_CONFIGURED' }, 503);
  }

  if (url.pathname === '/v1/device/connect') {
    if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return jsonResponse({ code: 'WEBSOCKET_REQUIRED' }, 426);
    }
    if (!await authorized(request, env.DEVICE_TOKEN)) {
      return jsonResponse({ code: 'UNAUTHORISED_DEVICE' }, 401);
    }
    if (url.searchParams.get('device_id') !== env.DEVICE_ID) {
      return jsonResponse({ code: 'WRONG_DEVICE' }, 403);
    }
    const internal = new Request('https://internal/device-connect', {
      method: 'GET',
      headers: {
        Upgrade: 'websocket',
        'x-device-id': env.DEVICE_ID,
      },
    });
    return connectionOwner(env).fetch(internal);
  }

  if (url.pathname === '/v1/client/status' && request.method === 'GET') {
    if (!await authorized(request, env.CLIENT_TOKEN)) {
      return jsonResponse({ code: 'UNAUTHORISED_CLIENT' }, 401);
    }
    return withGatewayHeader(await connectionOwner(env).fetch('https://internal/status'));
  }

  if (url.pathname === '/v1/client/call' && request.method === 'POST') {
    if (!await authorized(request, env.CLIENT_TOKEN)) {
      return jsonResponse({ code: 'UNAUTHORISED_CLIENT' }, 401);
    }
    const parsed = await readJsonBounded(request);
    if (!parsed.ok) return parsed.response;
    const validation = validateToolCall(parsed.value, env.DEVICE_ID);
    if (!validation.ok) {
      return jsonResponse({ code: validation.code }, validation.status);
    }
    const internal = new Request('https://internal/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validation.value),
    });
    return withGatewayHeader(await connectionOwner(env).fetch(internal));
  }

  return jsonResponse({ code: 'NOT_FOUND' }, 404);
}

export default { fetch: workerFetch };

export class NativeRdcConnectionOwner {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.waiters = new Map();
    if (typeof this.ctx.setWebSocketAutoResponse === 'function'
      && typeof WebSocketRequestResponsePair !== 'undefined') {
      this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/device-connect') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket'
        || request.headers.get('x-device-id') !== this.env.DEVICE_ID) {
        return jsonResponse({ code: 'INVALID_INTERNAL_DEVICE_REQUEST' }, 400);
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      await this.replaceDeviceConnection(server, crypto.randomUUID());
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/status') {
      const state = await this.ctx.storage.get('device');
      const socket = state ? this.currentDeviceSocket(state.connectionId) : null;
      return jsonResponse({
        device_id: this.env.DEVICE_ID,
        connected: Boolean(socket),
        ready: Boolean(socket && state?.ready),
        last_seen: state?.lastSeen ?? null,
      });
    }

    if (url.pathname === '/call' && request.method === 'POST') {
      return this.handleCall(await request.json());
    }

    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  }

  currentDeviceSocket(connectionId) {
    if (!connectionId) return null;
    for (const socket of this.ctx.getWebSockets('device')) {
      const attachment = socket.deserializeAttachment?.();
      if (socket.readyState === 1 && attachment?.connectionId === connectionId) return socket;
    }
    return null;
  }

  async replaceDeviceConnection(server, connectionId) {
    for (const existing of this.ctx.getWebSockets('device')) {
      try { existing.close(4001, 'replaced by newer authenticated connection'); } catch {}
    }
    server.serializeAttachment?.({
      role: 'device',
      deviceId: this.env.DEVICE_ID,
      connectionId,
    });
    this.ctx.acceptWebSocket(server, ['device']);
    await this.ctx.storage.put('device', {
      connectionId,
      connected: true,
      ready: false,
      hello: false,
      lastSeen: Date.now(),
    });
  }

  async handleCall(call) {
    const key = CALL_PREFIX + call.call_id;
    const existing = await this.ctx.storage.get(key);
    if (existing?.state === 'terminal') {
      return jsonResponse(existing.terminal, 200, { 'x-native-rdc-call-source': 'durable-cache' });
    }
    if (existing?.state === 'pending') {
      if (Date.parse(existing.call.deadline_at) <= Date.now()) {
        return jsonResponse({
          code: 'CALL_TIMEOUT',
          message: 'Caller deadline elapsed; local execution may have continued.',
        }, 504, { 'x-native-rdc-call-source': 'pending-timeout' });
      }
      return jsonResponse({ code: 'CALL_IN_PROGRESS' }, 409);
    }

    const deviceState = await this.ctx.storage.get('device');
    const socket = deviceState?.ready ? this.currentDeviceSocket(deviceState.connectionId) : null;
    if (!socket) return jsonResponse({ code: 'DEVICE_OFFLINE' }, 503);

    const wire = JSON.stringify(call);
    if (utf8Size(wire) > MAX_DEVICE_MESSAGE_BYTES) {
      return jsonResponse({ code: 'CALL_TOO_LARGE' }, 413);
    }
    await this.ctx.storage.put(key, {
      state: 'pending',
      call,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      acknowledged: false,
    });
    socket.send(wire);

    const timeoutMs = Math.max(
      1,
      Math.min(MAX_CALL_TIMEOUT_MS, Date.parse(call.deadline_at) - Date.now()),
    );
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiters.get(call.call_id)?.timer !== timer) return;
        this.waiters.delete(call.call_id);
        resolve(jsonResponse({
          code: 'CALL_TIMEOUT',
          message: 'Caller deadline elapsed; local execution may still complete.',
        }, 504, { 'x-native-rdc-call-source': 'device-timeout' }));
      }, timeoutMs);
      this.waiters.set(call.call_id, { resolve, timer });
    });
  }

  async webSocketMessage(ws, rawMessage) {
    if (typeof rawMessage !== 'string') {
      ws.close(1003, 'text messages required');
      return;
    }
    if (utf8Size(rawMessage) > MAX_DEVICE_MESSAGE_BYTES) {
      ws.close(1009, 'message too large');
      return;
    }
    const attachment = ws.deserializeAttachment?.();
    const deviceState = await this.ctx.storage.get('device');
    if (!attachment || attachment.connectionId !== deviceState?.connectionId) {
      ws.close(4001, 'stale connection');
      return;
    }

    let raw;
    try { raw = JSON.parse(rawMessage); } catch {
      ws.close(1007, 'invalid json');
      return;
    }
    const checked = validateDeviceMessage(raw, this.env.DEVICE_ID);
    if (!checked.ok) {
      ws.close(1008, checked.code);
      return;
    }
    const message = checked.value;

    if (message.type === 'DEVICE_HELLO') {
      await this.ctx.storage.put('device', {
        ...deviceState,
        hello: true,
        lastSeen: Date.now(),
      });
      return;
    }

    if (message.type === 'TOOL_LIST') {
      const names = message.tools.map((tool) => tool?.name).filter(Boolean);
      if (names.length !== 1 || names[0] !== ALLOWED_TOOL) {
        ws.close(1008, 'invalid capability set');
        await this.markDisconnectedIfCurrent(attachment.connectionId);
        return;
      }
      await this.ctx.storage.put('device', {
        ...deviceState,
        ready: true,
        lastSeen: Date.now(),
      });
      return;
    }

    if (message.type === 'HEARTBEAT') {
      await this.ctx.storage.put('device', { ...deviceState, lastSeen: Date.now() });
      return;
    }

    if (message.type === 'CALL_ACK') {
      const key = CALL_PREFIX + message.call_id;
      const record = await this.ctx.storage.get(key);
      if (record?.state === 'pending') {
        await this.ctx.storage.put(key, { ...record, acknowledged: true, updatedAt: Date.now() });
      }
      return;
    }

    if (message.type === 'TOOL_RESULT' || message.type === 'TOOL_ERROR') {
      const key = CALL_PREFIX + message.call_id;
      const record = await this.ctx.storage.get(key);
      if (!record) {
        ws.close(1008, 'result for unknown call');
        return;
      }
      if (record.state !== 'terminal') {
        await this.ctx.storage.put(key, {
          state: 'terminal',
          terminal: message,
          updatedAt: Date.now(),
        });
      }
      const waiter = this.waiters.get(message.call_id);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.waiters.delete(message.call_id);
        waiter.resolve(jsonResponse(message, 200, { 'x-native-rdc-call-source': 'device' }));
      }
      return;
    }

    if (message.type === 'DEVICE_OFFLINE') {
      await this.markDisconnectedIfCurrent(attachment.connectionId);
      try { ws.close(1000, 'device offline'); } catch {}
    }
  }

  async markDisconnectedIfCurrent(connectionId) {
    const state = await this.ctx.storage.get('device');
    if (state?.connectionId !== connectionId) return;
    await this.ctx.storage.put('device', {
      ...state,
      connected: false,
      ready: false,
      lastSeen: Date.now(),
    });
  }

  async webSocketClose(ws) {
    const attachment = ws.deserializeAttachment?.();
    if (attachment?.connectionId) {
      await this.markDisconnectedIfCurrent(attachment.connectionId);
    }
  }

  async webSocketError(ws) {
    const attachment = ws.deserializeAttachment?.();
    if (attachment?.connectionId) {
      await this.markDisconnectedIfCurrent(attachment.connectionId);
    }
    try { ws.close(1011, 'websocket error'); } catch {}
  }
}
