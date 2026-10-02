# Native RDC M3C — Safe Read-Only Tools

## Status

M3C expands the M3B deny-by-default policy registry from `get_config` to five explicitly allowlisted read operations. It does not expose writes, shell execution, browser control, Git mutation, arbitrary process execution, or a generic Desktop Commander proxy.

## Exposed remote tools

- `get_config` — READ_SAFE; sanitized configuration only.
- `list_processes` — READ_SENSITIVE; bounded text output.
- `list_directory` — READ_SENSITIVE; approved roots only, depth 1–2.
- `get_file_info` — READ_SENSITIVE; approved roots only.
- `read_file` — READ_SENSITIVE; approved text files only, maximum 200 lines per call.

Unknown tools fail closed.

## Approved read roots

Read roots are stored inside the DPAPI-protected Native RDC machine credential as `readRoots`.

If no roots are configured, filesystem reads fail closed. Up to 16 roots may be configured.

Before a filesystem operation, Native RDC resolves the requested path with `realpath` and requires the canonical target to remain inside a canonical approved root.
This prevents ordinary traversal and symlink/junction escape.

The read layer also rejects UNC/device path syntax on Windows and denies sensitive locations or names even when they appear beneath an otherwise approved root.

Examples of denied material include SSH/GPG/cloud credential directories, browser profile stores, Windows credential stores, the Native RDC local secret directory, official Desktop Commander credential data, `.env` files, private-key formats and password databases.

## File-read boundary

`read_file` is restricted to an allowlist of text/code extensions and requires a regular file.

Remote arguments are bounded:

- offset: 0–100000
- length: 1–200 lines
- directory depth: 1–2
- MCP request: existing 64 KiB boundary
- sanitized MCP result: existing 32 KiB boundary
- device transport: existing 1 MiB boundary

## Device enforcement

The Windows Native RDC device independently validates the same five-tool allowlist and filesystem arguments before calling Desktop Commander.

The Cloudflare gateway also validates the explicit tool set and argument shapes before dispatch.

This preserves defence in depth: an MCP-layer mistake cannot become a generic Desktop Commander invocation.
## Replay and timeout semantics

M3C operations are read-only. Read redispatch is allowed by policy, but a timeout still does not prove cancellation of the underlying Desktop Commander call.

M3C does not claim exactly-once execution.

Consequential operations remain unavailable and are deferred to M3D, where ambiguous timeout must not cause automatic redispatch.

## Validation

`npm run native-rdc:m3c:test` covers:

- the exact five-tool exposure;
- canonical in-root reads;
- outside-root denial;
- sensitive-path denial;
- binary-read denial;
- symlink/junction escape denial;
- fail-closed empty roots;
- bounded file reads;
- bounded directory depth;
- continued denial of `start_process` and `write_file`.

M3C must also retain all M2/M3A/M3B regression gates before commit.

## Next milestone

M3D adds approval infrastructure before exposing any narrowly scoped reversible consequential action.
