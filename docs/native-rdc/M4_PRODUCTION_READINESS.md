# Native RDC M4 — Production Readiness

## Purpose

M4 packages the validated Native RDC engineering layers into a maintainable personal Windows service. It does not add new remote powers.

The supported lifecycle surface is the `native-rdc` CLI, backed by the existing limited-privilege Task Scheduler wrapper.

Commands:

- `native-rdc status`
- `native-rdc doctor`
- `native-rdc install`
- `native-rdc start`
- `native-rdc stop`
- `native-rdc restart`
- `native-rdc update`
- `native-rdc rollback`
- `native-rdc rotate-credential`
- `native-rdc uninstall`

The npm development equivalent is `npm run native-rdc:lifecycle -- <command>`.

## Installation and startup

The Windows task is named `Native RDC Device`.

It runs at the current user's logon with limited privileges and launches the compiled Node watchdog directly, with no device credential in its command line.

The watchdog supervises the compiled Windows supervisor and restarts it with bounded backoff after an unexpected child exit. The supervisor loads the machine credential from the CurrentUser DPAPI-protected store and enforces a single active supervisor instance.

`native-rdc install` fails closed unless the compiled supervisor exists and the CurrentUser DPAPI-protected machine credential is readable. A missing credential therefore cannot leave behind a broken autostart task.

## Diagnostics

`native-rdc doctor` reports PASS/WARN/FAIL without printing secrets.

It checks:

- Windows runtime;
- compiled supervisor;
- protected credential readability;
- supervisor health state;
- Task Scheduler registration;
- Native RDC process listening sockets and matching firewall rules;
- gateway health.

A FAIL is a readiness failure. A WARN identifies an operational item that can be investigated without weakening security.

## Credential rotation

`native-rdc rotate-credential` generates a new high-entropy DEVICE_TOKEN in memory.

The new token is DPAPI-protected locally and streamed to Wrangler over stdin. It is never included in the command line or normal output.

If the Cloudflare secret update fails, the previous local protected credential is restored.

After the server-side update, rotation probes the superseded credential over a new WebSocket handshake until Cloudflare rejects it within a bounded verification window. If rejection cannot be proven, the Cloudflare secret and local DPAPI credential are rolled back. The task is restarted only after old-credential rejection is proven.

Wrangler discovery can be supplied with `NATIVE_RDC_WRANGLER_PATH` when Wrangler is not installed in this repository.

## Update and rollback

Update refuses a dirty worktree, records the current commit as last-known-good, performs only a fast-forward pull, builds the new revision, runs the M3D and M4 Native RDC release tests, and restarts the task only after validation succeeds.

If the candidate build or release tests fail, update resets to the previously recorded commit, rebuilds that revision, and reports the validation failure without restarting into the failed candidate.
Rollback also refuses a dirty worktree. It validates the recorded last-known-good commit, resets to that exact commit, rebuilds and restarts.

Protected machine credentials and operational state are outside the repository and therefore are not replaced by a Git update/rollback.

## Durable retention

M4 bounds Cloudflare Durable Object operational state:

- approval records: maximum 256;
- terminal call records: maximum 512.

Only terminal or expired records are eligible for pruning, ordered by recorded update/create time. Active approvals, UNKNOWN consequential operations and pending calls are preserved. If capacity is exhausted entirely by active state, new work is refused instead of evicting live state.

Local audit retention remains bounded by the M3A operational log implementation.

## Remote capability boundary

M4 retains the M3D surface:

Read tools:

- `get_config`
- `list_processes`
- `list_directory`
- `get_file_info`
- `read_file`

Approval workflow:

- `request_create_directory`
- `execute_approved_action`

There is still no direct remote `create_directory` tool and no arbitrary write/shell/process/browser/Git proxy.

## Production activation gates

Code completion is distinct from live replacement readiness.

A production deployment is not replacement-ready until all of these are proven on the actual machine:

1. Cloudflare Access owner policy active with the intended single owner.
2. DPAPI machine credential bootstrapped.
3. Task Scheduler supervisor installed and started.
4. Real DEVICE_TOKEN rotation proven.
5. Connector crash/reconnect/redeploy recovery proven.
6. Remote MCP reads proven against the deployed M4 Worker.
7. Approval-gated directory creation proven through the actual Access approval page.
8. Official RDC remains online as fallback.
9. Windows reboot proof completed when it is safe to do so.

A reboot may be deferred when executing it could remove the only control path.
## Recovery runbook

