# Antnest Runtime Security And Operations

## Trust Boundary

Docker or Kubernetes, the host and the root Supervisor are trusted infrastructure.
Runtime authenticates RC/ACP workload authority with RC-issued per-instance
tokens before HTTP dispatch; membership of an internal network grants no tool
authority. This profile is explicitly HTTP-only: exact token mode and the
insecure-transport opt-in are required. TLS/mTLS configuration fails startup
instead of downgrading. Runtime does not authorize end users or issue OAuth tokens.

Agent-selected shell commands, scripts, Skills, and downloaded dependencies are
untrusted. The container, UID/capability boundary, root-owned image files,
named roots, workspace volume, and network policy limit their fault radius.
This service does not claim resistance to a container or kernel escape.

## RuntimeSpec Environment

Runtime Controller injects one immutable generation document in
`ANTNEST_RUNTIME_SPEC`. Its only authority is
`contracts/runtime/runtime-spec.schema.json`; Runtime rejects malformed JSON,
unknown fields, missing required fields, and semantic violations. Individual
deployment variables such as `ANTNEST_AGENT_ID` or
`ANTNEST_RUNTIME_EGRESS_ENDPOINT` are not alternate configuration inputs.

Controller freezes generation at lifecycle admission: a new Initialize,
Update or Enable allocates the next value even with unchanged configuration.
A same-deployment restart or exact-operation recovery retains the allocated
generation. The workspace and system-Skill roots must be
normalized absolute paths without `..` and must not overlap. The nonsecret
`authentication` descriptor is mandatory for `serve`; raw bearers are not injected.
RC prepares a separate read-only named volume at `/run/antnest-auth`, with a
UID/GID 0 mode-0700 directory and regular mode-0600 `callers.json` and `tunnel.json`. Runtime
checks ownership, modes, both complete digests, exact RC/ACP hash identities and
canonical tunnel keys before
network setup. Symlinks, FIFOs, malformed or ambiguous JSON and mount loss stop
bootstrap. The UID/GID 1000 executor cannot read this volume.

OpenTelemetry variables are deployment-owned diagnostics and are never copied
into Executor environments.

Each tool Executor starts with an empty environment. Runtime supplies
`HOME=/workspace` (or the configured workspace) and
`PATH=/usr/local/bin:/usr/bin:/bin`; request parameters cannot override these
reserved names.

## Required Container Shape

- `antnest-runtime serve` is container PID 1 and remains root.
- The Supervisor has the platform privileges needed for TUN, policy routing,
  nftables, UID/GID transition, and process-tree cleanup, plus `/dev/net/tun`.
- The root filesystem is writable by the trusted Supervisor so it can replace
  the platform resolver; image files remain root-owned and are not writable by
  UID/GID 1000 Executors.
- `/workspace` is a writable persistent Agent volume.
- `/skills` is mounted read-only by Runtime Controller/container policy. Runtime's tool
  API does not grant writes but does not enforce the mount flag.
- `/run/antnest-auth` is RC's read-only, root-only, per-generation receiver volume.
  Its hashes are not credentials and it is separate from the workspace and Skills.
- `/tmp` is bounded ephemeral storage.
- No Docker socket, database credential, host filesystem, or external API
  credential is mounted.
- Runtime HTTP is exposed only on the private platform network.

A minimal Docker container has this shape. Runtime Controller supplies the
workspace, system-Skill mounts, DNS upstream, and immutable RuntimeSpec values.
Docker may initially expose its `127.0.0.11` embedded resolver; the root
Supervisor replaces that container-local file with the exact virtual resolver
before any UID/GID 1000 Executor exists.

The kill switch also drops UID 1000 and managed tool UID 2000..2007 traffic to
`127.0.0.11` before each loopback accept. This address-wide rule covers TCP and
UDP on every port, including Docker's translated DNS ports. Other loopback
traffic remains usable, subject to the existing MCP-listener exclusion.

