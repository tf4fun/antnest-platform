import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { composeConfig } from "../../support/compose-config.mjs";

const root = new URL("../../../", import.meta.url);
const credentials = JSON.parse(
  readFileSync(
    new URL(
      "contracts/platform/development-authentication-contract.json",
      root,
    ),
    "utf8",
  ),
);
const topology = JSON.parse(
  readFileSync(
    new URL("contracts/platform/development-network-contract.json", root),
    "utf8",
  ),
);
const applications = Object.keys(credentials.static_services);
const binds = {
  "identity-service": "ANTNEST_IDENTITY_LISTEN",
  "edge-gateway": "ANTNEST_EDGE_LISTEN",
  "admin-console": "ANTNEST_ADMIN_CONSOLE_LISTEN",
  "agent-controller": "ANTNEST_AGENT_CONTROLLER_LISTEN",
  "agent-acp-service": "ANTNEST_ACP_LISTEN",
  "runtime-controller": "ANTNEST_RUNTIME_CONTROLLER_LISTEN",
  "skill-registry": "ANTNEST_SKILL_REGISTRY_LISTEN",
  "runtime-egress": "ANTNEST_EGRESS_CONTROL_LISTEN",
};
const base = composeConfig();

test("optional observability outlives every exporter during normal Compose stop", () => {
  for (const name of applications) {
    assert.deepEqual(
      base.services[name].depends_on.jaeger,
      {
        condition: "service_started",
        required: false,
      },
      name,
    );
  }
  assert.equal(
    base.services["runtime-telemetry-ingress"].depends_on.jaeger.condition,
    "service_started",
  );
});

test("production-image admission changes image ownership without weakening deployment boundaries", () => {
  const candidate = composeConfig(
    ["compose.yaml", "tests/integration/deployment/compose.admission.yaml"],
    {
      ANTNEST_ADMISSION_TAG: "contract-isolated",
    },
  );
  for (const name of [...applications, "temporal"]) {
    const {
      image: originalImage,
      build: originalBuild,
      ...original
    } = structuredClone(base.services[name]);
    const { image, build, ...actual } = structuredClone(
      candidate.services[name],
    );
    assert.equal(image, `antnest/${name}:contract-isolated`, name);
    assert.equal(
      typeof build.labels["io.antnest.deployment-admission"],
      "string",
    );
    delete build.labels;
    assert.deepEqual(build, originalBuild, `${name} build input`);
    if (name === "runtime-controller") {
      assert.equal(
        actual.environment.ANTNEST_RUNTIME_SKILL_PREPARER_IMAGE,
        "antnest/runtime-controller:contract-isolated",
      );
      delete actual.environment.ANTNEST_RUNTIME_SKILL_PREPARER_IMAGE;
      delete original.environment.ANTNEST_RUNTIME_SKILL_PREPARER_IMAGE;
    }
    assert.deepEqual(
      actual,
      original,
      `${name} owning-image admission changes no boundary`,
    );
    void originalImage;
  }
});
function mounted(service, target) {
  const mounts = service.volumes.filter((volume) => volume.target === target);
  assert.equal(mounts.length, 1, target);
  const [mount] = mounts;
  assert.equal(mount.type, "bind", target);
  assert.equal(mount.read_only, true, target);
  assert.equal(mount.bind.create_host_path, false, target);
  return mount.source;
}
function address(listener, prefix = "10.241.0") {
  return listener.network === "control"
    ? "172.31.255.3"
    : `${prefix}.${listener.address_suffix}`;
}

test("every static workload opts into the exact token/HTTP profile and only its own private files", () => {
  for (const name of applications) {
    const service = base.services[name];
    assert.equal(service.environment.ANTNEST_SERVICE_AUTH_MODE, "token", name);
    assert.equal(
      service.environment.ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT,
      "true",
      name,
    );
    assert.equal(
      service.environment.ANTNEST_SERVICE_AUTH_CALLERS_FILE,
      "/etc/antnest/service-auth/callers.json",
      name,
    );
    assert.equal(
      service.environment.ANTNEST_SERVICE_AUTH_TOKEN_DIR,
      "/etc/antnest/service-auth/tokens",
      name,
    );
    assert.equal(
      mounted(service, "/etc/antnest/service-auth/callers.json"),
      `/never-mounted-deployment-credentials/${name}/callers.json`,
    );
    assert.equal(
      mounted(service, "/etc/antnest/service-auth/tokens"),
      `/never-mounted-deployment-credentials/${name}/tokens`,
    );
    if (!["runtime-controller", "runtime-egress"].includes(name))
      assert.equal(service.user, "65532:65532", name);
    assert(
      !service.volumes.some(
        (volume) => volume.source === "/never-mounted-deployment-credentials",
      ),
      name,
    );
  }
});

