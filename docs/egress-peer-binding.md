# Egress peer binding (#34)

The Phase 1 contract binds an Agent tunnel address to the Docker IPv4 of its
Runtime, then independently blocks protected destinations in the kernel.
Workload authentication protects the control operation that installs the
binding. Packet admission requires both the inner allocation and the bound
outer IPv4. The UDP source port may change. This is address binding within the
managed network's trust model; per-generation encrypted datagrams and replay
protection remain Phase 2.

## Contract and lifecycle

- [RC revision 18](../services/runtime-controller/api/control-contract.json)
  adds `runtime_endpoint` to Runtime inspections. It is the canonical IPv4 from
  Docker's configured management-network attachment, never a hostname resolved
  by Controller. Controller reads the current inspection after the completed
  compute receipt, pins its Runtime revision, and requires this peer address
  before opening traffic. Address inspection can be retried independently of
  compute completion. Current inspections report the address after restart.
- [Egress revision 6](../contracts/egress/control-api.md#runtime-attachment)
  requires the address when opening an attachment. Close clears the address.
  State and address share one CAS version and one cleanup barrier. Rebinding
  clears existing userspace flows and conntrack before admitting the new peer.
  An earlier-version retry cannot replace a newer peer binding.
- Controller forwards the inspected address for create/rebuild/enable and
  inspects the source Runtime for rebuild rollback. Its observation worker
  reconciles a changed peer before publishing execution readiness; it can
  update an open attachment, never reopen a lifecycle-closed one.
- Closed, unbound routes answer only the fixed local readiness SYN/RST probe;
  they cannot create flows or write to TUN. Open routes without a bound address
  drop traffic. Policy updates, Ensure and recovery retain the binding.

## Kernel and observation

The special-use CIDR list is defined once for userspace policy and generated
nft rules. The kernel also denies Egress's connected IPv4 subnets, including
operator-configured public subnets, and the selected tunnel range. The uplink
destination drop precedes TCP forwarding. Reverse traffic remains separately
restricted to established/related traffic. Input from TUN admits DNS only for
the virtual resolver address on port 53. Startup fails if subnet discovery or
rule installation fails.

Peer mismatch is checked before policy, flow ownership and packet output.
Its aggregate monotonic metric carries no victim-Agent attribution or packet
content. Alert on a non-zero rate. The kernel drop counter supplies independent
evidence even when a test writer bypasses the userspace policy.

## Delivery and acceptance

1. Shared contract and schema tests: passed.
2. RC producer: unit/race/lint/vet and PostgreSQL/component gates pass; real
   Docker address comparisons and 134 owner checks pass, with fixtures cleaned.
3. Egress owner gates pass: native and Linux unit/contract/component/Clippy,
   eight PostgreSQL integration tests, 182 Docker checks, and the real Linux
   userspace-bypass kernel test. Both Docker runs cleaned their resources.
4. Controller consumer: unit/race/lint/vet pass; PostgreSQL/Temporal component
   coverage passes (675 tests, 1,222 subtests, no skips), and 105 Docker owner
   checks pass with fixture cleanup. Fresh addresses, source restoration,
   lost-response CAS, restart rebinding and readiness fencing are covered.
5. Cross-service integration passes: six real Runs and 16 local fixture Provider
   requests, create/rebuild/enable Docker–RC–Egress address equality, disable
   clearing, and graceful restart from `.128` to `.40` with attachment CAS
   advancing from 6 to 7. Business/topology/privacy gates pass; only the existing
   reviewed clock-skew warnings remain in strict Trace evidence. The complete
   fixture was cleaned and retained Docker identities were unchanged.
6. The updated standalone Stage1 Docker entrypoint passes, including real
   outbound allow/deny, attachment close, Egress restart and persisted policy.
   Its disposable fixture cleanup was verified.

Reproduce the cross-service case with
[`make e2e-egress-peer-binding`](../tests/e2e/runtime-egress/README.md). Egress's
owner gate supplies the crafted-UDP and direct-TUN kernel proofs separately.

Integration runs after the three service batches pass their own gates. Update
each service in its own commit, then submit one reviewable PR; do not merge it.
