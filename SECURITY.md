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
  internal HTTP/JSON RPC. Identity now requires workload token/mTLS and signed
  caller context for administration; other service authentication and coordinated
  deployment remain pending in the rollout ledger. They must stay on private networks that browsers, Agent
  Runtimes and the Internet cannot reach.
- **Runtime Controller has Docker access.** By default it talks to
  `unix:///var/run/docker.sock`, which is equivalent to root on the host. Its
  revision 15 control boundary admits only verified Controller workloads and
  enforces an operator image repository/digest policy before new Docker effects.
  Control uses an explicit purpose-network IP and readiness a separate loopback
  listener. These limits do not contain a compromised RC process. A useful
  socket proxy needs resource-scope, create-payload and archive-target checks;
  broad method/path filtering alone is insufficient. See the
  [RC assessment](services/runtime-controller/api/service-authentication.md#docker-socket-assessment).
  Purpose-network deployment and Runtime instance credentials remain later batches.
- **Runtime Egress is privileged.** It owns a TUN device, routes and nftables
  rules, and its control listener is unauthenticated.
- **Agent Runtimes execute untrusted, model-selected commands.** They run as an
  unprivileged executor user, and their network traffic is forced through
  Runtime Egress policy. Do not mount host paths or secrets into Runtimes.
- **TLS is not terminated by the platform.** Put a TLS-terminating reverse proxy
  in front of Edge Gateway and keep `ANTNEST_EDGE_COOKIE_SECURE=true`.
- **RPC content capture can record secrets.** Keep
  `ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT=false` outside local debugging.

## Development defaults are not secrets

`.env.example` and `compose.yaml` contain public, synthetic development values:
database passwords ending in `-dev`, all-zero encryption keys, a fixed Skill
Registry token and the bootstrap administrator password `antnest-admin-dev`.
They exist only so a disposable local stack starts without setup. Replace every
one of them with a unique, randomly generated value before running the platform
anywhere else, and never commit the resulting `.env` file.

## Service authentication rollout

The [platform authentication contract](contracts/platform/service-authentication.md)
defines workload mTLS (or explicit per-caller interim tokens), Identity-signed
Caller Context Tokens, per-route allowlists and JSON media-type checks. Its
[trust model](docs/architecture/trust-model.md) and
[rollout ledger](contracts/platform/service-authentication-rollout.json) distinguish
the delivered foundation from pending service enforcement and network changes.
Passing the repository catalog/schema checks does not secure the current
listeners. The unauthenticated surfaces, internal host ports, shared networks
and development secrets described above remain release blockers under
[#80](https://github.com/tf4fun/antnest-platform/issues/80).
