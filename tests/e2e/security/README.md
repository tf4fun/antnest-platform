# Cross-service authentication integration

Run `make test-service-authentication-integration` before
`make e2e-service-authentication-integration`. The Docker gate uses all current
production service images, the purpose networks in
[the deployment contract](../../../contracts/platform/development-networks.md),
and separately generated disposable credentials. It does not call an external
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

The integration entry point then exercises real Gateway login, private Provider
destination rejection with the production default, and the existing complete
Skill learning/discovery/temporary-use/browser-promotion/Template/rebuild flow.
Only that flow's deterministic model receives an explicit private-endpoint
opt-in. The opt-in belongs to the test overlay and never changes `compose.yaml`.

`authenticated-peer.mjs` obtains caller context through real Identity login and
resolution, verifies it against authenticated public JWKS, and tests tampering,
wrong audience, actor substitution, session revocation and per-caller grants.
It also tests the actual native Runtime's authenticated MCP/status/private
routes and reduced anonymous liveness. Only the required sender files are
mounted into the peer; retained credentials and decrypted model keys are unused.
Saved and draft model discovery both traverse Gateway → Console → Controller.

The final admission passed 560 checks on all 24 created networks, 30 signed
context/role/Runtime checks and the complete browser/lifecycle/Skill flow.
`make e2e-skill-deployment` delegates to this same gate. Private bridges require
Engine 28+ and explicit `isolated` mode; the separate production deployment gate
passed all 51 checks after that option was added. This is token/HTTP development
admission; it does not claim a full-platform mTLS deployment.

Results, screenshots and failure diagnostics belong in the ignored
`artifacts/verification/` tree. Each run owns separate candidate image tags,
credentials and labelled Docker resources; cleanup preserves retained resources.
Passing fixture/planner tests alone is not complete Docker or business evidence.
