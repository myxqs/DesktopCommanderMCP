# Native RDC v0

Native RDC v0 is a local implementation seed for a self-hosted Desktop Commander remote transport.

Its current purpose is to prove that we can route an authenticated call through our own control plane to the existing local Desktop Commander MCP executor without disturbing the official Desktop Commander Remote connection.

## Current status

Implemented in this seed:

- explicit Native RDC protocol schemas;
- separate device/client bearer authentication;
- loopback-only relay;
- one trusted device;
- device tool discovery;
- SSE tool-call delivery;
- heartbeat and online/offline state;
- pending/running/completed/failed/expired call states;
- duplicate call-ID protection;
- device-side replay protection;
- request-size and store bounds;
- deadline enforcement;
- device reconnect after relay restart;
- automated fake-executor tests;
- real read-only `get_config` smoke path.

Not implemented yet:

- a public/private internet deployment;
- a ChatGPT-facing MCP server endpoint;
- durable in-flight call recovery across relay process restart;
- multi-user/multi-device routing;
- OAuth/RBAC;
- UI, billing or subscriptions.

The official `src/remote-device/` flow remains separate and unchanged.
## Files

```text
src/native-remote/
  auth.ts
  call-store.ts
  client.ts
  device-client.ts
  device-main.ts
  index.ts
  protocol.ts
  relay-main.ts
  relay-server.ts
  smoke.ts
  token-main.ts

docs/native-rdc/
  PROTOCOL.md
  ARCHITECTURE.md
  MIGRATION.md
  README.md

test/
  test-native-rdc.js
```

## Safety boundary

Native RDC v0 refuses a non-loopback relay host. The default is `127.0.0.1:47777`.

It does not read, delete or modify:

```text
~/.desktop-commander-device/device.json
```

It does not set the official `MCP_SERVER_URL`, revoke the official device, or replace the currently running official Desktop Commander Remote process.

Native RDC uses a separate local process and separate credentials.
## Configuration

The relay requires:

```text
NATIVE_RDC_DEVICE_TOKEN
NATIVE_RDC_CLIENT_TOKEN
```

They must both be present and must be different.

Optional relay settings:

```text
NATIVE_RDC_HOST=127.0.0.1
NATIVE_RDC_PORT=47777
NATIVE_RDC_MAX_BODY_BYTES=1048576
NATIVE_RDC_CALL_TIMEOUT_MS=30000
NATIVE_RDC_HEARTBEAT_TTL_MS=20000
NATIVE_RDC_MAX_CALLS=512
NATIVE_RDC_RETENTION_MS=600000
```

The device process requires:

```text
NATIVE_RDC_URL=http://127.0.0.1:47777
NATIVE_RDC_DEVICE_TOKEN=<same device token as relay>
NATIVE_RDC_DEVICE_ID=<optional stable local id>
```

Generate credentials with the included helper after the repository toolchain is available:

```powershell
npm run native-rdc:token
```

Run it twice and keep the two outputs separate. Do not commit them.
## Run locally

These commands assume the repository's declared dependencies are already installed.

### Terminal 1: relay

```powershell
$env:NATIVE_RDC_DEVICE_TOKEN = '<device-token>'
$env:NATIVE_RDC_CLIENT_TOKEN = '<client-token>'
npm run native-rdc:relay
```

Expected bind:

```text
http://127.0.0.1:47777
```

### Terminal 2: isolated Native RDC device

```powershell
$env:NATIVE_RDC_URL = 'http://127.0.0.1:47777'
$env:NATIVE_RDC_DEVICE_TOKEN = '<device-token>'
$env:NATIVE_RDC_DEVICE_ID = 'will-pc-native-rdc'
npm run native-rdc:device
```

This starts a separate `DesktopCommanderIntegration` child for Native RDC. It does not terminate or reconfigure the official Remote MCP device.

## Tests

Run the focused suite:

```powershell
npm run native-rdc:test
```

The suite exercises:

- unauthorised client;
- unauthorised device;
- valid tool call;
- unadvertised tool rejection;
- malformed protocol payload;
- duplicate call ID with one execution;
- deadline timeout;
- executor failure;
- relay restart and device reconnect.
## Real local smoke proof

Run:

```powershell
npm run native-rdc:smoke
```

The smoke test generates ephemeral credentials in memory and performs:

```text
synthetic authenticated client
-> local Native RDC relay
-> Native RDC device adapter
-> DesktopCommanderIntegration
-> Desktop Commander get_config
-> result returned
```

`get_config` is read-only. The smoke test does not use a destructive desktop tool.

A passing run prints:

```text
NATIVE RDC LOCAL END-TO-END: PASS
```

## Authentication behaviour

The relay has two trust roles.

The device token can register/heartbeat/open events/report results. It cannot use client endpoints.

The client token can list the current device tools and submit calls. It cannot use device endpoints.

Bearer values are compared through SHA-256 digests using Node's constant-time comparison.

## Reliability behaviour

A connected device heartbeats and maintains one SSE stream. If the relay restarts, the stream closes; the device retries registration and opens a fresh stream.

Within a running relay, duplicate call IDs are rejected. Within a running device process, in-flight and recently completed call IDs are also protected from re-execution.

The relay's v0 call store is memory-only. Calls already waiting when the relay process dies are not recoverable after restart.
## Security notes

Native RDC is only a transport layer.

It does not parse shell syntax, bypass blocked commands, widen allowed directories or grant new operating-system permissions. Local tool execution still goes through Desktop Commander's existing MCP server and safety controls.

The relay validates protocol shape and advertised tool names before dispatch. It also bounds request size and retained call count.

Before internet deployment, add a durable connection owner, TLS, hardened credential storage/rotation, result-size enforcement, durable call recovery and a real MCP gateway.

## Next engineering gate

The next milestone after a verified local E2E is a private remote deployment design/proof, not replacement of the official service.

The preferred direction is a Cloudflare Worker MCP gateway plus a Durable Object owning the authenticated Windows device connection and durable call-routing state.

Only after that private remote path is reliable should ChatGPT be connected to Native RDC in parallel with the official connector.
