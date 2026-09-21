# Controller Workflow span development synchronization

Recorded: 2026-09-21. Source commit: `d070a7d`. The previously validated
[Workflow span repair](controller-workflow-span-revalidation.md) is deployed to
retained project `antnest-dev-20260915`. Deployment/data checks, retained
lifecycle/browser business checks and scoped Trace topology checks pass. The
same deployed image also passes all 16 isolated Foundation topologies. Strict
Trace failures remain recorded; this is not full strict acceptance. This batch
changes deployment assets, not service code or SDK dependencies.

## Image and development configuration

Agent Controller now runs
`sha256:22565533975260e6e26db3a693509a8ea7bbc3a8ffdc33a7f2f90a5593050b67`,
promoted from `antnest/agent-controller:workflow-span-20260921` to `:local`.
The previous image remains tagged
`antnest/agent-controller:pre-controller-sync-20260921`.

An actual SIGTERM check exposed an existing development configuration mismatch:
`OTEL_METRICS_EXPORTER=otlp` sent metrics to Jaeger, whose `/v1/metrics` returned
404 while `/v1/traces` returned 200. Controller exited 1 with
`error_class=telemetry_shutdown`. The original failed check and private logs
remain recorded. The opt-in
[Controller development overlay](../compose.controller-development.yaml)
sets only this service's metrics exporter to `none`. Traces remain enabled;
no export interval, clock, warning or error classification changed. Two subsequent
normal stops exited zero and the same container restarted healthy.

Use the overlay when synchronizing this Controller against the development
Jaeger destination; omitting it restores the base metrics setting:

```sh
docker compose -p antnest-dev-20260915 \
  -f compose.yaml -f compose.stage3.yaml \
  -f compose.controller-development.yaml \
  --profile stage3 --profile observability \
  up -d --no-deps --no-build --pull never --wait agent-controller
```

Other services retain their existing exporter configuration. This is not a
platform-wide metrics rollout or validation.
Compose configuration comparison proves the overlay changes only Controller's
metrics exporter, and the deployed environment matches that configuration.
All three deployment asset checks pass; YAML formatting, document links and
`git diff --check` also pass.

## Cold development recovery and data retention

Before this work, eleven platform containers were stopped and the retained
Runtime was restarting. Original container identities, mounts and networks were
saved privately. PostgreSQL was started first; four custom-format database
backups were created and their archive listings verified before application
startup. All original platform containers were then started in dependency order.
Three fresh service database backups and full-row ACP digests were taken before
Controller replacement. Backups and raw deployment inspection are private.

The Runtime recovered health after its dependencies started, but its process
identity had changed during the outage. Controller correctly reported
`runtime_execution_changed`, leaving ACP offline. This predates deployment of
the new Controller. The documented
[Runtime availability contract](../services/agent-controller/docs/runtime-availability.md)
requires explicit lifecycle recovery for this state.

The original Agent was recovered using normal Rebuild with its existing Template
revision. Its workspace was archived first. The replacement Runtime kept the
same workspace volume and all file hashes; Agent configuration is unchanged.
Runtime/execution revisions changed as expected. The recovery Rebuild's complete
topology passed, with one expected Docker 404 and zero probe ERROR spans; timing
warnings still fail strict Trace. No SQL repair or database restore was used.

Immediately after deployment and after recovery, all original 20 Sessions,
40 Runs, 509 message rows and 26 Tool attempts retained their full-row digests.
Ten other platform containers kept their exact IDs and images. The original
Runtime's replacement is the explicit recovery described above, not an
unreported deployment side effect.

## Regression evidence

The retained development lifecycle profile passes Create, Disable, Enable,
Rebuild and Delete on a temporary Agent. Workspace bytes survive Disable/Enable
and physical Rebuild; Delete removes its Runtime and workspace. Three independent
publication traces contain the actual source SELECT, ACP HTTP exchange and
acknowledgement UPDATE. All five lifecycle topologies pass, including four
expected Docker absence probes with zero probe ERROR spans.

The first private deployment driver selected a lifecycle-owned publication while
asserting independent root publication. Its failure remains recorded. The query
now selects actual roots before applying the unchanged source/HTTP/SQL checks.
The subsequent complete lifecycle run passed.

After the final Controller idle restart, the recovered Agent remained ready and
idle with unchanged Runtime/execution revision and configuration digest.

The real browser profile passes all eight business checks against the retained
Agent and configured DeepSeek model: login, Console chat link, greeting, actual
tools, history restoration without prompt resubmission, another Tool after
reload, mobile layout and explicit Agent selection. Browser errors are zero;
desktop/mobile screenshots were inspected. Three Runs finish `completed` /
`end_turn`, and three durable Tool attempts finish settled. One model-generated
Tool input failed local schema validation before a durable attempt or Runtime
call; its visible rejection remains and the model corrected the arguments.
The dedicated acceptance file's final bytes match the new marker.

All three chat topologies pass with zero ERROR spans or missing parents. Two
pass strict validation; the read-after-reload trace retains timing warnings,
so the browser profile exits 1 at `chat_trace`. Across retained development,
12 scoped topologies pass: recovery Rebuild, five temporary lifecycle operations,
three independent publications and three chats. Six lifecycle traces and one
chat trace retain strict timing failures. All three publications pass strict
validation. No raw trace was changed.

The activity-in-progress scenario was run in a separate disposable project,
`antnest-lifecycle-58da8d45`, using the exact deployed Controller image through
the promoted local tag. It did not interrupt an active Run on the retained Agent.
It passes nine lifecycle operations, two completed real Tool Runs, two busy
rejections, exact command/history replay, workspace retention/deletion and
all 16 topologies (nine lifecycle plus seven Session traces). The held Run keeps
its physical process and effects across an observed exit-zero Controller restart,
then completes after release; the same Session loads and executes against the
replacement Runtime. Both actual Workflow parents are exported, with zero
missing-parent edges. Eight Docker 404 probes are expected absence, with zero
probe ERROR spans.

That runner exits 2 with `business_and_topology_passed`: eleven strict failures
remain, including ten traces with timing warnings, three canceled-drain error
spans and four busy-rejection error spans. These counts overlap by trace. The
original candidate's ten strict failures and this run's eleven are distinct
observations, not a change in the acceptance rule.

Final full-row comparison preserves all original ACP records. The new browser
Session brings totals to 21 Sessions, 43 Runs, 580 messages and 29 Tool attempts,
with zero active Runs. The recovered Agent remains ready/idle with its binding
unchanged across Controller restart and subsequent regression. The temporary
Agent and disposable Foundation project have no owned containers, networks or
volumes. Verification/browser children are gone. All 12 intended development
containers are running, with all 11 configured health checks passing; Jaeger
has no container health check.

## Evidence and remaining scope

Private backups, original failure logs, raw traces and deployment drivers are in
`.cache/controller-sync-20260921/`. These ignored artifacts must not be published
and are not guaranteed in a fresh clone. The earlier implementation and
integration report retains its original candidate-only scope.

Lifecycle network/packet-flow and the other historical acceptance consumers
remain separate migration batches. Old shared assets remain until migration and
combined stability evidence are complete. The accepted clock investigation
remains deferred; strict warning/error failures are not converted into passes.
