# Workspace protocol contract

`make e2e-workspace` runs on the disposable Foundation profile with the
installed ACP SDK. Browser, upload and layout coverage belongs to the separate
browser profile.

- Bootstrap Provider, Model and immutable Template using current public APIs.
- State is the six-field Gateway/ACP execution summary, with a nullable opaque
  `configuration_revision` hash and `unavailable_reason`. ACP owns the state
  watch; Identity validates access. Read its Trace ID from the Gateway response;
  never inject an unrecorded synthetic parent. No Controller admission-table oracle.
- Disconnect a live bash Run, reject a competing Session, then cancel the first
  Session from a new SDK connection. Observe the actual process group exiting
  and the workspace containing exactly the initial effect. Transport cancellation
  retains an unresolved, quiescent, unknown-effect public Run; physical process
  exit alone does not rewrite ACP's durable knowledge.
- The protected Runtime rejects another prompt with `runtime_barrier_required`
  (`-32020`, nonretryable). Explicit public Rebuild replaces the Runtime and
  clears protection while preserving workspace bytes and the unknown Run facts.
- A disconnected second Run completes once; fresh Session load replays exactly
  one answer without new Run, model or Tool activity. Rebuild is visible to an
  open observer, changes configuration hash and Runtime identity, retains bytes,
  and the next Run sees the rebuilt environment and uses its new binding.
- Owner revocation closes the state observer and existing SDK connection with
  policy code 1008; a new upgrade is unauthorized. Automatic offboarding disables
  the Runtime while retaining workspace. Verify its source-linked Temporal Disable
  trace. Explicit Delete removes owned assets. A retained historical unknown call
  may still require a Runtime barrier when no Runtime revision is published;
  Disable/Rebuild/Delete accept the explicitly expected barrier receipt, never
  `not_settled`, before fencing/removal.
- Retain actual JSON-RPC request identities, public audits and raw private traces.
  Validate complete Gateway/ACP/Runtime ancestry, persistence and execution
  bindings, including cancellation. Public Agent summaries redact the process ID;
  read it from the actual ready Runtime status and match it to model spans. Never
  allow missing parents as a cancellation
  exception. Observe stream closure before collecting finished spans with normal
  SDK export settings. Keep classified errors and timing warnings as strict
  failures; do not rewrite traces, use SIGKILL or tune clocks to obtain a pass.

Coverage: negative unit/contract fixtures, SSE component tests, the isolated
Docker protocol E2E and the shared Foundation regression, all run serially.
