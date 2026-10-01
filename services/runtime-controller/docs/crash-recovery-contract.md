# Update process-crash recovery contract

The selected scope is Runtime reconstruction, not Agent Session continuation.
The contract is verified against the real control service, PostgreSQL
journal/lock implementation and Docker driver with actual process loss. It adds
no production fault flag or startup gate.

The opt-in component fixture executes Update in a test subprocess with wrappers
around real adapters. It exits immediately (without deferred cleanup) at four
boundaries: before source removal, after source removal, after target creation
before journal completion, and after committed completion before returning its
result. A fresh subprocess retries exactly the same request and configuration.

Require durable request/source/target/revision/digest/generation identity, exact
workspace bytes, a single target claim and updated observation, no replacement
of an existing target, no extra effects on terminal replay, and release of the
old process's PostgreSQL mutation lock. Conflicting retry input and competing
requests must not bypass the nonterminal operation. Inspect actual journal and
Docker facts at each checkpoint; reaching an exit code alone is insufficient.

The fixture owns a fresh PostgreSQL container, internal network, a local UDP
fixture peer (not an egress-policy implementation), Skills volume and scoped
Runtime resources. It requires installed images and never pulls/builds images or
uses retained databases. This abnormal-exit component suite is separately opted
in and is not a stable normal-restart scenario. It does not assert
export of spans from the terminated process.

The component uses the real control service without the HTTP server or
observation monitor; it is not a full cross-service E2E test. Public Controller
Rebuild, Temporal retry and execution publication after an abnormal exit are
covered by a separately opted-in integration diagnostic.
