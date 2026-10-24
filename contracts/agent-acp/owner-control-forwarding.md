# Owner routing for state and control requests

This contract extends the fixed peer boundary in [owner-peer.md](owner-peer.md).
The ACP service batch is in development. State read/watch and settlement are
implemented and have focused two-process acceptance; remote delivery remains
pending. Source operations below define the pending contract and are not exposed
by the peer listener yet. Final two-replica fault/browser acceptance is pending.

| Operation         | Private POST route                           | Original caller    | Original public route                        |
| ----------------- | -------------------------------------------- | ------------------ | -------------------------------------------- |
| `state-read`      | `/internal/acp-peer/control/state-read`      | `agent-ui`         | `/rpc/agent-acp/get-agent-execution-state`   |
| `state-watch`     | `/internal/acp-peer/control/state-watch`     | `agent-ui`         | `/rpc/agent-acp/watch-agent-execution-state` |
| `settlement`      | `/internal/acp-peer/control/settlement`      | `agent-controller` | `/rpc/agent-acp/settle-agent`                |
| `source-inspect`  | `/internal/acp-peer/control/source-inspect`  | `skill-registry`   | `/internal/skill-sources/inspect`            |
| `source-artifact` | `/internal/acp-peer/control/source-artifact` | `skill-registry`   | `/internal/skill-sources/artifact`           |

There is no arbitrary URL or method dispatch. The existing directional member
credentials and optional mTLS authenticate the independent peer listener before
it accepts an operation. Public workload grants remain unchanged. The receiver
derives the original caller from the closed operation/caller pair, then applies
the original route policy. State requests carry the original signed Agent CCT;
the receiver verifies it again and compares its identity with the context.
Settlement and Registry source requests do not acquire a user CCT requirement.

`Antnest-ACP-Forward` carries a bounded canonical base64url strict JSON object.
It contains `operation`, `caller`, `request_id`, `deadline_at`,
`membership_sha256`, the complete `source` and `target` registrations,
`publication`, `body_sha256` and `hop: 1`. `body_sha256` binds the validated,
canonically serialized original operation input; the receiver validates the
body again before comparing it. The operation must match the exact private
route. State and source additionally bind `identity` and the live owner `epoch`;
the Registry actor supplies the source identity. Settlement instead binds
`scope` (`organizationId`, `agentId`) and carries no execution epoch.
Every scope must match the publication and original operation input. Unknown
fields, caller/operation mismatches, foreign registrations, expired admission deadlines,
changed membership/publication, and extra hops are rejected before dispatch.

State and source discovery is read-only and uses the current owner's complete
registration and live lease. The receiver verifies its generation and complete
private publication authority before invoking the existing owning service.
State dispatch retains the admitted owner fence across asynchronous access
checks so that a late request cannot adopt a replacement generation. It returns
the original JSON or SSE, including busy Session identity and the final revoked
state. An admitted watch keeps its original handler, reader and send tasks until
normal EOF or actual cancellation cleanup; publication ACK joins those tasks.
The ten-second state deadline only bounds admission, not idle watch lifetime.
An ingress watch remains cancellable until the owner accepts its SSE response.
Each response write and final flush has the configured state delivery deadline;
a stalled client cancels the stream while retaining its original cleanup join.

Settlement validates the closed operation and minimum revision, then routes by
the fixed Agent assignment to the identified member. It does not require a live
execution lease or recover an Agent at ingress. The owner reuses its existing
closed-operation settlement and protected recovery path. The original operation
deadline and final outcome/status remain authoritative; no early success header
or lease-expiry-only stop proof is introduced. User access revocation does not
cancel this authorized lifecycle cleanup.
Member discovery uses at most ten seconds within the original deadline; the
settlement itself retains that original deadline. The ingress never acquires an
execution lease. The receiver checks its complete registration, fixed assignment
and complete private publication under its actual generation, before and after
asynchronous reads. A protected control response joins the original task and
lease release even after cancellation. Independent late task or cleanup failures
remain failures rather than a successful `not_settled` result. A finite settlement
reply is validated and its original reader is joined before sending success.
An already-expired valid closed operation uses the original local settlement
path and returns `not_settled` without a lease or peer discovery. A forwarded
operation keeps its original business deadline at the owner. Its finite reply
has a separate absolute completion limit of that deadline plus ten seconds, so
the original cleanup and `not_settled` result can finish after business expiry.
This does not extend business work or reset the budget at another hop. Expiry
of the completion limit aborts transport and still joins original cleanup.

Registry inspect splits the validated request by Agent, routes each part to its
owner, and retains original ordering, omission rules and whole-request failure
semantics. All parts share the original 8.5-second budget. Artifact responses
retain ZIP bytes, ETag, artifact/content digests and source sequence. The owner
still holds the original source-read gate and verifies current Runtime and
projection bindings before and after reading. Forwarding neither reconstructs
an artifact from the shared projection nor introduces model calls.

All paths join original request reads, peer fetches, response readers, sends and
cleanup. An abort or closed public socket is not a cleanup receipt. Independent
cleanup failures remain blocking. Source authorization/actor revocation joins
the owning reads; settlement follows its original controller deadline and
shutdown ownership. Trace/Span findings remain auxiliary.
