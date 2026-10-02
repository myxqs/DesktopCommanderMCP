import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import {
  DEFAULT_POLICY_REGISTRY,
  GET_CONFIG_POLICY,
  getPolicy,
} from './policy.js';

export const MCP_ORIGIN = 'https://native-rdc-gateway.elliot-mercer-uk.workers.dev';
export const MCP_RESOURCE = MCP_ORIGIN + '/mcp';
export const MCP_SCOPE = 'native-rdc:read';
export const MCP_WRITE_SCOPE = 'native-rdc:write';
export const MCP_TOOL_NAME = 'get_config';
export const REQUEST_CREATE_DIRECTORY_TOOL_NAME = 'request_create_directory';
export const EXECUTE_APPROVED_ACTION_TOOL_NAME = 'execute_approved_action';
export const MAX_MCP_REQUEST_BYTES = 64 * 1024;
export const MAX_MCP_RESULT_BYTES = 32 * 1024;

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

function descriptorForPolicy(policy) {
  const descriptor = {
    ...policy.descriptor,
    securitySchemes: [{ type: 'oauth2', scopes: [MCP_SCOPE] }],
  };
  if (policy.externalName === MCP_TOOL_NAME) descriptor.outputSchema = outputSchema;
  return descriptor;
}

export const GET_CONFIG_TOOL = Object.freeze(descriptorForPolicy(GET_CONFIG_POLICY));

export const REQUEST_CREATE_DIRECTORY_TOOL = Object.freeze({
  name: REQUEST_CREATE_DIRECTORY_TOOL_NAME,
  title: 'Request directory creation',
  description: 'Create a short-lived approval request for one directory inside an approved Native RDC write root. This does not execute the write.',
  inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1, maxLength: 4096 } }, required: ['path'], additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  securitySchemes: [{ type: 'oauth2', scopes: [MCP_WRITE_SCOPE] }],
});

