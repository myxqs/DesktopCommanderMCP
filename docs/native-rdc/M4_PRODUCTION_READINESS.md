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

It runs at the current user's logon, with limited privileges, starts the compiled Windows supervisor hidden, and contains no device credential in its command line.

The supervisor loads the machine credential from the CurrentUser DPAPI-protected store and enforces a single active supervisor instance.

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

The task is restarted only after the server-side secret update succeeds.

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
- M4: 10 passed, 0 failed.
- Full project suite: 75 test modules passed, 0 failed.
- Local Native RDC end-to-end smoke: PASS.
- Windows/network boundary check: no Native RDC listening socket and no matching firewall rule.
- Direct Native RDC dependencies were raised to `@modelcontextprotocol/sdk@1.31.0` and `ws@8.22.0`; neither remains in the production audit findings.

The repository-wide production dependency audit is not clean: 27 findings remain (9 moderate, 16 high, 2 critical). The critical chains are under the existing PDF conversion stack (`@opendocsg/pdf2md`/canvas � tar and `md-to-pdf`/Puppeteer � basic-ftp), and no reference to those packages exists in the Native RDC source paths. They are retained as parent-project dependency debt rather than force-upgraded in the Native RDC transport milestone.

## Live activation state  2 October 2026

M4 code completion is proven, but the machine is intentionally not activated as a replacement yet.

Current `native-rdc doctor` state:

- Windows runtime: PASS.
- Compiled supervisor: PASS.
- Protected machine credential: FAIL  not provisioned.
- Supervisor health: FAIL  service not installed/running.
- Scheduled task: FAIL  `Native RDC Device` is not registered.
- Network exposure: PASS  0 Native RDC listeners and 0 matching firewall rules.
- Gateway health: FAIL  no protected gateway origin is configured.

The existing Cloudflare Worker `native-rdc-gateway` remains deployed as the older gateway implementation. It does not contain the M3C/M3D/M4 capability markers from this branch, so the validated M4 Worker has not replaced the existing deployment.

Official Desktop Commander Remote remains online and independent as the fallback control path.

The remaining activation inputs were not previously established: the exact Cloudflare Access owner identity/policy, the protected gateway URL/device credential, and explicit Native RDC read/write roots. Official RDC currently permits unrestricted filesystem scope, but Native RDC must not silently inherit that unrestricted setting.

## Remaining replacement-readiness proof

After the explicit owner/root inputs are established:

1. verify or create the intended single-owner Cloudflare Access policy;
2. deploy the committed M4 Worker;
3. bootstrap the CurrentUser DPAPI-protected credential using the deployed gateway URL, `native-rdc-windows-1`, a new machine token, and explicit bounded read/write roots;
4. install and start `Native RDC Device`;
5. run `native-rdc doctor` to a clean operational state;
6. prove real DEVICE_TOKEN rotation;
7. prove reconnect/redeploy recovery;
8. prove all five deployed read tools;
9. prove one approval-gated directory creation, then prove replay is refused;
10. keep official RDC online while performing a controlled reboot-persistence proof.

Until those live gates are complete, replacement status is `NOT YET REPLACEMENT-READY`.
