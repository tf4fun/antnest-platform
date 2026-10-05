import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  dockerClient,
  networkOctet,
  lines,
} from "../lifecycle-closeout/docker.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const project = `antnest-control-routing-${randomUUID().slice(0, 8)}`;
const label = `io.antnest.control-routing=${project}`;
const output = `${root}/artifacts/verification/${project}`;
mkdirSync(output, { recursive: true, mode: 0o700 });
const abort = new AbortController();
const stop = () => abort.abort();
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
const docker = dockerClient(process.env, abort.signal, 120000);
const cleanup = dockerClient(process.env, undefined, 60000);
const report = { project, observations: [], cleanup: false };
const before = {};
for (const [kind, args] of [
  ["container", ["ps", "-aq"]],
  ["network", ["network", "ls", "-q"]],
  ["volume", ["volume", "ls", "-q"]],
])
  before[kind] = lines(await docker(args)).sort();
const octet = await networkOctet(docker, 1 + (process.pid % 200));
const purpose = `10.242.${octet}.2`,
  outbound = `10.243.${octet}.2`;
let failure;
try {
  for (const mode of ["default", "nat", "isolated"]) {
    const controlName = `${project}-${mode}-control`,
      outsideName = `${project}-${mode}-outside`,
      server = `${project}-${mode}-server`,
      peer = `${project}-${mode}-peer`;
    await docker([
      "network",
      "create",
      "--internal",
      "--subnet",
      `10.242.${octet}.0/28`,
      "--label",
      label,
      ...(mode === "default"
        ? []
        : ["-o", `com.docker.network.bridge.gateway_mode_ipv4=${mode}`]),
      controlName,
    ]);
    await docker([
      "network",
      "create",
      "--subnet",
      `10.243.${octet}.0/28`,
      "--label",
      label,
      outsideName,
    ]);
    await docker([
      "create",
      "--name",
      server,
      "--label",
      label,
      "--network",
      controlName,
      "--ip",
      purpose,
      "--expose",
      "8080",
      "--read-only",
      "--user",
      "65532:65532",
      "--cap-drop",
      "ALL",
      "-e",
      `PURPOSE_ADDRESS=${purpose}`,
      "-v",
      `${root}/tests/integration/deployment/fixtures/purpose-listener.mjs:/probe.mjs:ro`,
      "node:24.21.0-bookworm-slim",
      "node",
      "/probe.mjs",
    ]);
    await docker(["network", "connect", "--ip", outbound, outsideName, server]);
    await docker(["start", server]);
    await docker([
      "exec",
      server,
      "node",
      "-e",
      `fetch('http://${purpose}:8080/').then(r=>{if(!r.ok)process.exitCode=1})`,
    ]);
    const program = `import{connect}from'node:net';let connected=false;await new Promise(done=>{const s=connect({host:'${purpose}',port:8080});s.setTimeout(2000,()=>s.destroy());s.once('error',()=>{});s.once('connect',()=>{connected=true;s.destroy()});s.once('close',done)});try{const r=await fetch('http://${purpose}:8080/',{signal:AbortSignal.timeout(2000)});await r.arrayBuffer();console.log(JSON.stringify({tcp_connected:connected,reachable:true,status:r.status}));}catch{console.log(JSON.stringify({tcp_connected:connected,reachable:false}));}`;
    const value = JSON.parse(
      await docker([
        "run",
        "--name",
        peer,
        "--label",
        label,
        "--network",
        outsideName,
        "--read-only",
        "--user",
        "65532:65532",
        "--cap-drop",
        "ALL",
        "node:24.21.0-bookworm-slim",
        "node",
        "--input-type=module",
        "-e",
        program,
      ]),
    );
    const networks = JSON.parse(
      await docker(["network", "inspect", controlName, outsideName]),
    );
    report.observations.push({
      mode,
      ...value,
      options: networks.map((network) => ({
        internal: network.Internal,
        options: network.Options,
      })),
    });
    console.log(JSON.stringify(report.observations.at(-1)));
    if (mode === "isolated")
      assert.equal(
        value.reachable,
        false,
        "isolated control HTTP is reachable",
      );
    await docker(["stop", "-t", "5", server]);
    await docker(["rm", server, peer]);
    await docker(["network", "rm", controlName, outsideName]);
  }
} catch (error) {
  failure = error;
} finally {
  for (const id of lines(
    await cleanup(["ps", "-aq", "--filter", `label=${label}`]),
  )) {
    const [row] = JSON.parse(await cleanup(["inspect", id]));
    assert.equal(row.Config.Labels["io.antnest.control-routing"], project);
    if (row.State.Running) await cleanup(["stop", "-t", "5", id]);
    await cleanup(["rm", id]);
  }
  for (const id of lines(
    await cleanup(["network", "ls", "-q", "--filter", `label=${label}`]),
  )) {
    const [row] = JSON.parse(await cleanup(["network", "inspect", id]));
    assert.equal(row.Labels["io.antnest.control-routing"], project);
    await cleanup(["network", "rm", id]);
  }
  for (const [kind, args] of [
    ["container", ["ps", "-aq"]],
    ["network", ["network", "ls", "-q"]],
    ["volume", ["volume", "ls", "-q"]],
  ])
    assert.deepEqual(lines(await cleanup(args)).sort(), before[kind]);
  report.cleanup = true;
  writeFileSync(`${output}/result.json`, JSON.stringify(report), {
    mode: 0o600,
    flag: "wx",
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, stop);
}
if (failure) throw failure;
