# Current recovery helper separation

Date: 2026-09-21. Follows [Stage 3 inline-tail cleanup](stage3-tail-retirement.md).

## Boundary

Current `update-receipt-flow.mjs` and `loss-flow.mjs` now import
`scripts/lifecycle-closeout/recovery-support.mjs`. Bounded polling, Compose-owned
service inspection and the ten fixed service-owned journal queries move without
semantic changes. Current Runtime inspection preserves ownership filters, exact
image/workspace checks and execution identity, generation, digest, health,
start time and restart evidence. It no longer executes a shell inside Runtime
to read the historical `.c3-update-entered` marker or returns `entered`.

`interruption-support.mjs` retains only the historical Compose/image helpers and
startup-gate physical inspection, and reexports the shared polling/service/journal
functions. Its source-container exclusion and nonce checks remain unchanged;
existing historical fixture tests still run, but no historical SIGKILL Docker
scenario is added to stable acceptance. The small historical physical inspector
is deliberately retained separately to avoid exposing gate options in the
current helper API. SQL fields, role boundaries and current consumer assertions
are unchanged. No service implementation, deployment timeout or exporter setting
changes. No historical fault implementation, image or evidence is deleted.

## Verification

The first fixture attempt used an
invalid Compose project and was corrected. The corrected red run has 19 passes
and one failure: current Runtime inspection still invokes the historical marker
command. After extraction, 20 current helper checks and 37 historical fixture
checks pass. The new checks cover scoped inventory, image/workspace rejection,
service ownership, each journal's database role, unsafe SQL inputs and bounded
polling cancellation/deadline behavior. The full shared suite passes 1,245 checks,
with five existing gated skips and no failures/cancellations (1,250 total).
Existing HTTP, WebSocket and real Chromium components remain included.

Source comparison confirms polling, service inspection and all journal queries
are byte-identical to the previous implementation, as is the retained historical
physical inspector. Relative-import traversal finds no historical interruption
graph in the current Update/loss consumer graphs (seven and 32 modules).

Normal-restart project `antnest-lifecycle-1cc5ccfb` passes committed-response loss,
normal zero-exit Controller stops, exact terminal child/target reuse, Template
revision 2 publication, original workspace preservation and final public deletion.
All three topologies pass with zero missing parents. All three strict results
remain failed: timing warnings and two Agent Controller error spans (canceled
Runtime HTTP request and its Activity) are preserved. This is passing scoped
business/topology evidence, not a strict acceptance pass.

Runtime-loss project `antnest-lifecycle-3f80e25f` passes both live/cold cases:
four completed Runs, two denied Prompts, eight model requests, zero extra model
calls on history replay, exact workspace bytes, preserved execution audits and
stable replacement/history across Controller restart. All twenty topologies pass
with zero missing parents. Fifteen strict results remain failed, including timing
warnings and four ACP Prompt error spans from the two unavailable-runtime
rejections. Both scenarios delete their Agents before teardown.

Together the two runs have 23 passing topologies, zero missing parents and
18 strict failures; six error spans remain recorded. Both Make invocations
return exit 2, so the strict Docker admission gate remains unsatisfied. The
source separation and business/topology regression are verified; this report
does not mark full acceptance complete or waive those failures.

Independent cleanup finds zero owned containers, volumes or networks for both
projects, and no verification/browser child processes. All twelve retained
containers preserve IDs, images, mounts, networks, start times and restart counts;
twelve run and eleven configured health checks remain healthy. No production
image is rebuilt or deployed. Formatting, local documentation links, relative
imports and `git diff --check` pass. Prior uncommitted changes are preserved.

Private source hashes, logs and a fresh twelve-container development baseline are
under `.cache/recovery-support-split-20260921/` with private file permissions.
Historical unfinished-mutation crash recovery remains separate from normal
committed-response recovery. The follow-up
[retires the historical startup gate/Compose/image/Trace graph](interruption-assets-retirement.md)
after auditing references and recording its separate fault scope. Shared
observability helpers retain current consumers and are preserved.
