import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { NativeRdcConnectionOwner, workerFetch } from './index.js';
import {
  MCP_ORIGIN,
  MCP_RESOURCE,
  MCP_SCOPE,
  createMcpApiHandler,
} from './mcp.js';
import { createDefaultHandler } from './auth.js';

const INSTANCE_NAME = 'primary';
const RESOURCE_METADATA_URL = MCP_ORIGIN + '/.well-known/oauth-protected-resource/mcp';

function connectionOwner(env) {
  const id = env.CONNECTION_OWNER.idFromName(INSTANCE_NAME);
  return env.CONNECTION_OWNER.get(id);
}

async function invokeGetConfig(env) {
  const created = Date.now();
  const call = {
    type: 'TOOL_CALL',
    call_id: 'm2-' + crypto.randomUUID(),
    device_id: env.DEVICE_ID,
    tool_name: 'get_config',
    arguments: {},
    created_at: new Date(created).toISOString(),
    deadline_at: new Date(created + 15000).toISOString(),
  };
  const response = await connectionOwner(env).fetch(new Request('https://internal/call', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(call),
  }));
  if (!response.ok) throw new Error('Native RDC backend call failed');
  return response.json();
}

const mcpHandler = createMcpApiHandler({
  invokeGetConfig,
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
  scopesSupported: [MCP_SCOPE, 'offline_access'],
  resourceMetadata: {
    resource: MCP_RESOURCE,
    authorization_servers: [MCP_ORIGIN],
  },
  requiredScopes: [MCP_SCOPE],
  clientIdMetadataDocumentEnabled: true,
});

export default app;
export { NativeRdcConnectionOwner };