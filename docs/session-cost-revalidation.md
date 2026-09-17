# Session Cost Deployment Revalidation

Recorded: 2026-09-17 (Asia/Shanghai), candidate `fd0867c` plus the acceptance
migration worktree. This batch changes acceptance fixtures and documentation,
not production service implementations. All **52 model requests**, actual ACP restart/recovery scenarios and **156 Trace
topology/privacy checks** passed. **116 final local tests** passed after retiring
the superseded helpers. Strict Trace remains failed on 86 timing-warning traces;
driver exit 1 / Make exit 2 is preserved. This is scoped business/topology
evidence, not full strict deployment acceptance.

## Contract and retained scenarios

The [cost driver](../scripts/acp-cost/README.md) creates Provider Connections
with synthetic credentials and initial priced/unpriced Models. It reads current
Model details by stable ID and edits prices with the returned `expected_version`.
Templates reference that Model ID; Agent creation uses the actual Template
revision and waits for executable readiness. Member create/edit attempts are
rejected and a rejected edit leaves prices unchanged.

The former Agent-default revision pin is obsolete: current ACP resolves both
`agent_default` and an explicit Model choice against the published catalog at
Run start. Neither choice pins a historical Model price. The fixture waits for
ACP's public configuration fingerprint to change after each catalog mutation.
A request held at the actual Provider then proves the separate execution
snapshot rule: changing prices in flight does not reprice that Run; the next
Run uses the current rates. Replayed usage remains immutable.

| Scenario, repeated on v1 WS, v2 WS and v1 HTTP           | Expected cumulative USD    |
| -------------------------------------------------------- | -------------------------- |
| Unpriced initial Run                                     | Cost absent                |
| Estimated Run                                            | 0.0028                     |
| Provider-reported 0.01, then explicit reported zero      | 0.0128 after each          |
| Cache-read/write subset estimate                         | 0.0154                     |
| Current Agent-default price after edit                   | 0.0210                     |
| Explicit choice made before the next edit                | 0.0322                     |
| Subsequent unpriced Run                                  | 0.0322 retained            |
| Fresh Session: unpriced / free / missing-cache-rate Runs | Absent / 0 / 0.0028        |
| Fork's next priced Run; parent remains unchanged         | Fork 0.0434; parent 0.0322 |
| Held execution edited in flight; next execution          | 0.0028, then 0.0084        |
| Restored parent with its saved unpriced choice           | 0.0322                     |
| Restored fork with its saved priced choice               | 0.0546                     |
| Restored parent after selecting the priced Model         | 0.0434                     |

The fresh unknown/free/cache-fallback checks share a new Session with separate
Runs; the held-execution case uses another Session. All three parent/fresh/fork
histories per transport survive a real ACP container restart. Repeated
load/resume and fork compare complete cumulative usage history and saved Model
choices, with no Provider calls or double counting. An additional authorized
observer preserves its independent USD 0.77 history before and after restart.

Current catalog publication refreshes public configuration on attached
Sessions. The raw-frame observer checks all frames before the SDK can strip
unknown fields, validates official update schemas and rejects private receipts,
measurements and rates. Operation views separate only an already-owned
Session's unchanged configuration refresh; foreign Sessions, messages, usage,
execution states and changed choices still fail. v1's paired mode notification
must match its known mode. SDK set-config responses do not contain complete
mode state, so the fixture preserves the previous verified baseline; forks
inherit their parent's baseline.

The restart wrapper verifies a real container restart and health. The client
then waits for Controller's ordinary configuration republication through the
public Agent-state API, without forcing publication or mutating prices. Only
startup HTTP 503 is retried; authentication and other HTTP failures are fatal.
The recovered configuration fingerprint must equal the pre-restart fingerprint
before any history is loaded.

## Trace contract

Each Session operation retains its actual SDK JSON-RPC request ID. WebSocket
request traces must link to the actual connection and match Agent, Session and
method; HTTP uses the Gateway response Trace ID and actual request metadata.
The 52 executions must map bijectively to 52 ACP Run IDs and 52 Provider HTTP
CLIENT span IDs. Each Run requires fresh Runtime information/catalog preparation,
committed reply persistence, and the actual pg driver finish CTE. No Tools or
Controller admission/finalization calls may occur in execution traces.

The remaining 85 Session requests cover setup, configuration, list,
load/resume/fork and 12 identity denials (nine cross-Agent and three cross-user).
They must not execute a Run, contact Runtime or call a Provider. Rejected
requests must carry the exact expected access error, with no unrelated errors.

