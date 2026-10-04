# ACP authentication and Provider acceptance

Run serially from the repository root with NVM Node:

```sh
docker build -f services/agent-acp-service/Dockerfile -t antnest/agent-acp-service:auth-provider-28 .
ANTNEST_ACP_AUDIT_IMAGE=antnest/agent-acp-service:auth-provider-28 node --import ./services/agent-acp-service/node_modules/tsx/dist/loader.mjs tests/e2e/agent-acp-service/sdk-regressions-docker.mjs
```

The owning-service harness uses the production image, isolated PostgreSQL,
temporary CSPRNG service credentials, an Identity fixture and synthetic model/MCP
dependencies. It covers 14 authentication/listener checks, 23 Provider policy
checks and five official SDK business scenarios, including normal process restart.

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
