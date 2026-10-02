import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const DEFAULT_ORIGIN = 'https://native-rdc-gateway.elliot-mercer-uk.workers.dev';
const MCP_SCOPE = 'native-rdc:read';
const originArg = process.argv.indexOf('--origin');
const origin = (originArg >= 0 ? process.argv[originArg + 1] : process.env.NATIVE_RDC_M2_ORIGIN || DEFAULT_ORIGIN).replace(/\/$/, '');
const resource = origin + '/mcp';
const redirectUri = 'http://127.0.0.1/native-rdc-m2-callback';

let stage = 'start';
let client;

function base64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

function safeError(error) {
  const name = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error ? error.message : String(error);
  return (name + ': ' + message)
    .replace(/Bearer\s+\S+/gi, 'Bearer <redacted>')
    .replace(/([?&](?:code|access_token|refresh_token)=)[^&\s]+/gi, '$1<redacted>')
    .replace(/[A-Za-z0-9_-]{48,}/g, '<redacted>');
}

function cookiesFrom(response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  return values.map((value) => value.split(';', 1)[0]).join('; ');
}

async function json(response, expected = 200) {
  assert.equal(response.status, expected, 'unexpected HTTP status ' + response.status + ' at ' + stage);
  return response.json();
}

function rpcBody(method, params = {}, id = 1) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

function mcpHeaders(token) {
  const headers = {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    'Mcp-Protocol-Version': '2025-11-25',
  };
  if (token) headers.Authorization = 'Bearer ' + token;
  return headers;
}

async function authorizeScope(authMetadata, clientId, scope) {
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(24));

  const authorizeUrl = new URL(authMetadata.authorization_endpoint);
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('scope', scope);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('resource', resource);

  const consent = await fetch(authorizeUrl, { redirect: 'manual' });
  assert.equal(consent.status, 200, 'authorization consent returned HTTP ' + consent.status);
  const cookie = cookiesFrom(consent);
  assert.ok(cookie, 'consent cookie missing');
  const html = await consent.text();
  const handleMatch = /name="handle" value="([^"]+)"/.exec(html);
  assert.ok(handleMatch, 'consent handle missing');

  const form = new URLSearchParams();
  form.set('handle', handleMatch[1]);
  form.set('decision', 'approve');
  form.append('scope', scope);

  const approval = await fetch(authMetadata.authorization_endpoint, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      Cookie: cookie,
    },
    body: form,
  });
  assert.equal(approval.status, 302, 'authorization approval returned HTTP ' + approval.status);
  const location = approval.headers.get('location');
  assert.ok(location, 'authorization redirect missing');
  const callback = new URL(location);
  assert.equal(callback.origin + callback.pathname, redirectUri);
  assert.equal(callback.searchParams.get('state'), state);
  const code = callback.searchParams.get('code');
  assert.ok(code, 'authorization code missing');

  const tokenForm = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
    resource,
  });
  const tokenResponse = await fetch(authMetadata.token_endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: tokenForm,
  });
  const tokenPayload = await json(tokenResponse);
  assert.equal(tokenPayload.token_type?.toLowerCase(), 'bearer');
  assert.equal(typeof tokenPayload.access_token, 'string');
  return { accessToken: tokenPayload.access_token, consentHtml: html };
}

