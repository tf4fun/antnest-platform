# Runtime Egress acceptance

Run `make e2e-stage1` serially with Docker and public DNS/HTTPS available. Its
authenticated fixture builds Runtime, Egress and Runtime Controller from the
current source, allocates host ports dynamically, and opens an `allow_all`
attachment. Egress must be able to resolve `postgres` and reverse-resolve its
address, and a root control probe
inside Runtime must resolve `runtime-controller` through Docker's embedded
resolver over both TCP and UDP, proving the names and bypass target exist.

The [DNS isolation probe](dns-isolation.py) then runs inside that same Runtime
as Executor UID 1000 and tool UIDs 2000 and 2007. `getent hosts postgres` and
`getent hosts runtime-controller` must fail, as must a reverse lookup of the
Postgres address, `getent hosts example.com` must
succeed, and explicit TCP/UDP queries to `127.0.0.11` for `runtime-controller`
must receive no response. Local TCP and UDP echo checks on ephemeral
`127.0.0.1` ports prove the remaining loopback allowance works. No DNS tooling
or additional Runtime image dependency is needed. Compose retains the default
`127.0.0.11:53` upstream; the probe exercises response filtering with real
internal answers. The harness removes its owned containers, networks, volumes
and candidate images.

Run `make e2e-lifecycle-network` separately for the existing two-Agent
allow/deny/restore, DNS and conntrack regression gate. It uses isolated targets
and a deterministic public DNS answer from its routed fixture resolver, with
one scoped synthetic public address and no Internet endpoints. The former
private-address DNS expectation encoded issue #36 and is replaced by an exact public-answer check;
DNS continuity across the other Agent's policy change is still required.

## Peer binding

Run `make e2e-egress-peer-binding` serially with Docker available. It builds the
real services from the current source and runs the authenticated managed MCP
lifecycle fixture with a local deterministic Provider; no external LLM is used.

After create, rebuild and enable, the test compares Docker's management IPv4,
RC's current inspection and Egress's committed attachment. Disable must clear
the peer. A graceful stop, network reconnect at a free fixture address and start
forces a changed outer peer; Controller must commit it with a new attachment
version. Updating this network binding does not reactivate an old execution.

The fixture also pauses Egress and a Runtime, then normally restarts RC to
produce an inventory health observation. Controller must commit `runtime_paused`
while Egress is still paused, then recover health after both resume. This uses
actual services and data without a synthetic database write.

The read-only probe runs only on the disposable control network, with a fixture
Controller workload token mounted read-only. All probe containers carry the
fixture's ownership label. The parent cleans owned containers, networks, volumes
and candidate images and verifies retained Docker identities are unchanged.

The Egress owner gate separately sends a forged Agent datagram and executes
the [kernel integration test](../../integration/runtime-egress/kernel_backstop.rs)
inside an isolated Linux container. This bypasses userspace admission by writing
to TUN and checks both nft's drop counter and the absence of a database connection.
