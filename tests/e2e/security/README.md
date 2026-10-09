# Cross-service authentication matrix and integration

Run `make test-service-authentication-integration` before either Docker gate.
The blocking security gate is `make e2e-service-authentication-matrix`, Tier B
suite `auth-network-matrix` in shard `b-auth-matrix`. It boots the same production
stack as the full integration flow, runs `runNetworkMatrix`, creates one Agent
and native Runtime through the shared workspace setup, and runs
`runAuthenticatedPeer` in admission mode. It needs no browser or Skill workflow
flags. Failures block the required `Integration checks` status.

Build the current checkout's local production images and pull the dependencies
before running locally; the gate starts Compose with `--no-build --pull never`:

```sh
docker build -f runtimes/antnest-runtime/Dockerfile -t antnest/antnest-runtime:local .
docker build -f scripts/temporal/Dockerfile -t antnest/temporal:local .
for service in admin-console agent-acp-service agent-controller agent-ui edge-gateway identity-service runtime-controller runtime-egress skill-registry; do
  docker build -f "services/$service/Dockerfile" -t "antnest/$service:local" .
done
docker pull postgres:17.11-bookworm
docker pull node:24.21.0-bookworm-slim
docker pull temporalio/admin-tools:1.32.0
docker pull cr.jaegertracing.io/jaegertracing/jaeger:2.21.0
make e2e-service-authentication-matrix
```

CI provides all eleven `antnest/<image>:local` production images from the
checkout's build inputs. The gate has a 15-minute budget, excluding image builds,
and uses the existing ownership-checked cleanup on success, failure and normal
interruption. It also compares retained container, running-container, network
and volume IDs before and after cleanup.

`make e2e-service-authentication-integration` remains the full Tier C suite
`c-service-authentication-integration` in `c-skill-discovery`; Tier C reports
separately and does not block merges. Both Docker gates use all current
production service images, the purpose networks in
[the deployment contract](../../../contracts/platform/development-networks.md),
and separately generated disposable credentials. Neither calls an external
model Provider or use a retained deployment's credentials.

`network-matrix.mjs` derives protected routes from the enforced caller catalogs
and targets from the actual container/network inventory. A credential-free,
nonroot, read-only peer visits every created network. Protected listeners reject
missing service credentials and forged context/actor headers. Secondary
interfaces and cross-network ACP control access return no HTTP response; even
401/404 responses on those interfaces fail the isolation check. A bare TCP
handshake is insufficient because Docker Desktop can accept it without
forwarding an HTTP request into an isolated bridge. Workspace and control
listeners reject each other's routes. An unclassified network or
missing workload fails planning rather than silently reducing coverage.

The full integration entry point additionally exercises real Gateway login,
private Provider destination rejection with the production default, and the existing complete
Skill learning/discovery/temporary-use/browser-promotion/Template/rebuild flow.
The shared Agent setup registers the deterministic model with an explicit
private-endpoint opt-in. The full flow also verifies rejection before enabling
that opt-in. The opt-in belongs to the test overlay and never changes `compose.yaml`.

`authenticated-peer.mjs` obtains caller context through real Identity login and
resolution, verifies it against authenticated public JWKS, and tests tampering,
wrong audience, actor substitution, session revocation and per-caller grants.
It also tests the actual native Runtime's authenticated MCP/status/private
routes and reduced anonymous liveness. Only the required sender files are
mounted into the peer; retained credentials and decrypted model keys are unused.
The full flow's saved and draft model discovery both traverse Gateway → Console → Controller.

The final admission passed 560 checks on all 24 created networks, 30 signed
context/role/Runtime checks and the complete browser/lifecycle/Skill flow.
`make e2e-skill-deployment` delegates to this same gate. Private bridges require
Engine 28+ and explicit `isolated` mode; the separate production deployment gate
passed all 51 checks after that option was added. This is token/HTTP development
admission; it does not claim a full-platform mTLS deployment.

Results, screenshots and failure diagnostics belong in the ignored
`artifacts/verification/` tree. The matrix uses the provided local image tags
without changing them; the full integration run owns separate candidate tags.
Both generate disposable credentials and labelled Docker resources; cleanup
preserves retained resources.
Passing fixture/planner tests alone is not complete Docker or business evidence.
