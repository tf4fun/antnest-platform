// Controller-owned protocol peers: no actual RC, Runtime, ACP or Egress runs here.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";

export function executionPeers(fixture, stats, json) {
  const runtimes = new Map(),
    networks = new Map(),
    publications = new Map();
  let mode = "ready";
  Object.assign(stats, {
    resolves: 0,
    rejectedResolves: 0,
    privateApplies: 0,
    closedApplies: 0,
  });
  const network = (agent) => {
    if (!networks.has(agent))
      networks.set(agent, {
        agent_id: agent,
        tunnel_ipv4: "10.245.1.2",
        resolver_ipv4: "10.245.1.1",
        packet_contract_revision: 1,
        egress_endpoint: { ipv4: "10.244.1.3", port: 8083 },
        state: "active",
        network_resource_version: 1,
        attachment_state: "closed",
        attachment_resource_version: 1,
      });
    return networks.get(agent);
  };
  const inspection = (value) => {
    const { connection_id, token, ...publicValue } = value;
    return { ...publicValue, observed_at: new Date().toISOString() };
  };
  const handled = (w, value, status) => {
    json(w, value, status);
    return true;
  };
  return {
    setConnectionMode(value) {
      assert(["ready", "wrong-endpoint", "unavailable"].includes(value));
      mode = value;
    },
    handle(service, r, w, path, body) {
      if (service === "runtime-egress") {
        const allocation = /^\/internal\/agent-networks\/([^/]+)$/.exec(path);
        if (allocation && ["PUT", "GET"].includes(r.method))
          return handled(w, network(allocation[1]));
        const attachment =
          /^\/internal\/agent-network-attachments\/([^/]+)$/.exec(path);
        if (attachment && r.method === "PUT") {
          const value = network(attachment[1]);
          assert.equal(
            body.expected_resource_version,
            value.attachment_resource_version,
          );
          assert(["open", "closed"].includes(body.state));
          const peer = body.runtime_endpoint;
          if (body.state === "open") assert.equal(peer, "10.243.1.20");
          else assert.equal(peer, undefined);
          if (
            body.state !== value.attachment_state ||
            peer !== value.runtime_endpoint
          ) {
            value.attachment_state = body.state;
            value.attachment_resource_version++;
          }
          if (peer === undefined) delete value.runtime_endpoint;
          else value.runtime_endpoint = peer;
          return handled(w, value);
        }
      }
      if (service === "runtime-controller") {
        if (path === "/internal/runtimes")
          return handled(w, {
            runtimes: [...runtimes.values()].map(inspection),
          });
        if (path === "/internal/runtime-observations")
          return handled(w, {
            observations: [],
            oldest_sequence: 0,
            latest_sequence: 0,
            next_sequence: 0,
          });
        const prepare =
          /^\/internal\/runtimes\/([^/]+)\/skill-sets\/prepare$/.exec(path);
        if (prepare) {
          assert(r.headers["idempotency-key"]);
          return handled(
            w,
            {
              request_id: r.headers["idempotency-key"],
              agent_id: prepare[1],
              organization_id: body.organization_id,
              owner_operation_id: body.owner_operation_id,
              state: "ready",
              progress: {
                verified_packages: 1,
                total_packages: 1,
                verified_bytes: 128,
                total_bytes: 128,
              },
              prepared_skill_set: {
                skill_set_digest: body.skill_set_digest,
                layout_version: body.layout_version,
              },
              prepared_reference_id: "psr_11111111111111111111111111111111",
            },
            202,
          );
        }
        if (/\/skill-sets\/preparations\/[^/]+\/release$/.test(path)) {
          w.writeHead(204);
          w.end();
          return true;
        }
        const initialize = /^\/internal\/runtimes\/([^/]+)\/initialize$/.exec(
          path,
        );
        if (initialize) {
          assert.equal(r.method, "POST");
          assert(r.headers["idempotency-key"]);
          assert(
            !runtimes.has(initialize[1]),
            "initialize replay fixture must not allocate twice",
          );
          const value = {
            agent_id: initialize[1],
            runtime_revision: "rtv_" + randomBytes(16).toString("hex"),
            runtime_execution_id: randomUUID(),
            mcp_endpoint: "http://" + initialize[1] + ":8093/mcp",
            runtime_endpoint: "10.243.1.20",
            lifecycle_state: "provisioned",
            health: "healthy",
            phase: "running",
            ...fixture.runtimeAuthority,
          };
          runtimes.set(initialize[1], value);
          return handled(w, {
            request_id: r.headers["idempotency-key"],
            agent_id: value.agent_id,
            kind: "initialize_runtime",
            target_revision: value.runtime_revision,
            state: "completed",
            effect: "completed",
            inspection: {
              ...inspection(value),
              health: "unknown",
              runtime_execution_id: "",
              mcp_endpoint: "",
            },
          });
        }
        const connection = /^\/internal\/runtimes\/([^/]+)\/connection$/.exec(
          path,
        );
        if (connection) {
          stats.resolves++;
          assert.equal(r.method, "POST");
          assert.equal(r.headers["idempotency-key"], undefined);
          assert.equal(r.headers["antnest-caller-context"], undefined);
          assert.deepEqual(Object.keys(body).sort(), [
            "expected_execution_id",
            "runtime_revision",
          ]);
          const value = runtimes.get(connection[1]);
          assert(value);
          assert.equal(body.runtime_revision, value.runtime_revision);
          assert.equal(body.expected_execution_id, value.runtime_execution_id);
          if (mode !== "ready") stats.rejectedResolves++;
          if (mode === "unavailable")
            return handled(
              w,
              {
                code: "runtime_connection_unavailable",
                message: "Fixture unavailable",
                retryable: true,
              },
              503,
            );
          w.setHeader("cache-control", "no-store");
          return handled(w, {
            agent_id: value.agent_id,
            runtime_revision: value.runtime_revision,
            runtime_execution_id: value.runtime_execution_id,
            connection_id: value.connection_id,
            mcp_endpoint:
              mode === "wrong-endpoint"
                ? "http://wrong-runtime:8093/mcp"
                : value.mcp_endpoint,
            credential: { caller: "agent-acp-service", token: value.token },
          });
        }
        const disable = /^\/internal\/runtimes\/([^/]+)\/disable$/.exec(path);
        if (disable) {
          const value = runtimes.get(disable[1]);
          assert(value);
          assert.equal(body.expected_revision, value.runtime_revision);
          Object.assign(value, {
            runtime_revision: "rtv_" + randomBytes(16).toString("hex"),
            runtime_execution_id: "",
            mcp_endpoint: "",
            lifecycle_state: "disabled",
            health: "absent",
            phase: "absent",
          });
          return handled(w, {
            request_id: r.headers["idempotency-key"],
            agent_id: value.agent_id,
            kind: "disable_runtime",
            target_revision: value.runtime_revision,
            state: "completed",
            effect: "completed",
            inspection: inspection(value),
          });
        }
        const get = /^\/internal\/runtimes\/([^/]+)$/.exec(path);
        if (get && r.method === "GET") {
          const value = runtimes.get(get[1]);
          assert(value);
          return handled(w, inspection(value));
        }
      }
      if (service === "agent-acp-service") {
        assert.equal(r.headers["antnest-caller-context"], undefined);
        if (path === "/rpc/agent-acp/apply-execution-snapshot") {
          for (const agent of body.agents) {
            if (agent.accepting_runs) {
              const expected = runtimes.get(agent.agent_id);
              assert(expected);
              assert.equal(agent.runtime.connection_id, expected.connection_id);
              assert.equal(
                agent.runtime.runtime_revision,
                expected.runtime_revision,
              );
              assert.equal(
                agent.runtime.runtime_execution_id,
                expected.runtime_execution_id,
              );
              assert.equal(agent.runtime.mcp_endpoint, expected.mcp_endpoint);
              assert.deepEqual(agent.runtime.credential, {
                caller: "agent-acp-service",
                token: expected.token,
              });
              stats.privateApplies++;
            } else {
              assert.equal(agent.runtime?.credential, undefined);
              stats.closedApplies++;
            }
            stats.lastAgent = {
              agent_id: agent.agent_id,
              accepting_runs: agent.accepting_runs,
              connection_id: agent.runtime?.connection_id,
              token_hash: agent.runtime?.credential
                ? createHash("sha256")
                    .update(agent.runtime.credential.token)
                    .digest("hex")
                : null,
            };
          }
          publications.set(body.organization_id, body);
          return handled(w, {
            organization_id: body.organization_id,
            applied_revision: body.revision,
          });
        }
        if (path === "/rpc/agent-acp/settle-agent") {
          const snapshot = publications.get(body.organization_id);
          assert(snapshot);
          const agent = snapshot.agents.find(
            (a) => a.agent_id === body.agent_id,
          );
          assert(agent);
          assert.equal(agent.accepting_runs, false);
          assert.equal(agent.operation_id, body.operation_id);
          assert(snapshot.revision >= body.minimum_revision);
          return handled(w, {
            applied_revision: snapshot.revision,
            outcome: "settled",
          });
        }
      }
      return false;
    },
  };
}
