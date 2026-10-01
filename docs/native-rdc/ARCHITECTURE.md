# Native RDC v0 Architecture

## Decision

Native RDC v0 uses a small Node/TypeScript relay over loopback HTTP plus Server-Sent Events (SSE).

This is deliberately not a clone of the hosted Supabase control plane. It is the minimum architecture needed to prove:

```text
synthetic authenticated client
        |
        v
loopback Native RDC relay
        |
        v
SSE + authenticated device HTTP
        |
        v
Native RDC device adapter
        |
        v
DesktopCommanderIntegration
        |
        v
local Desktop Commander MCP child
```

No external deployment is part of v0.

## Why HTTP + SSE

The repository already depends on Node and Zod. Node's built-in HTTP server plus Fetch is enough for a single trusted device, so no WebSocket package or new database is needed.

SSE provides a long-lived server-to-device path for tool calls. Device-to-relay acknowledgements, heartbeats and results use ordinary authenticated HTTP requests.

This keeps the first proof simple and makes every control-plane operation inspectable with standard HTTP tooling.
## Components

### Protocol schemas

`src/native-remote/protocol.ts` defines strict schemas and message types. This is the replacement protocol contract rather than an accidental copy of Supabase row shapes.

### Authentication and configuration

`src/native-remote/auth.ts` loads relay configuration from the environment.

The relay requires two different bearer credentials:

- `NATIVE_RDC_DEVICE_TOKEN` for the Windows device; and
- `NATIVE_RDC_CLIENT_TOKEN` for an AI/synthetic client.

Missing or identical credentials fail closed. Tokens are never hard-coded.

### Relay

`src/native-remote/relay-server.ts`:

- binds to loopback only;
- registers one device;
- records the tool list and heartbeat;
- owns one SSE event stream;
- validates client calls against advertised tools;
- tracks call state;
- dispatches tool calls;
- waits for result/error or deadline;
- bounds body size and retained call count.

### Call store

`src/native-remote/call-store.ts` provides the v0 state machine and bounded retention.

It is intentionally in memory. This is enough for local proof but is not enough for primary-production use because relay restart loses in-flight call state.

### Device adapter

`src/native-remote/device-client.ts` is isolated from the existing hosted `src/remote-device/` path.

It reuses `DesktopCommanderIntegration` rather than duplicating the execution layer. It registers tools, opens the SSE stream, heartbeats, executes calls, caches terminal results for replay protection and reconnects after relay loss.
### Synthetic client

`src/native-remote/client.ts` is a small authenticated client used for tests and the first proof. It is not the eventual ChatGPT MCP gateway.

### Smoke proof

`src/native-remote/smoke.ts` starts an ephemeral loopback relay, an isolated device adapter and a synthetic client in one process, then executes the read-only `get_config` Desktop Commander tool.

## Trust boundaries

### Boundary 1: client -> relay

Only the client token can submit calls. Calls are schema validated, bounded, targeted to the registered device, constrained to an advertised tool and deadline limited.

### Boundary 2: device -> relay

Only the device token can register the device, advertise tools, open the event stream, heartbeat or report results.

### Boundary 3: relay/device transport -> local executor

Native RDC transports a tool name and arguments to `DesktopCommanderIntegration`. It does not bypass Desktop Commander's existing blocked-command, allowed-directory or other local policy enforcement.

### Boundary 4: network

v0 refuses a non-loopback relay host. There is no supported internet-facing mode in this implementation seed.

## Authentication

Bearer tokens are sufficient for the single-user local prototype because the listener is loopback-only.

Comparison hashes both values with SHA-256 and uses constant-time buffer comparison. A token generator uses cryptographically secure random bytes.

The upgrade path for remote deployment is not "open this HTTP server to the internet". Remote deployment requires TLS, server-side secret storage/rotation, authenticated MCP client identity and a hardened persistent connection layer.
## Call flow

1. Device starts `DesktopCommanderIntegration`.
2. Device sends `DEVICE_HELLO`.
3. Relay replies `DEVICE_READY`.
4. Device sends `TOOL_LIST`.
5. Device opens authenticated SSE events.
6. Client posts a validated `TOOL_CALL`.
7. Relay creates a pending record and emits the call over SSE.
8. Device sends `CALL_ACK`; relay marks it running.
9. Device executes the existing local MCP tool.
10. Device posts `TOOL_RESULT` or `TOOL_ERROR`.
11. Relay resolves the waiting client request and retains the bounded terminal record.

Duplicate client call IDs are rejected before dispatch. The device also has in-process duplicate protection.

## Reconnect strategy

If the relay disappears, the device's SSE request ends. The device waits briefly, sends hello/tool registration again and reopens the stream.

This restores reachability after a relay restart. Because the current call store is memory-only, the restarted relay cannot recover a caller that was already waiting before the restart.

That limitation is explicit rather than hidden.

## Security review

### Path traversal and shell exposure

The transport itself never interprets paths or shells. Those values remain arguments to Desktop Commander tools, where existing local policy continues to apply.

### Secrets

No token literals are committed. Relay logs do not include bearer values. The token helper prints a newly generated token only when explicitly invoked by the local operator.

### Replay and duplicates

Relay call IDs are unique within retained state. Device in-flight and terminal caches prevent a replay from executing the same call twice in one device process.

Cross-relay-restart exactly-once semantics are not claimed in v0.
### Network exposure

The relay constructor and environment loader reject non-loopback hosts. No external deployment command exists in this seed.

### Request/result abuse

Request bodies, call IDs, tool names, error messages, tool lists and call-store cardinality are bounded.

A future remote service should also enforce a maximum terminal result byte size before accepting a device result. v0 relies on loopback trust and Desktop Commander's own result behaviour for this first proof.

### Runaway processes

Tool deadlines stop the relay from waiting indefinitely, but cancellation of an already-running local tool is not implemented. Desktop Commander's existing process controls remain authoritative.

### Stale sessions

A device is considered reachable only while its event stream is connected and its heartbeat is within the configured TTL.

## Internet deployment design

The preferred next remote architecture is:

```text
ChatGPT MCP client
      |
      v
Cloudflare Worker MCP gateway
      |
      v
Durable Object per user/device
      |
      +---- persistent authenticated WebSocket -> Windows device
      |
      +---- bounded durable call state
```

A Durable Object is a better fit than a stateless Worker alone because one device connection and its call-routing state need a stable owner.

D1 or KV should be added only if restart/audit requirements justify storage outside the Durable Object. Billing, organisations and general RBAC remain out of scope.

Before any deployment, verify Cloudflare's current WebSocket/Durable Object limits, cost model, MCP compatibility and persistence semantics. Do not assume "no product call-count limit" means the platform has no quotas.

## Known trade-offs

- Local v0 proves transport, not an internet-facing service.
- The call store is not durable across relay restart.
- The synthetic client is not yet an MCP endpoint for ChatGPT.
- One device and one trusted user are intentional constraints.
- No UI, billing, organisations or telemetry platform is included.
- Cancellation of an already-running Desktop Commander tool is not implemented.

These are migration gates, not reasons to expand v0 prematurely.
