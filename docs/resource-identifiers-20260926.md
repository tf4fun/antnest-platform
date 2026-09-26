# Resource identifier unification, 2026-09-26

Status: service batches, Docker business/topology integration and development
deployment passed. Strict Trace retains the reviewed cross-process clock-warning
exception and original exit 2. This work does not close the pending human style
review.

New platform-owned resources follow the
[generation contract](../contracts/resource-identifiers.md):
`<kind>_<32 lowercase hex digits>`. Agent and Session paths now use the same
identifier style, with `agent_` and `session_` distinguishing the resource.
The generated value is stored and returned unchanged; clients treat it as opaque.

## Delivered service batches

- ACP: secure random Session, Run, message, MCP revision, checkpoint and request
  IDs; deterministic message/Tool-attempt IDs for plans and recovery. Session
  forks keep bulk SQL copying, derive new message/checkpoint IDs and update
  payload message references together. Sequence, content and recovery deduplication
  are covered by PostgreSQL tests.
- Identity: bootstrap, directory, local login, OIDC, SCIM and audit records use
  the registered kind. OIDC callback replay, membership references and token
  resolution are covered with real persistence and HTTP boundaries. Secret token
  bytes, password hashing, OIDC state and PKCE generation retain their semantics.
- Controller: creation/rebuild share `agentspec_`; execution revisions use
  `execution_`; lifecycle, Runtime observation and owner revocation events use
  `event_`. Retry namespaces remain separate from resource kind. A golden vector
  verifies that existing Agent ID derivation is unchanged.

Existing primary keys and references are immutable. This change adds no data
migration or ID mapping layer. Runtime revision IDs already conform. External
model response/Tool-call IDs, connection/process tokens, Trace/Span IDs, request
keys, hashes and counters retain their protocol-specific representations.

## Verification

| Scope | Result |
| --- | --- |
| ACP unit | 841 passed |
| ACP protocol/adapter integration | 162 passed |
| ACP PostgreSQL | 249 passed in 33 files |
| Identity PostgreSQL, protocol and race checks | 144 tests and 59 subtests passed; no skips |
| Controller PostgreSQL, Temporal and race checks | 551 tests and 571 subtests passed; no skips |
| Fresh-ID contract and catalog fixture checks | 6 passed; all 78 Stage 3 base fixture checks passed |
| Repository format check | Passed with the pinned Rust 1.96.0 toolchain |
| Repository lint and storage policy | Passed; pinned Rust 1.96.0, no cache asset violations |
| Disposable Docker business integration | Passed: fresh resource IDs, five lifecycle operations, three ACP transports, Provider rotation, workspace preservation and revocation |
| Docker Trace topology | Passed across 34 Traces; strict exit 2 contains only 19 cross-service clock-warning edges, with no same-service warning edges |
| Human acceptance deployment | Three updated services healthy; existing Session and all 125 message rows retain their original IDs/content digest |
| Focused browser check | First `/help` creates a `session_` ID; reply completes, input becomes available and direct-link reload restores the conversation |

The disposable project `antnest-stage3-e2e-93700` passed deployment checks for
11 services. Create, disable, enable, rebuild and delete completed; ACP v1/v2
WebSocket and v1 HTTP checks passed. Deletion left no Runtime container or volume.
The suite and a subsequent scoped check confirm no owned Compose or Runtime
resources remain. Business acceptance uses the previously reviewed clock-only
exception; the strict result has not been relabeled or its checks relaxed.

Development project `antnest-acceptance-20260926` now runs the three producer
images tagged `resource-ids-20260926`. No active Run or lifecycle operation was
present before the graceful update. Existing Agent and Session records were
retained. Browser first-send creation produced
`session_f73ada6db3bdab3d94fa0735e9383eba` under Agent
`agent_6176153c6c2593f2b46e5b081f312093`; `/help` is handled locally without a
model request. The previous `你好` conversation remains in the sidebar.

| Deployed producer | Image SHA-256 |
| --- | --- |
| ACP | `cde2bcf23ab01ce08b162433085c9bb00c848c2be855030f6815c7631288d6b7` |
| Identity | `b2ad9833cb588ac7e6a005cabc0e2031b9bca8ce4a34336898cf66a80435cb30` |
| Controller | `80a63d3f9d48bf8e1a330c47a8cc9444ce1ec2e53d273f4bd319e547f9cfae53` |

The initial Controller run found a fault fixture that still injected the old
`runtime-observation-1` ID. Its collision target now uses the new derivation;
the original whole-transaction rollback assertions remain, and the complete
PostgreSQL/Temporal run subsequently passed. The first root lint invocation used
the host default Rust 1.98 instead of the repository's two pinned 1.96.0 toolchain
files. Verification uses `RUSTUP_TOOLCHAIN=1.96.0`, matching the deployment build.
The initial macOS tar context included AppleDouble `._*.sql` sidecars, which Go
embedded as migrations and PostgreSQL rejected. Image contexts are rebuilt as
USTAR with `COPYFILE_DISABLE=1` and sidecar exclusions; migration SQL is unchanged.

Private logs and cleanup records are under
`artifacts/verification/resource-identifiers/` and
`artifacts/verification/dependencies/resource-ids-*`. Source tests remain in
their owning services or root `tests/`; `.cache` contains no new test assets.
The final image mapping is `images-tested-clean.txt`; `stage3-docker-clean.*`
and `docker-trace-review.json` retain business and strict Trace results.
`human-deploy.*`, `human-images-{before,after}.json`,
`human-session-{before,after}.json` and `human-browser-review.json` record the
deployment and focused browser check. Earlier failed image attempts remain
separate evidence and are not the deployed images.

The [workspace navigation contract](../contracts/agent-ui/workspace-navigation.md)
continues to govern route selection. Visual approval and the subsequent broad
browser/C4 regression remain a separate human acceptance step.
