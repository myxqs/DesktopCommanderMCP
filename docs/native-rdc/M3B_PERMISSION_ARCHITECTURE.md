# Native RDC M3B — Permission Architecture

M3B introduces a deterministic, deny-by-default permission registry between the public MCP surface and Desktop Commander.

## Permission classes

- READ_SAFE
- READ_SENSITIVE
- WRITE_REVERSIBLE
- WRITE_CONSEQUENTIAL
- SYSTEM_CONSEQUENTIAL

Unknown permission classes are rejected when the registry is validated.

## Policy contract

Every remotely exposed operation must declare:
- external MCP name;
- internal Desktop Commander tool target;
- permission class;
- approval requirement;
- bounded timeout;
- replay policy;
- audit category;
- resource boundary;
- explicit invocation adapter;
- explicit sanitizer adapter;
- MCP descriptor and argument schema.

There is no generic tool-name forwarding path.

Unknown MCP tools are denied before dispatch.

## Current registry

M3B intentionally contains one live policy only:

`get_config`

Classification:
- READ_SAFE
- no approval required;
- sanitized configuration only;
- read redispatch is allowed;
- 15 second backend deadline.

The current remote capability remains exactly the M2/M3A `get_config` surface.

## Consequential actions

The permission model recognizes consequential classes but M3B does not expose them.

Future consequential policies must:
- set `approvalRequired: true`;
- use the single-use approval replay policy;
- bind arguments/resources before dispatch;
- never fall back to generic Desktop Commander invocation.

## Failure model

Malformed registries, unknown tools, unknown permissions, unsupported adapter mappings and missing approval flows fail closed.

Timeout semantics remain unchanged: a caller timeout does not prove cancellation of underlying execution.

## Validation

`npm run native-rdc:m3b:test` verifies:
- closed permission classes;
- registry validation;
- get_config classification;
- unknown-tool denial;
- unknown-permission denial;
- malformed-policy denial;
- descriptor/registry alignment;
- consequential policy requirements.

M3C may add selected read-only policies only after each operation has a strict schema, sanitizer and resource boundary.
