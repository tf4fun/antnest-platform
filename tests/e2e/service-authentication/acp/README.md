# ACP authentication, Provider and Runtime instance acceptance

Run serially from the repository root with Node 24 and the locked ACP packages:

```sh
docker build -f services/agent-acp-service/Dockerfile -t antnest/agent-acp-service:local .
docker pull postgres:17.11-bookworm
docker pull node:24.21.0-bookworm-slim
make e2e-acp-authentication
```

Tier B suite `auth-acp` in shard `b-auth` runs this target and blocks the required
`Integration checks` status. CI provides the current checkout's ACP production
image as `antnest/agent-acp-service:local`. The Make target passes it through
`ANTNEST_ACP_AUDIT_IMAGE` to `sdk-regressions-docker.mjs`, with the TSX loader from
the locked ACP installation; CI never uses the script's `sdk-fixes` fallback.
For an isolated local candidate, set `ANTNEST_ACP_AUDIT_IMAGE` explicitly when
invoking the target. The harness has a three-minute scenario budget.

The owning-service harness uses the production image, isolated PostgreSQL,
temporary CSPRNG service credentials, an Identity fixture and synthetic model/MCP
dependencies. It covers 14 authentication/listener checks, 23 Provider policy
checks, 18 Runtime instance checks and five official SDK business scenarios,
including normal process restart. The Runtime protocol peer admits only the
fixture's separate CSPRNG instance token and exact execution fence on every
official MCP request; it rejects unrelated user/CCT/cookie authority.

Runtime checks cover malformed executable/closed publications, immutable token
identity on equal and newer revisions, credential-free database/Run/model/log
projections, 0700/0600 sender storage, cold restart without restored authority,
verified same-revision republishing, in-flight closure without a connection ID,
retained unknown-effect protection and normal shutdown cleanup. The production
ACP image and migrations run here; native Runtime's own receiver and the actual
Controller/RC lifecycle belong to their separate gates and final integration.

An internal network with a randomly selected public-classified subnet verifies
the production adapter's default policy without Internet access. A separate private
alias verifies default rejection and the explicit private-endpoint opt-in. The
SDK business fixture uses that private alias with the operator flag enabled;
its backend is a fixed synthetic model handler. It does not depend on Docker
Desktop's reserved host-gateway address being accepted as a Provider destination.
Fixtures reject private workload headers, CCT, cookies and baggage. Redirects must
remain unfollowed and environment proxies unused. No real Provider key or model
inference is used.

Native component gates separately exercise mixed answers, rebinding, original
HTTPS/SNI/Host identity, response streaming and cancellation. The isolated
PostgreSQL gate verifies bounded durable failures and a later explicit Run for
both ACP versions. These checks do not claim cross-service acceptance.

The harness removes its containers, networks and credential directory in finally.
Bounded evidence belongs under ignored `artifacts/verification/`.
