# Workspace document navigation

This document defines the browser document paths for the Workspace and how
Agent UI, Admin Console and Edge Gateway parse, produce and forward them.
Document selection uses paths only; there are no query-based document routes.
The HTTP/SSE business API is unaffected.

| Document | Path |
| --- | --- |
| Workspace directory | `/workspace/` |
| Agent workspace / local conversation draft | `/workspace/{agentId}/` |
| Existing ACP Session | `/workspace/{agentId}/sessions/{sessionId}` |

Identifiers are opaque UTF-8 values encoded once as individual URL path segments.
Decode only after matching the segment structure. Each ID must be nonempty,
at most 200 UTF-8 bytes, without surrounding whitespace or ASCII control bytes,
and must not be `.` or `..`. Encoded separators stay inside the identifier.
The Agent segment `assets` is reserved for `/workspace/assets/*`.
Selection uses the pathname only, without query parameters. Login return paths
also reject fragments; local accessibility anchors do not change selection.
Unknown shapes are not valid document or login-return destinations. Paths grant
no access.

Agent UI's browser and SSR share one parser. Opening a workspace selects its
local draft; first send creates a Session and navigates to its Session path.
Refresh and Back/Forward restore the same Agent and Session without resubmission.
SSR never creates a Session. Assets keep absolute `/workspace/assets/*` URLs.
Document telemetry uses route templates, never concrete Agent/Session IDs.

Gateway authenticates every document route, preserves its escaped path when
proxying, and retains a validated path through login. Console produces the same
Agent path for Open chat and independently validates login return destinations.
Malformed, external, query-bearing or unknown return destinations fall back to
the existing safe landing page. Existing HTTP/SSE API query parameters are
unaffected.

## Testing

Agent UI, Admin Console and Edge Gateway each test their own parsing and
production of these paths. Production SSR/HTTP integration covers direct load
and reload; the navigation browser test covers Back/Forward, draft retention
and the absence of Session or Prompt writes during navigation.
