# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/tf4fun/antnest-platform/security/advisories/new).
Include the affected component, version or commit, reproduction steps, and the
impact you observed. We aim to acknowledge reports within five working days and
will coordinate a fix and disclosure date with you.

## Supported versions

The project has not published a stable release yet. Security fixes are made on
the `main` branch and included in the next tagged release.

## Deployment security model

Antnest Platform is designed for a single trusted Docker host or a private
cluster network. Before exposing a deployment, understand these boundaries:

- **Edge Gateway is the only public entry point.** All other services expose
  internal HTTP/JSON RPC. Identity, Gateway, Console, Agent UI, Controller, ACP,
  RC, Registry and native Runtime have passed their owning-service authentication
  gates. Egress has also passed its owning-service authentication gates;
  coordinated network/credential deployment and full integration remain pending in
  the rollout ledger. Services must stay on private networks that browsers, Agent
  Runtimes and the Internet cannot reach.
- **Runtime Controller has Docker access.** By default it talks to
  `unix:///var/run/docker.sock`, which is equivalent to root on the host. Its
  revision 16 control boundary admits only verified Controller workloads and
  enforces an operator image repository/digest policy before new Docker effects.
  Control uses an explicit purpose-network IP and readiness a separate loopback
  listener. These limits do not contain a compromised RC process. A useful
  socket proxy needs resource-scope, create-payload and archive-target checks;
  broad method/path filtering alone is insufficient. See the
  [RC assessment](services/runtime-controller/api/service-authentication.md#docker-socket-assessment).
  RC-issued Runtime instance credentials, native admission and private Controller
  to ACP relay are implemented; purpose-network deployment and cross-service
  acceptance remain later batches.
- **Runtime Egress is privileged.** It owns a TUN device, routes and nftables
  rules. Its control listener admits only authenticated Controller calls on its
  configured purpose address; readiness uses a separate loopback listener.
  These checks do not contain a compromised Egress process.
- **Agent Runtimes execute untrusted, model-selected commands.** They run as an
  unprivileged executor user, and their network traffic is forced through
  Runtime Egress policy. Do not mount host paths or secrets into Runtimes.
- **The frozen network cutover has one OTLP infrastructure exception.** A bounded
  ingestion-only transport will preserve Runtime telemetry while moving Jaeger
  entirely off management. It has no business credentials, query/control API or
  arbitrary destination. Compose/transport admission is still pending; see the
  [deployment network contract](contracts/platform/development-networks.md#runtime-telemetry-exception).
- **TLS is not terminated by the platform.** Put a TLS-terminating reverse proxy
  in front of Edge Gateway and keep `ANTNEST_EDGE_COOKIE_SECURE=true`.
- **RPC content capture can record secrets.** Keep
  `ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT=false` outside local debugging.
- **Host diagnostics require an explicit overlay.** Base Compose publishes
  only Gateway. `compose.debug.yaml` is for disposable local diagnostics and
  binds every publication to loopback, preserving workload/CCT verification.
  Keep it out of public deployments; see the
  [development port contract](contracts/platform/development-authentication.md#host-ports-and-explicit-diagnostics).

## Development defaults are not secrets

`.env.example` and `compose.yaml` contain public, synthetic development values:
database passwords ending in `-dev`, all-zero encryption keys, a fixed Skill
Registry token and the bootstrap administrator password `antnest-admin-dev`.
These are historical disposable-development settings. The authenticated services
reject missing service credentials, and Registry rejects its nonempty legacy
API/source tokens. The existing Compose defaults cannot start the new rollout
unchanged; provisioning and wiring are a pending deployment batch. Replace
public defaults with unique randomly generated values, keep per-pair secrets in
protected files, and never commit the resulting configuration.

## Service authentication rollout

The [platform authentication contract](contracts/platform/service-authentication.md)
defines workload mTLS (or explicit per-caller interim tokens), Identity-signed
Caller Context Tokens, per-route allowlists and JSON media-type checks. Its
[trust model](docs/architecture/trust-model.md) and
[rollout ledger](contracts/platform/service-authentication-rollout.json) distinguish
the delivered foundation from pending service enforcement and network changes.
Repository catalog/schema checks and admitted service batches do not complete
deployment security. The remaining Egress surface, internal host ports, shared
networks and development provisioning described above remain release blockers under
[#80](https://github.com/tf4fun/antnest-platform/issues/80).
