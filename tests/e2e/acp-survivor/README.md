# Two ACP replicas and survivor recovery

`node tests/e2e/acp-survivor/run.mjs` starts a disposable deployment with two
ACP containers, the real Runtime Controller and browser ingress through A.
It requires the platform images tagged `antnest/<service>:local` and Chromium.
CI supplies them in the independent required `c-acp-survivor` shard.

The scenario requires both owners to complete distinct Prompts. It holds a
second Run on B, kills that exact container without restarting it, and waits
for the original lease to expire according to the database clock. A must
recover the original Run using the real RC stop receipt and a greater epoch.
The original B ownership and recovery audit must remain durable. A new
Controller publication and a browser Prompt on the same Agent must succeed.
The old Prompt must never replay, another member must remain unauthorized,
and deleting every created Agent must remove its Runtime resources.

All SQL is read-only. The runner never edits leases, inserts stop proofs or
calls recovery directly. Browser connections are closed and joined before A
must exit normally; final cleanup verifies that all project containers, volumes
and networks are gone. Failures retain private partial evidence under
`artifacts/verification/acp-survivor/` and return a nonzero exit status.
Trace identifiers are retained when available and are auxiliary diagnostics.

Prompt receipts validate the original response body, request frame, Agent,
Session, prompt and ordinary `Idempotency-Key` header. The ordinary sent header
comes from `Request.headers()`; unrelated full security-header metadata must
not hold business admission open after that information is already available.
Missing or different idempotency keys remain failures.

The uploaded report retains a safe `browser_phase` checkpoint and bounded
nested error types/source locations. Raw messages, assertion values, Cookies
and request headers remain excluded; the original errors stay in private
evidence. The original total budget and all eleven business/cleanup checks are
unchanged.

Acceptance requires evidence for the exact candidate commit and CI run: every
required business check, `business_completed: true`, the survivor's normal exit
code `0`, and `cleanup: verified`. Fixture tests and Compose rendering alone do
not satisfy this gate. Successful one-shot database initialization is checked
separately from the complete, healthy resident service inventory.

The profile, model and deployment fixture tests are included in `make test-repo`:

```sh
node --test --test-concurrency=1 tests/e2e/acp-survivor/*.test.mjs
```
