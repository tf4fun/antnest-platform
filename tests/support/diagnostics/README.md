# Diagnostic collectors

These tools observe a test run and collect private diagnostics. Their output is
not a business test result. Use an explicit JSON configuration outside
`.cache/`, create the private output directory first, and keep raw logs and
responses under `artifacts/verification/`.

## HTTP error preload

`http-errors.mjs` is a Node preload. Set `ANTNEST_HTTP_DIAGNOSTICS_CONFIG` to a
file containing:

```json
{
  "output": "artifacts/verification/example-http",
  "originPrefix": "http://127.0.0.1:",
  "pathPrefix": "/api/"
}
```

```sh
ANTNEST_HTTP_DIAGNOSTICS_CONFIG=/path/to/http-config.json node --import ./tests/support/diagnostics/http-errors.mjs /path/to/fixture.mjs
```

Matching `undici:request:error` events are appended to
`http-errors.private.jsonl`. Query strings are omitted; error messages and
causes stay in private evidence. Invalid configuration or a missing output
directory fails at startup. If a later append fails, collection continues on a
best-effort basis.

## Failed-request Trace capture

`capture-http-failure-traces.mjs --config /path/to/capture-config.json` accepts
`output`, `inputLog` and an HTTP(S) `jaeger` base URL without credentials, query
or fragment. It waits six seconds, selects unique lowercase 32-digit Trace IDs
from HTTP 500 log records, and fetches `/api/traces/<id>` with a five-second
deadline. Raw bodies are saved as `identity-failure-<id>.private.json`. Saving
a response does not mean Jaeger returned a successful status or a valid Trace.
Network failures exit nonzero; the collector never restarts services.

The tests for both tools use synthetic diagnostic events and a replaced
`fetch`.

## Process observers

The Commands and SDK observers run a command in an owned subprocess session,
periodically snapshot matching containers, and preserve the observed command's
exit code. Run them through the private command runner, because Commands prints
its captured inner log and SDK inherits the child's output:

```sh
node tests/support/run-command.mjs --output artifacts/verification/example-observer --name commands -- python3 -B tests/support/diagnostics/commands-observer.py --config /path/to/commands.json
node tests/support/run-command.mjs --output artifacts/verification/example-observer --name sdk -- python3 -B tests/support/diagnostics/sdk-observer.py --config /path/to/sdk.json
```

Both configurations require `output`, an argv array `command` and a string
object `environment` (which may be empty). Configuration is validated before
any output is created or a child starts. An existing Commands inner log is
rejected; container state and log snapshots are overwritten.

Commands additionally requires `project_pattern` and a nonempty `services`
list. A typical configuration observes `command: ["make", "e2e-slash-commands"]`
with pattern `antnest-stage3-e2e-\d+` and the services `agent-controller`,
`runtime-controller`, `agent-acp-service`, `edge-gateway` and `admin-console`.
It samples every three seconds, tolerates containers disappearing during
teardown, and limits container logs to `--tail 3000`.

SDK additionally requires `container_filter` and `container_pattern`. A typical
configuration runs `["node", "tests/e2e/agent-acp-service/sdk-regressions-docker.mjs"]`
with an installed `ANTNEST_ACP_AUDIT_IMAGE` in `environment`, filter
`name=antnest-acp-sdk-` and pattern
`antnest-acp-sdk-[0-9a-f]{8}-(postgres|service)`. It samples every 0.3 seconds.

### Cleanup

Observers clean up surviving descendants even after the observed command has
exited. Cleanup sends TERM to the whole owned process group, waits up to the
grace period, then sends KILL only if needed. The default grace is 180 seconds
for Commands and 45 seconds for SDK; set a positive `cleanup_grace_seconds` to
override it. SIGINT and SIGTERM cancel the observer with exit code 130 or 143,
and repeated signals cannot interrupt final cleanup. A primary failure remains
a failure even if cleanup also fails.

The [progress interruption harness](../../e2e/acp-progress/README.md) has a
different success condition: it deliberately interrupts a fixture and verifies
that the fixture cleaned its own resources before the harness fallback runs.

## Identity service logs

The Stage 3 E2E entry accepts an optional
`ANTNEST_E2E_IDENTITY_DIAGNOSTIC_LOG=/path/to/identity-services.private.log`.
The path is validated as a durable regular-file path before any Docker
operation. Before teardown, the entry writes the complete Identity, Admin
Console and Gateway stdout and stderr to that private file. A collection failure
does not replace the original exit status.