```bash
docker run --rm \
  --name antnest-runtime-agent-123 \
  --network antnest-internal \
  --cpus 1 \
  --memory 1g \
  --pids-limit 256 \
  --stop-timeout 15 \
  --cap-drop ALL \
  --cap-add CHOWN \
  --cap-add DAC_OVERRIDE \
  --cap-add KILL \
  --cap-add NET_ADMIN \
  --cap-add SETGID \
  --cap-add SETPCAP \
  --cap-add SETUID \
  --device /dev/net/tun \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  --dns 100.64.0.1 \
  --dns-option use-vc \
  --mount type=bind,src=/srv/antnest/agents/agent-123,\
dst=/workspace \
  --mount type=bind,src=/srv/antnest/skills,\
dst=/skills,readonly \
  --mount type=volume,src=RC_PREPARED_AUTH_VOLUME,dst=/run/antnest-auth,readonly \
  --env ANTNEST_SERVICE_AUTH_MODE=token \
  --env ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT=true \
  --env ANTNEST_SERVICE_AUTH_CALLERS_FILE=/run/antnest-auth/callers.json \
  --env 'ANTNEST_RUNTIME_SPEC=<RC-generated document with authentication descriptor>' \
  antnest/antnest-runtime:<immutable-tag>
```

The corresponding Kubernetes container security context is:

```yaml
spec:
  terminationGracePeriodSeconds: 15
  containers:
    - name: runtime
      resources:
        requests: { cpu: 100m, memory: 256Mi }
        limits: { cpu: "1", memory: 1Gi }
      securityContext:
        runAsUser: 0
        runAsGroup: 0
        readOnlyRootFilesystem: false
        allowPrivilegeEscalation: false
        capabilities:
          drop: ["ALL"]
          add:
            [
              "CHOWN",
              "DAC_OVERRIDE",
              "KILL",
              "NET_ADMIN",
              "SETGID",
              "SETPCAP",
              "SETUID",
            ]
      volumeMounts:
        - { name: tun, mountPath: /dev/net/tun }
        - { name: workspace, mountPath: /workspace }
        - { name: system-skills, mountPath: /skills, readOnly: true }
        - { name: instance-auth, mountPath: /run/antnest-auth, readOnly: true }
        - { name: tmp, mountPath: /tmp }
```

`tun` is a deployment-managed character-device mount, `workspace` is an
Agent-owned persistent volume, `system-skills` is read-only, and `tmp` is a
memory-backed `emptyDir` with a size limit. `/etc/resolv.conf` must remain
writable by the root Supervisor during bootstrap; the default cluster resolver
is only an initial platform value and is not an Agent DNS path.
The `instance-auth` volume must preserve the root-only receiver shape above;
default-readable projected volumes are insufficient. The Pod has no public
Service or ingress. NetworkPolicy permits full status from RC/ACP, MCP from ACP,
and root-owned outbound
traffic only to Runtime Egress UDP and the optional OTLP collector. Executor
traffic reaches every allowed internal or external destination through TUN and
Runtime Egress policy.

CPU, memory, PID, workspace-volume, and `/tmp` limits are deployment inputs and
must be explicit. The platform termination grace period must cover Runtime's
eight-second component drain plus its five-second telemetry flush so active
Executor cancellation, descendant reaping, network task exit, and telemetry
flush can finish before SIGKILL.

Named-root containment uses Linux `openat2`; the host kernel must provide that
system call (Linux 5.6 or newer) and the container seccomp profile must allow
it. Linux admission calls `bash`, `read`, `write`, and `edit` through an
official MCP client so an incompatible kernel or seccomp policy fails before
deployment.

The long-lived Supervisor remains root and must not execute Agent-selected file
or shell operations. Each built-in tool call starts its matching explicit
`bash`, `read`, `write`, or `edit` subcommand; information Resource reads use
`info`. Before reading stdin, that
subcommand clears supplementary groups, drops irreversibly to UID/GID 1000,
clears all capability sets, enables `no_new_privileges`, and verifies the final
process state. Managed tool calls instead forward through their already-running
dedicated UID 2000..2007 / workspace GID 1000 stdio server, started by the `mcp-stdio` launcher; discovery/status
requests do not create a one-shot Executor.

Bootstrap verifies that every required Supervisor capability is present,
including `CAP_KILL`. Runtime Controller owns the exact capability set. This
capability is required to terminate a UID/GID 1000 Executor on request
cancellation, timeout, or container shutdown; it is never retained by the
Executor.

