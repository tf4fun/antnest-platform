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
checkout's build inputs. To preserve existing local tags, build the current
checkout into separate candidate tags and select them through these variables:

| Image              | Candidate variable                      |
| ------------------ | --------------------------------------- |
| agent-acp-service  | `ANTNEST_C4_AGENT_ACP_IMAGE`            |
| agent-ui           | `ANTNEST_C4_AGENT_UI_IMAGE`             |
| agent-controller   | `ANTNEST_E2E_AGENT_CONTROLLER_IMAGE`    |
| edge-gateway       | `ANTNEST_E2E_GATEWAY_IMAGE`             |
| identity-service   | `ANTNEST_E2E_IDENTITY_IMAGE`            |
| skill-registry     | `ANTNEST_E2E_DISCOVERY_REGISTRY_IMAGE`  |
| admin-console      | `ANTNEST_E2E_PROPAGATION_CONSOLE_IMAGE` |
| runtime-controller | `ANTNEST_E2E_PROPAGATION_RC_IMAGE`      |
| runtime-egress     | `ANTNEST_E2E_EGRESS_IMAGE`              |
| temporal           | `ANTNEST_E2E_TEMPORAL_IMAGE`            |
| antnest-runtime    | `ANTNEST_E2E_RUNTIME_IMAGE`             |

The runner captures only these image selections before the fixture environment
is isolated. Existing C4 Controller/Gateway and Runtime Controller aliases remain
supported, but conflicting aliases fail before setup. The final Compose overlays
and Runtime Controller preparer use the same selection. Before admission, the
runner records selected image IDs and verifies the actual ten Compose service
containers and fixture-owned native Runtime against them. The Runtime must also
carry the expected Agent and managed-runtime ownership labels. A matching tag
with a different image ID fails. The runner neither builds nor removes selected images;
the caller owns candidate-image cleanup.

The gate has a 15-minute budget, excluding image builds,
and uses the existing ownership-checked cleanup on success, failure and normal
interruption. It also compares retained container, running-container, network
and volume IDs before and after cleanup.

`make e2e-service-authentication-integration` remains the full Tier C suite
`c-service-authentication-integration` in `c-skill-discovery`; selected Tier C
shards also block the required `Integration checks`. The separate
`c-encryption-key-rotation` suite runs the same journey with actual platform
key rotation enabled. Both Docker gates use all current
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
Workspace admission uses the Agent UI → ACP credential and obtains the exact
`workspace` CCT from the owner's existing Identity session, scoped to the target
Agent. The peer verifies its signature, owner, Agent and complete audience set,
then forwards it unchanged. Missing and tampered CCTs fail; conflicting raw
User/Principal/Organization/Agent hints cannot replace the signed identity.
The success receipt must identify the expected Agent and allow its owner.
Console and wrong-audience probes retain their original profiles. Failed
workspace Resolve requests and peer diagnostics exclude untrusted response and
exception details. Owner and administrator session cleanup run independently,
and cleanup failures cannot erase the primary admission failure.
The full flow's saved and draft model discovery both traverse Gateway → Console → Controller.

The historical admission before Gateway 24 passed 560 checks on all 24 created
networks, 30 signed context/role/Runtime checks and the complete
browser/lifecycle/Skill flow. Those counts do not establish admission of the
current Bridge consumers; each run records its actual checks and image receipts.
`make e2e-skill-deployment` delegates to this same gate. Private bridges require
Engine 28+ and explicit `isolated` mode; the separate production deployment gate
passed all 51 checks after that option was added. This is token/HTTP development
admission; it does not claim a full-platform mTLS deployment.

Results, screenshots and failure diagnostics belong in the ignored
`artifacts/verification/` tree. The matrix uses the selected image tags
without changing them; the full integration run owns separate candidate tags.
Both generate disposable credentials and labelled Docker resources; cleanup
preserves retained resources.
Passing fixture/planner tests alone is not complete Docker or business evidence.
