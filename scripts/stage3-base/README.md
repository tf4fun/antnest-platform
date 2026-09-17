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

The historical retained-stack, Identity/OIDC, Managed MCP and fault-injection
branches remain in `e2e-stage3a.sh` for their separate migration batches.
This driver verifies Workspace HTML/bootstrap and protocol behavior, not a new
browser interaction acceptance. See C4 for the separate browser evidence.

Raw lifecycle diagnostics, when collected, stay in the ignored private
`.cache/stage3-base/<project>/stage3-traces/` directory. Only aggregate business,
topology, warning and cleanup evidence is printed.