Supervisor starts subcommands through `/proc/self/exe` with an empty environment
and only three protocol pipes. All other descriptors are close-on-exec. stdin
contains one bounded tool-specific JSON request, stdout one bounded structured
response, and stderr bounded diagnostics. Inputs never appear in argv.

## Connectivity

Runtime listens on:

- `GET /status` for Controller readiness checks;
- `POST /mcp` for official MCP Streamable HTTP tool calls.

There is no reverse Controller connection and no Runtime self-registration.
Runtime Controller gives Agent Controller the endpoint. Runtime opens one connected UDP socket
to Egress. Revision 2 carries `ANT2`, an opaque generation key ID and a WireGuard
message, authenticated with independent endpoint keys and a 32-byte PSK. Only
decrypted complete unfragmented IPv4/TCP data enters the policy path. BoringTun
owns nonces, bounded replay checks and session rotation; no raw fallback exists.

The root Supervisor retains the platform main routing table for MCP replies,
Egress UDP, and OTLP. UID-based policy rules send UID 1000 and 2000..2007 traffic to an Agent
table whose only default path is TUN and whose terminal unreachable route
prevents fallback to the main table. nftables is the fail-closed backstop: it
rejects UID 1000 and 2000..2007 bypass traffic, access to Runtime's own listen port, and IPv6.
Before accepting loopback, it drops all traffic from those UIDs to Docker's
embedded resolver at `127.0.0.11`. Explicit TCP or UDP DNS queries cannot bypass
the virtual resolver; local workspace servers on other loopback addresses
remain usable.
Internal destinations needed by an Agent are therefore reached through Egress
policy instead of direct platform routes. The deployment must not publish the
MCP port outside the trusted Docker or Kubernetes network.

Runtime installs immutable DNS-over-TCP resolver configuration before it
installs the Agent policy route. The root Supervisor truncates the
container-local `/etc/resolv.conf`, writes `options use-vc` plus exactly one
`nameserver <network.resolver_ipv4>` entry from RuntimeSpec, flushes it, and
validates the result. Startup fails closed when the file cannot be written or
does not match. UID/GID 1000 cannot modify the root-owned file later.

This removes Docker's embedded `127.0.0.11` and Kubernetes cluster DNS from the
Agent path because either would bypass TUN and Egress policy. Runtime Controller
still supplies platform DNS settings as a bootstrap hint, but Runtime owns the
final resolver state inside its network namespace. Additional name servers are
never retained.

Egress filters protected IPv4 answers using its forwarding baseline plus its
tunnel pool and connected subnets, removes all AAAA answers, and removes CNAME
chains with no usable terminal answer. Filtering away every answer yields
NXDOMAIN, and AAAA or non-public reverse lookups are answered locally without
reaching the upstream. Production should configure the Egress upstream as a recursive
resolver with no view of internal service names; Compose retains its embedded
upstream for offline development. See the
[Egress resolver operations](../../../services/runtime-egress/docs/operations.md).

RC-owned deployment input (public descriptors below are illustrative; actual
IDs and digests must come from the prepared private volume):

```dotenv
ANTNEST_RUNTIME_SPEC={"agent_id":"agent-123","generation":1,"listen":{"host":"0.0.0.0","port":8093},"network":{"packet_contract_revision":2,"egress_endpoint":{"ipv4":"172.30.255.3","port":8092},"tunnel_ipv4":"100.96.0.2","resolver_ipv4":"100.64.0.1"},"filesystem":{"workspace":"/workspace","system_skills":"/skills"},"authentication":{"connection_id":"rci_00000000000000000000000000000001","callers_file":"/run/antnest-auth/callers.json","receiver_digest":"sha256:<prepared callers digest>","tunnel":{"key_id":"rtk_<generation identity>","keys_file":"/run/antnest-auth/tunnel.json","keys_digest":"sha256:<prepared keys digest>"}}}
```

Egress is the sole authority for this endpoint. Its Agent network attachment
contains exactly one literal `IPv4:port`; Agent Controller copies that value
into RuntimeSpec, and Runtime Controller deploys the immutable RuntimeSpec
without discovering, resolving, or rewriting the endpoint. Runtime itself also
performs no hostname lookup. The deployment platform must make the supplied
literal endpoint routable from Runtime's root control plane. Agent DNS remains
on the governed TUN path without a split-resolver special case.

## Failure Diagnosis

