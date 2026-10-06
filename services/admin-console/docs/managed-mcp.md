# Managed MCP Configuration

This document describes how administrators configure platform-managed stdio
MCP servers as part of a Template in Admin Console.

Admin Console extends the existing Template workflow; it is not an MCP registry.
Platform-managed stdio servers belong to the frozen Runtime configuration.
Client MCP injection is disabled: both ACP versions accept only `mcpServers: []`.
This screen configures administrator-managed Runtime stdio servers, not an
exception to the client-injection restriction.

## Browser Workflow

Template create and revision forms contain an optional MCP servers section.
Each entry has a stable server ID, executable, an ordered argument list and
public environment name/value pairs and separate write-only secrets. Zero servers is valid. Add/remove controls edit
these structured fields without shell splitting or requiring JSON. Frontend
validation gives field-specific feedback for duplicate IDs/variable names,
reserved environment names and bootstrap limits. Agent Controller remains the
configuration validation authority; Console never launches commands.

Opening a revision starts from the complete immutable configuration. Unchanged
arguments and public environment values survive publication. Saved secrets
start as `keep` entries and show only their fingerprints; Replace accepts a new
value, and Remove clears that name from the next revision. New values, including
an explicit empty string, are encrypted by Controller. Read APIs never return
them. An explicit empty list
removes all managed servers from the new revision. Rejected/pending submissions
retain form contents and cannot be submitted twice. Closing the form discards
its local draft. Arguments and environment values are never put in browser
storage, logs or recovery records. Public environment fields are visually masked
with a reveal/edit control; credentials belong in secret fields. Only newly typed
secret values can be revealed locally, never saved ones.
Revealed values and arguments use multiline fields. Edits preserve untouched
CRLF/CR line endings despite the browser's textarea LF normalization; added lines
follow the field's existing newline style. Empty arguments/values remain valid.

Template detail and historical revision endpoints allow authorized administrators
to read the public process configuration and secret set/fingerprint descriptors
for editing/inspection. Inventory/Overview
omit process configuration. Agent detail exposes only server IDs and executables
from its published configuration, not argument/environment values. The exact
frozen Template revision remains linked for inspection. Revision publication
does not restart existing Agents: the existing explicit rebuild action applies
the selected revision. Console has no MCP database, command endpoint or Runtime
proxy.

## Contract And Testing

The BFF accepts `runtime.mcp_servers` on existing create/revise endpoints and
forwards that JSON intact to the owning service, including explicit `[]`.
Unknown server fields and malformed Unicode are rejected by the owner rather
than silently normalized by an intermediate typed decoder. Other request
fields retain the existing strict BFF allowlist. All reads remain administrator-
only, organization-scoped and `no-store`.
The BFF read allowlist drops unexpected secret value/ciphertext fields and rejects
invalid descriptors. See the [shared secret contract](../../../contracts/runtime/managed-mcp-secrets.md).

Tests cover BFF transport/projection and scope, create/edit/removal, lossless
argument/environment round trips, validation, rejection retry, pending controls,
historical read-only inspection, secret set/keep/clear, write-only read boundaries,
and Agent deployed summaries. The managed-MCP
Docker profile configures Templates through the BFF, then verifies real child
execution, rebuild and Gateway-rooted traces. Browser tests cover desktop/mobile
form layout and the administrator navigation workflow.
