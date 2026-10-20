import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  tag,
  traceTopology,
  assertCaptureDisabled,
} from "../observability/trace-tree.mjs";
import { hasError } from "../acp-plan/requests.mjs";

const quantizationUS = 1000;
const finite = (value) =>
  assert(Number.isFinite(value), "ACP clock time missing");
const fields = (rows = []) => {
  const result = Object.fromEntries(rows.map(({ key, value }) => [key, value]));
  assert.equal(
    Object.keys(result).length,
    rows.length,
    "duplicate ACP clock field",
  );
  return result;
};
const instance = (trace, span) => {
  const process = trace.processes?.[span.processID];
  assert.equal(
    process?.serviceName,
    "agent-acp-service",
    "clock service differs",
  );
  const id = fields(process.tags)["service.instance.id"];
  assert(typeof id === "string" && id.length > 0, "ACP instance missing");
  return id;
};
const end = (span) => {
  finite(span.startTime);
  finite(span.duration);
  assert(span.duration >= 0, "ACP span unfinished");
  return span.startTime + span.duration;
};

export function inspectACPClockReceipt(row) {
  assert(row, "actual ACP clock sample missing");
  assert.match(row.container_id ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(row.listener, "control");
  assert.equal(row.method, "GET");
  assert.equal(row.path, "/status");
  assert.equal(row.status, 200);
  assert.equal(row.ready, true);
  assert.equal(row.body_complete, true);
  assert(
    Number.isSafeInteger(row.body_bytes) &&
      row.body_bytes > 0 &&
      row.body_bytes <= 65536,
  );
  assert.match(row.body_sha256 ?? "", /^[a-f0-9]{64}$/u);
  const date = Date.parse(row.server_date);
  assert(
    Number.isFinite(date) && new Date(date).toUTCString() === row.server_date,
    "actual ACP HTTP Date missing",
  );
  finite(row.started_at);
  finite(row.received_at);
  assert(row.received_at >= row.started_at, "ACP response preceded request");
  return row;
}

// The inventory is the complete independent control GET /status search in
// this isolated Jaeger. There is exactly one probe, without propagated parent.
// Additional candidates are ambiguous; never choose a nearest timestamp.
export function inspectACPClock(sample, traces) {
  inspectACPClockReceipt(sample);
  assert.equal(traces.length, 1, "ACP health Trace missing or ambiguous");
  const [trace] = traces,
    tree = traceTopology(trace);
  assertCaptureDisabled(trace);
  const roots = trace.spans.filter((span) => !tree.parent(span));
  assert.equal(roots.length, 1, "ACP health root missing or duplicated");
  const [root] = roots;
  const receivers = trace.spans.filter(
    (span) =>
      tree.service(span) === "agent-acp-service" &&
      span.operationName === "HTTP GET /status" &&
      tag(span, "span.kind") === "server" &&
      tag(span, "http.request.method") === "GET" &&
      tag(span, "http.route") === "/status" &&
      tag(span, "antnest.listener") === "control",
  );
  assert.equal(
    receivers.length,
    1,
    "ACP health receiver inventory missing or ambiguous",
  );
  assert.equal(receivers[0], root, "health inventory is not the original root");
  assert.equal(root.operationName, "HTTP GET /status");
  assert.equal(
    root.references?.length ?? 0,
    0,
    "ACP health probe has invented parent or link",
  );
  for (const [key, value] of Object.entries({
    "span.kind": "server",
    "http.request.method": "GET",
    "http.route": "/status",
    "antnest.listener": "control",
    "http.response.status_code": 200,
  }))
    assert.equal(tag(root, key), value, `ACP health ${key} differs`);
  const serviceInstance = instance(trace, root);
  for (const span of trace.spans) {
    fields(span.tags);
    assert(!hasError(span), "failed ACP clock Trace");
    end(span);
  }
  const dateUS = Date.parse(sample.server_date) * 1000;
  // ACP's SDK anchors each span at Date.now() and measures duration with a
  // monotonic clock. Keep the <1ms anchor quantization as its own bound; it
  // does not waive network/IPC uncertainty or other Trace diagnostics.
  // The SERVER begins before its response can arrive. Its finish callback
  // need not precede client body completion, so its end is not a lower bound.
  const lower = Math.max(
    root.startTime - sample.received_at * 1000,
    dateUS - sample.received_at * 1000,
  );
  const upper = Math.min(
    root.startTime - sample.started_at * 1000 + quantizationUS,
    dateUS + 1000000 - sample.started_at * 1000,
  );
  assert(lower <= upper, "ACP clock/Date intervals do not intersect");
  return {
    container_id: sample.container_id,
    source_trace_id: trace.traceID,
    source_span_id: root.spanID,
    service_instance_id: serviceInstance,
    offset_min_us: lower,
    offset_max_us: upper,
    probe_round_trip_ms: sample.received_at - sample.started_at,
    node_sdk_quantization_us: quantizationUS,
  };
}

// Reconcile the actual session/list SERVER starts against all 100 independent
// HTTP wire windows. Same process identity alone does not prove stable clock
// anchors. A clock step that makes these observed intervals inconsistent fails.
// The caller supplies the list spans whose complete request parent chains it
// already verified; no uncorrelated timestamp can become a calibration sample.
export function tightenACPClock(clock, windows) {
  assert.equal(windows.length, 100, "100 actual ACP clock windows required");
  let lower = clock.offset_min_us,
    upper = clock.offset_max_us;
  finite(lower);
  finite(upper);
  assert(lower <= upper);
  const seen = new Set(),
    samples = [];
  for (const {
    trace,
    span,
    started_at: started,
    received_at: received,
  } of windows) {
    assert.equal(
      instance(trace, span),
      clock.service_instance_id,
      "ACP clock instance differs",
    );
    assert.equal(tag(span, "span.kind"), "server");
    assert.equal(tag(span, "rpc.service"), "acp");
    assert.equal(tag(span, "rpc.method"), "session/list");
    assert(trace.spans.includes(span), "clock source is not in actual Trace");
    assert(!seen.has(trace.traceID), "duplicate actual clock sample");
    seen.add(trace.traceID);
    finite(started);
    finite(received);
    end(span);
    assert(received >= started, "clock wire response before request");
    const min = span.startTime - received * 1000;
    const max = span.startTime - started * 1000 + quantizationUS;
    lower = Math.max(lower, min);
    upper = Math.min(upper, max);
    assert(lower <= upper, "actual ACP clock intervals do not intersect");
    samples.push({
      trace_id: trace.traceID,
      span_id: span.spanID,
      started_at: started,
      received_at: received,
      offset_min_us: min,
      offset_max_us: max,
    });
  }
  return {
    ...clock,
    offset_min_us: lower,
    offset_max_us: upper,
    business_samples: samples,
  };
}

export function acpSpanEndInterval(clock, trace, span) {
  assert(
    trace.spans.includes(span) && span.traceID === trace.traceID,
    "clock source is not in actual Trace",
  );
  assert.equal(
    instance(trace, span),
    clock.service_instance_id,
    "ACP clock instance differs",
  );
  finite(clock.offset_min_us);
  finite(clock.offset_max_us);
  assert(clock.offset_min_us <= clock.offset_max_us);
  assert.equal(clock.node_sdk_quantization_us, quantizationUS);
  const value = end(span);
  return {
    lower: (value - clock.offset_max_us) / 1000,
    upper: (value + quantizationUS - clock.offset_min_us) / 1000,
  };
}

export function acpSpanStartInterval(clock, trace, span) {
  // Reuse original-span, process and finite-duration checks without copying
  // or changing the archived span to manufacture a zero-duration sample.
  acpSpanEndInterval(clock, trace, span);
  return {
    lower: (span.startTime - clock.offset_max_us) / 1000,
    upper: (span.startTime + quantizationUS - clock.offset_min_us) / 1000,
  };
}

// Match ACP's :port, host:port and [ipv6]:port listen syntax. This pure helper
// is also embedded in the standalone in-container program below.
export function acpControlEndpoint(value) {
  if (typeof value !== "string") throw new Error("invalid control listen");
  const normalized = value.trim();
  const ipv6 = /^\[([^\]]+)\]:(\d+)$/u.exec(normalized);
  let host, rawPort;
  if (ipv6) [, host, rawPort] = ipv6;
  else {
    const separator = normalized.lastIndexOf(":");
    if (separator < 0 || normalized.slice(0, separator).includes(":"))
      throw new Error("invalid control listen");
    host = normalized.slice(0, separator).trim();
    rawPort = normalized.slice(separator + 1);
  }
  rawPort = rawPort.trim();
  const port = Number(rawPort);
  if (
    !/^\d+$/u.test(rawPort) ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error("invalid control port");
  return {
    hostname:
      host === "" || host === "0.0.0.0"
        ? "127.0.0.1"
        : host === "::"
          ? "::1"
          : host,
    port,
  };
}

// This runs inside the original ACP container as its existing unprivileged
// user. It neither reads credentials nor changes service state. Waiting for
// a host handshake excludes Docker/Node startup from the measured interval.
async function healthProbeProgram() {
  const { request } = await import("node:http");
  const { createHash } = await import("node:crypto");
  const { createInterface } = await import("node:readline");
  const { hostname, port } = acpControlEndpoint(
    process.env.ANTNEST_ACP_CONTROL_LISTEN ?? ":8081",
  );
  const abort = new AbortController();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const cancelled = () => abort.abort(new Error("probe cancelled"));
  input.once("close", cancelled);
  const timeout = setTimeout(cancelled, 10000);
  let sent = false;
  const start = new Promise((resolve, reject) => {
    abort.signal.addEventListener(
      "abort",
      () => reject(new Error("probe cancelled")),
      { once: true },
    );
    input.on("line", (line) => {
      if (!sent && line === "probe") {
        sent = true;
        resolve();
      } else cancelled();
    });
  });
  try {
    // Register input/cancellation before announcing readiness. Keep stdin open
    // through the request so a host cancel joins the remote process as well.
    process.stdout.write(JSON.stringify({ kind: "ready" }) + "\n");
    await start;
    const result = await new Promise((resolve, reject) => {
      const req = request(
        {
          hostname,
          port,
          path: "/status",
          method: "GET",
          agent: false,
          signal: abort.signal,
          headers: { Connection: "close" },
        },
        (response) => {
          const chunks = [];
          let bytes = 0;
          response.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > 65536)
              response.destroy(new Error("health body too large"));
            else chunks.push(chunk);
          });
          response.once("error", reject);
          response.once("end", () => {
            try {
              const body = Buffer.concat(chunks);
              const value = JSON.parse(body.toString());
              resolve({
                kind: "result",
                status: response.statusCode,
                server_date: response.headers.date,
                ready: value.status === "ready",
                body_complete: response.complete,
                body_bytes: bytes,
                body_sha256: createHash("sha256").update(body).digest("hex"),
              });
            } catch {
              reject(new Error("invalid health response"));
            }
          });
        },
      );
      req.once("error", reject);
      req.setTimeout(5000, () =>
        req.destroy(new Error("health request timeout")),
      );
      req.end();
    });
    process.stdout.write(JSON.stringify(result) + "\n");
  } finally {
    clearTimeout(timeout);
    input.off("close", cancelled);
    input.close();
    process.stdin.destroy();
  }
}
const program = `${acpControlEndpoint.toString()}\nawait (${healthProbeProgram.toString()})().catch(() => { process.stderr.write("ACP clock probe failed\\n"); process.exitCode = 1; });`;

