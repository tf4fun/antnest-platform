import assert from "node:assert/strict";

export function planNetworkMatrix({
  project,
  topology,
  catalogs,
  networks,
  rows,
  profiles = [],
}) {
  assert(Array.isArray(profiles), "profiles must be an array");
  const declaredProfiles = new Set();
  for (const listeners of Object.values(topology.listeners))
    for (const [, listener] of Object.entries(listeners))
      if (listener.profile !== undefined)
        declaredProfiles.add(listener.profile);
  const enabledProfiles = new Set();
  for (const profile of profiles) {
    assert(
      typeof profile === "string" &&
        profile.length > 0 &&
        declaredProfiles.has(profile),
      "unknown listener profile",
    );
    assert(!enabledProfiles.has(profile), "duplicate listener profile");
    enabledProfiles.add(profile);
  }
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
  const privateListeners = [];
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
    const listeners = Object.entries(topology.listeners[service]);
    const control = new Set(topology.control_routes?.[service] ?? []);
    const owner = new Set(topology.owner_routes?.[service] ?? []);
    for (const route of owner)
      assert(!control.has(route), "route has multiple listener purposes");
    for (const [name, attachment] of Object.entries(
      row.NetworkSettings.Networks,
    )) {
      const plan = plans.get(name);
      assert(plan, `missing network inventory: ${name}`);
      assert.match(attachment.IPAddress, /^\d+\.\d+\.\d+\.\d+$/u);
      for (const port of new Set(
        listeners.map(([, listener]) => listener.port),
      )) {
        const matches = listeners.filter(
          ([, candidate]) =>
            candidate.network === plan.key && candidate.port === port,
        );
        assert(matches.length <= 1, "multiple purposes share one listener");
        const entry = matches[0];
        if (
          entry === undefined ||
          (entry[1].profile !== undefined &&
            !enabledProfiles.has(entry[1].profile))
        ) {
          plan.probes.push({
            service,
            address: attachment.IPAddress,
            port,
            closed: true,
          });
          continue;
        }
        const [purpose, listener] = entry;
        if (purpose === "control" || purpose === "owner")
          privateListeners.push({
            purpose,
            service,
            address: attachment.IPAddress,
            port,
            network: plan.key,
          });
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
          const routePurpose = owner.has(route)
            ? "owner"
            : control.has(route)
              ? "control"
              : "primary";
          const wrongListener =
            listener.authentication_before_routing !== true &&
            routePurpose !== purpose;
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
        if (
          listener.authentication_before_routing === true &&
          !plan.probes.some(
            (probe) =>
              probe.service === service &&
              probe.address === attachment.IPAddress &&
              probe.port === port &&
              probe.method === "GET" &&
              probe.path === "/status",
          )
        )
          plan.probes.push({
            service,
            address: attachment.IPAddress,
            port,
            method: "GET",
            path: "/status",
            body: false,
            status: 401,
          });
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
  for (const [service, listeners] of Object.entries(topology.listeners))
    for (const [purpose, listener] of Object.entries(listeners))
      if (
        listener.profile !== undefined &&
        enabledProfiles.has(listener.profile)
      )
        assert(
          privateListeners.some(
            (actual) =>
              actual.service === service &&
              actual.purpose === purpose &&
              actual.network === listener.network &&
              actual.port === listener.port,
          ),
          "enabled listener is missing from actual workload inventory",
        );
  const controlListener = privateListeners.find(
    (listener) =>
      listener.service === "agent-acp-service" &&
      listener.purpose === "control",
  );
  const controlProbe =
    controlListener === undefined
      ? undefined
      : [...plans.values()]
          .find((plan) => plan.key === controlListener.network)
          ?.probes.find(
            (probe) =>
              probe.service === controlListener.service &&
              probe.address === controlListener.address &&
              probe.port === controlListener.port &&
              probe.status === 401,
          );
  assert(controlProbe, "missing ACP control probe");
  for (const plan of plans.values()) {
    for (const listener of privateListeners)
      if (plan.key !== listener.network)
        plan.probes.push({
          service: listener.service,
          address: listener.address,
          port: listener.port,
          closed: true,
        });
    assert(plan.probes.length, `network has no probes: ${plan.key}`);
  }
  return [...plans.values()].sort((a, b) => a.key.localeCompare(b.key));
}
