# Workspace document navigation

Status: implemented and deployed to the human acceptance preview on 2026-09-26.
Focused route checks pass; broad visual regression and C4 remain pending user
style approval. This replaces query-based document selection in development;
no legacy query-route compatibility is required. The HTTP/SSE business API
remains unchanged.

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

Delivery order (one service implementation at a time):

1. Agent UI: shared parser, browser navigation, SSR, local unit/component gates.
2. Console: Open chat and login return, local unit/component gates.
3. Gateway: validated login return and escaped-path forwarding, local Go gates.
4. Integration: direct load, refresh, login return and Back/Forward across the
   deployed services. Broad visual regression remains gated by the user's style
   approval; a preview is not a completed acceptance claim.

All three service batches have passed their focused local checks. Production
SSR/HTTP integration covers direct load and reload; the navigation browser case
covers Back/Forward, draft retention and zero Session/Prompt writes. The deployed
preview was checked for Console links, unauthenticated login redirect and the
existing conversation's direct load, reload and browser history.
