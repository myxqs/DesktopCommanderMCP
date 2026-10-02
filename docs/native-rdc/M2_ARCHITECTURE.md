# Native RDC M2 — ChatGPT MCP interface

## Scope

M2 adds a standards-compliant, authenticated, read-only MCP surface to the validated M1 private remote transport. It exposes exactly one capability: `get_config`.

M2 does not expose arbitrary Desktop Commander tools, shell execution, file operations, browser control, writes, purchases, credentials, or system configuration changes.

## Layering

```text
MCP client / future ChatGPT
  -> HTTPS Streamable HTTP + OAuth access token
Cloudflare Worker /mcp
  -> MCP protocol + authorization policy
existing M1 Durable Object connection owner
  <-> authenticated outbound WebSocket
Windows Native RDC device
  -> DesktopCommanderIntegration
local Desktop Commander MCP
  -> get_config
```

The M1 device transport is not replaced. The Windows PC still initiates the only device connection outbound over TCP/443 and opens no inbound listener.

## Current OpenAI requirements verified on 2026-10-02

Official references:

- https://developers.openai.com/plugins/build/mcp-server
- https://developers.openai.com/plugins/build/auth
- https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt
- https://help.openai.com/en/articles/12515353-build-with-the-apps-sdk

The implementation follows the current requirements relevant to this proof:

- remote MCP is exposed over stable HTTPS;
- transport is Streamable HTTP at `/mcp`;
- private data requires authentication and per-request authorization;
- OAuth protected-resource metadata is published;
- each private tool advertises its own top-level `securitySchemes`;
- `get_config` advertises `readOnlyHint: true`, `destructiveHint: false`, and `openWorldHint: false`;
- search/fetch tools are not required for a normal custom MCP server;
- PKCE S256 and standards-based client registration/discovery are supported by the authorization layer.

## Current ChatGPT product gate

The authenticated ChatGPT account used for this project is currently on Plus.

OpenAI's current Developer Mode documentation lists:
- Business and Enterprise/Edu for full custom MCP;
- Pro for developer-mode MCP connections with read/fetch permissions.

Plus is not listed as supporting custom MCP Developer Mode.

Therefore M2 can be protocol-complete and independently proven, but a real ChatGPT → M2 invocation is classified as:

`CHATGPT_DIRECT_CONNECTION_BLOCKED_BY_CURRENT_PRODUCT_ACCESS`

This is not an engineering test failure and must not be represented as a ChatGPT E2E pass.

## MCP implementation

The Worker uses the official Model Context Protocol TypeScript SDK.

The endpoint is:

`https://native-rdc-gateway.elliot-mercer-uk.workers.dev/mcp`

The Web Standards Streamable HTTP transport is used because it is compatible with Cloudflare Workers.

The MCP server is stateless at the HTTP session layer. Durable call/device state remains owned by the existing M1 Durable Object.

The SDK low-level `Server` API is used for tool-list handling because the current high-level helper does not preserve OpenAI's newer top-level `securitySchemes` extension in the parsed tool model. The official SDK still performs MCP initialization, transport handling, JSON-RPC parsing, and call validation.

## Tool policy

Exactly one MCP tool is advertised:

`get_config`

Input schema:
- empty object;
- additional properties forbidden.

Authorization:
- OAuth scope `native-rdc:read`.

Annotations:
- `readOnlyHint: true`
- `destructiveHint: false`
- `openWorldHint: false`

Security scheme:
- OAuth 2.0
- scope `native-rdc:read`

Requests for any other tool name fail closed before any Native RDC dispatch.

## Result minimisation

Desktop Commander's native `get_config` result contains more host information than M2 needs, including runtime paths, process information, client identifiers, feature state, and usage history.

M2 does not return that raw payload.

The M2 result is reduced to:
- Desktop Commander version;
- default shell name;
- telemetry enabled flag;
- file read line limit;
- file write line limit;
- blocked command policy;
- whether allowed-directory restrictions are configured;
- number of configured allowed directories.

Actual directory paths, client IDs, runtime paths, process IDs, usage statistics, environment data, credentials, and gateway trust material are omitted.

## OAuth architecture

M2 uses `@cloudflare/workers-oauth-provider` v1.2.1.

Reference:
- https://github.com/cloudflare/workers-oauth-provider
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization

The library supplies the standards machinery:
- RFC 9728 protected-resource metadata;
- RFC 8414 authorization-server metadata;
- authorization code flow;
- PKCE S256;
- token issuance and validation;
- resource/audience binding;
- scopes;
- CIMD support;
- DCR compatibility;
- issuer identification;
- consent handles and browser binding.

OAuth state is stored in the dedicated Cloudflare KV namespace:

`native-rdc-oauth`

The M1 `DEVICE_TOKEN` and `CLIENT_TOKEN` remain internal M1 trust credentials and are not used as MCP end-user OAuth credentials.

## M2 proof identity gate

M2 deliberately does not claim to contain a production identity provider.

For the single-user proof, OAuth consent is allowed only when the authorization browser/request comes from the same public network origin as the successfully authenticated Windows M1 device.

The Worker records only a SHA-256 digest of the source address after a successful authenticated M1 WebSocket upgrade. The raw address is not persisted by M2.

The consent request must:
1. originate from the matching network;
2. pass Cloudflare OAuth request/client validation;
3. complete the normal consent flow;
4. request the `native-rdc:read` scope.

This prevents arbitrary Internet clients from self-authorizing the private MCP during M2 while avoiding reuse of M1 role credentials.

