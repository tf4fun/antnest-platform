# Runtime Controller owning-service authentication gate

Run `node tests/e2e/service-authentication/runtime-controller/run.mjs` from the
repository root, with the local Antnest Runtime image installed. The harness
builds a separately tagged production RC image, generates temporary CSPRNG
Controller credentials, and runs isolated PostgreSQL, two internal networks and
bare Node probes. For #30 it builds an explicitly named, RC-owned Runtime protocol
double on the installed Runtime image: the double validates the real root-only
receiver volume, authenticates full status and exposes reduced liveness. This
does not test native Runtime's pending receiver implementation. No host ports
are published. It removes only its scope/project resources, candidate tags and
credentials in `finally`; bounded results remain
under ignored `artifacts/verification/`.

The machine-readable RC contract drives missing, duplicate and wrong-workload
checks on every control route, including all three Skill preparation routes.
The harness verifies exact JSON media, local health, management-interface
inaccessibility, startup rejection, two-key receiver rotation/restart,
repository image admission, frozen image IDs, rejected-mutation nonacceptance,
direct RC lifecycle/replay and normal SIGTERM/SIGINT recovery. Instance checks
cover private resolution, unauthenticated status/MCP denial, per-generation
rotation, unchanged authority after RC restart, receiver labels/permissions,
UID-1000 denial and receiver cleanup after Disable/Delete. The UDP peer fixture
is retained for native Runtime bootstrap checks in its owning batch; it does not
run Runtime Egress or forward user traffic. Registry's native HTTP transport is
covered by the root Go component gate.

The direct Docker volume component test also verifies archive preparation via a
never-started, network-none helper, complete readback and rejection of Docker's
unlabeled empty replacement. Archive extraction uses the parent `/run` directory
to apply mode 0700 to the mount root; Docker skips a `.` archive entry's mode.
The helper's rootfs is writable only for this stopped archive operation. The
actual Runtime receiver mount remains read-only and inaccessible to UID 1000.

This is RC's local admission evidence. Complete Controller workflows, prepared
Skill delivery, native Runtime/Controller/ACP adoption and all-service network probes are
the final integration batch after each service has passed its own gates.
