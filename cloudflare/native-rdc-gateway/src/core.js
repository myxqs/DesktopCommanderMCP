export const MAX_REQUEST_BYTES = 64 * 1024;
export const MAX_DEVICE_MESSAGE_BYTES = 1024 * 1024;
export const MAX_CALL_TIMEOUT_MS = 30_000;
export const MAX_CLOCK_SKEW_MS = 5_000;
export const ALLOWED_TOOL = 'get_config';
export const ALLOWED_TOOLS = Object.freeze([
  'get_config',
  'list_processes',
  'list_directory',
  'get_file_info',
  'read_file',
]);
const ALLOWED_TOOL_SET = new Set(ALLOWED_TOOLS);

export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

function digestText(value) {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
}

export async function secureTokenEqual(provided, expected) {
  if (!provided || !expected) return false;
  const [left, right] = await Promise.all([digestText(provided), digestText(expected)]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a[i % a.length] ?? 0) ^ (b[i % b.length] ?? 0);
  }
  return diff === 0;
}

export function extractBearer(header) {
  if (typeof header !== 'string') return null;
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(header);
  return match?.[1] ?? null;
}

export async function authorized(request, expected) {
  const token = extractBearer(request.headers.get('authorization'));
  return token !== null && await secureTokenEqual(token, expected);
}

export async function readJsonBounded(request, maxBytes = MAX_REQUEST_BYTES) {
  const length = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(length) && length > maxBytes) {
    return { ok: false, response: jsonResponse({ code: 'BODY_TOO_LARGE' }, 413) };
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    return { ok: false, response: jsonResponse({ code: 'BODY_TOO_LARGE' }, 413) };
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, response: jsonResponse({ code: 'MALFORMED_JSON' }, 400) };
  }
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  if (!plainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
}

function validId(value, max = 128) {
  return typeof value === 'string' && value.length >= 1 && value.length <= max;
}

function validateRemoteArguments(toolName, args) {
  if (!plainObject(args)) return false;
  if (toolName === 'get_config' || toolName === 'list_processes') {
    return exactKeys(args, []);
  }
  if (toolName === 'get_file_info') {
    return exactKeys(args, ['path']) && typeof args.path === 'string' && args.path.length > 0;
  }
  if (toolName === 'list_directory') {
    return (exactKeys(args, ['path']) || exactKeys(args, ['path', 'depth']))
      && typeof args.path === 'string' && args.path.length > 0
      && (args.depth === undefined || (Number.isInteger(args.depth) && args.depth >= 1 && args.depth <= 2));
  }
  if (toolName === 'read_file') {
    const allowedKeys = ['path', 'offset', 'length'];
    if (!exactKeys(args, Object.keys(args)) || !Object.keys(args).every((key) => allowedKeys.includes(key))) return false;
    if (typeof args.path !== 'string' || args.path.length === 0) return false;
    if (args.offset !== undefined && (!Number.isInteger(args.offset) || args.offset < 0 || args.offset > 100000)) return false;
    if (args.length !== undefined && (!Number.isInteger(args.length) || args.length < 1 || args.length > 200)) return false;
    return true;
  }
  return false;
}

export function validateToolCall(raw, expectedDeviceId, now = Date.now()) {
  const keys = ['type', 'call_id', 'device_id', 'tool_name', 'arguments', 'created_at', 'deadline_at'];
  if (!exactKeys(raw, keys) || raw.type !== 'TOOL_CALL') {
    return { ok: false, status: 400, code: 'MALFORMED_CALL' };
  }
  if (!validId(raw.call_id) || !validId(raw.device_id) || !validId(raw.tool_name, 256)) {
    return { ok: false, status: 400, code: 'MALFORMED_CALL' };
  }
  if (raw.device_id !== expectedDeviceId) {
    return { ok: false, status: 403, code: 'WRONG_DEVICE' };
  }
  if (!ALLOWED_TOOL_SET.has(raw.tool_name)) {
    return { ok: false, status: 403, code: 'TOOL_NOT_ALLOWED' };
  }
  if (!validateRemoteArguments(raw.tool_name, raw.arguments)) {
    return { ok: false, status: 400, code: 'INVALID_ARGUMENTS' };
  }
  const createdAt = Date.parse(raw.created_at);
  const deadlineAt = Date.parse(raw.deadline_at);
  if (!Number.isFinite(createdAt) || !Number.isFinite(deadlineAt) || createdAt > deadlineAt) {
    return { ok: false, status: 400, code: 'INVALID_DEADLINE' };
  }
  if (deadlineAt <= now || deadlineAt - now > MAX_CALL_TIMEOUT_MS + MAX_CLOCK_SKEW_MS) {
    return { ok: false, status: 400, code: 'INVALID_DEADLINE' };
  }
  return { ok: true, value: raw };
}

export function validateDeviceMessage(raw, expectedDeviceId) {
  if (!plainObject(raw) || typeof raw.type !== 'string' || raw.device_id !== expectedDeviceId) {
    return { ok: false, code: 'MALFORMED_DEVICE_MESSAGE' };
  }
  switch (raw.type) {
    case 'DEVICE_HELLO':
      return raw.protocol_version === 1 && validId(raw.device_name, 256)
        ? { ok: true, value: raw }
        : { ok: false, code: 'MALFORMED_DEVICE_MESSAGE' };
    case 'TOOL_LIST':
      return Array.isArray(raw.tools) && raw.tools.length <= 1000
        ? { ok: true, value: raw }
        : { ok: false, code: 'MALFORMED_DEVICE_MESSAGE' };
    case 'HEARTBEAT':
      return typeof raw.sent_at === 'string'
        ? { ok: true, value: raw }
        : { ok: false, code: 'MALFORMED_DEVICE_MESSAGE' };
    case 'CALL_ACK':
      return validId(raw.call_id) && typeof raw.acknowledged_at === 'string'
        ? { ok: true, value: raw }
        : { ok: false, code: 'MALFORMED_DEVICE_MESSAGE' };
    case 'TOOL_RESULT':
      return validId(raw.call_id) && raw.status === 'completed'
        ? { ok: true, value: raw }
        : { ok: false, code: 'MALFORMED_DEVICE_MESSAGE' };
    case 'TOOL_ERROR':
      return validId(raw.call_id) && raw.status === 'failed' && plainObject(raw.error)
        && typeof raw.error.message === 'string' && raw.error.message.length <= 4096
        ? { ok: true, value: raw }
        : { ok: false, code: 'MALFORMED_DEVICE_MESSAGE' };
    case 'DEVICE_OFFLINE':
      return { ok: true, value: raw };
    default:
      return { ok: false, code: 'UNKNOWN_DEVICE_MESSAGE' };
  }
}

export function utf8Size(value) {
  return new TextEncoder().encode(value).byteLength;
}
