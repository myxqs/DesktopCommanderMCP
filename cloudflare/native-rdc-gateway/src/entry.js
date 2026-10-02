import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { NativeRdcConnectionOwner, workerFetch } from './index.js';
import {
  MCP_ORIGIN,
  MCP_RESOURCE,
  MCP_SCOPE,
  MCP_WRITE_SCOPE,
  createMcpApiHandler,
} from './mcp.js';
import { createDefaultHandler } from './auth.js';

const INSTANCE_NAME = 'primary';
const RESOURCE_METADATA_URL = MCP_ORIGIN + '/.well-known/oauth-protected-resource/mcp';

function connectionOwner(env) {
  const id = env.CONNECTION_OWNER.idFromName(INSTANCE_NAME);
  return env.CONNECTION_OWNER.get(id);
}

async function invokeRemoteTool(env, policy, args) {
  if (!policy || policy.invokeKey !== 'remoteRead') {
    throw new Error('Unsupported Native RDC policy');
  }
  const created = Date.now();
  const call = {
    type: 'TOOL_CALL',
    call_id: 'm3-' + crypto.randomUUID(),
    device_id: env.DEVICE_ID,
    tool_name: policy.internalTool,
    arguments: args,
    created_at: new Date(created).toISOString(),
    deadline_at: new Date(created + policy.timeoutMs).toISOString(),
  };
  const response = await connectionOwner(env).fetch(new Request('https://internal/call', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(call),
  }));
  if (!response.ok) throw new Error('Native RDC backend call failed');
  return response.json();
}

async function requestApproval(env, ownerId, args) {
  const response = await connectionOwner(env).fetch(new Request('https://internal/approval/request', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ownerId, action: 'create_directory', arguments: args }),
  }));
  if (!response.ok) throw new Error('Native RDC approval request failed');
  const approval = await response.json();
  return {
    approval_id: approval.id,
    fingerprint: approval.fingerprint,
    state: approval.state,
    expires_at: approval.expires_at,
    action: approval.action,
    arguments: approval.arguments,
    approval_url: MCP_ORIGIN + '/approvals/' + approval.id,
  };
}

async function finalizeApproval(env, id, state) {
  await connectionOwner(env).fetch(new Request('https://internal/approval/finalize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, state }),
  }));
}

async function executeApprovedAction(env, ownerId, approvalId, fingerprint) {
  const consumedResponse = await connectionOwner(env).fetch(new Request('https://internal/approval/consume', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ownerId, id: approvalId, fingerprint }),
  }));
  const consumed = await consumedResponse.json();
  if (!consumedResponse.ok) {
    return { ok: false, code: consumed.code || 'APPROVAL_REJECTED', state: consumed.state || null };
  }
  const created = Date.now();
  const call = {
    type: 'TOOL_CALL',
    call_id: consumed.operation_id,
    device_id: env.DEVICE_ID,
    tool_name: 'create_directory',
    arguments: consumed.arguments,
    created_at: new Date(created).toISOString(),
    deadline_at: new Date(created + 15000).toISOString(),
  };
  try {
    const response = await connectionOwner(env).fetch(new Request('https://internal/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(call),
    }));
    const body = await response.json();
    if (response.status === 504) {
      await finalizeApproval(env, approvalId, 'UNKNOWN');
      return { ok: false, state: 'UNKNOWN', operation_id: consumed.operation_id, code: 'AMBIGUOUS_TIMEOUT' };
    }
    if (!response.ok) {
      await finalizeApproval(env, approvalId, 'FAILED');
      return { ok: false, state: 'FAILED', operation_id: consumed.operation_id, code: body.code || 'REMOTE_ACTION_FAILED' };
    }
    const completed = body?.type === 'TOOL_RESULT' && body?.status === 'completed';
    await finalizeApproval(env, approvalId, completed ? 'COMPLETED' : 'FAILED');
    return {
      ok: completed,
      state: completed ? 'COMPLETED' : 'FAILED',
      operation_id: consumed.operation_id,
      action: consumed.action,
      arguments: consumed.arguments,
    };
  } catch {
    await finalizeApproval(env, approvalId, 'UNKNOWN');
    return { ok: false, state: 'UNKNOWN', operation_id: consumed.operation_id, code: 'DISPATCH_STATUS_UNKNOWN' };
  }
}

const mcpHandler = createMcpApiHandler({
  invokeRemoteTool,
  requestApproval,
  executeApprovedAction,
  resourceMetadataUrl: RESOURCE_METADATA_URL,
});

const defaultHandler = createDefaultHandler(workerFetch);

const app = new OAuthProvider({
  apiRoute: '/mcp',
  apiHandler: mcpHandler,
  defaultHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/oauth/token',
  clientRegistrationEndpoint: '/oauth/register',
  scopesSupported: [MCP_SCOPE, MCP_WRITE_SCOPE, 'offline_access'],
  resourceMetadata: {
    resource: MCP_RESOURCE,
    authorization_servers: [MCP_ORIGIN],
  },
  requiredScopes: [MCP_SCOPE],
  clientIdMetadataDocumentEnabled: true,
});

export default app;
export { NativeRdcConnectionOwner };