1. **Exit 78 with `phase=bootstrap`:** inspect stderr for invalid RuntimeSpec, mount,
   TUN, resolver, route, capability, or bind failure.
2. **Exit 78 with `phase=runtime`:** inspect the preceding structured fatal
   record for HTTP service, UDP/TUN session, shutdown timeout, or child-process
   containment failure.
3. **`/status` is unreachable:** process is starting or the Runtime instance is
   invalid. The container platform may restart it; bootstrap must reconcile the
   Runtime-owned network state or fail closed.
4. **`/status` identity differs:** Runtime Controller or Agent Controller selected the wrong
   endpoint; never route work to it.
5. **`tools/list` fails after status succeeds:** inspect MCP discovery/transport
   and managed server health. Controller readiness uses platform health and
   `/status`, not a `tools/list` probe. ACP must fail preparation rather than
   invent an empty tool list; status alone does not prove discovery succeeds.
6. **`/status` succeeds but public traffic fails:** the Runtime-to-Egress packet
   path was ready at startup, but `/status` does not prove external reachability;
   inspect current Egress health, policy, DNS upstream, and destination state.
7. **A denied TCP connection hangs:** inspect Egress policy and its fast-reject
   path; Runtime does not evaluate policy locally.
8. **DNS fails:** inspect the UDP Egress endpoint, virtual resolver, and
   DNS-over-TCP upstream.
9. **A tool request times out or is canceled:** Runtime signals only this call's
   process group and reaps its direct Executor. Earlier background jobs remain
   alive. Deliberate detachment is not contained by this per-call mechanism.
   `bash`, `write`, and `edit` may report an unknown side-effect outcome; the
   Agent should inspect state before retrying.
10. **A second tool call returns `runtime_busy`:** the existing Executor still
    owns foreground admission. Retry after that call settles; this admission
    does not stop background processes from modifying the workspace.

## Recovery

Runtime is crash-only and disposable. If PID 1 exits, Controller marks that
endpoint unavailable and the container platform restarts or replaces it:

- Docker may restart the container or Runtime Controller may replace it;
- Kubernetes may restart the container in the retained Pod sandbox or Runtime Controller
  may replace the Pod;
- bootstrap removes only the exact Runtime-owned UID rule and two expected
  routes. It never flushes a routing table or deletes by priority alone. The
  fixed high-numbered table/priority are Runtime reservations; any remaining
  rule or route at those identifiers is treated as a platform conflict and
  bootstrap fails before installing Agent routing;
- Runtime Controller reattaches the persistent Agent workspace;
- same-deployment restart keeps generation but changes execution ID; each new
  Update/Enable allocates a new generation even with unchanged configuration;
- Runtime Controller records the new execution from platform health and
  `/status`. Agent Controller's observation consumer invalidates the old binding
  and requires explicit Rebuild before publishing a new executable binding;
  healthy container restart alone does not resume Agent routing. ACP owns later
  MCP discovery, not Runtime Controller.

Runtime does not implement restart, drain, retire, purge, or rollback methods.
Those are Runtime Controller and Agent Controller lifecycle effects.

Managed MCP secret values are read from the root-only private bootstrap mount
before dropping to the server UID; only that server receives them at exec. The
launcher and Docker environment contain descriptors only. Ordinary tools and
other managed server UIDs cannot read its proc environment or ptrace it. Use
trusted image-controlled MCP code when assigning credentials: mutable workspace
code and the server's own tool semantics are part of the administrator-selected
server's trust boundary. See the [shared secret contract](../../../contracts/runtime/managed-mcp-secrets.md).

Managed servers use UID-owned 0700 HOME/TMPDIR/XDG directories under the
root-owned 0711 tmpfs `/run/antnest-mcp-home`. RC sets exec/nosuid/nodev and
bounds all server caches together by `tmpfs_bytes`; standalone operators must
provide the same mount. The entry verifies its tmpfs type and ownership before
dropping privileges. MCP umask is 077, while cwd remains workspace. This also
protects default `/tmp` files from the common GID. Caches reset on restart and
may require OAuth reauthentication. UID rank uses sorted IDs; only reordering is
stable, not additions/removals. Trusted MCP code can still deliberately share
credentials or execute mutable workspace code; private cache isolation does not
contain those actions.