test("bootstrap keys are separate readonly owner mounts and retired credential channels disappear", () => {
  const identity = base.services["identity-service"],
    runtime = base.services["runtime-controller"];
  assert.equal(
    identity.environment.ANTNEST_IDENTITY_CCT_SIGNING_KID,
    "wiring-contract-unused",
  );
  assert.equal(
    mounted(
      identity,
      identity.environment.ANTNEST_IDENTITY_CCT_SIGNING_KEY_FILE,
    ),
    "/never-mounted-deployment-credentials/identity-service/cct-signing.pem",
  );
  assert.equal(
    mounted(identity, identity.environment.ANTNEST_IDENTITY_CCT_JWKS_FILE),
    "/never-mounted-deployment-credentials/identity-service/cct-jwks.json",
  );
  assert.equal(
    mounted(runtime, runtime.environment.ANTNEST_RUNTIME_INSTANCE_KEY_FILE),
    "/never-mounted-deployment-credentials/runtime-controller/instance-master.key",
  );
  for (const name of applications)
    for (const key of [
      "ANTNEST_SKILL_REGISTRY_API_TOKEN",
      "ANTNEST_SKILL_REGISTRY_SOURCE_TOKEN",
      "ANTNEST_ACP_SKILL_REGISTRY_TOKEN",
      "ANTNEST_ACP_SKILL_SOURCE_TOKEN",
    ])
      assert.equal(
        base.services[name].environment[key],
        undefined,
        `${name} retires ${key}`,
      );
  assert.equal(
    base.services["agent-controller"].environment.ANTNEST_AGENT_ACP_SERVICE_URL,
    undefined,
  );
  assert.equal(
    identity.environment.ANTNEST_IDENTITY_PUBLIC_BASE_URL,
    "http://127.0.0.1:8090",
  );
});

test("actual Compose networks implement every fixed purpose member and listener", () => {
  assert.equal(base.networks.development, undefined);
  for (const [name, network] of Object.entries(topology.networks)) {
    assert.equal(base.networks[name].internal ?? false, network.internal, name);
    if (!network.subnet_environment)
      assert.equal(
        base.networks[name].ipam.config[0].subnet,
        `10.241.0.${network.subnet_suffix}/28`,
        name,
      );
    for (const [member, suffix] of Object.entries(network.members)) {
      assert(base.services[member].networks[name], `${member}->${name}`);
      const expected =
        name === "control" ? `172.31.255.${suffix}` : `10.241.0.${suffix}`;
      assert.equal(base.services[member].networks[name].ipv4_address, expected);
    }
  }
  for (const [name, definition] of Object.entries(topology.listeners)) {
    const { primary } = definition;
    if (name === "agent-ui") {
      assert.equal(
        base.services[name].environment.ANTNEST_AGENT_UI_BRIDGE_HOST,
        address(primary),
      );
      assert.equal(
        base.services[name].environment.ANTNEST_AGENT_UI_BRIDGE_PORT,
        String(primary.port),
      );
    } else
      assert.equal(
        base.services[name].environment[binds[name]],
        `${address(primary)}:${primary.port}`,
        name,
      );
  }
  assert.equal(
    base.services["agent-acp-service"].environment.ANTNEST_ACP_CONTROL_LISTEN,
    "10.241.0.34:8081",
  );
  assert.equal(
    base.services["agent-controller"].environment.ANTNEST_AGENT_ACP_CONTROL_URL,
    "http://agent-acp-control:8081",
  );
  assert.deepEqual(base.services["runtime-egress"].healthcheck.test, [
    "CMD",
    "/usr/local/bin/runtime-egress",
    "--healthcheck",
  ]);
});

test("every workload destination maps to its receiving interface and owns an allowed route", () => {
  for (const [caller, destinations] of Object.entries(topology.destinations)) {
    const hosts = Object.fromEntries(
      base.services[caller].extra_hosts.map((entry) => entry.split("=")),
    );
    for (const [host, destination] of Object.entries(destinations)) {
      const receiver =
        topology.listeners[destination.receiver][destination.listener];
      assert.equal(hosts[host], address(receiver), `${caller}->${host}`);
    }
  }
  for (const [name, variable] of [
    ["agent-acp-service", "ANTNEST_ACP_IDENTITY_URL"],
    ["skill-registry", "ANTNEST_IDENTITY_URL"],
    ["agent-ui", "ANTNEST_AGENT_UI_IDENTITY_URL"],
  ])
    assert.equal(
      base.services[name].environment[variable],
      "http://identity-service:8080",
    );
  assert.equal(
    base.services["edge-gateway"].environment.ANTNEST_AGENT_ACP_URL,
    "http://agent-acp-workspace:8080",
  );
  assert.equal(
    base.services["agent-ui"].environment.ANTNEST_AGENT_ACP_SERVICE_URL,
    "http://agent-acp-workspace:8080",
  );
});