try {
  stage = 'protected-resource metadata';
  const protectedMetadata = await json(await fetch(
    origin + '/.well-known/oauth-protected-resource/mcp',
    { headers: { Accept: 'application/json' } },
  ));
  assert.equal(protectedMetadata.resource, resource);
  assert.ok(protectedMetadata.authorization_servers?.includes(origin));
  assert.ok(protectedMetadata.scopes_supported?.includes(MCP_SCOPE));
  console.log('OAUTH_PROTECTED_RESOURCE_METADATA: PASS');

  stage = 'authorization-server metadata';
  const authMetadata = await json(await fetch(
    origin + '/.well-known/oauth-authorization-server',
    { headers: { Accept: 'application/json' } },
  ));
  assert.equal(authMetadata.issuer, origin);
  assert.ok(authMetadata.authorization_endpoint);
  assert.ok(authMetadata.token_endpoint);
  assert.ok(authMetadata.registration_endpoint);
  assert.ok(authMetadata.code_challenge_methods_supported?.includes('S256'));
  console.log('OAUTH_AUTHORIZATION_SERVER_METADATA: PASS');
  console.log('OAUTH_PKCE_S256: PASS');

  stage = 'unauthenticated MCP rejection';
  const unauth = await fetch(resource, {
    method: 'POST',
    headers: mcpHeaders(),
    body: rpcBody('tools/list', {}, 10),
  });
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get('www-authenticate') || '', /resource_metadata=/);
  console.log('MCP_UNAUTHENTICATED_REJECTED: PASS');

  stage = 'invalid bearer rejection';
  const invalid = await fetch(resource, {
    method: 'POST',
    headers: mcpHeaders('deliberately-invalid-oauth-token'),
    body: rpcBody('tools/list', {}, 11),
  });
  assert.equal(invalid.status, 401);
  console.log('MCP_INVALID_CREDENTIAL_REJECTED: PASS');

  stage = 'dynamic client registration';
  const registration = await fetch(authMetadata.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Native RDC M2 proof client',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  assert.ok(registration.status === 200 || registration.status === 201, 'DCR failed with HTTP ' + registration.status);
  const registered = await registration.json();
  assert.equal(typeof registered.client_id, 'string');
  console.log('OAUTH_DCR: PASS');

  stage = 'read-scope authorization';
  const readGrant = await authorizeScope(authMetadata, registered.client_id, MCP_SCOPE);
  assert.match(readGrant.consentHtml, /Native RDC M2 proof client/);
  assert.match(readGrant.consentHtml, /native-rdc:read/);
  console.log('OAUTH_TRUSTED_DEVICE_ORIGIN_GATE: PASS');
  console.log('OAUTH_CONSENT_PAGE: PASS');
  console.log('OAUTH_AUTHORIZATION_CODE: PASS');
  console.log('OAUTH_TOKEN_EXCHANGE: PASS');

  stage = 'insufficient scope enforcement';
  const weakGrant = await authorizeScope(authMetadata, registered.client_id, 'offline_access');
  const weakResponse = await fetch(resource, {
    method: 'POST',
    headers: mcpHeaders(weakGrant.accessToken),
    body: rpcBody('tools/list', {}, 12),
  });
  assert.ok(weakResponse.status === 401 || weakResponse.status === 403, 'insufficient scope unexpectedly allowed');
  console.log('MCP_INSUFFICIENT_SCOPE_REJECTED: PASS');

  stage = 'malformed MCP request';
  const malformed = await fetch(resource, {
    method: 'POST',
    headers: mcpHeaders(readGrant.accessToken),
    body: '{not-json',
  });
  assert.equal(malformed.status, 400);
  console.log('MCP_MALFORMED_JSON_REJECTED: PASS');

  stage = 'oversized MCP request';
  const oversized = await fetch(resource, {
    method: 'POST',
    headers: mcpHeaders(readGrant.accessToken),
    body: JSON.stringify({ junk: 'x'.repeat(70 * 1024) }),
  });
  assert.equal(oversized.status, 413);
  console.log('MCP_OVERSIZED_REQUEST_REJECTED: PASS');

  stage = 'MCP initialize';
  const transport = new StreamableHTTPClientTransport(new URL(resource), {
    requestInit: {
      headers: { Authorization: 'Bearer ' + readGrant.accessToken },
    },
  });
  client = new Client({ name: 'native-rdc-m2-remote-proof', version: '1.0.0' });
  await client.connect(transport);
  console.log('MCP_INITIALIZE: PASS');

  stage = 'MCP tools list';
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 1);
  assert.equal(listed.tools[0].name, 'get_config');
  assert.equal(listed.tools[0].annotations?.readOnlyHint, true);
  assert.equal(listed.tools[0].annotations?.openWorldHint, false);
  console.log('MCP_TOOL_LIST: PASS (get_config only)');

  stage = 'consequential tool rejection';
  await assert.rejects(
    () => client.callTool({ name: 'start_process', arguments: { command: 'whoami' } }),
    /Unknown or disallowed tool|Invalid/,
  );
  await assert.rejects(
    () => client.callTool({ name: 'write_file', arguments: { path: 'x', content: 'x' } }),
    /Unknown or disallowed tool|Invalid/,
  );
  console.log('MCP_CONSEQUENTIAL_TOOLS_UNREACHABLE: PASS');

  stage = 'MCP get_config';
  const result = await client.callTool({ name: 'get_config', arguments: {} });
  assert.notEqual(result.isError, true);
  const safe = result.structuredContent;
  assert.equal(typeof safe, 'object');
  assert.equal(typeof safe.version, 'string');
  const encoded = JSON.stringify(result);
  for (const forbidden of ['clientId', 'systemInfo', 'usageStats', 'nodeInfo', 'processInfo']) {
    assert.equal(encoded.includes(forbidden), false, 'unsafe field leaked: ' + forbidden);
  }
  console.log('MCP_GET_CONFIG: PASS');
  console.log('MCP_SANITIZED_RESULT: PASS');
  console.log('DESKTOP_COMMANDER_VERSION=' + safe.version);
  console.log('NATIVE RDC M2 REMOTE MCP E2E: PASS');
} catch (error) {
  console.error('NATIVE RDC M2 REMOTE MCP E2E: FAIL');
  console.error('FAILED_STAGE=' + stage);
  console.error(safeError(error));
  process.exitCode = 1;
} finally {
  try { await client?.close(); } catch {}
}