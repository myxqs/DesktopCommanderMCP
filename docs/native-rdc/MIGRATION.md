# Native RDC Migration Plan

Migration is deliberately staged. The official Desktop Commander Remote path remains the fallback until Native RDC has demonstrated equivalent reliability for the use cases we actually need.

## Stage 0 — Official RDC remains primary

State:

- official Desktop Commander Remote stays connected;
- existing device authorisation stays valid;
- existing local credential file is untouched;
- no Native RDC traffic is internet-facing.

Exit gate: none. This is the safety baseline.

## Stage 1 — Native RDC local proof

Prove on one Windows PC:

```text
synthetic authenticated client
-> Native RDC loopback relay
-> Native RDC device
-> local Desktop Commander MCP
-> safe read-only tool
-> result
```

Required evidence:

- unauthorised device/client rejected;
- tool discovery works;
- duplicate call ID does not execute twice;
- deadlines fail cleanly;
- device reconnects after relay restart;
- local executor failure becomes a terminal error;
- official RDC remains usable throughout.

Do not proceed on architecture alone.
## Stage 2 — Native RDC private remote deployment

Move only the relay/gateway boundary to a private remote service.

Preferred candidate:

```text
Cloudflare Worker
-> Durable Object for one user/device
-> authenticated persistent device connection
```

Before deployment verify current Cloudflare limits and costs for:

- persistent WebSocket connections;
- Durable Object hibernation/reconnect;
- request and message sizes;
- CPU/runtime limits;
- storage semantics;
- MCP streaming compatibility.

Add durable call state before relying on restart recovery.

Keep the official connector primary.

## Stage 3 — ChatGPT MCP connection to Native RDC

Expose a proper authenticated MCP endpoint from our gateway.

The gateway must translate MCP tool discovery/invocation into the Native RDC protocol without giving ChatGPT direct access to the device token.

Validate:

- MCP initialise/capabilities;
- tool list parity;
- tool call/result/error mapping;
- long-running call behaviour;
- disconnect/cancellation behaviour;
- authentication and token rotation.
## Stage 4 — Parallel validation

Connect Native RDC in parallel while official RDC remains available.

Use a defined read-only parity set first, for example:

- `get_config`;
- `list_directory`;
- `read_file`;
- process/status inspection that has no side effects.

Compare:

- tool schemas;
- returned content;
- latency;
- failure messages;
- reconnect time;
- duplicate behaviour;
- call history/auditability.

Do not route consequential desktop changes through Native RDC merely to accelerate testing.

## Stage 5 — Parity and reliability testing

Run controlled failure tests:

- gateway restart;
- device restart;
- network loss;
- stale device heartbeat;
- duplicate delivery;
- result larger than normal;
- local MCP child crash;
- malformed client call;
- expired call;
- credential rejection/rotation.

Durable recovery and exactly-once boundaries must be understood before primary use.

## Stage 6 — Native RDC becomes primary

Only switch primary traffic after the required tool surface and reliability gates pass.

At this stage operational requirements should include:

- stable private endpoint;
- durable call records;
- bounded retention;
- alertable device health;
- credential rotation;
- documented recovery;
- reproducible deployment;
- rollback to official RDC.
## Stage 7 — Official RDC retained temporarily as fallback

Do not revoke the official device immediately after cutover.

Keep it available for a defined fallback period while Native RDC handles normal work.

Retire it only after:

- Native RDC has remained stable through ordinary use and failure drills;
- required Desktop Commander tools have parity;
- remote deployment costs/quotas are understood;
- recovery can be performed without the hosted service.

## Rollback principle

At every stage before final retirement, rollback is:

```text
stop Native RDC path
-> leave official RDC configuration alone
-> continue through official connector
```

No migration stage should require deleting official credentials as a prerequisite.

## Current continuation point

After the local implementation seed is verified, the single highest-value next action is:

**design and prove the private remote gateway/connection owner with durable call state, while keeping the official RDC path primary.**

Do not skip directly from local HTTP/SSE proof to replacing the official connector.
