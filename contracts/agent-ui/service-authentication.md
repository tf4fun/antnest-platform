# Agent UI service authentication

Agent UI implements the [shared service-authentication contract](../platform/service-authentication.md)
and the [caller catalog](callers.json). Only Edge Gateway may call its Workspace
document, asset and API routes. `GET /live` and `GET /status` are minimal health
exceptions. Assets require workload authentication; documents and API routes
also require one valid Identity-issued CCT with audience `agent-ui`. Agent API
paths must match its signed `agt`. HTML and bootstrap use organization-scoped
CCT for discovery, even when the document selects an Agent. SSR never connects
ACP. Unknown routes do not reach the runtime.

Node derives user, organization and administrator status exclusively from the
verified CCT, never from `X-Antnest-*` authority hints. Gateway's canonical
Base64URL UTF-8 organization slug/name remain presentation fields for bootstrap
and SSR, accepted only after Gateway workload authentication. SSR explicitly
carries the private verified context into its bootstrap request. Cloning raw
headers does not create authority. Neither CCT nor workload credentials appear
in browser projections, history/configuration conditions or telemetry.

Bridge and Controller discovery use their own workload credentials and forward
the received CCT unchanged. Configured dependency origins are distinct and
pinned; TLS and token rotation follow the shared contract. No browser cookie or
`Authorization` credential goes to those dependencies. A Bridge owner is scoped
to user, organization and Agent. A later ordinary authenticated HTTP request in
that same scope can supply a newer CCT for subsequent upstream requests. This
does not mint or renew a token, reconnect an accepted Run, or define the deferred
long-lived renewal protocol in #58. Expired context rejects new requests; already
accepted model work and established notification delivery are not cancelled.

POST bodies are bounded UTF-8 JSON objects. Unsupported media/encoding is `415`,
malformed JSON or decoded duplicate members are `400`, and oversize bodies are
`413`, before business dispatch. Workload errors are `401 service_unauthenticated`
(Bearer challenge) or `403 caller_not_allowed`. Invalid CCT is
`401 caller_context_invalid`; unavailable authenticated Identity key discovery is
`503 identity_dependency_unavailable`. Existing browser-safe error envelopes and
read recovery semantics remain in use.

The service gate is separate from cross-service admission. Controller consumer
and deployment credential/network batches passed, followed by the complete
token-profile business/security Docker gate recorded in the
[rollout ledger](../platform/service-authentication-rollout.json).