export async function probeACPClock({
  container,
  environment = process.env,
  signal,
  now = () => performance.now(),
  spawnProcess = spawn,
  timeoutMS = 30000,
}) {
  assert.match(container ?? "", /^[a-f0-9]{64}$/u);
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawnProcess(
      "docker",
      ["exec", "-i", container, "node", "--input-type=module", "-e", program],
      { env: environment, detached: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let started,
      received,
      result,
      failure,
      cancellationTimer,
      output = "",
      bytes = 0,
      stderr = false;
    const terminate = (reason) => {
      failure ??= reason;
      if (cancellationTimer) return;
      // First ask the in-container program to abort its HTTP request and exit.
      // SIGKILL is only a fallback for an unresponsive local Docker process;
      // that failure still requires the owning runner's container cleanup.
      cancellationTimer = setTimeout(() => {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") failure = error;
        }
      }, 2000);
      if (!child.stdin.destroyed && !child.stdin.writableEnded)
        child.stdin.end("cancel\n");
    };
    const interrupt = () =>
      terminate(new Error("ACP clock probe interrupted or timed out"));
    const timer = setTimeout(interrupt, timeoutMS);
    signal?.addEventListener("abort", interrupt, { once: true });
    if (signal?.aborted) interrupt();
    child.stdin.on("error", () =>
      terminate(new Error("ACP clock handshake failed")),
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data) => {
      output += data;
      bytes += Buffer.byteLength(data);
      if (bytes > 65536)
        return terminate(new Error("ACP clock output exceeded limit"));
      while (output.includes("\n") && !failure) {
        const at = output.indexOf("\n"),
          line = output.slice(0, at);
        output = output.slice(at + 1);
        try {
          const value = JSON.parse(line);
          if (value.kind === "ready") {
            assert.equal(started, undefined, "duplicate probe handshake");
            assert.deepEqual(value, { kind: "ready" });
            started = now();
            child.stdin.write("probe\n");
          } else {
            assert.equal(value.kind, "result");
            assert.notEqual(started, undefined);
            assert.equal(result, undefined);
            received = now();
            const { kind: _kind, ...body } = value;
            assert.deepEqual(
              Object.keys(body).sort(),
              [
                "status",
                "server_date",
                "ready",
                "body_complete",
                "body_bytes",
                "body_sha256",
              ].sort(),
            );
            result = {
              ...body,
              container_id: container,
              listener: "control",
              method: "GET",
              path: "/status",
              started_at: started,
              received_at: received,
            };
            inspectACPClockReceipt(result);
          }
        } catch {
          terminate(new Error("invalid ACP clock probe receipt"));
        }
      }
    });
    child.stderr.on("data", () => {
      stderr = true;
      terminate(new Error("ACP clock probe reported failure"));
    });
    child.once("error", () => {
      failure ??= new Error("ACP clock probe could not start");
    });
    // Always join exit, including abort/protocol failure. Receiving a result
    // does not transfer ownership of a still-running Docker/Node process.
    child.once("close", (code) => {
      clearTimeout(timer);
      clearTimeout(cancellationTimer);
      signal?.removeEventListener("abort", interrupt);
      if (failure) return reject(failure);
      if (code !== 0 || stderr || output !== "" || !result)
        return reject(new Error("ACP clock probe did not complete cleanly"));
      resolve(result);
    });
  });
}
