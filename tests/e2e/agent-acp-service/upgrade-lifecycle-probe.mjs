import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { context, propagation, trace } from "@opentelemetry/api";
import { core, node, tracing } from "@opentelemetry/sdk-node";

// The same probe runs against source locally and compiled production code in
// the candidate image. Authentication is a controlled port; its real signed
// credential matrix has a separate gate. WS, SDK spans and transport are real.
const source = process.env.ANTNEST_ACP_PROBE_SOURCE === "true";
const base = source
  ? new URL("../../../services/agent-acp-service/src/", import.meta.url)
  : new URL("./dist/", import.meta.url);
const load = (name) => import(new URL(`${name}.${source ? "ts" : "js"}`, base));
const { AgentAcpHttpServer } = await load("transport/http-server");
const { bindAuthenticatedRequest } = await load("transport/trusted-identity");
const { configureBoundaries } = await load("telemetry/diagnostics");
const require = createRequire(new URL("../package.json", base));
const events = [
  "antnest.http.upgrade.response.prepared",
  "antnest.http.upgrade.connection.setup.started",
  "antnest.http.upgrade.connection.setup.completed",
];
const exportSpan = (span) => ({
  ...span.spanContext(),
  name: span.name,
  kind: span.kind,
  parent: span.parentSpanContext,
  startTime: span.startTime,
  endTime: span.endTime,
  attributes: span.attributes,
  events: span.events,
  status: span.status,
});
const workerSource = `
const {workerData:d,parentPort}=require('node:worker_threads');
const ws=require(d.ws),WebSocket=ws.WebSocket??ws.default??ws;
const {node,tracing}=require(d.otel);
const exporter=new tracing.InMemorySpanExporter();
const provider=new node.NodeTracerProvider({spanProcessors:[new tracing.SimpleSpanProcessor(exporter)]});
const span=provider.getTracer('upgrade-probe-client').startSpan('HTTP GET agent-acp-workspace',{kind:2});
const identity=span.spanContext();
const socket=new WebSocket(d.url,{headers:{traceparent:'00-'+identity.traceId+'-'+identity.spanId+'-01','x-probe-secret':'header-canary'}});
const state=new Int32Array(d.state);
let finished=false;
function finish(status){
 if(finished)return;finished=true;
 span.setAttribute('http.response.status_code',status);span.end();
 const time=process.hrtime.bigint().toString();
 Atomics.store(state,0,1);Atomics.notify(state,0);
 const s=exporter.getFinishedSpans()[0];
 parentPort.postMessage({status,time,span:{...s.spanContext(),kind:s.kind,startTime:s.startTime,endTime:s.endTime,attributes:s.attributes,events:s.events,status:s.status}});
}
socket.once('open',()=>finish(101));
socket.once('unexpected-response',(_req,response)=>{finish(response.statusCode);response.destroy();socket.terminate();});
socket.on('error',()=>{});
socket.once('close',async()=>{await provider.shutdown();parentPort.close();});
parentPort.on('message',()=>socket.close());
`;

