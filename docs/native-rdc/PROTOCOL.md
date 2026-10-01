# Native RDC v0 Protocol

## Scope

This document separates two things:

1. the hosted Desktop Commander Remote protocol observed in this repository; and
2. the deliberately smaller Native RDC v0 protocol implemented under `src/native-remote/`.

The hosted notes below are source-derived. Server internals that are not visible in this repository are not assumed.

## Observed hosted control plane

### Service discovery

The remote device takes its base URL from `MCP_SERVER_URL`, defaulting to `https://mcp.desktopcommander.app`.

At startup it performs an unauthenticated `GET /api/mcp-info`. The response supplies `supabaseUrl` and `supabasePublishableKey`, which initialise the Supabase client.

### Device authentication

If a persisted session cannot be reused, `DeviceAuthenticator` runs an OAuth-style device flow with PKCE:

- `POST /device/start` sends client/device information, hostname, optional existing device ID, and an S256 code challenge.
- The returned verification URL/code is shown to the user.
- `POST /device/poll` sends the device code and PKCE verifier until authorised or terminally rejected.
- A successful poll returns an access token, refresh token and device ID.

The normal device stores the device ID and session in `~/.desktop-commander-device/device.json`. Native RDC v0 does not read or modify that file.
### Device row and reachability

The hosted client reads and writes the Supabase table `mcp_devices`.

The client uses that row for the device identity plus operational fields including status, capabilities and `last_seen`. Registration initially avoids claiming reachability. A device becomes dispatchable only after the realtime channel and presence path are proven.

The capability `transport_broadcast_v1` is advertised only after successful presence publication. Status and heartbeat writes are tied to actual transport/executor reachability.

### Realtime transport

The device joins a private Supabase realtime channel named:

```text
user:<authenticated-user-id>
```

Presence is enabled with the device ID as its presence key.

Fast-path delivery is a broadcast event named `new_call`. The doorbell contains identifiers, not the full execution payload. The durable database row remains the source of truth.

### Durable call queue

The client reads and writes `mcp_remote_calls`.

On reconnect it scans live rows for its device where:

- `status = pending`;
- `timeout_at` is still in the future;
- rows are ordered by `created_at`.

This recovers calls whose one-shot realtime doorbell was missed while disconnected.

On a doorbell, the device attempts a conditional claim:

```text
pending -> executing
```

The update is constrained by call ID, device ID, pending status and an unexpired timeout. A successful claim returns the full row.
### Duplicate protection and execution

The hosted device has two layers:

1. a bounded in-process set of recently handled call IDs; and
2. the database conditional claim.

The local in-process guard prevents duplicate execution within the running device process even if a transient database error makes the server-side claim uncertain.

The claimed row carries the tool name, tool arguments, device ID and optional metadata. Non-special tools are executed through `DesktopCommanderIntegration.callClientTool()`.

### Result and error transport

Terminal state is written back to `mcp_remote_calls` with:

- terminal status;
- `completed_at`;
- result payload for success; or
- text error information for failure.

The hosted implementation sanitises NUL bytes before storing result/error data to avoid PostgreSQL/jsonb rejection.

### Heartbeat, reconnect and shutdown

The hosted transport maintains device `last_seen`, status and realtime health. It retries presence, recreates unhealthy realtime channels, refreshes sessions, and drains pending calls after a usable rejoin.

On local Desktop Commander child failure the remote device stops advertising itself as reachable and attempts local executor recovery.

Graceful shutdown stops heartbeat/realtime work and writes the device offline without revoking the user's device authorisation.
## Native RDC v0 message contract

Native RDC does not reproduce Supabase tables. The protocol boundary is explicit messages validated in `src/native-remote/protocol.ts`.

| Message | Direction | Purpose |
| --- | --- | --- |
| `DEVICE_HELLO` | device -> relay | identify one trusted device and protocol version |
| `DEVICE_READY` | relay -> device | acknowledge registration |
| `HEARTBEAT` | device -> relay | refresh reachability |
| `TOOL_LIST` | device -> relay | advertise current Desktop Commander tools |
| `TOOL_CALL` | client/relay -> device | carry one tool invocation with call ID and deadline |
| `CALL_ACK` | device -> relay | transition a pending call to running |
| `TOOL_RESULT` | device -> relay | terminal successful result |
| `TOOL_ERROR` | device -> relay | terminal failed result |
| `DEVICE_OFFLINE` | device -> relay | explicit graceful disconnect |

Every `TOOL_CALL` includes `call_id`, `device_id`, `tool_name`, `arguments`, `created_at` and `deadline_at`.

Every terminal message includes `call_id`, `device_id`, terminal status and `completed_at`.

## Native RDC v0 HTTP mapping

Device endpoints require the device bearer token. Client endpoints require a different client bearer token.

- `POST /v0/device/hello`
- `POST /v0/device/tools`
- `POST /v0/device/heartbeat`
- `GET /v0/device/events?device_id=...` (SSE)
- `POST /v0/device/ack`
- `POST /v0/device/result`
- `POST /v0/device/offline`
- `GET /v0/client/tools`
- `POST /v0/client/call`

`GET /health` exposes only an `ok` boolean and no device, token or tool information.
## Native RDC v0 call state machine

```text
pending -> running -> completed
                  -> failed
pending/running -> expired
```

A duplicate `call_id` is rejected before a second dispatch. The device also keeps a bounded terminal cache and in-flight set so an accidental replay does not re-execute a tool inside that process.

The v0 call store is in memory. A relay process restart therefore loses call records. The device reconnects and re-registers, but an in-flight caller is not recovered across that relay restart. Durable recovery is a later-stage requirement before Native RDC becomes primary.

## Security assumptions

Native RDC v0 is intentionally local-only:

- relay binding is restricted to loopback;
- device and client tokens are mandatory and distinct;
- bearer comparison uses fixed-length SHA-256 digests with `timingSafeEqual`;
- request bodies and retained calls are bounded;
- message schemas are strict;
- tool names must have been advertised by the connected device;
- deadlines are enforced at the relay and checked again by the device;
- Native RDC does not weaken Desktop Commander's local command/path safeguards;
- tokens are environment-driven and are never embedded in the repository.

The hosted service's server-side RLS, dispatcher, billing and account controls are outside the observable client protocol and are not copied or assumed here.
