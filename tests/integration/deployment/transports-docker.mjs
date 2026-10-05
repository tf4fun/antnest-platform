import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  dockerClient,
  lines,
  networkOctet,
} from "../../e2e/lifecycle-closeout/docker.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const project = `antnest-transports-${randomUUID().slice(0, 8)}`;
const label = `io.antnest.deployment-transports=${project}`;
const output = `${root}artifacts/verification/${project}`;
mkdirSync(output, { recursive: true, mode: 0o700 });
const controller = new AbortController(),
  interrupt = () => controller.abort();
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, interrupt);
const docker = dockerClient(process.env, controller.signal, 240000);
const cleanup = dockerClient(process.env, undefined, 120000);
const baseline = {};
for (const [kind, args] of [
  ["container", ["ps", "-aq"]],
  ["network", ["network", "ls", "-q"]],
  ["volume", ["volume", "ls", "-q"]],
])
  baseline[kind] = lines(await docker(args)).sort();
const octet = await networkOctet(docker, 1 + (process.pid % 200));
const prefix = `10.242.${octet}`,
  management = `10.243.${octet}`;
const networks = Object.fromEntries(
  ["receiver", "observation", "ingress", "management"].map((name) => [
    name,
    `${project}-${name}`,
  ]),
);
const report = {
  project,
  checks: 0,
  scope: "deployment-transport-fixtures",
  cleanup: false,
};
let primaryError, cleanupError;
function checked(condition, message) {
  assert(condition, message);
  report.checks++;
}
async function healthy(id) {
  const deadline = Date.now() + 20000;
  let row;
  do {
    row = JSON.parse(await docker(["inspect", id]))[0];
    if (row.State.Health?.Status === "healthy") return row;
    assert(row.State.Running, "owned transport did not stay running");
    assert(Date.now() < deadline, "owned transport health did not settle");
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (row.State.Health?.Status !== "healthy");
}
async function create(
  name,
  network,
  ip,
  env,
  command,
  health,
  publications = [],
) {
  return docker([
    "create",
    "--name",
    `${project}-${name}`,
    "--label",
    label,
    "--network",
    network,
    "--ip",
    ip,
    "--user",
    "65532:65532",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--env",
    `ANTNEST_SERVICE_NETWORK_PREFIX=${prefix}`,
    ...Object.entries(env).flatMap(([key, value]) => [
      "--env",
      `${key}=${value}`,
    ]),
    "--mount",
    `type=bind,src=${root}scripts/deployment,dst=/opt/antnest/scripts/deployment,readonly`,
    "--mount",
    `type=bind,src=${root}contracts/platform/development-network-contract.json,dst=/opt/antnest/contracts/platform/development-network-contract.json,readonly`,
    "--mount",
    `type=bind,src=${root}tests/integration/deployment/fixtures/transport-peer.mjs,dst=/peer.mjs,readonly`,
    ...publications.flatMap((port) => ["--publish", `127.0.0.1::${port}`]),
    "--health-cmd",
    health,
    "--health-interval",
    "1s",
    "--health-timeout",
    "3s",
    "--health-retries",
    "15",
    "node:24.21.0-bookworm-slim",
    "node",
    ...command,
  ]);
}
async function execute(id, code) {
  return JSON.parse(
    await docker(["exec", id, "node", "--input-type=module", "-e", code]),
  );
}
const fetchCode = (url, options = {}) =>
  `const r=await fetch(${JSON.stringify(url)},{...${JSON.stringify(options)},signal:AbortSignal.timeout(2000)});console.log(JSON.stringify({status:r.status,headers:Object.fromEntries(r.headers),body:await r.text()}));`;
const denyCode = (urls) =>
  `const results=[];for(const url of ${JSON.stringify(urls)}){try{const r=await fetch(url,{signal:AbortSignal.timeout(500)});await r.arrayBuffer();results.push(false);}catch{results.push(true);}}console.log(JSON.stringify(results));`;

try {
  for (const [name, subnet, internal] of [
    ["receiver", `${prefix}.48/28`, true],
    ["observation", `${prefix}.112/28`, true],
    ["ingress", `${prefix}.144/28`, false],
    ["management", `${management}.0/24`, true],
  ])
    await docker([
      "network",
      "create",
      "--subnet",
      subnet,
      "--label",
      label,
      ...(internal ? ["--internal"] : []),
      networks[name],
    ]);

  const receiver = await create(
    "receiver",
    networks.receiver,
    `${prefix}.50`,
    { TRANSPORT_PEER_KIND: "receiver" },
    ["/peer.mjs"],
    `node -e "fetch('http://${prefix}.50:8080/').then(r=>{if(r.status!==401)process.exit(1)}).catch(()=>process.exit(1))"`,
  );
  await docker([
    "network",
    "connect",
    "--ip",
    `${management}.5`,
    networks.management,
    receiver,
  ]);
  await docker(["start", receiver]);
  await healthy(receiver);
  const collector = await create(
    "collector",
    networks.observation,
    `${prefix}.114`,
    { TRANSPORT_PEER_KIND: "collector" },
    ["/peer.mjs"],
    `node -e "fetch('http://${prefix}.114:16686/').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"`,
  );
  await docker(["start", collector]);
  await healthy(collector);

  const relay = await create(
    "relay",
    networks.receiver,
    `${prefix}.52`,
    {},
    ["/opt/antnest/scripts/deployment/diagnostic-relay.mjs"],
    `node -e "const n=require('node:net').connect(58080,'${prefix}.146',()=>n.end());n.on('error',()=>process.exit(1))"`,
    [58080, 16686],
  );
  await docker([
    "network",
    "connect",
    "--gw-priority",
    "1",
    "--ip",
    `${prefix}.146`,
    networks.ingress,
    relay,
  ]);
  await docker([
    "network",
    "connect",
    "--ip",
    `${prefix}.125`,
    networks.observation,
    relay,
  ]);
  await docker(["start", relay]);
  const relayRow = await healthy(relay);
  checked(
    relayRow.HostConfig.ReadonlyRootfs &&
      relayRow.Config.User === "65532:65532",
    "relay privilege boundary",
  );
  checked(
    relayRow.Mounts.every(
      (mount) =>
        !mount.RW &&
        !/authentication|docker\.sock|workspace/u.test(mount.Source),
    ),
    "relay has only readonly public source mounts",
  );
  const ports = relayRow.NetworkSettings.Ports;
  const receiverPort = ports["58080/tcp"][0],
    uiPort = ports["16686/tcp"][0];
  checked(
    receiverPort.HostIp === "127.0.0.1" && uiPort.HostIp === "127.0.0.1",
    "diagnostics stay on host loopback",
  );
  const host = `http://127.0.0.1:${receiverPort.HostPort}`;
  const missing = await fetch(host, { signal: AbortSignal.timeout(3000) });
  await missing.arrayBuffer();
  checked(missing.status === 401, "relay did not add authentication authority");
  const accepted = await fetch(host, {
    headers: {
      "Antnest-Service-Authorization": "Bearer fixture-exact",
      "Antnest-Caller-Context": "fixture-cct",
    },
    signal: AbortSignal.timeout(3000),
  });
  const received = await accepted.json();
  checked(
    accepted.status === 200 &&
      received.service_authorization === "Bearer fixture-exact" &&
      received.caller_context === "fixture-cct",
    "opaque authority bytes are preserved",
  );
  const ui = await fetch(`http://127.0.0.1:${uiPort.HostPort}`, {
    signal: AbortSignal.timeout(3000),
  });
  checked(
    ui.status === 200 && (await ui.json()).surface === "query-ui",
    "diagnostics select the observation target",
  );
  checked(
    (
      await execute(
        relay,
        denyCode([`http://${prefix}.52:58080/`, `http://${prefix}.125:58080/`]),
      )
    ).every(Boolean),
    "relay binds only its explicit ingress interface",
  );

  const ingress = await create(
    "otlp",
    networks.management,
    `${management}.4`,
    { ANTNEST_RUNTIME_OTLP_INGRESS_IPV4: `${management}.4` },
    ["/opt/antnest/scripts/deployment/runtime-telemetry-ingress.mjs"],
    `node -e "fetch('http://${management}.4:4318/v1/traces').then(r=>{if(r.status!==405)process.exit(1)}).catch(()=>process.exit(1))"`,
  );
  await docker([
    "network",
    "connect",
    "--ip",
    `${prefix}.124`,
    networks.observation,
    ingress,
  ]);
  await docker(["start", ingress]);
  const ingressRow = await healthy(ingress);
  checked(
    !Object.values(ingressRow.NetworkSettings.Ports).some(
      (value) => value?.length,
    ),
    "OTLP has no published host endpoint",
  );
  checked(
    ingressRow.HostConfig.ReadonlyRootfs &&
      ingressRow.Config.User === "65532:65532",
    "OTLP privilege boundary",
  );
  const probe = await create(
    "probe",
    networks.management,
    `${management}.12`,
    { PROBE_ADDRESS: `${management}.12` },
    ["/peer.mjs"],
    `node -e "fetch('http://${management}.12:8080/').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"`,
  );
  await docker(["start", probe]);
  await healthy(probe);
  for (const path of ["/v1/traces", "/v1/metrics", "/v1/logs"]) {
    const result = await execute(
      probe,
      fetchCode(`http://${management}.4:4318${path}`, {
        method: "POST",
        body: "fixture-otlp",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer fixture-authority",
          "Antnest-Caller-Context": "fixture-cct",
        },
      }),
    );
    const body = JSON.parse(result.body);
    checked(
      result.status === 200 &&
        body.path === path &&
        body.body === Buffer.from("fixture-otlp").toString("base64"),
      "OTLP path and wire bytes preserved",
    );
    checked(
      body.headers.authorization === undefined &&
        body.headers["antnest-caller-context"] === undefined &&
        result.headers["set-cookie"] === undefined,
      "OTLP forwards no authority",
    );
  }
  checked(
    (await execute(probe, fetchCode(`http://${management}.4:4318/api/traces`)))
      .status === 404,
    "management cannot query the collector through ingress",
  );
  checked(
    (
      await execute(
        probe,
        `const r=await fetch('http://${management}.4:4318/v1/traces',{method:'POST',body:Buffer.alloc(8388609),signal:AbortSignal.timeout(5000)});await r.arrayBuffer();console.log(JSON.stringify({status:r.status}));`,
      )
    ).status === 413,
    "actual CLI wire-body cap",
  );
  checked(
    (
      await execute(
        probe,
        denyCode([
          `http://${management}.5:8080/`,
          `http://${management}.4:16686/`,
          `http://${prefix}.114:16686/`,
        ]),
      )
    ).every(Boolean),
    "management cannot reach business/query/observation interfaces",
  );
  checked(
    (
      await execute(ingress, denyCode([`http://${prefix}.124:4318/v1/traces`]))
    ).every(Boolean),
    "OTLP binds only the management ingress interface",
  );

  await docker(["kill", "--signal=SIGINT", relay]);
  checked((await docker(["wait", relay])) === "0", "relay normal SIGINT exit");
  await docker(["stop", "--time", "5", ingress]);
  checked(
    JSON.parse(await docker(["inspect", ingress]))[0].State.ExitCode === 0,
    "OTLP normal SIGTERM exit",
  );
} catch (error) {
  primaryError = error;
} finally {
  try {
    const failures = [];
    for (const id of lines(
      await cleanup(["ps", "-aq", "--filter", `label=${label}`]),
    )) {
      const row = JSON.parse(await cleanup(["inspect", id]))[0];
      assert.equal(
        row.Config.Labels["io.antnest.deployment-transports"],
        project,
      );
      if (row.State.Running) await cleanup(["stop", "--time", "5", id]);
      const stopped = JSON.parse(await cleanup(["inspect", id]))[0];
      if (stopped.State.ExitCode !== 0)
        failures.push(
          new Error("owned transport/fixture did not stop normally"),
        );
      await cleanup(["rm", id]);
    }
    for (const id of lines(
      await cleanup(["network", "ls", "-q", "--filter", `label=${label}`]),
    ))
      await cleanup(["network", "rm", id]);
    for (const [kind, args] of [
      ["container", ["ps", "-aq"]],
      ["network", ["network", "ls", "-q"]],
      ["volume", ["volume", "ls", "-q"]],
    ])
      assert.deepEqual(
        lines(await cleanup(args)).sort(),
        baseline[kind],
        `${kind} baseline changed`,
      );
    report.cleanup = true;
    if (failures.length)
      cleanupError = new AggregateError(
        failures,
        "transport shutdown admission failed",
      );
  } catch (error) {
    cleanupError = error;
  }
  for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, interrupt);
  writeFileSync(
    `${output}/result.json`,
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600, flag: "wx" },
  );
}
if (primaryError || cleanupError)
  throw new AggregateError(
    [primaryError, cleanupError].filter(Boolean),
    "deployment transport acceptance failed",
  );
console.log(JSON.stringify(report));
