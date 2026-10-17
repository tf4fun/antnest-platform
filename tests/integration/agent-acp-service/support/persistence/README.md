# Persistence fault components

Issue [#167](https://github.com/tf4fun/antnest-platform/issues/167) moves database
fault rules out of the whole-platform Persistence E2E. The owning PostgreSQL
suite discovers `../../e2e/persistence-faults.postgres.test.ts` automatically:

```sh
make test-agent-acp-postgres
node --test --test-concurrency=1 tests/integration/agent-acp-service/support/persistence/*.test.mjs
```

The six cases use production ACP composition, migrations, worker ownership,
admission, execution, shutdown and startup recovery. Only the model transport
and outbound MCP dialer are fake. A wire proxy holds an actual successful
PostgreSQL response after commit at intent, acceptance or completion, then drops
the exact selected socket. Independent database reads check durable state while
the response is held. Both ACP versions must stop new admission, preserve
committed history across restart and two replays, and execute a later Run once.
The v2 completion ACK is matched to the original durable user message.

These components prove service behavior in process. They do not claim a natural
OS exit code, a real Runtime effect or a whole-platform Docker journey. Those
boundaries remain with the separate retained Restart/integration scenarios.
The old Persistence platform target is pending removal after component admission;
previous evidence remains private under `artifacts/verification/`.

`wire.mjs` and `evidence.mjs` retain the existing wire and durability assertions.
The proxy releases its database listener if control-listener startup fails.
Its unit tests also run under `make test-repo`. Confirmed external SDK defects
are non-blocking and require no new investigation or workaround.
