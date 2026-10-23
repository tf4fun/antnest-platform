# Runtime Controller lifecycle acceptance

Run `make e2e-runtime-controller` through the authenticated candidate harness.
The suite preserves initialize, inspection, Controller restart, observation
continuity, Runtime restart and stale execution fencing, update, disable,
enable and delete checks. The parent verifies actual Docker resource cleanup.

The two outbound probes after create and update use a disposable HTTPS target
on the existing Egress network. Its namespace owns synthetic public address
`1.1.1.1`; a project-local Egress `/32` route reaches it. A scoped nft guard
permits only that address and TCP 8443 for tunneled Runtime traffic. The fixture
resolver returns only `egress-fixture.example -> 1.1.1.1`; it never forwards
queries to public DNS. Production private-address filtering remains enabled.

Both IP and DNS requests run as Runtime UID 1000 over its real tunnel and use
the disposable CA to verify the endpoint certificate. The DNS request uses the
Runtime resolver, with no hosts override. Each request must return HTTP 200 and
its original nonce, phase and kind. Exact target inventory must show all four
requests arriving from this Egress instance, with no missing or repeated hit.
Transport, TLS, HTTP and response failures remain blocking. The target reuses
the candidate Runtime image, with no separate image build or published port.

Per-probe exit code, HTTP status, body hash, response body and target inventory
are retained under the shell suite's `https-probe/` evidence directory. The
disposable TLS directory is removed at cleanup; Runtime receives only the
public CA. The target receives only individual read-only server certificate and
key binds, readable without DAC capabilities; their host directory remains
private and the disposable CA signing key is deleted before startup.
Local HTTPS tests cover wrong CA/hostname, wrong nonce, duplicate
requests, partial handshakes and original socket/listener closure. Complete
Docker lifecycle and cleanup evidence is required from the candidate's CI.
