# Skill learning E2E failure evidence

`automatic-flow.test.mjs` preserves failed client evidence under
`artifacts/verification/skill-learning/`, before deployment cleanup. Files are
private (`0600`) in a private directory (`0700`).

The original View request records its HTTP status, allowlisted response code,
returned Trace ID, Agent/Session and request interval before status admission.
Response bodies, headers, cookies and free-form exception text are excluded
from this receipt. Each client mode retains its first successful View receipt;
the host keeps earlier successful client output when a later mode fails.

On failure the host independently attempts the existing client/model/task
archive, Agent UI and Gateway logs, and three bounded Jaeger samples. Samples
keep the failed GET, prior successful View and private ACP connection as
distinct sources. The original business request is never resent by this
diagnostic path, and collection errors cannot replace the original failure.

The real propagation browser pass also observes its original scoped GET View
responses without reading bodies or sending requests. It keeps response counts
and at most the first, first failed and last receipts. On failure it detaches
the observer before independently saving the original failure, screenshot and
Trace samples under the existing `preset-<phase>-` artifact prefix. Missing
Trace headers and observer failures remain explicit diagnostic gaps; business
timeouts and assertions are unchanged.

`agent_ui.acp.close` is an independent root without an Agent scope attribute.
Its service/operation search results are saved as **unattributed candidates**.
Attribution requires review of the exact initialization Link, source request
scope and UI process in the original traces. Missing traces, query failures and
empty searches remain explicit gaps. These artifacts are diagnostic evidence,
not business, topology or cleanup acceptance.