test("management, owner databases, Provider and gateway ingress have exact memberships", () => {
  const members = (network) =>
    Object.entries(base.services)
      .filter(([, service]) => service.networks?.[network])
      .map(([name]) => name)
      .sort();
  assert.deepEqual(
    members("runtime-management"),
    [...topology.runtime_management.static_members].sort(),
  );
  assert.equal(
    base.networks["runtime-management"].ipam.config[0].ip_range,
    "172.30.255.128/25",
  );
  for (const [name, network] of Object.entries(topology.database_networks)) {
    assert.equal(base.networks[name].internal, true, name);
    assert(base.services[network.owner].networks[name], name);
    assert(base.services.postgres.networks[name], name);
  }
  for (const [name, network] of Object.entries(topology.outbound_networks)) {
    assert.equal(base.networks[name].internal ?? false, false, name);
    const expected = [
      ...network.members,
      ...(["controller-provider", "acp-provider"].includes(name)
        ? ["stage2-model", "stage3-model"]
        : []),
    ];
    assert.deepEqual(members(name), expected.sort(), name);
  }
  assert.deepEqual(members("gateway-ingress"), ["edge-gateway"]);
  assert.deepEqual(members("diagnostic-ingress"), ["diagnostic-relay"]);
  assert.equal(
    base.services["edge-gateway"].networks["gateway-ingress"].gw_priority,
    1,
  );
});

test("infrastructure transports have only public readonly mounts and no authority files", () => {
  for (const name of ["diagnostic-relay", "runtime-telemetry-ingress"]) {
    const service = base.services[name];
    assert.equal(service.image, "node:24.21.0-bookworm-slim");
    assert.equal(service.user, "65532:65532");
    assert.equal(service.read_only, true);
    assert.deepEqual(service.cap_drop, ["ALL"]);
    assert.deepEqual(service.security_opt, ["no-new-privileges:true"]);
    assert.equal(service.ports?.length ?? 0, 0);
    assert(
      service.volumes.every(
        (volume) =>
          volume.type === "bind" &&
          volume.read_only &&
          !volume.source.startsWith("/never-mounted-deployment-credentials"),
      ),
    );
  }
  assert.equal(
    base.services["runtime-telemetry-ingress"].environment
      .ANTNEST_RUNTIME_OTLP_INGRESS_IPV4,
    "172.30.255.4",
  );
  assert.equal(
    base.services["runtime-controller"].environment
      .ANTNEST_RUNTIME_OTEL_EXPORTER_OTLP_ENDPOINT,
    "http://172.30.255.4:4318",
  );
});

test("deployment overrides move all purpose listeners and private mounts together", () => {
  const config = composeConfig(["compose.yaml"], {
    ANTNEST_SERVICE_NETWORK_PREFIX: "10.246.17",
    ANTNEST_SERVICE_AUTH_UID: "10001",
    ANTNEST_SERVICE_AUTH_GID: "10002",
    ANTNEST_SERVICE_AUTH_DIRECTORY: "/never-mounted-alternate-credentials",
  });
  for (const name of applications) {
    if (!["runtime-controller", "runtime-egress"].includes(name))
      assert.equal(config.services[name].user, "10001:10002", name);
    assert.equal(
      mounted(config.services[name], "/etc/antnest/service-auth/callers.json"),
      `/never-mounted-alternate-credentials/${name}/callers.json`,
    );
    const { primary } = topology.listeners[name];
    if (name === "agent-ui")
      assert.equal(
        config.services[name].environment.ANTNEST_AGENT_UI_BRIDGE_HOST,
        address(primary, "10.246.17"),
      );
    else
      assert.equal(
        config.services[name].environment[binds[name]],
        `${address(primary, "10.246.17")}:${primary.port}`,
        name,
      );
  }
});

test("Skill discovery/source capabilities are enabled by maintenance keys without retired tokens", () => {
  assert.equal(
    base.services["agent-acp-service"].environment
      .ANTNEST_ACP_SKILL_REGISTRY_URL,
    "",
  );
  assert.equal(
    base.services["skill-registry"].environment
      .ANTNEST_SKILL_REGISTRY_SOURCE_URL,
    "",
  );
  const enabled = composeConfig(["compose.yaml"], {
    ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY: "fixture-config-marker",
  });
  assert.equal(
    enabled.services["agent-acp-service"].environment
      .ANTNEST_ACP_SKILL_REGISTRY_URL,
    "http://skill-registry:8080",
  );
  assert.equal(
    enabled.services["skill-registry"].environment
      .ANTNEST_SKILL_REGISTRY_SOURCE_URL,
    "http://agent-acp-workspace:8080",
  );
  assert.equal(
    enabled.services["agent-controller"].environment
      .ANTNEST_PROVIDER_ALLOW_PRIVATE_ENDPOINTS,
    "false",
  );
  assert.equal(
    enabled.services["agent-acp-service"].environment
      .ANTNEST_PROVIDER_ALLOW_PRIVATE_ENDPOINTS,
    "false",
  );
});
