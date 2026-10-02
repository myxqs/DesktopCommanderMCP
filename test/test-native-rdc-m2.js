import assert from 'node:assert/strict';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  GET_CONFIG_TOOL,
  MAX_MCP_REQUEST_BYTES,
  MCP_SCOPE,
  createMcpApiHandler,
  sanitizeGetConfigResult,
} from '../cloudflare/native-rdc-gateway/src/mcp.js';
import {
  trustedAuthorizationOwner,
} from '../cloudflare/native-rdc-gateway/src/auth.js';

const goodConfig = {
  version: '0.2.52',
  defaultShell: 'powershell.exe',
  telemetryEnabled: true,
  fileReadLineLimit: 1000,
  fileWriteLineLimit: 50,
  blockedCommands: ['shutdown', 'reboot'],
  allowedDirectories: ['C:\\Sensitive\\MustNotLeak'],
  clientId: 'must-not-leak',
  usageStats: { totalToolCalls: 999 },
  systemInfo: { nodeInfo: { path: 'C:\\Sensitive\\node.exe' } },
};

function terminalFor(config = goodConfig) {
  return {
    type: 'TOOL_RESULT',
    status: 'completed',
    result: { structuredContent: { config } },
  };
}

let backendMode = 'ok';
let backendCalls = 0;
const handler = createMcpApiHandler({
  resourceMetadataUrl: 'https://example.test/.well-known/oauth-protected-resource/mcp',
  invokeGetConfig: async () => {
    backendCalls += 1;
    if (backendMode === 'offline') throw new Error('synthetic offline');
    if (backendMode === 'error') return { type: 'TOOL_ERROR', status: 'failed' };
    return terminalFor();
  },
});

async function nodeRequestToWeb(req, origin) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) headers.set(key, value.join(', '));
    else if (value !== undefined) headers.set(key, value);
  }
  const body = [];
  for await (const chunk of req) body.push(chunk);
  const bytes = Buffer.concat(body);
  return new Request(origin + req.url, {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : bytes,
  });
}

async function sendWebResponse(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (!response.body) {
    res.end();
    return;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  res.end(bytes);
}

const server = http.createServer(async (req, res) => {
  try {
    const origin = 'http://' + req.headers.host;
    const webRequest = await nodeRequestToWeb(req, origin);
    const bearer = /^Bearer\s+(.+)$/.exec(req.headers.authorization || '')?.[1];
    const auth = bearer === 'local-oauth-test'
      ? { scope: [MCP_SCOPE], token: 'local-test-token', clientId: 'local-test-client' }
      : { scope: [], token: null, clientId: null };
    const response = await handler.fetch(webRequest, {}, { auth });
    await sendWebResponse(res, response);
  } catch (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
});

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('sanitizer removes host and client details', () => {
  const safe = sanitizeGetConfigResult({ structuredContent: { config: goodConfig } });
  assert.equal(safe.version, '0.2.52');
  assert.equal(safe.defaultShell, 'powershell.exe');
  assert.deepEqual(safe.directoryRestriction, { configured: true, count: 1 });
  const encoded = JSON.stringify(safe);
  assert.equal(encoded.includes('Sensitive'), false);
  assert.equal(encoded.includes('clientId'), false);
  assert.equal(encoded.includes('systemInfo'), false);
  assert.equal(encoded.includes('usageStats'), false);
});

test('tool descriptor is explicitly read-only and OAuth scoped', () => {
  assert.equal(GET_CONFIG_TOOL.name, 'get_config');
  assert.deepEqual(GET_CONFIG_TOOL.inputSchema, {
    type: 'object',
    properties: {},
    additionalProperties: false,
  });
  assert.equal(GET_CONFIG_TOOL.annotations.readOnlyHint, true);
  assert.equal(GET_CONFIG_TOOL.annotations.destructiveHint, false);
  assert.equal(GET_CONFIG_TOOL.annotations.openWorldHint, false);
  assert.deepEqual(GET_CONFIG_TOOL.securitySchemes, [
    { type: 'oauth2', scopes: [MCP_SCOPE] },
  ]);
});

test('authorization requires configured Cloudflare Access owner identity', async () => {
  const access = { async getIdentity() { return { email: 'owner@example.test' }; } };
  assert.deepEqual(
    await trustedAuthorizationOwner({ OWNER_EMAIL: 'owner@example.test' }, { access }),
    { userId: 'cloudflare-access:owner@example.test', email: 'owner@example.test' },
  );
  assert.equal(
    await trustedAuthorizationOwner({ OWNER_EMAIL: 'other@example.test' }, { access }),
    null,
  );
  assert.equal(
    await trustedAuthorizationOwner({ OWNER_EMAIL: 'owner@example.test' }, {}),
    null,
  );
});

let baseUrl;
let client;

test('actual Streamable HTTP initialize and tools/list succeed', async () => {
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl + '/mcp'), {
    requestInit: {
      headers: { Authorization: 'Bearer local-oauth-test' },
    },
  });
  client = new Client({ name: 'native-rdc-m2-test', version: '1.0.0' });
  await client.connect(transport);
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 1);
  assert.equal(listed.tools[0].name, 'get_config');
  assert.equal(listed.tools[0].annotations?.readOnlyHint, true);
  assert.equal(listed.tools[0].annotations?.openWorldHint, false);
});

