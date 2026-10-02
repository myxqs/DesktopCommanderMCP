# Native RDC M3A — Operational Hardening

## Status

M3A adds the repository-side operational hardening required before Native RDC expands beyond the M2 `get_config` proof. The live M2 Worker remains the rollback point until Cloudflare Access is activated and the hardened deployment is proven.

## Owner identity

The M2 trusted-network-origin authorization gate is removed from application code. Human OAuth authorization now requires a Cloudflare Access execution context and an identity whose email matches `OWNER_EMAIL`.

Cloudflare Access is the intended production identity provider, using Cloudflare account membership for this single-owner deployment. The Access identity is used only for human OAuth authorization. It is not reused as the M1 Windows device credential.

The M1 device WebSocket continues to authenticate independently with `DEVICE_TOKEN`.

Production activation requires:
1. Configure Cloudflare Access for the human authorization route without intercepting the M1 device WebSocket.
2. Use Cloudflare as the identity provider.
3. Restrict policy to the intended Cloudflare account member.
4. Configure `OWNER_EMAIL` as deployment configuration outside Git.
5. Deploy and traverse a real Access-authenticated OAuth authorization flow.

Until this is performed, keep the validated M2 deployment as the rollback deployment.

## Windows protected credential

`windows-credential-store.ts` stores Native RDC machine connection material using Windows DPAPI with `CurrentUser` scope.

Default location:

`%LOCALAPPDATA%\NativeRDC\device-credential.json`

The file contains a versioned envelope and DPAPI ciphertext only. The device token is never supplied in process arguments. DPAPI plaintext buffers are zeroed after use where practical.

The credential contains:
- gateway HTTPS URL;
- Native RDC device ID;
- Native RDC device token.

It never contains official Desktop Commander Remote credentials.

## Credential provisioning

Build first:

`npm run build`

Status:

`npm run native-rdc:m3a:credential:status`

Provisioning accepts JSON through stdin:

`node dist/native-remote/windows-credential-cli.js store`

Do not paste production credentials into committed files or command arguments.

For rotation, generate a high-entropy replacement in memory, update the Cloudflare `DEVICE_TOKEN` secret and the DPAPI-protected local credential, restart the supervised connector, verify the new credential, then verify the previous credential is rejected.

If dual-secret overlap is not implemented, expect a short controlled reconnect window.

## Supervisor

`windows-supervisor.ts`:
- loads the DPAPI-protected credential;
- holds a single-instance lock;
- starts the existing Cloudflare device client in-process;
- writes non-sensitive health state;
- writes bounded redacted audit events;
- retries initial transient connection failures with bounded backoff;
- respects deliberate shutdown.

Backoff is capped at 30 seconds.

Health states are:
- STARTING
- CONNECTING
- ONLINE
- DEGRADED
- OFFLINE
- AUTH_FAILED

## Audit

The local audit log is bounded by event count. Events contain timestamps, event names, safe outcomes/correlation IDs and redacted reasons.

Bearer/token/secret/authorization/credential-like reason text is redacted.

No environment dump, access token, device token or full Desktop Commander configuration is written to the audit log.

## Windows Task Scheduler

`scripts/native-rdc-windows.ps1` manages the `Native RDC Device` task.

Actions:
- Install
- Start
- Stop
- Restart
- Status
- Uninstall

The task runs at current-user logon with limited privileges and starts the supervisor without embedding Native RDC credentials in the task arguments.

The scheduled task must not be registered until the build and protected credential are validated.

## Network boundary

M3A preserves:
- outbound Windows connection only;
- HTTPS/WSS transport;
- no inbound Windows listener;
- no Native RDC firewall rule;
- no router change.

## Remote tool boundary

M3A exposes only:

`get_config`

It does not expose `start_process`, `write_file`, shell access, browser control, Git mutation or a generic Desktop Commander proxy.

## Timeout and replay semantics

M3A does not claim exactly-once execution.

An MCP/client timeout does not prove that underlying device execution was cancelled. M1 durable call state and device-side duplicate handling remain as documented in M1/M2.

Future consequential operations must not blindly redispatch after an ambiguous timeout.

## Validation

Deterministic M3A tests cover protected credential storage, fail-closed missing/corrupt credentials, bounded backoff, redacted/bounded audit events, duplicate supervisor prevention, retry/graceful stop, Cloudflare Access owner identity, removal of network-origin trust and preservation of the `get_config` boundary.

## Rollback

Application rollback is the validated M2 commit and deployment. Do not remove official Desktop Commander Remote.

Task rollback:
1. Stop the Native RDC task.
2. Uninstall the Native RDC task.
3. Leave the protected Native RDC state in place unless intentional credential revocation is being performed.
4. Restore/redeploy the validated M2 Worker if an M3A Worker deployment fails.

## Remaining production proofs

Repository implementation alone does not prove:
- Cloudflare Access policy activation;
- real Access owner login;
- real DEVICE_TOKEN rotation;
- actual scheduled-task registration;
- crash recovery of the installed task;
- Windows reboot recovery.

Those are live operational gates and must be reported as such rather than simulated.
