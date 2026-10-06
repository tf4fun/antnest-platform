# Runtime Egress peer binding

Run `make e2e-egress-peer-binding` serially with Docker available. It builds the
real services from the current source and runs the authenticated managed MCP
lifecycle fixture with a local deterministic Provider; no external LLM is used.

After create, rebuild and enable, the test compares Docker's management IPv4,
RC's current inspection and Egress's committed attachment. Disable must clear
the peer. A graceful stop, network reconnect at a free fixture address and start
forces a changed outer peer; Controller must commit it with a new attachment
version. Updating this network binding does not reactivate an old execution.

The read-only probe runs only on the disposable control network, with a fixture
Controller workload token mounted read-only. All probe containers carry the
fixture's ownership label. The parent cleans owned containers, networks, volumes
and candidate images and verifies retained Docker identities are unchanged.

The Egress owner gate separately sends a forged Agent datagram and executes
the [kernel integration test](../../integration/runtime-egress/kernel_backstop.rs)
inside an isolated Linux container. This bypasses userspace admission by writing
to TUN and checks both nft's drop counter and the absence of a database connection.