test('raw Streamable HTTP tools/list emits OpenAI securitySchemes metadata', async () => {
  const response = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer local-oauth-test',
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'Mcp-Protocol-Version': '2025-11-25',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 77,
      method: 'tools/list',
      params: {},
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.result.tools[0].securitySchemes, [
    { type: 'oauth2', scopes: [MCP_SCOPE] },
  ]);
});

test('actual Streamable HTTP tools/call reaches only get_config and returns sanitized data', async () => {
  backendMode = 'ok';
  const before = backendCalls;
  const result = await client.callTool({ name: 'get_config', arguments: {} });
  assert.equal(result.isError, undefined);
  assert.equal(backendCalls, before + 1);
  assert.equal(result.structuredContent.version, '0.2.52');
  const encoded = JSON.stringify(result);
  assert.equal(encoded.includes('Sensitive'), false);
  assert.equal(encoded.includes('clientId'), false);
  assert.equal(encoded.includes('systemInfo'), false);
});

test('separate MCP calls may redispatch and therefore are not exactly-once', async () => {
  backendMode = 'ok';
  const before = backendCalls;
  await client.callTool({ name: 'get_config', arguments: {} });
  await client.callTool({ name: 'get_config', arguments: {} });
  assert.equal(backendCalls, before + 2);
});

test('start_process is not remotely callable', async () => {
  await assert.rejects(
    () => client.callTool({ name: 'start_process', arguments: { command: 'whoami' } }),
    /Unknown or disallowed tool|Invalid/,
  );
});

test('write_file is not remotely callable', async () => {
  await assert.rejects(
    () => client.callTool({ name: 'write_file', arguments: { path: 'x', content: 'x' } }),
    /Unknown or disallowed tool|Invalid/,
  );
});

test('get_config rejects arguments', async () => {
  await assert.rejects(
    () => client.callTool({ name: 'get_config', arguments: { unexpected: true } }),
    /does not accept arguments|Invalid/,
  );
});

test('unauthenticated private MCP request is rejected with auth challenge', async () => {
  const response = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'unauth', version: '1' },
      },
    }),
  });
  assert.equal(response.status, 403);
  assert.match(response.headers.get('www-authenticate') || '', /resource_metadata=/);
});

test('malformed JSON is rejected through actual HTTP transport', async () => {
  const response = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer local-oauth-test',
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: '{not-json',
  });
  assert.equal(response.status, 400);
});

test('oversized request is rejected before MCP dispatch', async () => {
  const response = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer local-oauth-test',
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ junk: 'x'.repeat(MAX_MCP_REQUEST_BYTES + 1024) }),
  });
  assert.equal(response.status, 413);
});

test('device offline becomes a safe MCP tool error', async () => {
  backendMode = 'offline';
  const result = await client.callTool({ name: 'get_config', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /backend is unavailable/i);
  backendMode = 'ok';
});

test('backend tool failure becomes a safe MCP tool error', async () => {
  backendMode = 'error';
  const result = await client.callTool({ name: 'get_config', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /did not complete successfully/i);
  backendMode = 'ok';
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
baseUrl = 'http://127.0.0.1:' + address.port;

let passed = 0;
let failed = 0;
try {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      console.log('PASS ' + name);
    } catch (error) {
      failed += 1;
      console.error('FAIL ' + name);
      console.error(error);
    }
  }
} finally {
  try { await client?.close(); } catch {}
  await new Promise((resolve) => server.close(resolve));
}

console.log('Native RDC M2 MCP tests: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exitCode = 1;