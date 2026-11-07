# Contract rollout and golden evidence matrix

Issue #48 replaces handwritten contract literals with real producer captures
and established rolling N/N-1 deployment. This matrix records the ten
producer→consumer pairs, the evidence that exercises them, and the deployment
rules. Consumer-first deployment is a rollout rule, separate from the stacked
PR merge order — see the PR list below.

## Producer → consumer evidence

| Producer           | Consumer          | Contract files                                                                                                                          | Consumer test source                                                                  |
| ------------------ | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| agent-controller   | agent-acp-service | `agent-acp/execution-snapshot.{ready,v2,n-1-ready,n-1-preparing,preparing}.json`, `skill-learning/learning-policy.automatic.json` | `services/agent-acp-service/test/contracts/consumer-golden.test.ts`                   |
| agent-controller   | admin-console     | `agent-controller/get-agent.ready`, `list-agents.ready`, `list-events.ready`                                                            | `services/admin-console/internal/server/consumer_golden_test.go`                      |
| runtime-controller | agent-controller  | `runtime/rc-inspection.healthy`, `rc-observations.{current,n-1}`                                                                        | `services/agent-controller/internal/runtimeclient/boundary_golden_test.go`            |
| runtime-controller | antnest-runtime   | `runtime/runtime-spec.{current,n-1}`                                                                                                    | `runtimes/antnest-runtime/src/config_golden_tests.rs`                                 |
| runtime-egress     | agent-controller  | `egress/network.{closed,open}`, `assignment.current`, `policy.{v1,v2}`, `policy-metadata.{v1,v2}`                                       | `services/agent-controller/internal/runtimeclient/boundary_golden_test.go`            |
| identity-service   | edge-gateway      | `identity/list-login-methods.member`, `local-login.member`, `resolve-access-token.member`                                               | `services/edge-gateway/internal/identity/consumer_golden_test.go`                     |
| identity-service   | agent-controller  | `identity/resolve-principal.member`                                                                                                     | `services/agent-controller/internal/runtimeclient/boundary_golden_test.go`            |
| agent-acp-service  | agent-ui          | `agent-acp/workspace-execution.running`, `workspace-intent.running`, `skill-learning/learning-status.blocked`, `learning-changes.empty` | `services/agent-ui/web/server/test/consumer-golden.test.ts`                           |
| agent-acp-service  | admin-console     | `agent-acp/execution-events.{current,n-1,permissions}`                                                                                  | `services/admin-console/internal/server/consumer_golden_test.go`                      |
| antnest-runtime    | agent-acp-service | `runtime/temporary-{install.installed,release.released,operation.disabled}`                                                             | `services/agent-acp-service/test/contracts/runtime-temporary-consumer-golden.test.ts` |

## Versioning policy

- Optional marker (absent = N-1, `schema_version` 1 = current, others
  rejected): execution snapshots, RuntimeSpec, RC runtime observations, and
  ACP execution-audit events at both envelope and row level. The separate
  v2 publication schema REQUIRES `schema_version` 2 and is explicitly
  supported by consumers alongside absent/1.
- Required marker: Agent Controller agent event rows must carry
  `schema_version` 1 or 2; Egress policy revisions carry `schema_version`
  1 or 2 in spec and metadata.
- Response tolerance drops additive unknown members only; every declared
  field's type/enum/required/binding checks stay unchanged. Request decoders,
  keyfiles, and security checks are never relaxed.

## Submitted PRs (exact heads, unit/contract/component CI unreviewed)

| PR          | Head           | Batch                                       |
| ----------- | -------------- | ------------------------------------------- |
| #560        | bc2f3c5b       | Shared golden tooling + contract catalogue  |
| #561        | 3e72d0b5       | Agent Controller producer markers           |
| #562        | 3ef1f7ee       | RuntimeSpec / Runtime Controller producer   |
| #563        | e939583a       | Runtime Egress producer goldens             |
| #564        | e5bcadb8       | Identity handler-based goldens              |
| #565        | 80380ef1       | Agent ACP consumer projection + versioning  |
| #567        | 05ec0496       | Antnest Runtime consumer DTO + goldens      |
| #568        | a2551892       | Edge Gateway identity response decoder      |
| #569        | 0cb810a3       | Admin Console consumer + version admission  |
| #570        | d3abd22a       | Agent UI consumer projection + goldens      |
| #571        | 58e317e6       | Runtime producer temporary-skill goldens    |
| #572        | dea9b3c6       | ACP temporary consumer normalization        |
| #573        | 36c178c5       | Agent Controller consumer goldens + markers |
| fix/issue-48-contract-integration | (this integration batch) | Shared hardening, route parity, integration |

## Deployment order

Upgrade the UI, Console and Gateway response consumers **and the Antnest
Runtime consumer (PR #567)** first — the RuntimeSpec consumer must accept the
marker before Runtime Controller (PR #562) starts emitting it. Then the
tolerant ACP (PR #565) and Agent Controller consumers. Finally enable the
producers: Controller snapshot/event markers, RC RuntimeSpec/observation
markers, ACP audit markers. PR #571 is a serializer-extraction capture only —
it does not add temporary-response wire fields; the ACP temporary consumer's
additive tolerance (PR #572) is the prerequisite for any future additive
Runtime field. Mixed-role binaries keep current emission until their
downstream consumers are ready — dependency cycles are staged by emission,
not by a whole-binary topological order. Each boundary's N-1 stays for at
least one release. The merge stack `#560 → #561 → #562 → #563 → #564 → #565 →
#567 → #568 → #569 → #570 → #571 → #572 → #573 → integration` is a PR chain
separate from rollout order.

Local evidence preserved: Runtime `skill_temporary_http` 10/10; global
golden manifest/schema 3/3; ACP focused 62/62 then expanded 40/40 + tsc
clean; Controller runtimeclient/egressclient/identityclient all ok; Agent UI
11/11 + server tsc clean; integration focused 134/134. Whole-repository
remote CI for the exact heads remains unreviewed; results are supplied by
the USER. No merge/closure or E2E claims are made here.

Final integration recheck: shared contract tooling and contract integration
45/45, contract conventions 164 documents clean, and contract ownership
registered. The earlier 134/134 run also covered the Learning and Workspace
Bridge suites; it is separate from this final focused recheck. Evidence
remains temporary under `artifacts/verification/issue-48/` until remote PR
evidence is confirmed.
