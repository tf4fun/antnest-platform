# Current Stage 3 base acceptance

This integration fixture owns no production service changes. Its contract is:

- Console creates a Provider connection, then stable Models and Templates.
  Credentials rotate on the Provider; Model edits require `expected_version`
  and preserve the API model name. Template history and an Agent's build
  snapshot remain immutable until Rebuild.
- Model write parameters exclude the Provider endpoint present in Model reads.
  Template publication rejects malformed image references, but preserves valid
  tags without resolving local image availability. The executing fixture uses
  the configured immutable image; a second unexecuted Template proves valid
  missing-tag preservation. Runtime image-resolution failures remain part of
  the later lifecycle fault batch.
- Fresh resource IDs at Gateway/ACP boundaries follow the
  [platform generation contract](../../../contracts/resource-identifiers.md):
  Identity, catalog, Agent, lifecycle events, Runtime revisions and Sessions.
  Catalog retries retain IDs and history/rebuild retain Session references;
  external model response and Tool-call identifiers remain protocol-owned.
- Password/directory/SCIM administration, idempotent catalog creation,
  pagination, image rejection, scoped Agent lookup and events remain covered.
- Create, Disable, Enable, Rebuild and Delete complete through Temporal and
  current Runtime operations. Drain requires published execution configuration
  and ACP settlement before Runtime mutation.
- Official SDK v1 WebSocket, v2 WebSocket and v1 HTTP exercise real Bash effects
  and exact history recovery without model re-execution. Rebuild preserves the
  workspace. Logout rejects new work on both WebSocket versions.
- Trace collection uses actual Gateway lifecycle response IDs and actual SDK
  message IDs, with RPC content capture disabled. Warnings fail the strict
  gate even when business, topology and privacy checks pass. Docker absence
  probes must have the exact owner, command ancestry and subsequent successful
  allocation/start or storage verification to permit topology diagnosis; their
  ERROR spans still fail the strict gate. Other errors fail immediately.

`make test-stage3-base-fixtures` runs local gates. `make e2e-stage3-local`
uses already built local images; `make e2e-stage3` builds first. Both default
to an isolated, bounded, disposable project. Existing development containers,
volumes, credentials and ports are outside its ownership.

Identity/OIDC, Managed MCP and fault profiles now dispatch to their separate
migrated launchers. Their old inline copies are superseded. The explicit
`ANTNEST_E2E_KEEP_STACK=true` flag is now [retired](../../../docs/retained-seed-retirement.md)
and rejects before any dependency is invoked. Unset, empty or `false` keeps
current disposable behavior. The [old inline tail](../../../docs/stage3-tail-retirement.md)
and its exclusive CLI/input helpers are now removed. The subsequent
[interruption retirement](../../../docs/interruption-assets-retirement.md) removes
the historical startup-gate/Trace graph; shared current helpers remain.
This driver verifies Workspace HTML/bootstrap and protocol behavior, not a new
browser interaction acceptance. See C4 for the separate browser evidence.

Raw lifecycle diagnostics, when collected, stay in the ignored private
`artifacts/verification/stage3-base/<project>/stage3-traces/` directory. Only aggregate business,
topology, warning and cleanup evidence is printed.
