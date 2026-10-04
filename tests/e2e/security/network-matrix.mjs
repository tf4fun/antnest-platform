import assert from "node:assert/strict";

export function planNetworkMatrix({
  project,
  topology,
  catalogs,
  networks,
  rows,
}) {
  const declared = new Set([
    ...Object.keys(topology.networks),
    ...Object.keys(topology.outbound_networks),
    ...Object.keys(topology.database_networks),
    "runtime-management",
  ]);
  const plans = new Map();
  for (const network of networks) {
    const key = network.Labels?.["com.docker.compose.network"];
    assert.equal(network.Labels?.["com.docker.compose.project"], project);
    assert(declared.has(key), `unclassified network: ${key}`);
    assert(!plans.has(network.Name), "duplicate network");
    plans.set(network.Name, {
      key,
      name: network.Name,
      id: network.Id,
      internal: network.Internal,
      probes: [],
    });
  }
  const owners = new Set();
  for (const row of rows) {
    assert.equal(row.Config.Labels["com.docker.compose.project"], project);
    const service = row.Config.Labels["com.docker.compose.service"];
    const catalog = catalogs[service];
    if (!catalog) continue;
    assert.equal(catalog.service, service);
    assert.equal(catalog.status, "enforced");
    assert(topology.listeners[service]);
    assert(!owners.has(service), "duplicate workload");
    owners.add(service);
    const listeners = Object.values(topology.listeners[service]);
    const control = new Set(topology.control_routes[service] ?? []);
    for (const [name, attachment] of Object.entries(
      row.NetworkSettings.Networks,
    )) {
      const plan = plans.get(name);
      assert(plan, `missing network inventory: ${name}`);
      assert.match(attachment.IPAddress, /^\d+\.\d+\.\d+\.\d+$/u);
      for (const port of new Set(listeners.map((listener) => listener.port))) {
        const listener = listeners.find(
          (candidate) =>
            candidate.network === plan.key && candidate.port === port,
        );
        if (!listener) {
          plan.probes.push({
            service,
            address: attachment.IPAddress,
            port,
            closed: true,
          });
          continue;
        }
        for (const [route, rule] of Object.entries(catalog.routes)) {
          if (rule.authentication !== "workload") continue;
          const [registeredMethod, path] = route.split(" ");
          const methods =
            registeredMethod === "*"
              ? ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
              : [registeredMethod === "UPGRADE" ? "GET" : registeredMethod];
          assert(
            methods.every((method) =>
              /^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/u.test(method),
            ),
            `unsupported protected route: ${route}`,
          );
          const wrongListener =
            listeners.length > 1 &&
            control.has(route) !== (port !== listeners[0].port);
          for (const method of methods)
            plan.probes.push({
              service,
              address: attachment.IPAddress,
              port,
              method,
              ...(registeredMethod === "UPGRADE" ? { upgrade: true } : {}),
              path: path.replace(/\{[^}]+\}/gu, "security-probe"),
              body: rule.request_body === "json",
              status: wrongListener ? 404 : 401,
            });
        }
      }
      if (["runtime-controller", "runtime-egress"].includes(service))
        plan.probes.push({
          service,
          address: attachment.IPAddress,
          port: 8082,
          closed: true,
        });
    }
  }
  assert.deepEqual(
    owners,
    new Set(Object.keys(catalogs)),
    "missing workload inventory",
  );
  const controlProbe = [...plans.values()]
    .find((plan) => plan.key === "controller-acp")
    ?.probes.find((probe) => probe.status === 401);
  assert(controlProbe, "missing ACP control probe");
  for (const plan of plans.values()) {
    if (plan.key !== "controller-acp")
      plan.probes.push({
        service: controlProbe.service,
        address: controlProbe.address,
        port: controlProbe.port,
        closed: true,
      });
    assert(plan.probes.length, `network has no probes: ${plan.key}`);
  }
  return [...plans.values()].sort((a, b) => a.key.localeCompare(b.key));
}
