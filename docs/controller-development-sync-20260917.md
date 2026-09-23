# Controller Development Deployment And Regression

Recorded: 2026-09-17. Source baseline: `234c12a`, including Agent Controller
fix `79559db` and Runtime Controller fix `428f666`. Both verified Controller
images are now deployed to retained project `antnest-dev-20260915`. Deployment,
data retention, five lifecycle flows, eight browser business checks and eleven
scoped Trace topology/privacy checks passed. Strict Trace still fails on the
recorded timing warnings; this is not full strict acceptance.

## Deployed images and recovery assets

| Service | Deployed image ID | Verified change |
| --- | --- | --- |
| Agent Controller | `sha256:e7d6da966ebd4e3af1520c41f1612469556b8ccfc0e5e313217c4a67bdb6b69d` | Recording publication attempt owns source SQL, ACP HTTP and acknowledgement SQL |
| Runtime Controller | `sha256:d994b5e92363cb630ae9b6bc3d64bc8deee64fc93bfd26cf257e54d10f6b1c3d` | Initial Docker existence-probe 404 is expected absence |

These are the previously validated independent candidates. Agent Controller's
[service and RPC integration gates](controller-publication-trace-revalidation.md)
and Runtime Controller's [service and isolated integration gates](trace-acceptance-followup.md)
remain their implementation evidence. This deployment batch changes no service
code or dependencies and does not rerun the complete service suites.

Before replacement, the original Agent was ready and idle, with no admitting or
running Runs. Compose environment values matched both running services exactly.
Fresh custom-format backups of the Controller, Runtime Controller and ACP
databases were created and their archive listings checked. Backups have mode
0600 in the ignored evidence directory. Old running images remain tagged:

- `antnest/agent-controller:pre-controller-sync-20260917`
- `antnest/runtime-controller:pre-controller-sync-20260917`

The tested images were promoted to their service `:local` tags. Runtime
Controller and Agent Controller were replaced serially using the original
Compose files with `--no-deps --no-build --pull never --wait`. Both became
healthy. The other ten containers retained their exact IDs and images, including
the original Agent's Runtime. All twelve containers remain running, with eleven
configured health checks passing; Jaeger has no container health check.
All mount identities, destinations, read/write flags and network memberships
remain unchanged. No database restore was performed.

## Retained data and lifecycle regression

The 19 original Sessions, 37 Runs, 449 message rows and 23 Tool attempts retain
their full-row digests immediately after deployment and after all regression.
The original Agent's Runtime revision, execution revision and configuration
digest remain unchanged; it finishes ready and idle. Its acceptance file kept
its original checksum across deployment. The browser regression subsequently
rewrote that dedicated file, whose final bytes exactly match the new marker.

A temporary Agent, `agent_d12cef926c4f3d0ada5b19aace622893`, used the original
Agent's existing Template revision. Create, Disable, Enable, Rebuild and Delete
all completed. A synthetic workspace file survived Disable/Enable and a physical
Rebuild with a different container ID and Runtime revision but the same workspace
volume. Delete removed the temporary Runtime, workspace and associated network
resources. The deleted Agent and lifecycle audit records remain as normal history.
The retained Agent was not rebuilt or disabled.

All five lifecycle topology/privacy checks passed. Four Docker existence probes
returned HTTP 404 with `antnest.outcome=absent`, unset status, no error event and
subsequent successful allocation evidence. There are zero lifecycle ERROR spans.
All five strict results remain failed on Jaeger timing warnings, with distinct
calculated deltas ranging from 144.264 to 847.607 microseconds.

Three periodic publication traces independently passed strict validation. Each
has its own root recording attempt, one current source SELECT, one successful
ACP HTTP exchange and one acknowledgement UPDATE directly owned by the attempt.
The applied revision is 27 in all three; no SQL evidence gaps, errors or warnings
were found. Their Trace IDs are `a3acdbc18429ed3d94effd98c50bcf76`,
`0aab89c32c2bebbc4a11d68f1a338fed` and `fc85cbef86778fed7dfafc6a26bb97c1`.

## Real browser and chat regression

The existing development-browser profile ran against the original Agent and its
configured real DeepSeek model. All eight business checks passed: browser login,
the Console link to the same Agent, real greeting, actual tools with collapsed
activity, history restoration without prompt resubmission, another Tool after
reload, mobile layout and explicit Agent selection. Browser errors were zero;
desktop and mobile screenshots were inspected.

Session `4673a4ce-4f1c-43ee-b71f-df77aa9da395` retains three completed/end-turn
Runs, eight model HTTP requests and three successful Runtime calls: one write
and two reads. Two earlier model-generated Tool arguments failed local schema
validation; their visible failure records remain, with no durable Tool attempts
or Runtime calls for those rejected inputs. The model corrected its arguments
and completed the task. The UI's two failed entries are not Runtime failures.

All three chat traces passed topology/privacy inspection with no ERROR spans,
error events or missing parents. Two passed strict validation. The read-after-
reload trace `6cc6063fb23631a686ef6384d47463c4` retains a 258.443-microsecond
Jaeger timing warning, so the browser profile exits 1 at `chat_trace`. The strict
failure remains visible under the existing
[OBS-ACP-CLOCK decision](controller-acp-execution-boundary-plan.md#obs-acp-clock).
No timestamp rewriting, warning exemption or SDK export change was introduced.

Final ACP totals are 20 Sessions, 40 Runs, 509 messages and 26 Tool attempts,
with zero active Runs. Temporary verification processes and browser children
have exited. The intended twelve development containers remain available.

## Evidence and remaining scope

Private backups, row digests, container and Agent snapshots, local verification
drivers, raw traces, browser reports/screenshots and final cleanup checks are in
`artifacts/verification/controller-sync-20260917/`. Earlier browser evidence was archived before
the profile ran. Ignored artifacts are not guaranteed in a fresh clone and must
not be published with the report.

This completes the two Controller deployment synchronization and scoped
regression task. Identity/access and the other pending acceptance migrations
remain in the [asset inventory](acceptance-asset-migration.md). Combined wider
regression and remaining shared-asset retirement still follow those migrations.
F07 and the accepted timing investigation remain deferred.
