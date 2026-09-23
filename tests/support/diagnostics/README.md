# Diagnostic collectors

These tools observe a run; their output is not a business acceptance result.
Use explicit JSON configuration outside `.cache`, and create the private output
directory first. Keep raw logs and responses under `artifacts/verification/`.
The Commands and SDK Python observers use an owned subprocess session. They
preserve the observed command's exit code and clean surviving descendants even
after that command exits. SIGINT/SIGTERM cancel the observer with 130/143;
repeated signals cannot interrupt final cleanup.

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

Matching `undici:request:error` events append to `http-errors.private.jsonl`.
Query strings are omitted; error messages and causes remain private evidence.
Invalid configuration or an absent output directory fails at startup. Event
collection retains the old best-effort behavior if a later append fails.

`capture-http-failure-traces.mjs --config /path/to/capture-config.json` accepts
`output`, `inputLog` and an HTTP(S) `jaeger` base URL without credentials, query
or fragment. It waits six seconds, selects unique lowercase 32-digit Trace IDs
from numeric HTTP 500 log records, and fetches `/api/traces/<id>` with a five-second
deadline. Raw bodies are saved as `identity-failure-<id>.private.json`. Saving a
response does not assert that Jaeger returned a successful status or a valid
Trace. Network failures remain nonzero; the collector does not restart services.

The [migration map](../migrations/cache-diagnostics.json) identifies the old
sources and verification evidence. Tests use synthetic diagnostic events and
replaced fetch calls; they do not claim a new query against a retained Jaeger.

## Process observers

Run either Python observer through the private command runner because Commands
prints its captured inner log and SDK inherits the child's output:

```sh
node tests/support/run-command.mjs --output artifacts/verification/example-observer --name commands -- python3 -B tests/support/diagnostics/commands-observer.py --config /path/to/commands.json
node tests/support/run-command.mjs --output artifacts/verification/example-observer --name sdk -- python3 -B tests/support/diagnostics/sdk-observer.py --config /path/to/sdk.json
```

Both configurations require `output`, an argument-array `command` and a string
object `environment` (which may be empty). They validate configuration before
creating output or starting a child. Existing Commands inner logs are rejected;
container state/log snapshots retain their previous overwrite behavior.

Commands additionally requires `project_pattern` and nonempty `services`. The
migrated profile uses `command: ["make", "e2e-slash-commands"]`, pattern
`antnest-stage3-e2e-\d+`, and the five service names `agent-controller`,
`runtime-controller`, `agent-acp-service`, `edge-gateway`, `admin-console`.
It observes every three seconds; disappearing containers during teardown are
still tolerated. Container logs keep the original `--tail 3000` bound.

SDK additionally requires `container_filter` and `container_pattern`. Its
migrated command is `["node", "tests/e2e/agent-acp-service/sdk-regressions-docker.mjs"]`,
with an explicit installed `ANTNEST_ACP_AUDIT_IMAGE` in `environment`, filter
`name=antnest-acp-sdk-` and pattern
`antnest-acp-sdk-[0-9a-f]{8}-(postgres|service)`. It observes every 0.3 seconds.

Cleanup sends TERM to the whole owned group, waits up to the configured grace,
then sends KILL only if required. Defaults remain 180 seconds for Commands and
45 seconds for SDK; optional positive `cleanup_grace_seconds` makes overrides
explicit. A primary failure remains a failure even if cleanup also fails.
The [progress interruption harness](../../e2e/acp-progress/README.md) has a
different success condition: it deliberately interrupts a fixture and verifies
that the fixture cleaned its own resources before harness fallback.

Identity's Stage 3 entry accepts optional
`ANTNEST_E2E_IDENTITY_DIAGNOSTIC_LOG=/path/to/identity-services.private.log`.
It validates this durable regular-file path before any Docker operation, creates
private output, then collects complete Identity/Console/Gateway stdout and stderr
before teardown. Collection failure does not replace the original exit status.
This is an explicit private diagnostic export, not the normal terminal log summary.
