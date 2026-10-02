# Native RDC M1 — Private Remote Gateway

## Scope

M1 proves one private remote path for one trusted Windows device and one trusted synthetic client. It does not expose Desktop Commander directly, does not replace the official Desktop Commander Remote service, and does not provide a ChatGPT-facing MCP endpoint.

The only remotely executable Desktop Commander tool in M1 is `get_config`. Both the Cloudflare gateway and the Windows device enforce this allow-list.

## Architecture

```text
synthetic remote client
  -> HTTPS + client bearer credential
Cloudflare Worker (native-rdc-gateway)
  -> authenticated/sanitised internal request
Durable Object (NativeRdcConnectionOwner)
  <-> hibernatable WebSocket
Windows Native RDC M1 device
  -> DesktopCommanderIntegration
local Desktop Commander MCP
```

The Windows PC initiates the WebSocket connection outbound to Cloudflare. No inbound Windows listener, router forwarding, UPnP or firewall relaxation is required.

## Components

- Worker: authenticates DEVICE and REMOTE CLIENT roles before routing any private endpoint.
- Durable Object: owns the single trusted device connection, replaces stale connections, stores call state, and routes calls/results.
- Windows device transport: authenticates with the DEVICE secret, reconnects outbound, validates protocol messages and enforces the read-only tool allow-list.
- Synthetic client: authenticates with the CLIENT secret and calls the deployed Worker over HTTPS.

## Trust boundaries

DEVICE and CLIENT credentials are independent high-entropy bearer secrets. The Worker fails closed if either secret is missing or both are equal.

Cloudflare stores gateway copies as Worker secrets. The Windows proof stores local copies outside git protected with Windows DPAPI. Secrets are never accepted in URLs, committed to source, or intentionally logged.

The Worker URL is public in the normal Workers sense, but private control endpoints require authentication. `/health` is the only unauthenticated route and returns only a minimal service status.

## Call safety and replay semantics

M1 stores call records in Durable Object storage before dispatch. A completed call ID is returned from durable cache and is not dispatched again. A duplicate while the original call is still pending returns conflict rather than re-executing.

The device also keeps an in-memory terminal-result cache. This protects against repeated delivery while that device process survives.

M1 does **not** claim durable exactly-once execution across a complete device-process restart. If a client times out, the local tool may still finish; timeout means the caller stopped waiting, not that local execution was cancelled. Consequential tools are intentionally unavailable in M1.

## Bounds

Client request bodies are capped at 64 KiB. Device WebSocket messages/results are capped at 1 MiB. Call deadlines are capped at 30 seconds.

## Local v0 vs private remote M1 vs future M2

- LOCAL v0: loopback HTTP/SSE relay and local device proof.
- PRIVATE REMOTE M1: Cloudflare Worker + Durable Object + outbound authenticated Windows WebSocket + synthetic HTTPS client.
- CHATGPT MCP M2: future ChatGPT-facing MCP endpoint and policy layer; explicitly out of scope here.

## Deployment and credentials

The deployable Worker lives at `cloudflare/native-rdc-gateway/`. `wrangler.jsonc` contains only non-secret configuration.

Set Worker secrets named `DEVICE_TOKEN` and `CLIENT_TOKEN` with Wrangler secret storage before deployment. The non-secret trusted device ID is configured as `DEVICE_ID`.

Local device/client processes read credentials only from environment variables. For the proof run, local copies may be DPAPI-protected outside the repository and decrypted only into process memory.

## Reconnect and replacement

A new authenticated device connection replaces any older connection for the same single trusted device. Close events from stale connections cannot mark the replacement offline.

Worker redeployment disconnects WebSockets; the Windows M1 client reconnect loop re-establishes the outbound connection and republishes its read-only capability.

## Teardown

Stop the M1 Windows device process. Optionally delete the `native-rdc-gateway` Worker to remove the remote endpoint. No Windows firewall or router rollback is required because M1 makes no such changes.

## Known limitations

- One user, one trusted device, one client role.
- No ChatGPT MCP endpoint.
- No unattended startup persistence.
- No remote consequential tools.
- Client timeout does not cancel local execution.
- Exactly-once is not guaranteed across a full device-process restart.
- Pending calls are not blindly replayed after uncertain disconnects.

## Next milestone

M2 may add a ChatGPT-facing MCP endpoint and explicit policy/approval controls only after M1 remains stable.

## Verified private remote proof

Deployment:

- Worker: `native-rdc-gateway`
- Endpoint: `https://native-rdc-gateway.elliot-mercer-uk.workers.dev`
- Verified Worker version: `fe79c083-831a-4b9d-b1a2-1eab54eb1994`

The deployed health endpoint returned 200 while unauthenticated private client access returned 401. An authenticated status request carried a Cloudflare `cf-ray` and reported the trusted device as connected and ready.

The real read-only proof traversed the deployed endpoint and returned `NATIVE RDC PRIVATE REMOTE E2E: PASS` for `get_config`, with the gateway marker `cloudflare-durable-object` and call source `device`.

A fixed call ID was then submitted twice. The first response came from `device`; the second came from `durable-cache`, proving completed-call duplicate suppression without redispatch.

Cloudflare redeployment disconnected the WebSocket. The same Windows process observed the close and automatically reconnected to ready state over outbound TCP/443. A separate device-offline test stopped only the M1 connector; the gateway reported disconnected/not-ready and returned `DEVICE_OFFLINE` until the connector was manually restarted.

No Windows listening port, router forwarding, UPnP, firewall relaxation, startup persistence, or official RDC configuration change is required by this proof.
