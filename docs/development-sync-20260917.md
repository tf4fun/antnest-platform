# Development Deployment Synchronization And Regression

Recorded: 2026-09-17. Source baseline: `ec12041`. The retained development
project `antnest-dev-20260915` now runs the verified ACP SDK/metadata/AJV fixes
and Agent UI capability-error fix. Deployment, retained-data checks and ten
browser/business checks passed. The strict development-browser script still
exited 1 on recorded Jaeger timing warnings; this is not a full strict pass.

## Deployed Candidate

| Service | Deployed image ID | Scope |
| --- | --- | --- |
| ACP | `sha256:e3aa69201e82455db532a47bb6417eadb344260d4119a237c5e9f35818273c9f` | Promoted the tested `ajv-fixed` image to `local`; confirmed installed AJV 8.20.0 |
| Agent UI | `sha256:199d86414a5ca54ac13deb4fd6dad70c66cf1b5ffb189f6701e5e3e99484a6f1` | Promoted the existing C4/combined-integration candidate into the running deployment |
| Runtime | `sha256:2ed4ffe11b2f7ce24de4bcfb07566e7de012637400c7a82d3703fdc53ab1b909` | Already current; container and generation 3 retained |

The preceding [ACP dependency batch](../services/agent-acp-service/docs/ajv-remediation.md)
passed 961 unit/component, 245 PostgreSQL, nine SDK audit tests and four
production-image Docker scenarios. The UI image passed the earlier
[combined C4 integration](acp-platform-integration.md). Those are the images'
prior service/integration gates, not fresh reruns in this deployment batch.
No service implementation or dependency changed here.

Before deployment, the Agent was ready and idle with zero admitting/running
Runs. Compose environment values for the two replacement services matched
their existing containers. ACP and UI were replaced serially with the original
Compose files, `--no-deps --no-build --pull never --wait`; no other container
was recreated. All 11 configured health checks passed; Jaeger has no container
health check. The Agent's Runtime revision, execution revision and execution
configuration digest remained unchanged, and it was ready and idle afterward.

## Retained Data And Recovery Assets

ACP database migration `0008_refused_context.sql` was applied at startup.
Before replacement, a local custom-format PostgreSQL backup was created and
its archive listing checked. It is stored with mode 0600 in the ignored
deployment evidence directory; it must not be published with the report.
Old running images remain tagged:

- `antnest/agent-acp-service:pre-sync-20260917`
- `antnest/agent-ui:pre-sync-20260917`

The 17 preexisting Sessions, 32 Runs and 381 message records had unchanged
ordered row digests immediately after deployment and after the regression.
For messages, the digest covers the original transcript columns rather than
the newly added context-eligibility column. All volume identities, destinations
and read/write flags remained unchanged. The synthetic acceptance file retained
its predeployment checksum until the browser regression deliberately rewrote it.
Its final content matches the new acceptance marker exactly.

The regression retains two new acceptance Sessions: one with four successful
Runs and one with the expected unsupported-audio failure. A database restore
would lose these and any later changes; retained backup availability is not
authorization for an automatic restore.

## Browser And Business Evidence

The existing profile ran against the retained Agent and real configured
DeepSeek model:

```sh
node tests/e2e/workspace-closeout/development-browser.mjs \
  --confirm-development --agent agent_13f29da090d9a459c2d6f02576f74705
```

All eight business checks passed: browser login, Console's matching Agent chat
link, real greeting, Runtime tools with collapsed activity, history reload
without prompt replay, another real Tool after reload, mobile layout without
horizontal overflow, and explicit Agent selection. Browser errors were zero.
The script's final result was **failed at `chat_trace`, exit 1**, as detailed below.

Two subsequent deployed-browser checks also passed:

