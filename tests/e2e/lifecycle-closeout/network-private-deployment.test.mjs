import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { foundationPrivateDeploymentFixture } from "./foundation-private-deployment.fixture.mjs";
import { inspectFoundationDeployment } from "./foundation-setup.mjs";
import { assertDeployment } from "./deployment.mjs";
const url = new URL("./network-private-deployment.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
function fixture() {
  const f = foundationPrivateDeploymentFixture();
  f.config.resolvedImage = "sha256:" + "a".repeat(64);
  const target = {
    Config: {
      Labels: {
        "com.docker.compose.project": f.config.project,
        "com.docker.compose.service": "network-target",
      },
    },
    Image: f.config.resolvedImage,
    State: { Running: true, Health: { Status: "healthy" } },
    HostConfig: { PortBindings: {}, CapDrop: ["ALL"], CapAdd: ["NET_ADMIN"] },
    NetworkSettings: {
      Ports: {},
      Networks: { [f.config.project + "_egress"]: {} },
    },
  };
  f.rows.push(target);
  return { ...f, target };
}
test("Network verifies seventeen raw services then preserves Foundation's fifteen services and nine images", () => {
  assert.equal(
    typeof implementation.inspectNetworkPrivateDeployment,
    "function",
  );
  const f = fixture(),
    before = structuredClone(f.rows);
  const base = implementation.inspectNetworkPrivateDeployment(f.rows, f.config);
  assert.deepEqual(f.rows, before);
  assert.equal(f.rows.length, 17);
  assert.equal(inspectFoundationDeployment(base, f.config).services, 15);
  assert.equal(
    assertDeployment(
      f.config,
      base.map((r) => ({
        labels: r.Config.Labels,
        image: r.Image,
        running: r.State.Running,
        health: r.State.Health?.Status ?? "none",
        ports: r.NetworkSettings.Ports,
      })),
      f.images,
    ).applicationImages,
    9,
  );
  assert.equal(f.config.privateAccess.acp, "http://127.0.0.1:45002");
  const source = readFileSync(
    new URL("./foundation-run.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /if \(profile === "network"\) configureFoundationPrivate\(config\)/u,
  );
  assert.match(source, /inspectNetworkPrivateDeployment\(rows, config\)/u);
  assert.match(source, /admission = networkPrivateAdmission\(result\)/u);
});
for (const [name, mutate] of [
  ["extra service", (f) => f.rows.push(structuredClone(f.target))],
  [
    "public ACP",
    (f) => (f.relay.NetworkSettings.Ports["58081/tcp"][0].HostIp = "0.0.0.0"),
  ],
  ["missing exporter", (f) => f.rows.splice(f.rows.indexOf(f.exporter), 1)],
  [
    "target host port",
    (f) =>
      (f.target.HostConfig.PortBindings["18080/tcp"] = [
        { HostIp: "127.0.0.1", HostPort: "18080" },
      ]),
  ],
  [
    "foreign target network",
    (f) => (f.target.NetworkSettings.Networks.extra = {}),
  ],
  ["wrong target image", (f) => (f.target.Image = "foreign")],
])
  test(`Network deployment rejects ${name}`, () => {
    assert.equal(
      typeof implementation.inspectNetworkPrivateDeployment,
      "function",
    );
    const f = fixture();
    mutate(f);
    assert.throws(() =>
      implementation.inspectNetworkPrivateDeployment(f.rows, f.config),
    );
  });
