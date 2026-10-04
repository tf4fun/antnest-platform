# Runtime Controller owning-service authentication gate

Run `node tests/e2e/service-authentication/runtime-controller/run.mjs` from the
repository root, with the local Antnest Runtime image installed. The harness
builds a separately tagged production RC image, generates temporary CSPRNG
Controller credentials, and runs isolated PostgreSQL, two internal networks and
bare Node probes. No host ports are published. It removes only its scope/project
resources, candidate tag and credentials in `finally`; bounded results remain
under ignored `artifacts/verification/`.

The machine-readable RC contract drives missing, duplicate and wrong-workload
checks on every control route, including all three Skill preparation routes.
The harness verifies exact JSON media, local health, management-interface
inaccessibility, startup rejection, two-key receiver rotation/restart,
repository image admission, frozen image IDs, rejected-mutation nonacceptance,
direct RC lifecycle/replay and normal SIGTERM/SIGINT recovery. A restricted UDP
packet fixture answers only Runtime's documented readiness probe; it does not
run Runtime Egress or forward user traffic. Registry's native HTTP transport is
covered by the root Go component gate.

This is RC's local admission evidence. Complete Controller workflows, prepared
Skill delivery, Runtime instance credentials and all-service network probes are
the final integration batch after each service has passed its own gates.
