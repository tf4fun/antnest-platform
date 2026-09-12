# Service Verification

Run from the platform repository root. Node.js 22+ and Go are required.
The coordinator runs one service at a time. This runner does not start Docker,
create/drop databases, commit files or save raw test output.

```sh
node scripts/verification/go-service.mjs runtime-controller --test-database antnest_obs_runtime_controller_test
node scripts/verification/go-service.mjs agent-controller --test-database antnest_obs_agent_controller_test
node scripts/verification/go-service.mjs identity-service --test-database antnest_obs_identity_test
node --test scripts/verification/*.test.mjs
```

The named databases must already exist, be owned by the matching service role,
and end in `_test`. They must never be the human acceptance or production database.
`--test-database` reads only the matching Postgres password and host port from
`.env` (override with `--env-file`). It does not pass the entire file to tests.
Alternatively supply the service's `ANTNEST_*_TEST_DATABASE_URL` and omit that option.
URLs and passwords are not printed by the runner.

The command always runs the full service with `go test -json -race -p=1`, no
test-result cache, and a ten-minute package timeout. It preserves Go's exit code,
prints failure diagnostics, and emits compact final package/test/subtest/skip
counts. A skip is visible and is not a pass. A twelve-minute outer watchdog kills
the test process group; interrupted or timed-out results are incomplete and may
not be used as acceptance evidence. Check for leftover processes before retrying.

The script is a convenience wrapper, not an alternative gate: `make fmt-check`,
`make lint`, applicable contract tests and deployment verification still apply.
