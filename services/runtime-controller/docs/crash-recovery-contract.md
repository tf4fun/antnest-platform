# Update process-crash recovery contract

The selected scope is Runtime reconstruction, not Agent Session continuation.
This first owning-service batch validates the existing control service, PostgreSQL
journal/lock implementation and Docker driver with actual process loss. No new
production fault flag or startup gate is permitted.

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
in and is not a stable normal-restart acceptance scenario. It does not assert
export of spans from the terminated process.

After local unit, RPC contract, PostgreSQL and this component evidence pass,
a separate integration batch must exercise public Controller Rebuild, Temporal
retry and one execution publication. The component uses the real control service
without the HTTP server or observation monitor; it is not full cross-service E2E.

[Current component results](../../../docs/runtime-crash-recovery-revalidation.md)
record the four passing boundaries, earlier fixture failures and pending
Controller/Temporal integration.

The later [integration report](../../../docs/runtime-crash-integration-revalidation.md)
records public Rebuild and Temporal recovery at two real Docker mutation
boundaries. It remains a separately opted-in abnormal-process diagnostic.
