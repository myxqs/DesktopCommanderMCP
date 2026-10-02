import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

export const MCP_ORIGIN = 'https://native-rdc-gateway.elliot-mercer-uk.workers.dev';
export const MCP_RESOURCE = MCP_ORIGIN + '/mcp';
export const MCP_SCOPE = 'native-rdc:read';
export const MCP_TOOL_NAME = 'get_config';
export const MAX_MCP_REQUEST_BYTES = 64 * 1024;
export const MAX_MCP_RESULT_BYTES = 32 * 1024;

const inputSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

const outputSchema = {
  type: 'object',
  properties: {
    version: { type: ['string', 'null'] },
    defaultShell: { type: ['string', 'null'] },
    telemetryEnabled: { type: ['boolean', 'null'] },
    fileReadLineLimit: { type: ['number', 'null'] },
    fileWriteLineLimit: { type: ['number', 'null'] },
    blockedCommands: { type: 'array', items: { type: 'string' } },
    directoryRestriction: {
      type: 'object',
      properties: {
        configured: { type: ['boolean', 'null'] },
        count: { type: ['number', 'null'] },
      },
      required: ['configured', 'count'],
      additionalProperties: false,
    },
  },
  required: [
    'version',
    'defaultShell',
    'telemetryEnabled',
    'fileReadLineLimit',
    'fileWriteLineLimit',
    'blockedCommands',
    'directoryRestriction',
  ],
  additionalProperties: false,
};

export const GET_CONFIG_TOOL = {
  name: MCP_TOOL_NAME,
  title: 'Get Desktop Commander configuration',
  description: 'Use this when the user wants to inspect the current read-only Desktop Commander configuration and safety limits on their trusted Windows device.',
  inputSchema,
  outputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  securitySchemes: [
    { type: 'oauth2', scopes: [MCP_SCOPE] },
  ],
};

function safeScalar(value, type) {
  return typeof value === type ? value : null;
}

export function sanitizeGetConfigResult(toolResult) {
  const config = toolResult?.structuredContent?.config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Desktop Commander returned an unsupported get_config result');
  }

  const blockedCommands = Array.isArray(config.blockedCommands)
    ? config.blockedCommands.filter((value) => typeof value === 'string').slice(0, 128)
    : [];
  const directories = Array.isArray(config.allowedDirectories) ? config.allowedDirectories : null;

  return {
    version: safeScalar(config.version, 'string'),
    defaultShell: safeScalar(config.defaultShell, 'string'),
    telemetryEnabled: safeScalar(config.telemetryEnabled, 'boolean'),
    fileReadLineLimit: safeScalar(config.fileReadLineLimit, 'number'),
    fileWriteLineLimit: safeScalar(config.fileWriteLineLimit, 'number'),
    blockedCommands,
    directoryRestriction: {
      configured: directories === null ? null : directories.length > 0,
      count: directories === null ? null : directories.length,
    },
  };
}

function jsonRpcError(status, code, message, id = null) {
  return new Response(JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  }), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

async function boundedRequest(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(length) && length > MAX_MCP_REQUEST_BYTES) return null;
  if (request.method !== 'POST') return request;

  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > MAX_MCP_REQUEST_BYTES) return null;

  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
  });
}

function authChallenge(resourceMetadataUrl) {
  return 'Bearer resource_metadata="' + resourceMetadataUrl
    + '", error="insufficient_scope", error_description="native-rdc:read scope required"';
}

export function createMcpApiHandler({ invokeGetConfig, resourceMetadataUrl }) {
  if (typeof invokeGetConfig !== 'function') throw new TypeError('invokeGetConfig is required');

  return {
    async fetch(request, env, ctx) {
      const scopes = Array.isArray(ctx?.auth?.scope) ? ctx.auth.scope : [];
      if (!scopes.includes(MCP_SCOPE)) {
        return new Response(JSON.stringify({ code: 'INSUFFICIENT_SCOPE' }), {
          status: 403,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'www-authenticate': authChallenge(resourceMetadataUrl),
          },
        });
      }

      const bounded = await boundedRequest(request);
      if (!bounded) return jsonRpcError(413, -32000, 'MCP request body exceeds limit');

      const server = new Server(
        { name: 'native-rdc', version: '2.0.0' },
        {
          capabilities: { tools: {} },
          instructions: 'Read-only access to the trusted Windows Desktop Commander configuration. No write, shell, browser, file, or arbitrary tool execution is available.',
        },
      );

      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [GET_CONFIG_TOOL],
      }));

      server.setRequestHandler(CallToolRequestSchema, async (message) => {
        if (message.params.name !== MCP_TOOL_NAME) {
          throw new McpError(ErrorCode.InvalidParams, 'Unknown or disallowed tool');
        }
        const args = message.params.arguments ?? {};
        if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 0) {
          throw new McpError(ErrorCode.InvalidParams, 'get_config does not accept arguments');
        }
        if (!scopes.includes(MCP_SCOPE)) {
          return {
            isError: true,
            content: [{ type: 'text', text: 'Authorization scope is insufficient.' }],
            _meta: { 'mcp/www_authenticate': [authChallenge(resourceMetadataUrl)] },
          };
        }

        let terminal;
        try {
          terminal = await invokeGetConfig(env);
        } catch {
          return {
            isError: true,
            content: [{ type: 'text', text: 'Native RDC backend is unavailable.' }],
          };
        }

        if (terminal?.type !== 'TOOL_RESULT' || terminal?.status !== 'completed') {
          return {
            isError: true,
            content: [{ type: 'text', text: 'Desktop Commander get_config did not complete successfully.' }],
          };
        }

        let safe;
        try {
          safe = sanitizeGetConfigResult(terminal.result);
        } catch {
          return {
            isError: true,
            content: [{ type: 'text', text: 'Desktop Commander returned an unsupported configuration result.' }],
          };
        }

        const text = JSON.stringify(safe);
        if (new TextEncoder().encode(text).byteLength > MAX_MCP_RESULT_BYTES) {
          return {
            isError: true,
            content: [{ type: 'text', text: 'Sanitized configuration exceeded the M2 result limit.' }],
          };
        }

        return {
          content: [{ type: 'text', text }],
          structuredContent: safe,
        };
      });

      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      return transport.handleRequest(bounded);
    },
  };
}