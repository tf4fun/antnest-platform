# Managed MCP Configuration

Admin Console extends the existing Template workflow, not a new MCP registry.
Platform-managed stdio servers belong to the frozen Runtime configuration.
Client MCP injection is disabled: both ACP versions accept only `mcpServers: []`.
This screen configures administrator-managed Runtime stdio servers, not an
exception to the client-injection restriction.

## Browser Workflow

Template create and revision forms contain an optional MCP servers section.
Each entry has a stable server ID, executable, an ordered argument list and
environment name/value pairs. Zero servers is valid. Add/remove controls edit
these structured fields without shell splitting or requiring JSON. Frontend
validation gives field-specific feedback for duplicate IDs/variable names,
reserved environment names and bootstrap limits. Agent Controller remains the
configuration validation authority; Console never launches commands.

Opening a revision starts from the complete immutable configuration. Unchanged
arguments and environment values survive publication; an explicit empty list
removes all managed servers from the new revision. Rejected/pending submissions
retain form contents and cannot be submitted twice. Closing the form discards
its local draft. Arguments and environment values are never put in browser
storage, logs or recovery records. Environment fields are visually masked with
an explicit reveal/edit control; this is not encryption or a secret vault.
Revealed values and arguments use multiline fields. Edits preserve untouched
CRLF/CR line endings despite the browser's textarea LF normalization; added lines
follow the field's existing newline style. Empty arguments/values remain valid.

Template detail and historical revision endpoints allow authorized administrators
to read the process configuration for editing/inspection. Inventory/Overview
omit process configuration. Agent detail exposes only server IDs and executables
from its published configuration, not argument/environment values. The exact
frozen Template revision remains linked for inspection. Revision publication
does not restart existing Agents: the existing explicit rebuild action applies
the selected revision. No new database, command endpoint or Runtime proxy is added.

## Contract And Verification

The BFF accepts `runtime.mcp_servers` on existing create/revise endpoints and
forwards that JSON intact to the owning service, including explicit `[]`.
Unknown server fields and malformed Unicode are rejected by the owner rather
than silently normalized by an intermediate typed decoder. Other request
fields retain the existing strict BFF allowlist. All reads remain administrator-
only, organization-scoped and `no-store`.

Tests cover BFF transport/projection and scope, create/edit/removal, lossless
argument/environment round trips, validation, rejection retry, pending controls,
historical read-only inspection, and Agent deployed summaries. The existing
managed-MCP Docker profile must configure templates through the BFF, then verify
real child execution/rebuild and Gateway-rooted traces. Browser acceptance covers
desktop/mobile form layout and the administrator navigation workflow.
