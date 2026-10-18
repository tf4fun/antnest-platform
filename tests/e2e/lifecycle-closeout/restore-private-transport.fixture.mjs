export function restoreTransportFixture() {
  const project = "antnest-lifecycle-12345678";
  const privateAccess = {
    acp: "http://127.0.0.1:45002",
    identity: "http://127.0.0.1:45003",
    otlp: "http://127.0.0.1:45004/v1/traces",
    credentials: "/fixture/credentials",
  };
  const jaeger = "http://127.0.0.1:45001";
  const rows = [
    "diagnostic-relay",
    "foundation-client-telemetry",
    "jaeger",
  ].map((name, i) => ({
    Id: "container-" + name,
    Image: "sha256:" + String(i).repeat(64),
    RestartCount: 0,
    Config: {
      Labels: {
        "com.docker.compose.project": project,
        "com.docker.compose.service": name,
      },
    },
    State: {
      Running: true,
      StartedAt: "2026-10-19T00:00:00Z",
      ...(name === "jaeger" ? {} : { Health: { Status: "healthy" } }),
    },
    NetworkSettings: {
      Ports:
        name === "diagnostic-relay"
          ? Object.fromEntries(
              [5432, 16686, 58081, 58082].map((port, index) => [
                port + "/tcp",
                [{ HostIp: "127.0.0.1", HostPort: String(45000 + index) }],
              ]),
            )
          : name === "foundation-client-telemetry"
            ? { "4318/tcp": [{ HostIp: "127.0.0.1", HostPort: "45004" }] }
            : {},
    },
  }));
  return { project, privateAccess, jaeger, rows };
}
