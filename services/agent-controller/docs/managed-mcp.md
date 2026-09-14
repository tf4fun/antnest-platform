# Runtime-managed stdio MCP configuration

Agent Controller owns the desired configuration, not MCP processes, protocol
sessions, tool discovery, or Runtime context reads. Templates accept optional
`runtime.mcp_servers` entries with `id`, `command`, `args`, and `env`, matching the
[Runtime contract](../../../contracts/runtime/runtime-spec.schema.json).

The command must already be available in the Runtime image or persistent
workspace. Configuration does not install packages, allocate HTTP endpoints for
children, or allow ACP clients to start processes on the ACP service host.

```json
{
  "mcp_servers": [
    {
      "id": "documents",
      "command": "node",
      "args": ["/workspace/mcp/documents.js"],
      "env": {"DOCUMENTS_URL": "https://documents.example.test"}
    }
  ]
}
```

## Ownership and lifecycle

1. Template create/revise validates bounded configuration before persistence.
   There are at most eight unique IDs (`[a-z][a-z0-9-]{0,15}`), 64 arguments and
   64 environment entries per server, 32 KiB raw data per server and 64 KiB of
   encoded configuration overall. NUL and invalid UTF-8 are rejected; `HOME`,
   `PATH` and `ANTNEST_*` environment keys are reserved. Exact field bounds are
   in the linked contract.
2. A template revision and the materialized Agent spec freeze independent deep
   copies of the configuration. It participates in the Agent spec digest.
3. Create, explicit rebuild and enable forward the frozen spec to Runtime
   Controller as `configuration.mcp_servers`. Rebuild uses the selected target
   revision; enable restores the Agent's saved spec, not the latest template.
4. Runtime Controller deploys the configuration. Agent Controller publishes a
   usable execution only after the existing Runtime readiness barrier. Required
   MCP startup/discovery failure is an ordinary Runtime preparation failure.
5. ACP receives the bound Runtime MCP endpoint and execution identity, never
   the process command, arguments or environment through configuration publication. It
   discovers tools and reads Runtime information through that endpoint.

This introduces no extra tables, lifecycle states, desired-state replicas or
cross-service database access. The existing `agent_controller.agent_template_revisions`
and `agent_controller.agent_spec_revisions` JSON snapshots own persistence.
Runtime deployment itself remains the responsibility of Runtime Controller.

## Configuration privacy

Explicit MCP environment values are deployment configuration. They are stored
with immutable revisions in Agent Controller's own database, not a new secret
manager. Trusted internal administrative catalog/configuration RPCs return this
configuration; they must not be exposed as public user APIs. Database access and
backups therefore require the same protection as other sensitive configuration.
Operational observations, lifecycle events, ACP Agent configuration and prompts
must not copy this configuration. Diagnostic formatting displays server IDs only.
Future credential references can replace inline values without changing process
ownership. This batch does not add a Console MCP configuration editor.

## Verification

Domain tests cover validation, snapshot isolation and digest changes. Lifecycle
tests cover create/rebuild/enable forwarding; HTTP client tests check the wire
payload. PostgreSQL integration verifies revision round trips. Final cross-service
acceptance is tracked in the [feature plan](../../../docs/runtime-context-and-managed-mcp.md).
