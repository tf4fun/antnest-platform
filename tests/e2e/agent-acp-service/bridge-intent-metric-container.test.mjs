import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const runningDocker = new Set();

async function docker(args, timeout = 180_000) {
  const controller = new AbortController();
  runningDocker.add(controller);
  try {
    return await exec("docker", args, {
      cwd: root, timeout, maxBuffer: 2_000_000, signal: controller.signal,
    });
  } finally {
    runningDocker.delete(controller);
  }
}

test("ACP production image exports durable Bridge intent reuse without private labels", { timeout: 240_000 }, async () => {
  const image = `antnest-agent-acp-metric-e2e:${randomUUID().slice(0, 12)}`;
  const container = `antnest-agent-acp-metric-e2e-${randomUUID().slice(0, 12)}`;
  const interrupt = (exitCode) => {
    process.exitCode = exitCode;
    for (const controller of runningDocker) controller.abort();
  };
  const onInterrupt = () => interrupt(130);
  const onTerminate = () => interrupt(143);
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  try {
    await docker(["build", "-q", "-f", "services/agent-acp-service/Dockerfile", "-t", image, "."]);
    const { stdout } = await docker([
      "run", "--rm", "--name", container, "--network", "none", "--entrypoint", "node", image,
      "--input-type=module", "-e", containerProbe,
    ], 60_000);
    assert.equal(stdout.trim(), "ACP intent reuse OTLP export verified");
  } finally {
    await docker(["rm", "-f", container], 30_000).catch(() => {});
    await docker(["image", "rm", "-f", image], 30_000).catch(() => {});
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  }
});

const containerProbe = `
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { startTelemetry } from "./dist/telemetry/telemetry.js";
import { InstrumentedAcpApplication } from "./dist/telemetry/instrumented-ports.js";
import { DomainError } from "./dist/domain/errors.js";

const requests = [];
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  requests.push({ path: request.url, body: Buffer.concat(chunks).toString("utf8") });
  response.writeHead(200).end();
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
let runtime;
try {
  runtime = await startTelemetry({
    serviceName: "agent-acp-metric-e2e",
    endpoint: new URL("http://127.0.0.1:" + server.address().port),
    disabled: false,
    tracesEnabled: false,
    metricsEnabled: true,
    captureRpcContent: false,
  });
  for (const code of ["intent_already_recorded", "idempotency_conflict"]) {
    const delegate = { acceptPrompt: async () => {
      throw new DomainError(code, "private-error-message");
    } };
    const application = new InstrumentedAcpApplication(delegate, runtime.telemetry);
    await assert.rejects(application.acceptPrompt({
      binding: { agentId: "private-agent" },
      sessionId: "private-session",
      prompt: [{ type: "text", text: "private-prompt" }],
      bridgeIntent: { intentId: "private-intent" },
      outputChanged: () => {},
    }), { code });
  }
  await runtime.shutdown();
  runtime = undefined;

  const exported = requests.filter((request) => request.path === "/v1/metrics");
  assert.ok(exported.length > 0, "Production image did not export OTLP metrics");
  const metrics = exported.flatMap((request) => JSON.parse(request.body).resourceMetrics
    .flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics)));
  const reuseMetrics = metrics.filter((metric) => metric.name === "antnest.acp.bridge_intent_reuse");
  const reusePayload = JSON.stringify(reuseMetrics);
  for (const privateValue of ["private-agent", "private-session", "private-prompt", "private-intent", "private-error-message"])
    assert.ok(!reusePayload.includes(privateValue), "Intent reuse metric contains " + privateValue);
  const points = reuseMetrics.flatMap((metric) => metric.sum?.dataPoints ?? []);
  assert.equal(points.length, 2);
  const results = points.map((point) => {
    assert.equal(Number(point.asInt ?? point.asDouble), 1);
    assert.equal(point.attributes.length, 1);
    assert.equal(point.attributes[0].key, "result");
    return point.attributes[0].value.stringValue;
  }).sort();
  assert.deepEqual(results, ["conflict", "hit"]);
  process.stdout.write("ACP intent reuse OTLP export verified\\n");
} finally {
  if (runtime) await runtime.shutdown();
  server.close();
  await once(server, "close");
}
`;
