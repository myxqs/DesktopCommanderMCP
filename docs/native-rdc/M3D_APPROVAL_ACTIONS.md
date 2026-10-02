# Native RDC M3D — Approval-Gated Consequential Actions

## Scope

M3D adds one narrowly scoped reversible mutation: creating a directory inside an explicitly configured Native RDC write root.

It does not expose arbitrary Desktop Commander mutations. In particular, direct `create_directory`, `write_file`, deletion, shell/PowerShell, process launch, browser control, registry access and arbitrary tool forwarding remain unavailable through MCP.

## OAuth boundary

Read operations continue to use `native-rdc:read`.

The approval workflow additionally requires `native-rdc:write`.

A token carrying only the read scope can list the approval workflow descriptors but cannot request or execute a write approval.

## Approval flow

1. MCP calls `request_create_directory` with the exact requested path.
2. The Worker creates a five-minute Durable Object approval record.
3. The record binds owner identity, action, exact arguments and a random nonce into a SHA-256 fingerprint.
4. The MCP response returns the approval ID, fingerprint, expiry and Access-protected approval URL.
5. The owner opens `/approvals/<id>` and authenticates through Cloudflare Access.
6. The page shows the exact target and allows Approve or Deny.
7. `execute_approved_action` must present the exact approval ID and fingerprint.
8. The Durable Object atomically changes APPROVED to DISPATCHED before any device call.
9. The operation ID is deterministically `approval-<approval-id>`.
10. Completion is recorded as COMPLETED or FAILED. Ambiguous dispatch/timeout becomes UNKNOWN.
## State model

The durable approval state is:

REQUESTED → APPROVED → DISPATCHED → COMPLETED
                         ↘ FAILED
                         ↘ UNKNOWN

REQUESTED may instead become DENIED or EXPIRED.

APPROVED may become EXPIRED before consumption.

Only APPROVED may be consumed. Consumption is single-use. A second consume attempt on DISPATCHED, COMPLETED, FAILED, UNKNOWN, DENIED or EXPIRED is rejected.

UNKNOWN is deliberately not retried automatically. It requires reconciliation because a caller timeout does not prove the Windows action was cancelled.

## Device boundary

The device may advertise `create_directory` only when at least one protected `writeRoot` is configured.

The legacy CLIENT_TOKEN endpoint remains restricted to the five M3C read tools; it cannot submit `create_directory`.

Before Desktop Commander receives a create-directory call, the Windows device validates it again:

- exactly one path argument;
- configured write root required;
- UNC and Windows device paths denied;
- sensitive credential-related paths denied;
- canonical existing parent must remain inside an approved write root;
- target must be a direct child whose parent already exists;
- an existing target is rejected.

Write roots are stored inside the DPAPI-protected Native RDC machine credential and are separate from read roots.
## Security properties

- Owner identity is bound to the approval record.
- Fingerprint mismatch fails closed.
- Changed arguments cannot reuse the approval.
- Approval expires after five minutes.
- Approval is single-use.
- Durable Object storage serializes approval transitions.
- Dispatch uses a deterministic operation ID.
- Ambiguous timeout enters UNKNOWN instead of redispatching.
- Direct mutation tool names are not in the MCP tool list.
- The device independently enforces write-root policy.

M3D does not claim exactly-once execution. It provides single-use approval consumption and at-most-once dispatch from the MCP approval path; underlying execution can still become ambiguous after dispatch if the caller loses the result.

## Exposed MCP workflow tools

- `request_create_directory`
- `execute_approved_action`

These are workflow tools, not generic Desktop Commander forwarding.

## Live-production limitation

The approval page depends on the M3A Cloudflare Access owner policy being activated. Until that live Access configuration and the protected Windows supervisor are installed and proven, M3D is engineering-complete only at the implementation/test layer and must not be described as production-proven.

## Next milestone

M4 packages lifecycle operations, diagnostics, update/rollback and reliability validation without broadening the consequential action set.
