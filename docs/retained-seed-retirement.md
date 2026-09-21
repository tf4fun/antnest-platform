# Retained Stage 3 seed entry retirement

Date: 2026-09-21. The [retirement audit](acceptance-retirement-audit.md) found that
`ANTNEST_E2E_KEEP_STACK=true` still reached obsolete Model-owned credential writes
and Model-revision Template references. Current disposable profiles and browser
drivers have separate migrated entry points. This batch retires the unsupported
retained seed mode rather than adding a new persistent deployment workflow.

## Entry contract

- Unset, empty or exactly `false` retains existing disposable behavior.
- Exactly `true` exits 1 with a retirement message and the current
  `make e2e-stage3-local` / `make e2e-workspace-browser` alternatives.
- Other values exit 1 with a validation message. Rejection does not echo the
  supplied value, which may contain unintended private input.
- Validation occurs before repository setup, Node/network discovery, Docker,
  temporary directories, credentials or service calls. It also precedes profile
  selection, so combining the retired flag with another profile cannot start it.
- Existing retained development resources are not inspected or deleted by this
  rejection. Current profile selection, ownership and cleanup remain unchanged.

Only the shell entry's flag validation changes. The obsolete inline tail and
its cleanup/helper branches become unreachable through supported entry arguments;
their physical removal is a separate bounded cleanup. Historical tests that
extract those cleanup functions do not establish a supported retained mode.
No production service or image changes in this batch.

## Test-first evidence

The new `scripts/stage3-base/retained-entry.test.mjs` executes the real shell
entry with dependency sentinels for Node, Docker, curl, mktemp and openssl.
Sentinels record and stop the first dependency instead of touching services.
Before implementation, the four rejection cases fail because the entry reaches
Node first; the three disposable cases already pass. After implementation all
seven pass: retired mode alone/with Identity, two invalid values, and
unset/empty/false compatibility. The sentinel directory is removed in `finally`;
subprocesses have a timeout.

The shared suite passes 1,212 tests with five pre-existing opt-in ACP PostgreSQL
commit-receipt fault checks skipped and no failures/cancellations. Its 1,217
tests add exactly seven to the preceding suite, including real shell execution
and existing HTTP/WebSocket/Chromium components.

Default Stage 3 project `antnest-stage3-e2e-2095` passes deployment checks,
five lifecycle operations, eight model calls across v1 WebSocket, v2 WebSocket
and v1 HTTP, Provider credential rotation, immutable build snapshots, Rebuild
workspace preservation, logout rejection/empty recovery and exact deletion.
All five lifecycle plus 29 individual Session topologies pass. Seventeen strict
results retain timing warnings: five lifecycles and twelve Session requests.
Calculated deltas range from +6.319 to +715.599 µs and -98.318 to -256.255 µs;
these are Jaeger diagnostics, not measured physical clock offsets. Exit 2 is
retained, not treated as full strict acceptance.

The five saved raw lifecycle traces independently have zero missing parents and
zero error spans; current Session topology/privacy checks pass. Private raw
lifecycle evidence is under `.cache/stage3-base/antnest-stage3-e2e-2095/`.
Independent cleanup finds zero owned containers, volumes or networks and no
verification/browser children. All twelve retained development containers keep
the same identities, images, mounts, networks, start times and restart counts;
twelve run and eleven configured health checks remain healthy. No service image
was rebuilt or deployed.

Shell syntax, formatting, local documentation links and `git diff --check` pass.
Source-hash comparison confines existing executable changes to the entry script;
the only added executable source is its seven-case contract/component test.
Private coordinator and owned-profile evidence use directory/file modes 700/600.

Private logs, source hashes and retained-container baseline are under
`.cache/retained-seed-retirement-20260921/`.

The following [inline-tail retirement](stage3-tail-retirement.md) removes that
setup and its exclusive CLI/input helpers while keeping current Identity shell
clients, OIDC setup, profile dispatch and owned cleanup. Current interruption
helpers and historical abrupt-crash diagnostics still require separate treatment.
