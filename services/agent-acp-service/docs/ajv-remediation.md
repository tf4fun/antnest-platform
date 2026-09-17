# AJV Dependency Remediation

Recorded: 2026-09-17. Baseline: `061ef9e`. This service-owned batch updates AJV
from 8.17.1 to the official stable 8.20.0 release. No MCP/ACP protocol or Tool
admission contract changes.

## Advisory And Exposure

[GHSA-2g4f-4pwh-qvx6](https://github.com/advisories/GHSA-2g4f-4pwh-qvx6)
describes dynamic-pattern ReDoS with `$data` enabled. Its affected ranges are
7.0.0-alpha.0 through versions before 8.18.0, and the older branch before 6.14.0.
[The upstream fix](https://github.com/ajv-validator/ajv/commit/720a23f) uses the
configured regular-expression engine for dynamic patterns. The current official
[8.20.0 release](https://github.com/ajv-validator/ajv/releases/tag/v8.20.0) was
confirmed through GitHub and npm registry metadata on 2026-09-17.

Production AJV usage is `ToolPreflight` with `allErrors: true, strict: false`;
it does not enable `$data`. A service regression confirms that a data-supplied
pattern is rejected as `invalid_tool_schema` before validation. Another verifies
ordinary static-pattern acceptance/rejection and unchanged input arguments.
Both behavior checks passed before upgrading, documenting the existing boundary.
They do not claim the old dependency was outside the advisory's version range.

Only the AJV package/version/integrity entry changed in the dependency lockfile.
The separate ESLint dependency remains AJV 6.15.0, outside the advisory range.
Installation disabled lifecycle scripts and npm's automatic audit. The two ACP
Docker installation stages also explicitly disable automatic audit.

## Evidence Boundary

Service verification after the upgrade:

| Check                                 | Result                     |
| ------------------------------------- | -------------------------- |
| Unit, protocol and component tests    | 961 passed across 83 files |
| PostgreSQL persistence/protocol tests | 245 passed across 33 files |
| Independent official ACP SDK audit    | 9 passed                   |
| Typecheck, lint, build and formatting | Passed                     |
| Rebuilt production-image Docker E2E   | 4 scenarios passed         |

The rebuilt `antnest/agent-acp-service:ajv-fixed` image is
`sha256:e3aa69201e82455db532a47bb6417eadb344260d4119a237c5e9f35818273c9f`.
An isolated, network-disabled container confirmed installed AJV 8.20.0.
The existing `scripts/sdk-regressions-docker.mjs` passed metadata observer/list/
fork/process-restart consistency, refusal-context exclusion, close/reload and
unknown-effect Tool cancellation protection. It made four controlled model
requests and one Tool call and completed fixture cleanup. This is service-owned
ACP evidence with controlled model/MCP dependencies, not a new platform-wide
or real Runtime acceptance run. The retained development deployment was not
changed.

The subsequent [development synchronization](../../../docs/development-sync-20260917.md)
deployed this exact image and records its separate retained-data, real-browser,
model/Runtime and Trace evidence. Its strict timing-warning failure remains
visible; it does not alter this dependency batch's service-gate results.

The environment's automatic approval review rejected `npm audit` because it
would send the project's complete dependency names/versions to an external
registry. No alternative upload or indirect audit was attempted. This batch
uses the published advisory and a local lockfile comparison for this one issue;
it is not a claim that a full online dependency audit is clean.

Local evidence is in `.cache/acp-ajv-20260917/`: official registry metadata,
before/after lockfile comparison, installation output and verification logs.
Ignored cache files are not guaranteed to exist in a fresh clone.
