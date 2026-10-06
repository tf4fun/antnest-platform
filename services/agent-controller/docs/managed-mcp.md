# Runtime-managed stdio MCP configuration

Agent Controller owns the desired configuration, not MCP processes, protocol
sessions, tool discovery, or Runtime context reads. Templates accept optional
`runtime.mcp_servers` entries with `id`, `command`, `args`, public `env` and write-only `secret_env`, matching the
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
      "args": ["/skills/documents/server.js"],
      "env": {"DOCUMENTS_URL": "https://documents.example.test"},
      "secret_env": {"API_KEY": {"value": "write-only-on-create"}}
    }
  ]
}
```

Credentialed MCP code and dependencies must be administrator-controlled image
or read-only preset content. Using model-writable workspace code would let the
model change how that trusted server uses its own credentials.

## Ownership and lifecycle

1. Template create/revise validates bounded configuration before persistence.
   There are at most eight unique IDs (`[a-z][a-z0-9-]{0,15}`), 64 arguments and
   64 environment entries per server, 32 KiB raw data per server and 64 KiB of
   encoded configuration overall. NUL and invalid UTF-8 are rejected; `HOME`,
   `PATH`, temporary/XDG cache directory variables and `ANTNEST_*` environment keys are reserved. Exact field bounds are
   in the linked contract.
2. A template revision and the materialized Agent spec freeze independent deep
   copies of the configuration. It participates in the Agent spec digest.
3. Create, explicit rebuild and enable forward the frozen spec to Runtime
   Controller as `configuration.mcp_servers`. Rebuild uses the selected target
   revision; enable restores the Agent's saved spec, not the latest template.
4. Runtime Controller deploys the configuration. Agent Controller publishes a
   usable execution only after independent healthy Runtime observation. Required
   MCP startup/discovery failure is an ordinary Runtime preparation failure.
5. ACP receives the bound Runtime MCP endpoint and execution identity, never
   the process command, arguments or environment through configuration publication. It
   discovers tools and reads Runtime information through that endpoint.

Controller stores only secret descriptors in Template/Agent Runtime snapshots.
`agent_controller.managed_mcp_secrets` stores authenticated envelopes in the same
Template transaction. The AAD binds organization, Template, revision, server and
name. `keep: true` reads that exact predecessor and reseals under the new revision;
omission clears only the new revision. Reads, receipts and execution audits never
return values or ciphertext. Every read shows set state and an opaque 128-bit HMAC-SHA-256
fingerprint derived from the protected envelope data key. New revisions may
change it even when keeping the value. Requests with value writes use a separate
full envelope-keyed HMAC; identical retries use the original revision's key,
including after master-key re-wrapping and retirement. Concurrent retries
recompute against the committed winner before reporting a conflict. Every active/decrypt-only master key policy still applies; the existing
`agent-controller rekey` now covers Provider and managed MCP rows under one lock.

## Configuration privacy

`env` is public configuration and must never carry credentials, including URLs
with passwords. Use `secret_env` for sensitive values regardless of variable
name. Create/revise and the workload-only bootstrap route are metadata-only in
telemetry, even when RPC content capture is enabled. Only authenticated RC can
call `POST /internal/managed-mcp-secrets/resolve`, pinning organization, Template
and revision. It is not bound to a particular Agent or lifecycle operation:
authenticated RC may resolve any organization's frozen revision, consistent with
its Docker/host-root trust. Console, ACP, UI and Gateway cannot access it. RC resolves values at
startup; its journal and deployment identity contain only descriptors and a
frozen Template source. No master key is sent to RC or Runtime.

The [shared secret contract](../../../contracts/runtime/managed-mcp-secrets.md)
defines dedicated process identities, private read-only bootstrap delivery and
the coordinated pre-release upgrade. Old disposable configurations must be
explicitly re-entered/rebuilt; their plaintext snapshots and backups cannot be
silently made safe by returning a redacted view. Runtime, RC and Console consume
this boundary in their owning implementations; the root managed-MCP acceptance
verifies the complete flow separately.

## Verification

Domain tests cover validation, snapshot isolation and digest changes. Lifecycle
tests cover create/rebuild/enable forwarding; HTTP client tests check the wire
payload. PostgreSQL integration verifies revision round trips. The cross-service
design is described in
[Runtime context and managed MCP](../../../docs/runtime-context-and-managed-mcp.md);
`make e2e-managed-mcp-v1` and `make e2e-managed-mcp-v2` exercise the deployed flow.
