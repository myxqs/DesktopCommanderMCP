import {
  ALLOWED_TOOL,
  ALLOWED_TOOLS,
  DEVICE_ALLOWED_TOOLS,
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
const APPROVAL_PREFIX = 'approval:';
const APPROVAL_TTL_MS = 5 * 60 * 1000;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (plainObject(value)) {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

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
    if (url.pathname === '/approval/request' && request.method === 'POST') {
      return this.requestApproval(await request.json());
    }
    if (url.pathname === '/approval/get' && request.method === 'GET') {
      return this.getApproval(url.searchParams.get('id'));
    }
    if (url.pathname === '/approval/decide' && request.method === 'POST') {
      return this.decideApproval(await request.json());
    }
    if (url.pathname === '/approval/consume' && request.method === 'POST') {
      return this.consumeApproval(await request.json());
    }
    if (url.pathname === '/approval/finalize' && request.method === 'POST') {
      return this.finalizeApproval(await request.json());
    }

    return jsonResponse({ code: 'NOT_FOUND' }, 404);
  }

  async requestApproval(raw) {
    if (!plainObject(raw)
      || typeof raw.ownerId !== 'string' || !raw.ownerId.startsWith('cloudflare-access:')
      || raw.action !== 'create_directory'
      || !plainObject(raw.arguments)
      || Object.keys(raw.arguments).length !== 1
      || typeof raw.arguments.path !== 'string' || !raw.arguments.path.trim()) {
      return jsonResponse({ code: 'INVALID_APPROVAL_REQUEST' }, 400);
    }
    if (!(await this.ensureStorageCapacity(APPROVAL_PREFIX, 256))) {
      return jsonResponse({ code: 'APPROVAL_CAPACITY_EXHAUSTED' }, 503);
    }
    const id = crypto.randomUUID();
    const nonce = crypto.randomUUID();
    const createdAt = Date.now();
    const expiresAt = createdAt + APPROVAL_TTL_MS;
    const fingerprint = await sha256Hex(stableJson({
      ownerId: raw.ownerId,
      action: raw.action,
      arguments: raw.arguments,
      nonce,
    }));
    const record = {
      id,
      ownerId: raw.ownerId,
      action: raw.action,
      arguments: { path: raw.arguments.path },
      fingerprint,
      state: 'REQUESTED',
      createdAt,
      expiresAt,
      updatedAt: createdAt,
    };
    await this.ctx.storage.put(APPROVAL_PREFIX + id, record);
    return jsonResponse({
      id,
      fingerprint,
      state: record.state,
      expires_at: new Date(expiresAt).toISOString(),
      action: record.action,
      arguments: record.arguments,
    }, 201);
  }

  async getApproval(id) {
    if (typeof id !== 'string' || !id) return jsonResponse({ code: 'INVALID_APPROVAL_ID' }, 400);
    const record = await this.ctx.storage.get(APPROVAL_PREFIX + id);
    if (!record) return jsonResponse({ code: 'APPROVAL_NOT_FOUND' }, 404);
    const state = record.expiresAt <= Date.now() && ['REQUESTED', 'APPROVED'].includes(record.state)
      ? 'EXPIRED' : record.state;
    if (state !== record.state) {
      record.state = state;
      record.updatedAt = Date.now();
      await this.ctx.storage.put(APPROVAL_PREFIX + id, record);
    }
    return jsonResponse({
      id: record.id,
      ownerId: record.ownerId,
      action: record.action,
      arguments: record.arguments,
      fingerprint: record.fingerprint,
      state,
      created_at: new Date(record.createdAt).toISOString(),
      expires_at: new Date(record.expiresAt).toISOString(),
    });
  }

  async decideApproval(raw) {
    if (!plainObject(raw)
      || typeof raw.ownerId !== 'string'
      || typeof raw.id !== 'string'
      || typeof raw.fingerprint !== 'string'
      || !['approve', 'deny'].includes(raw.decision)) {
      return jsonResponse({ code: 'INVALID_APPROVAL_DECISION' }, 400);
    }
    const key = APPROVAL_PREFIX + raw.id;
    const record = await this.ctx.storage.get(key);
    if (!record) return jsonResponse({ code: 'APPROVAL_NOT_FOUND' }, 404);
    if (record.ownerId !== raw.ownerId || record.fingerprint !== raw.fingerprint) {
      return jsonResponse({ code: 'APPROVAL_MISMATCH' }, 403);
    }
    if (record.expiresAt <= Date.now()) {
      record.state = 'EXPIRED';
      record.updatedAt = Date.now();
      await this.ctx.storage.put(key, record);
      return jsonResponse({ code: 'APPROVAL_EXPIRED' }, 410);
    }
    if (record.state !== 'REQUESTED') {
      return jsonResponse({ code: 'APPROVAL_NOT_PENDING', state: record.state }, 409);
    }
    record.state = raw.decision === 'approve' ? 'APPROVED' : 'DENIED';
    record.updatedAt = Date.now();
    await this.ctx.storage.put(key, record);
    return jsonResponse({ id: record.id, fingerprint: record.fingerprint, state: record.state });
  }

  async consumeApproval(raw) {
    if (!plainObject(raw)
      || typeof raw.ownerId !== 'string'
      || typeof raw.id !== 'string'
      || typeof raw.fingerprint !== 'string') {
      return jsonResponse({ code: 'INVALID_APPROVAL_CONSUME' }, 400);
    }
    const key = APPROVAL_PREFIX + raw.id;
    const record = await this.ctx.storage.get(key);
    if (!record) return jsonResponse({ code: 'APPROVAL_NOT_FOUND' }, 404);
    if (record.ownerId !== raw.ownerId || record.fingerprint !== raw.fingerprint) {
      return jsonResponse({ code: 'APPROVAL_MISMATCH' }, 403);
    }
    if (record.expiresAt <= Date.now()) {
      if (record.state === 'REQUESTED' || record.state === 'APPROVED') {
        record.state = 'EXPIRED';
        record.updatedAt = Date.now();
        await this.ctx.storage.put(key, record);
      }
      return jsonResponse({ code: 'APPROVAL_EXPIRED', state: record.state }, 410);
    }
    if (record.state !== 'APPROVED') {
      return jsonResponse({ code: 'APPROVAL_NOT_EXECUTABLE', state: record.state }, 409);
    }
    record.state = 'DISPATCHED';
    record.operationId = 'approval-' + record.id;
    record.dispatchedAt = Date.now();
    record.updatedAt = record.dispatchedAt;
    await this.ctx.storage.put(key, record);
    return jsonResponse({
      id: record.id,
      fingerprint: record.fingerprint,
      state: record.state,
      operation_id: record.operationId,
      action: record.action,
      arguments: record.arguments,
    });
  }

  async finalizeApproval(raw) {
    if (!plainObject(raw)
      || typeof raw.id !== 'string'
      || !['COMPLETED', 'FAILED', 'UNKNOWN'].includes(raw.state)) {
      return jsonResponse({ code: 'INVALID_APPROVAL_FINALIZE' }, 400);
    }
    const key = APPROVAL_PREFIX + raw.id;
    const record = await this.ctx.storage.get(key);
    if (!record) return jsonResponse({ code: 'APPROVAL_NOT_FOUND' }, 404);
    if (!['DISPATCHED', 'UNKNOWN'].includes(record.state)) {
      return jsonResponse({ code: 'APPROVAL_NOT_DISPATCHED', state: record.state }, 409);
    }
    record.state = raw.state;
    record.updatedAt = Date.now();
    record.completedAt = raw.state === 'COMPLETED' || raw.state === 'FAILED' ? Date.now() : null;
    await this.ctx.storage.put(key, record);
    await this.prunePrefix(APPROVAL_PREFIX, 256);
    return jsonResponse({ id: record.id, state: record.state, operation_id: record.operationId });
  }

  async prunePrefix(prefix, maxRecords) {
    if (typeof this.ctx.storage.list !== 'function' || typeof this.ctx.storage.delete !== 'function') return;
    const records = await this.ctx.storage.list({ prefix });
    if (!records || records.size <= maxRecords) return;
    const now = Date.now();
    const removable = [...records.entries()].filter(([, record]) => {
      if (prefix === APPROVAL_PREFIX) {
        const state = record?.state;
        const expired = Number(record?.expiresAt ?? Number.POSITIVE_INFINITY) <= now
          && ['REQUESTED', 'APPROVED'].includes(state);
        return expired || ['DENIED', 'EXPIRED', 'COMPLETED', 'FAILED'].includes(state);
      }
      if (prefix === CALL_PREFIX) return record?.state === 'terminal';
      return false;
    }).sort((left, right) => {
      const a = Number(left[1]?.updatedAt ?? left[1]?.createdAt ?? 0);
      const b = Number(right[1]?.updatedAt ?? right[1]?.createdAt ?? 0);
      return a - b;
    });
    const remove = removable.slice(0, Math.max(0, records.size - maxRecords));
    for (const [key] of remove) await this.ctx.storage.delete(key);
  }

  async ensureStorageCapacity(prefix, maxRecords) {
    if (typeof this.ctx.storage.list !== 'function' || typeof this.ctx.storage.delete !== 'function') return true;
    await this.prunePrefix(prefix, Math.max(0, maxRecords - 1));
    const records = await this.ctx.storage.list({ prefix });
    return !records || records.size < maxRecords;
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
    if (!(await this.ensureStorageCapacity(CALL_PREFIX, 512))) {
      return jsonResponse({ code: 'CALL_CAPACITY_EXHAUSTED' }, 503);
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
      const allowed = new Set(DEVICE_ALLOWED_TOOLS);
      const unique = new Set(names);
      if (!names.includes(ALLOWED_TOOL)
        || names.length !== unique.size
        || names.some((name) => !allowed.has(name))) {
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
        await this.prunePrefix(CALL_PREFIX, 512);
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
