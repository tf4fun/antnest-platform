import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    project: { type: "string" },
    image: { type: "string", default: "antnest/antnest-runtime:local" },
    jaeger: { type: "string", default: "http://127.0.0.1:16686" },
  },
});
assert(
  values.project,
  "--project must identify an existing development instance",
);
const agent = `img-${randomUUID()}`;
const requestID = `initialize-${agent}`;
const egress = `${values.project}-runtime-egress-1`;
const container = `antnest-runtime-${agent}`;
const controller = "http://runtime-controller:8080";

function docker(...args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 110000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function rpc(base, path, method = "GET", body, key) {
  const args = [
    "exec",
    egress,
    "curl",
    "--silent",
    "--show-error",
    "--max-time",
    "100",
    "--write-out",
    "\n%{http_code}",
    "-X",
    method,
  ];
  if (key) args.push("-H", `Idempotency-Key: ${key}`);
  if (body !== undefined)
    args.push(
      "-H",
      "Content-Type: application/json",
      "-d",
      JSON.stringify(body),
    );
  args.push(base + path);
  const output = docker(...args);
  const boundary = output.lastIndexOf("\n");
  const status = Number(output.slice(boundary + 1));
  const result = JSON.parse(output.slice(0, boundary));
  assert(
    status >= 200 && status < 300,
    `${method} ${path}: HTTP ${status}, ${result.code ?? "unknown error"}`,
  );
  return result;
}

async function imageTrace(imageID) {
  await setTimeout(6000);
  const url = new URL("/api/traces", values.jaeger);
  url.search = new URLSearchParams({
    service: "runtime-controller",
    operation: "runtime.platform.create",
    lookback: "1h",
    limit: "20",
    tags: JSON.stringify({ "antnest.agent.id": agent }),
  });
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  assert(response.ok, `Jaeger HTTP ${response.status}`);
  const { data, errors } = await response.json();
  assert.equal(errors?.length ?? 0, 0);
  const trace = data.find((item) =>
    Object.values(item.processes).some(
      (p) => p.serviceName === "antnest-runtime",
    ),
  );
  assert(trace, "build trace did not contain a Runtime server span");
  const tag = (items, key) => items?.find((item) => item.key === key)?.value;
  const runtime = Object.values(trace.processes).find(
    (p) => p.serviceName === "antnest-runtime",
  );
  assert.equal(tag(runtime.tags, "antnest.runtime.image.id"), imageID);
  assert.equal(
    tag(runtime.tags, "antnest.runtime.image.reference"),
    values.image,
  );
  const create = trace.spans.find(
    (span) => span.operationName === "runtime.platform.create",
  );
  assert(create, "missing platform create span");
  assert.equal(tag(create.tags, "antnest.runtime.image.id"), imageID);
  const ids = new Set(trace.spans.map((span) => span.spanID));
  for (const span of trace.spans) {
    assert.equal(span.warnings?.length ?? 0, 0, "Jaeger span warning");
    for (const parent of span.references.filter(
      (ref) => ref.refType === "CHILD_OF",
    )) {
      assert(
        ids.has(parent.spanID),
        "missing parent span after export grace period",
      );
    }
  }
  return `${values.jaeger}/trace/${trace.traceID}`;
}

function assertStartupImage(imageID) {
  const result = spawnSync("docker", ["logs", container], {
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, "could not inspect Runtime startup log");
  const records = (result.stdout + result.stderr)
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  const startup = records.find(
    (record) => record.message === "Runtime telemetry initialized",
  );
  assert(startup, "missing Runtime startup metadata log");
  assert.equal(startup["antnest.runtime.image.id"], imageID);
  assert.equal(startup["antnest.runtime.image.reference"], values.image);
}

const egressURL = `http://${docker("exec", egress, "printenv", "ANTNEST_EGRESS_CONTROL_LISTEN").trim()}`;
const network = rpc(egressURL, `/internal/agent-networks/${agent}`, "PUT");
let operation;
let traceURL;
try {
  const {
    packet_contract_revision,
    egress_endpoint,
    tunnel_ipv4,
    resolver_ipv4,
  } = network;
  const body = {
    configuration: {
      image_ref: values.image,
      network: {
        packet_contract_revision,
        egress_endpoint,
        tunnel_ipv4,
        resolver_ipv4,
      },
      resources: {
        memory_bytes: 536870912,
        pids_limit: 256,
        tmpfs_bytes: 67108864,
      },
    },
  };
  operation = rpc(
    controller,
    `/internal/runtimes/${agent}/initialize`,
    "POST",
    body,
    requestID,
  );
  assert.equal(operation.state, "completed");
  assert.equal(operation.image_reference, values.image);
  const [physical] = JSON.parse(docker("inspect", container));
  assert.equal(physical.Image, operation.image_id);
  assert.equal(physical.Config.Image, operation.image_id);
  assertStartupImage(operation.image_id);
  assert(
    physical.Config.Env.includes(
      `ANTNEST_RUNTIME_IMAGE_REFERENCE=${values.image}`,
    ),
  );
  assert(
    physical.Config.Env.includes(
      `ANTNEST_RUNTIME_IMAGE_ID=${operation.image_id}`,
    ),
  );
  const replay = rpc(
    controller,
    `/internal/runtimes/${agent}/initialize`,
    "POST",
    body,
    requestID,
  );
  assert.equal(replay.image_id, operation.image_id);
  assert.equal(replay.target_revision, operation.target_revision);
  traceURL = await imageTrace(operation.image_id);
} finally {
  if (operation?.target_revision) {
    const deleted = rpc(
      controller,
      `/internal/runtimes/${agent}/delete`,
      "POST",
      {
        expected_revision: operation.target_revision,
      },
      `delete-${agent}`,
    );
    assert.equal(deleted.state, "completed");
  } else {
    // Only this test's named resources may be removed after a failed initialize.
    if (docker("ps", "-aq", "--filter", `name=^/${container}$`).trim()) {
      docker("rm", "--force", container);
    }
    if (
      docker(
        "volume",
        "ls",
        "-q",
        "--filter",
        `name=^antnest-workspace-${agent}$`,
      ).trim()
    ) {
      docker("volume", "rm", `antnest-workspace-${agent}`);
    }
  }
  rpc(egressURL, `/internal/agent-networks/${agent}/release`, "POST", {
    expected_resource_version: network.network_resource_version,
  });
}
const retained = rpc(controller, `/internal/runtime-operations/${requestID}`);
assert.equal(retained.image_id, operation.image_id);
assert.equal(retained.image_reference, values.image);
assert.equal(
  docker("ps", "-aq", "--filter", `name=^/${container}$`).trim(),
  "",
);
assert.equal(
  docker(
    "volume",
    "ls",
    "-q",
    "--filter",
    `name=^antnest-workspace-${agent}$`,
  ).trim(),
  "",
);
console.log(
  JSON.stringify({
    result: "passed",
    image_reference: values.image,
    image_id: operation.image_id,
    trace: traceURL,
    container_and_workspace_removed: true,
    retained_audit_operation: requestID,
  }),
);