This gate is proof-only. Shared-NAT users could share the same origin and it is not a substitute for a real user identity provider. M3 must replace it with an established upstream sign-in provider before broad or consequential access is considered.

## Discovery and registration

Protected-resource metadata:

`/.well-known/oauth-protected-resource/mcp`

Authorization-server metadata:

`/.well-known/oauth-authorization-server`

Authorization endpoint:

`/authorize`

Token endpoint:

`/oauth/token`

DCR compatibility endpoint:

`/oauth/register`

CIMD is enabled by the Cloudflare OAuth provider with the required `global_fetch_strictly_public` compatibility flag.

## Call semantics

An MCP `tools/call` for `get_config` creates a fresh M1 call ID and routes through the existing M1 Durable Object.

M1 stores call state durably before dispatch.

A repeated M1 call ID is protected by the M1 durable cache, but M2 does not claim that an arbitrary repeated MCP request is exactly-once: a fresh MCP call creates a fresh M1 call ID and can redispatch.

M2 therefore exposes only a read-only operation.

## Timeout semantics

M2 uses a 15-second backend deadline within M1's existing 30-second maximum.

A caller timeout does not prove local cancellation.

If the caller stops waiting after the Windows device has begun execution, the local read-only operation may finish and M1 may persist the late terminal result.

M2 does not claim cancellation or exactly-once execution.

## Bounds

MCP request body: 64 KiB maximum.

Sanitised MCP tool result: 32 KiB maximum.

M1 device transport/result boundary remains 1 MiB.

## Local validation

Run:

`npm run native-rdc:m2:test`

The M2 focused suite uses the official MCP SDK client against a real local Streamable HTTP listener and validates:
- initialize;
- tools/list;
- exactly one tool;
- annotations;
- OpenAI `securitySchemes` on the raw wire;
- get_config call;
- output sanitisation;
- unknown/consequential tool rejection;
- argument rejection;
- unauthenticated rejection;
- malformed JSON;
- request-size bound;
- offline/error handling;
- trusted-device authorization-origin matching.

## Remote proof

Run from the trusted Windows PC after deployment:

`npm run native-rdc:m2:remote-proof`

The proof client:
1. retrieves protected-resource metadata;
2. retrieves authorization-server metadata;
3. verifies PKCE S256;
4. registers a temporary public proof client through DCR;
5. opens the consent flow from the trusted device network;
6. completes an authorization-code + PKCE exchange;
7. connects with the official MCP SDK over the deployed `/mcp`;
8. verifies only `get_config` is advertised;
9. invokes `get_config`;
10. verifies the returned result is sanitised.

No access token or authorization code is intentionally printed.

## Coexistence

The official Desktop Commander Remote service is independent.

M2 must not modify:
- `src/remote-device/`;
- the official device credential file;
- `MCP_SERVER_URL`;
- router configuration;
- Windows Firewall.

The official service and Native RDC may remain online simultaneously.

## Cloudflare components

Worker:
`native-rdc-gateway`

Bindings:
- `CONNECTION_OWNER` — existing M1 Durable Object;
- `OAUTH_KV` — M2 OAuth state;
- `DEVICE_ID` — existing non-secret trusted device ID.

Existing M1 Worker secrets remain unchanged:
- `DEVICE_TOKEN`
- `CLIENT_TOKEN`

M2 does not require either of those secrets to be revealed to an MCP client.

## Teardown

To remove M2 while preserving source history:
- stop using `/mcp`;
- remove the OAuth KV binding and M2 entrypoint in a future rollback deployment;
- optionally delete the dedicated `native-rdc-oauth` KV namespace after the Worker no longer references it.

No Windows firewall, router, or inbound-listener rollback is required.

## Milestone boundaries

- v0 — local Native RDC relay/device proof.
- M1 — private Cloudflare remote transport.
- M2 — authenticated read-only MCP interface.
- M3 — operational hardening and any future permissioned actions.

M3 must not widen the tool surface until identity, approval, startup/recovery, credential lifecycle, monitoring, and consequential-action semantics are explicitly designed and proven.


## Verified M2 proof — 2026-10-02

Cloudflare Worker deployment:

`d1f22d73-3540-4500-acfb-1a1584cfe55d`

Verified deployed path:

`MCP client → Cloudflare /mcp → M1 connection owner → Windows device → DesktopCommanderIntegration → get_config → MCP result`

Remote proof result:

`NATIVE RDC M2 REMOTE MCP E2E: PASS`

Live OAuth/security proof:
- protected-resource metadata: PASS;
- authorization-server metadata: PASS;
- PKCE S256: PASS;
- DCR proof client: PASS;
- trusted-device-network authorization gate: PASS;
- authorization-code exchange: PASS;
- unauthenticated MCP rejection: PASS;
- invalid bearer rejection: PASS;
- insufficient-scope rejection: PASS;
- malformed JSON rejection: PASS;
- oversized request rejection: PASS;
- consequential tool rejection: PASS;
- sanitised real get_config result: PASS.

The Worker redeployment disconnected/re-established the M1 outbound connection without opening an inbound Windows listener.

Final local regression gate:
- build: PASS;
- Native RDC v0: 11 passed / 0 failed;
- M1: 15 passed / 0 failed;
- full repository: 70 passed / 0 failed;
- local Native RDC smoke: PASS;
- M2 focused suite: 15 passed / 0 failed.

ChatGPT direct connection was not attempted because the current Plus product access is not listed by OpenAI as supporting custom MCP Developer Mode. The deployed M2 endpoint remains independently protocol-proven and ready for a supported ChatGPT product tier or future product-access change.
