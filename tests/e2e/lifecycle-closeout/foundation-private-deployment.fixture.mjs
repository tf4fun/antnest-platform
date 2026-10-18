import { applicationServices } from "./deployment.mjs";

export function foundationPrivateDeploymentFixture() {
  const project = "antnest-lifecycle-01234567";
  const config = {
    project,
    credentials: "/original-inner/credentials",
    env: {
      ANTNEST_SERVICE_NETWORK_PREFIX: "10.241.7",
      ANTNEST_POSTGRES_HOST_PORT: "45000",
      ANTNEST_JAEGER_UI_HOST_PORT: "45001",
      ANTNEST_EDGE_HOST_PORT: "45005",
      ANTNEST_LIFECYCLE_MODEL_HOST_PORT: "45006",
    },
    compose: (args) => ["base", ...args],
  };
  const row = (name, ports) => ({
    Config: {
      Labels: {
        "com.docker.compose.project": project,
        "com.docker.compose.service": name,
      },
      Image: "node:24.21.0-bookworm-slim",
    },
    State: { Running: true, Health: { Status: "healthy" } },
    HostConfig: { PortBindings: ports },
    NetworkSettings: { Ports: structuredClone(ports), Networks: {} },
  });
  const ports = (names, start = 45000) =>
    Object.fromEntries(
      names.map((port, i) => [
        `${port}/tcp`,
        [{ HostIp: "127.0.0.1", HostPort: String(start + i) }],
      ]),
    );
  const relay = row("diagnostic-relay", ports([5432, 16686, 58081, 58082]));
  const exporter = row("foundation-client-telemetry", ports([4318], 45004));
  Object.assign(exporter.Config, {
    User: "65532:65532",
    Cmd: [
      "node",
      "/opt/antnest/scripts/deployment/runtime-telemetry-ingress.mjs",
    ],
    Env: [
      "ANTNEST_SERVICE_NETWORK_PREFIX=10.241.7",
      "ANTNEST_RUNTIME_OTLP_INGRESS_IPV4=10.241.7.147",
    ],
  });
  Object.assign(exporter.HostConfig, {
    ReadonlyRootfs: true,
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges:true"],
  });
  exporter.Mounts = [
    "/opt/antnest/scripts/deployment",
    "/opt/antnest/contracts/platform/development-network-contract.json",
  ].map((Destination) => ({ Type: "bind", Destination, RW: false }));
  exporter.NetworkSettings.Networks = {
    [project + "_diagnostic-ingress"]: { IPAddress: "10.241.7.147" },
    [project + "_observability"]: { IPAddress: "10.241.7.126" },
  };
  const others = [
    ...applicationServices,
    "postgres",
    "temporal",
    "jaeger",
    "stage3-model",
    "runtime-telemetry-ingress",
  ].map((name) =>
    row(
      name,
      name === "edge-gateway"
        ? ports([8080], 45005)
        : name === "stage3-model"
          ? ports([8080], 45006)
          : {},
    ),
  );
  const images = Object.fromEntries(
    applicationServices.map((name, i) => [
      name,
      "sha256:" + String(i).repeat(64),
    ]),
  );
  for (const r of others) {
    r.Image = images[r.Config.Labels["com.docker.compose.service"]];
    if (r.Config.Labels["com.docker.compose.service"] === "jaeger")
      delete r.State.Health;
  }
  return {
    config,
    rows: [relay, exporter, ...others],
    relay,
    exporter,
    images,
  };
}