- Two actual pages observed Session `7f1107ec-d6f0-4427-9f9f-44cc5c0762f7`.
  After another real prompt, both received and displayed title `你好` and the
  same activity timestamp, advancing from `2026-09-17T02:37:06.693Z` to
  `2026-09-17T02:40:05.770Z`. A fresh list, load notification and visible
  timestamp matched exactly after reload. History matched and reload sent no
  new prompt. The database contains exactly four completed/end-turn Runs for
  this Session.
- A synthetic WAV on a model without audio support returned
  `model_unsupported_content` and displayed the actionable model/attachment
  message. The composer became usable again. The rejected Session retains a
  failed Run and its user message, with `executor_state=quiescent` and
  `tool_effect_state=none`. Its Trace proves zero model HTTP requests and zero
  Runtime Tool calls; no Tool attempt was stored. A preliminary read-only
  postcheck incorrectly expected no retained Run and was corrected to this
  existing audit contract, without changing production behavior.

The four successful Runs produced ten model HTTP requests and four actual
Runtime Tool calls. Desktop metadata, the attachment error and mobile chat
screenshots were inspected. Temporary browser processes exited; the intended
development services and acceptance data remain available.

## Trace Evidence And Timing Boundary

All four successful-chat traces passed the existing topology/privacy inspector:
Gateway SERVER/CLIENT to ACP SERVER/Run/model and Runtime ancestry, no detached
or duplicated parents, no management calls beneath a Run, no error spans or
error events, no RPC content capture and no configured credential values.

| Prompt | Trace ID | Spans | Runtime Tool calls | Strict result |
| --- | --- | ---: | ---: | --- |
| Greeting | `135274b110138beb40635b2357f36dd9` | 144 | 0 | Passed |
| Write/read | `98bb59d94a23e5a3a8df7d544ea2cc6a` | 647 | 3 | Passed |
| Read after reload | `a75ab241877a1aa3602ae2f1d85f442d` | 220 | 1 | Failed: timing warnings |
| Metadata update | `87104ff9e51160a3ef57683acfa87239` | 143 | 0 | Passed |

The failed trace has two distinct `clock skew adjustment disabled` messages,
with calculated deltas **206.287 µs** and **-2.160485 ms**. The final retained
query contains 603 repeated warning entries; these are not separate incidents.
The original timestamps show:

- The ACP prompt server starts 206 µs before its Gateway client parent, with
  a millisecond-aligned ACP timestamp.
- During Runtime information `resources/read`, the ACP HTTP client records
  HTTP 200, 425 response bytes and an `AbortError` cancellation event. The
  Runtime child records the same 425 bytes, protocol/transport success and
  HTTP 200, ending 1,344 µs after the client. The containing Run completes
  normally. This is a transport-lifetime observation, not a cancelled Run or
  proof of host-clock drift. The adapter closes each SDK connection after the
  resource operation; the exact timing cause was not independently forced here.

The separate expected-rejection trace is
`83ea23a3b854a8376bd97a6f8c100001`. Its structure and disabled-capture check
passed, with the expected `model_unsupported_content` failure preserved; it is
not counted as a successful-chat trace.

The existing [OBS-ACP-CLOCK decision](controller-acp-execution-boundary-plan.md#obs-acp-clock)
continues to govern timing investigation. No warning filter, duration exemption,
timestamp rewriting or clock setting was introduced. The failed strict result
and original cancellation event remain visible. This deployment does not close
F07, client MCP injection, automatic recovery after unknown Tool effects, or
the remaining historical acceptance profiles.

## Local Artifacts

Evidence is under `artifacts/verification/development-sync-20260917/`: sanitized container and
Agent snapshots, database digests, private backup, archived previous browser
evidence, current browser report/screenshots, additional metadata/error probes,
unmodified traces, timing review and final business checks. The extra deployed
probes are local recorded checks, not newly supported acceptance entry points;
their reusable scenario reference is the existing C4 browser profile.
Ignored artifacts are not guaranteed in a fresh clone. Old acceptance assets
were not migrated or retired in this batch.