export const EXECUTE_APPROVED_ACTION_TOOL = Object.freeze({
  name: EXECUTE_APPROVED_ACTION_TOOL_NAME,
  title: 'Execute approved Native RDC action',
  description: 'Execute a previously human-approved, single-use Native RDC action. Approval must match exactly and remain unexpired.',
  inputSchema: { type: 'object', properties: { approval_id: { type: 'string', minLength: 36, maxLength: 36 }, fingerprint: { type: 'string', minLength: 64, maxLength: 64 } }, required: ['approval_id', 'fingerprint'], additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  securitySchemes: [{ type: 'oauth2', scopes: [MCP_WRITE_SCOPE] }],
});

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

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactAllowedKeys(value, allowed) {
  return plainObject(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function validateMcpArguments(policy, args) {
  if (!plainObject(args)) throw new McpError(ErrorCode.InvalidParams, 'Tool arguments must be an object');
  if (policy.externalName === 'get_config' || policy.externalName === 'list_processes') {
    if (Object.keys(args).length !== 0) throw new McpError(ErrorCode.InvalidParams, policy.externalName + ' does not accept arguments');
    return {};
  }
  if (policy.externalName === 'get_file_info') {
    if (!exactAllowedKeys(args, ['path']) || Object.keys(args).length !== 1 || typeof args.path !== 'string' || !args.path) {
      throw new McpError(ErrorCode.InvalidParams, 'get_file_info requires only a non-empty path');
    }
    return { path: args.path };
  }
  if (policy.externalName === 'list_directory') {
    if (!exactAllowedKeys(args, ['path', 'depth']) || typeof args.path !== 'string' || !args.path
      || (args.depth !== undefined && (!Number.isInteger(args.depth) || args.depth < 1 || args.depth > 2))) {
      throw new McpError(ErrorCode.InvalidParams, 'list_directory requires path and optional depth 1 or 2');
    }
    return { path: args.path, ...(args.depth === undefined ? {} : { depth: args.depth }) };
  }
  if (policy.externalName === 'read_file') {
    if (!exactAllowedKeys(args, ['path', 'offset', 'length']) || typeof args.path !== 'string' || !args.path
      || (args.offset !== undefined && (!Number.isInteger(args.offset) || args.offset < 0 || args.offset > 100000))
      || (args.length !== undefined && (!Number.isInteger(args.length) || args.length < 1 || args.length > 200))) {
      throw new McpError(ErrorCode.InvalidParams, 'read_file arguments are outside the bounded remote read schema');
    }
    return {
      path: args.path,
      ...(args.offset === undefined ? {} : { offset: args.offset }),
      ...(args.length === undefined ? {} : { length: args.length }),
    };
  }
  throw new McpError(ErrorCode.InvalidParams, 'Tool policy adapter is not implemented');
}

function sanitizeBoundedTextResult(toolResult) {
  const parts = Array.isArray(toolResult?.content)
    ? toolResult.content.filter((part) => part?.type === 'text' && typeof part.text === 'string')
    : [];
  if (parts.length === 0) throw new Error('Desktop Commander returned no supported text result');
  let text = parts.map((part) => part.text).join('\n').replace(/\0/g, '');
  if (text.length > 24000) text = text.slice(0, 24000) + '\n[remote result truncated]';
  return text;
}

export function createMcpApiHandler({ invokeRemoteTool, invokeGetConfig, requestApproval, executeApprovedAction, resourceMetadataUrl }) {
  const invoke = typeof invokeRemoteTool === 'function'
    ? invokeRemoteTool
    : typeof invokeGetConfig === 'function'
      ? async (env, policy) => {
        if (policy.externalName !== 'get_config') throw new Error('Remote read adapter unavailable');
        return invokeGetConfig(env);
      }
      : null;
  if (!invoke) throw new TypeError('invokeRemoteTool is required');

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
          instructions: 'Native RDC exposes bounded read tools plus one separately scoped approval workflow for creating a directory inside an approved write root. Direct writes, shell, browser, deletion, and arbitrary tool execution are unavailable.',
        },
      );

      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          ...Object.values(DEFAULT_POLICY_REGISTRY).map(descriptorForPolicy),
          REQUEST_CREATE_DIRECTORY_TOOL,
          EXECUTE_APPROVED_ACTION_TOOL,
        ],
      }));

      server.setRequestHandler(CallToolRequestSchema, async (message) => {
        const toolName = message.params.name;
        const rawArgs = message.params.arguments ?? {};
        const ownerId = typeof ctx?.auth?.props?.userId === 'string'
          ? ctx.auth.props.userId
          : typeof ctx?.auth?.userId === 'string' ? ctx.auth.userId : null;

        if (toolName === REQUEST_CREATE_DIRECTORY_TOOL_NAME) {
          if (!scopes.includes(MCP_WRITE_SCOPE)) throw new McpError(ErrorCode.InvalidParams, 'native-rdc:write scope required');
          if (!ownerId || typeof requestApproval !== 'function') throw new McpError(ErrorCode.InvalidParams, 'Owner approval service unavailable');
          if (!plainObject(rawArgs) || !exactAllowedKeys(rawArgs, ['path']) || Object.keys(rawArgs).length !== 1
            || typeof rawArgs.path !== 'string' || !rawArgs.path.trim()) {
            throw new McpError(ErrorCode.InvalidParams, 'request_create_directory requires exactly one non-empty path');
          }
          const approval = await requestApproval(env, ownerId, { path: rawArgs.path });
          const text = JSON.stringify(approval);
          return { content: [{ type: 'text', text }], structuredContent: approval };
        }

        if (toolName === EXECUTE_APPROVED_ACTION_TOOL_NAME) {
          if (!scopes.includes(MCP_WRITE_SCOPE)) throw new McpError(ErrorCode.InvalidParams, 'native-rdc:write scope required');
          if (!ownerId || typeof executeApprovedAction !== 'function') throw new McpError(ErrorCode.InvalidParams, 'Approved-action service unavailable');
          if (!plainObject(rawArgs) || !exactAllowedKeys(rawArgs, ['approval_id', 'fingerprint'])
            || Object.keys(rawArgs).length !== 2
            || typeof rawArgs.approval_id !== 'string' || !/^[0-9a-f-]{36}$/.test(rawArgs.approval_id)
            || typeof rawArgs.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(rawArgs.fingerprint)) {
            throw new McpError(ErrorCode.InvalidParams, 'execute_approved_action requires approval_id and fingerprint');
          }
          const result = await executeApprovedAction(env, ownerId, rawArgs.approval_id, rawArgs.fingerprint);
          const text = JSON.stringify(result);
          return { content: [{ type: 'text', text }], structuredContent: result, ...(result.ok ? {} : { isError: true }) };
        }

        const policy = getPolicy(toolName);
        if (!policy) throw new McpError(ErrorCode.InvalidParams, 'Unknown or disallowed tool');
        if (policy.approvalRequired || policy.invokeKey !== 'remoteRead') {
          throw new McpError(ErrorCode.InvalidParams, 'Tool requires a separate approval flow');
        }
        const args = validateMcpArguments(policy, rawArgs);
        if (!scopes.includes(MCP_SCOPE)) {
          return {
            isError: true,
            content: [{ type: 'text', text: 'Authorization scope is insufficient.' }],
            _meta: { 'mcp/www_authenticate': [authChallenge(resourceMetadataUrl)] },
          };
        }

        let terminal;
        try {
          terminal = await invoke(env, policy, args);
        } catch {
          return {
            isError: true,
            content: [{ type: 'text', text: 'Native RDC backend is unavailable.' }],
          };
        }

        if (terminal?.type !== 'TOOL_RESULT' || terminal?.status !== 'completed') {
          return {
            isError: true,
            content: [{ type: 'text', text: 'Desktop Commander remote read did not complete successfully.' }],
          };
        }

        if (policy.sanitizerKey === 'getConfig') {
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
              content: [{ type: 'text', text: 'Sanitized configuration exceeded the result limit.' }],
            };
          }
          return {
            content: [{ type: 'text', text }],
            structuredContent: safe,
          };
        }

        if (policy.sanitizerKey !== 'boundedText') {
          return {
            isError: true,
            content: [{ type: 'text', text: 'Remote result sanitizer is unavailable.' }],
          };
        }

        let text;
        try {
          text = sanitizeBoundedTextResult(terminal.result);
        } catch {
          return {
            isError: true,
            content: [{ type: 'text', text: 'Desktop Commander returned an unsupported remote read result.' }],
          };
        }
        if (new TextEncoder().encode(text).byteLength > MAX_MCP_RESULT_BYTES) {
          return {
            isError: true,
            content: [{ type: 'text', text: 'Sanitized remote result exceeded the result limit.' }],
          };
        }
        return { content: [{ type: 'text', text }] };
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