Ten initial Model publications and nine edits each have independent management
Trace evidence. Gateway's owning route is `/api/admin/{path...}`; Console and
Controller must expose the exact create/edit route and HTTP 201. Their client
and server ancestry must be intact, with a committed current `model_profiles`
SQL write. Payload capture and credential/content sentinels remain prohibited.
Warnings and negative model-to-finish timing remain strict failures; successful
business/topology checks do not turn them into a passing deployment gate.

## Validation record

| Evidence                 | Final result                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Business                 | Three transports; 52 model requests and 52 distinct Runs; 9 restored histories plus the independent observer; one actual ACP restart                                                 |
| Request Trace            | 137 unique traces: 52 execution and 85 non-execution; 12 exact identity denials                                                                                                      |
| Pricing Trace            | 19 unique commands: 10 initial Model publications and 9 price edits; current committed SQL and complete management ancestry                                                          |
| Strict timing            | Failed: 71 request and 15 pricing traces contain Jaeger warnings; 11,511 warning entries in total; no model-to-finish ordering failure                                               |
| Local gates              | 116 passed, zero failed: cost, multimodal, permissions, commands, Plan, Files, progress, shared model collector, bounded Docker and SDK connection fixtures                          |
| Deployment/static checks | Dedicated Compose isolation and execution publication wiring passed; shell syntax, JavaScript syntax, formatting and whitespace checks passed                                        |
| Cleanup                  | All eight owned projects have zero remaining containers, Runtime resources, volumes or networks; no verification child processes remain; retained 12-container snapshot is unchanged |

The 86 strict failures are retained under the existing
[OBS-ACP-CLOCK](controller-acp-execution-boundary-plan.md#obs-acp-clock)
maintenance deferral. Jaeger's calculated deltas range from +0.882 µs to
+953.895 µs and from −143.942 µs to −2.081232 ms. The recorded warning edges
include an ACP HTTP child starting 698 µs before its Gateway parent and a v1
prompt server ending 63,255 µs after its Gateway client. These are exported
span timing observations, not proof that physical clock synchronization alone
would resolve them. All 52 model-to-finish gaps are nonnegative (minimum
5,970 µs). No clock, timestamp, capture or error allowance was changed to pass
the gate.

The deployment corrections were admitted with failing local tests before their
replacement implementations. Early disposable runs exposed the now-supported
catalog/mode refresh and SDK partial-response contracts, then restart readiness:

| Temporary project suffix | Outcome                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `74816`, `75679`         | Observer required unchanged public configuration and paired v1 mode refresh handling                       |
| `76505`, `77343`         | Multiplexed owned Session refresh and retained mode baseline needed current SDK handling                   |
| `78137`, `78922`         | Health alone was insufficient; wait for configuration republication, permitting only startup HTTP 503      |
| `79675`                  | Coordinator stopped the run to correct Gateway's documented management wildcard route; TERM cleanup passed |
| `81012`                  | All business and topology/privacy checks passed; strict timing failure retained                            |

Every project was independently checked by Compose and Runtime ownership labels
and project names after cleanup. Existing development containers, Runtime,
volumes, rollback images and private backup were not replaced or removed.

## Superseded assets and next batch

After cost became the final migrated consumer and Docker business/topology plus
cleanup checks passed, `scripts/acp-multimodal/evidence.mjs` and its three
admission-era fixture cases were removed. The current multimodal `trace.mjs`
now serves both native input and non-Tool cost execution checks. The old
ancestry-only pricing validator and its one fixture were replaced by
`scripts/acp-cost/trace.mjs` and mutation tests for exact HTTP boundaries,
committed current Model writes, unrelated errors, privacy and strict warnings.
Raw-wire, model, restart and cost business fixtures remain.

The next batch is the base `e2e-stage3a` product flow; real managed-MCP lifecycle
migration remains a separate batch. See the
[asset inventory](acceptance-asset-migration.md). This work does not certify all
remaining historical profiles.

Ignored local evidence is under `.cache/legacy-acceptance-20260917/`:
`cost-docker-8.log`, `cost-result.json`, `cost-summary.json`,
`cost-gates-final.log`, `cost-compose-check.log`, `cost-cleanup.json`, the
retained baseline, and the earlier red-test/deployment logs. No raw credentials,
Provider payloads or database dumps were added to tracked files.