async function exercise(version, mode) {
  const exporter = new tracing.InMemorySpanExporter();
  const ended = new Map();
  const provider = new node.NodeTracerProvider({
    spanProcessors: [
      {
        onStart() {},
        onEnd(span) {
          ended.set(span.spanContext().spanId, process.hrtime.bigint());
        },
        async forceFlush() {},
        async shutdown() {},
      },
      new tracing.SimpleSpanProcessor(exporter),
    ],
  });
  provider.register({ propagator: new core.W3CTraceContextPropagator() });
  configureBoundaries({
    captureRpcContent: false,
    disabled: mode === "disabled",
  });
  const state = new SharedArrayBuffer(8);
  const shared = new Int32Array(state);
  const reported = [];
  let accepted = false;
  const server = new AgentAcpHttpServer({
    authentication: {
      workload: {},
      async admit(request) {
        if (mode === "rejected")
          return { status: 401, code: "service_unauthenticated" };
        bindAuthenticatedRequest(request, "agent-ui", {
          sub: "probe-owner",
          org: "probe-org",
          agt: "probe-agent",
        });
        return {};
      },
    },
    application: {},
    ready: async () => true,
    maxWebSocketPayloadBytes: 65536,
    telemetry: {
      count(_name, attributes) {
        if (attributes.result !== "accepted") return;
        accepted = true;
        if (mode !== "held") return;
        // A real peer receives 101 while this production setup callback is
        // held. The shared atomic proves order without comparing wall clocks.
        Atomics.wait(shared, 0, 0, 4000);
        assert.equal(
          Atomics.load(shared, 0),
          1,
          "peer did not receive handshake",
        );
        Atomics.wait(shared, 1, 0, 15);
      },
      log(_level, operation) {
        reported.push(operation);
      },
    },
  });
  if (mode === "setup-failed")
    server.observeConnection = () => {
      throw new Error("setup-canary");
    };
  let worker, timer;
  const errors = [];
  try {
    await server.listen("127.0.0.1", 0);
    const address = server.address();
    assert(address && typeof address !== "string");
    worker = new Worker(workerSource, {
      eval: true,
      execArgv: [],
      workerData: {
        url: `ws://127.0.0.1:${address.port}/v${version}/acp`,
        ws: require.resolve("ws"),
        otel: require.resolve("@opentelemetry/sdk-node"),
        state,
      },
    });
    worker.on("error", (error) => errors.push(error));
    const result = await new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("upgrade probe deadline")),
        6000,
      );
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", () =>
        reject(new Error("peer exited before handshake receipt")),
      );
    });
    clearTimeout(timer);
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    if (mode === "disabled") assert.equal(spans.length, 0);
    else {
      assert.equal(spans.length, 1);
      const span = spans[0];
      assert.equal(span.kind, 1);
      assert.equal(span.spanContext().traceId, result.span.traceId);
      assert.equal(span.parentSpanContext.spanId, result.span.spanId);
      assert.equal(
        span.attributes["http.response.status_code"],
        mode === "rejected" ? 401 : 101,
      );
      const names = span.events.map((item) => item.name);
      assert.deepEqual(
        names,
        mode === "rejected"
          ? []
          : mode === "setup-failed"
            ? events.slice(0, 2)
            : events,
      );
      const nanos = (time) =>
        BigInt(time[0]) * 1_000_000_000n + BigInt(time[1]);
      let previous = nanos(span.startTime);
      for (const event of span.events) {
        assert.deepEqual(event.attributes, {});
        assert(nanos(event.time) >= previous);
        assert(nanos(event.time) <= nanos(span.endTime));
        previous = nanos(event.time);
      }
      if (mode === "held") {
        assert(ended.get(span.spanContext().spanId) > BigInt(result.time));
        assert(
          ended.get(span.spanContext().spanId) - BigInt(result.time) >=
            10_000_000n,
        );
      }
      const record = {
        version,
        mode,
        server: exportSpan(span),
        client: result.span,
        client_open_before_server_end: mode === "held",
      };
      assert(!JSON.stringify(record).includes("canary"));
      console.log(
        JSON.stringify({ event: "upgrade_lifecycle_source", ...record }),
      );
    }
    assert.equal(result.status, mode === "rejected" ? 401 : 101);
    assert.equal(accepted, mode !== "rejected");
    if (mode === "setup-failed") assert(reported.includes("acp_connect"));
  } catch (error) {
    errors.push(error);
  } finally {
    clearTimeout(timer);
    for (const close of [
      async () => {
        if (worker) await worker.terminate();
      },
      () => server.close(),
      () => provider.shutdown(),
    ])
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    trace.disable();
    context.disable();
    propagation.disable();
    configureBoundaries({ captureRpcContent: false, disabled: false });
  }
  if (errors.length)
    throw new AggregateError(errors, "upgrade lifecycle probe failed");
}

for (const version of [1, 2])
  for (const mode of ["held", "setup-failed", "rejected", "disabled"])
    await exercise(version, mode);
console.log(
  JSON.stringify({
    event: "upgrade_lifecycle_verified",
    scenarios: 8,
    held_peer_open_before_server_end: 2,
  }),
);