If Native RDC is unhealthy:

1. run `native-rdc doctor`;
2. inspect the bounded health/audit state;
3. run `native-rdc restart`;
4. if authentication fails, reconcile the Worker DEVICE_TOKEN and DPAPI-protected device credential;
5. do not repeatedly retry an UNKNOWN consequential operation;
6. keep official RDC available during recovery.

If an update fails, use `native-rdc rollback`.

If Native RDC must be disabled, use `native-rdc stop` or `native-rdc uninstall`. Uninstall removes the scheduled task but does not remove official RDC.

## Security invariants

- Windows remains outbound-only.
- Native RDC requires no inbound listener.
- No router or firewall weakening is part of installation.
- Owner identity, MCP OAuth identity and M1 machine credentials remain separate.
- Machine tokens are never returned by status/doctor.
- Filesystem reads and writes remain root-bounded.
- Consequential approval is exact, expiring and single-use.
- Ambiguous timeout becomes UNKNOWN and is not automatically redispatched.
- Official Desktop Commander Remote remains independent and unchanged.

## Validation

M4 adds tests for lifecycle exposure, command-line secret avoidance, safe status output, Durable Object retention, repeated approval consumption and protected read/write-root persistence.

The final release gate also runs all earlier Native RDC suites, the full project test suite, local smoke, secret scan, network audit and live deployment checks that are safely executable.

## M4 code-completion checkpoint  2 October 2026

Validated on Windows against branch `native-rdc/m4-production-readiness`:

- M1: 15 passed, 0 failed.
- M2: 17 passed, 0 failed.
- M3A: 11 passed, 0 failed.
- M3B: 8 passed, 0 failed.
- M3C: 10 passed, 0 failed.
- M3D: 11 passed, 0 failed.
- M4: 11 passed, 0 failed.
- Full project suite: 75 test modules passed, 0 failed.
- Local Native RDC end-to-end smoke: PASS.
- Windows/network boundary check: no Native RDC listening socket and no matching firewall rule.
- Direct Native RDC dependencies were raised to `@modelcontextprotocol/sdk@1.31.0` and `ws@8.22.0`; neither remains in the production audit findings.

The repository-wide production dependency audit is not clean: 27 findings remain (9 moderate, 16 high, 2 critical). The critical chains are under the existing PDF conversion stack (`@opendocsg/pdf2md`/canvas � tar and `md-to-pdf`/Puppeteer � basic-ftp), and no reference to those packages exists in the Native RDC source paths. They are retained as parent-project dependency debt rather than force-upgraded in the Native RDC transport milestone.

## Live activation state — 2 October 2026

The M4 Worker is deployed at `https://native-rdc-gateway.elliot-mercer-uk.workers.dev`. The owner identifier is stored as a Worker secret rather than committed configuration.

The Windows runtime is now activated in parallel with official RDC:

- CurrentUser DPAPI-protected machine credential: PASS.
- Explicit read roots: 2.
- Explicit write roots: 1 dedicated Native RDC workspace.
- `Native RDC Device` scheduled task: INSTALLED.
- Scheduled task launches the Node watchdog directly with no credential in its command line.
- Watchdog → supervisor → outbound WebSocket: ONLINE.
- Forced supervisor-child crash recovery: PASS; watchdog created a replacement child and health returned to ONLINE.
- Native RDC listening sockets: 0.
- Matching Native RDC firewall rules: 0.
- Gateway health: PASS.
- Real DEVICE_TOKEN rotation: PASS; superseded credential rejection is required before restart and no token is printed.
- Official Desktop Commander Remote remains online and independent as fallback.

A live `native-rdc doctor` run reports PASS for Windows runtime, compiled supervisor, protected credential, supervisor health, scheduled-task registration, network exposure and gateway health.

## Remaining replacement-readiness proof

The remaining external gate is the production Cloudflare Access policy for the single owner. The Worker application already requires `ctx.access` on human authorization/approval routes and fails closed without it, but the account-level Access application/policy must still be activated through Cloudflare's Access management surface.

After that policy is active, complete these final live proofs:

1. authenticate the intended owner through Cloudflare Access;
2. exercise all five deployed MCP read tools through OAuth;
3. request and approve one directory creation through the Access-protected approval page, execute it once, and prove replay is refused;
4. perform the controlled Windows reboot-persistence proof when it is safe to risk the remote control path.

Until those external/live interaction gates are complete, engineering is operational but replacement status remains `NOT YET REPLACEMENT-READY`.
