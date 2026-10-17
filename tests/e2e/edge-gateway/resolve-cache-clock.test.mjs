import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import * as clockTools from "./resolve-cache-clock.mjs";
import {
  probeACPClock,
  inspectACPClockReceipt,
  inspectACPClock,
  acpSpanEndInterval,
} from "./resolve-cache-clock.mjs";

const container = "a".repeat(64);
const date = "Wed, 14 Oct 2026 09:00:00 GMT";
const epoch = Date.parse(date) * 1000;
const hash = (text) => createHash("sha256").update(text).digest("hex");
function receipt() {
  return {
    container_id: container,
    listener: "control",
    method: "GET",
    path: "/status",
    started_at: 100,
    received_at: 105,
    server_date: date,
    status: 200,
    body_complete: true,
    body_bytes: 18,
    body_sha256: hash('{"status":"ready"}'),
    ready: true,
  };
}
function healthTrace() {
  const traceID = "1".repeat(32),
    spanID = "2".repeat(16);
  return {
    traceID,
    processes: {
      p: {
        serviceName: "agent-acp-service",
        tags: [{ key: "service.instance.id", value: "original-acp:1" }],
      },
    },
    spans: [
      {
        traceID,
        spanID,
        processID: "p",
        operationName: "HTTP GET /status",
        startTime: epoch + 102000,
        duration: 1000,
        references: [],
        tags: [
          { key: "span.kind", value: "server" },
          { key: "http.route", value: "/status" },
          { key: "http.request.method", value: "GET" },
          { key: "antnest.listener", value: "control" },
          { key: "http.response.status_code", value: 200 },
        ],
        logs: [],
      },
    ],
  };
}

test("ACP clock keeps conservative host/actual-server intervals and SDK quantization separate", () => {
  const r = receipt(),
    trace = healthTrace();
  const clock = inspectACPClock(r, [trace]);
  assert.equal(clock.service_instance_id, "original-acp:1");
  assert.equal(clock.offset_min_us, epoch - 3000);
  assert.equal(clock.offset_max_us, epoch + 3000);
  assert.equal(clock.probe_round_trip_ms, 5);
  assert.equal(clock.node_sdk_quantization_us, 1000);
  const stream = {
    ...trace.spans[0],
    spanID: "3".repeat(16),
    operationName: "HTTP GET /v1/acp",
    startTime: epoch + 100000,
    duration: 20000,
  };
  trace.spans.push(stream);
  assert.deepEqual(acpSpanEndInterval(clock, trace, stream), {
    lower: 117,
    upper: 124,
  });
  // Intersection with a stop window cannot prove that closure followed stop.
  assert(acpSpanEndInterval(clock, trace, stream).lower < 120);
});

for (const [name, mutate] of [
  [
    "missing full body",
    (r) => {
      r.body_complete = false;
    },
  ],
  [
    "unready service",
    (r) => {
      r.ready = false;
    },
  ],
  [
    "failed status",
    (r) => {
      r.status = 503;
    },
  ],
  [
    "non-control listener",
    (r) => {
      r.listener = "workspace";
    },
  ],
  [
    "invalid actual Date",
    (r) => {
      r.server_date = "invented";
    },
  ],
  [
    "response before request",
    (r) => {
      r.received_at = 99;
    },
  ],
])
  test(`ACP clock receipt rejects ${name}`, () => {
    const r = receipt();
    mutate(r);
    assert.throws(() => inspectACPClockReceipt(r));
  });

for (const [name, mutate] of [
  [
    "ambiguous independent health inventory",
    (traces) => {
      traces.push(structuredClone(traces[0]));
    },
  ],
  [
    "workspace health probe",
    (traces) => {
      traces[0].spans[0].tags.find((x) => x.key === "antnest.listener").value =
        "workspace";
    },
  ],
  [
    "invented parent",
    (traces) => {
      traces[0].spans[0].references = [
        {
          refType: "CHILD_OF",
          traceID: traces[0].traceID,
          spanID: "f".repeat(16),
        },
      ];
    },
  ],
  [
    "missing instance",
    (traces) => {
      traces[0].processes.p.tags = [];
    },
  ],
  [
    "duplicate instance",
    (traces) => {
      traces[0].processes.p.tags.push(traces[0].processes.p.tags[0]);
    },
  ],
  [
    "Date inconsistent with actual SERVER clock",
    (traces) => {
      traces[0].spans[0].startTime += 2000000;
    },
  ],
  [
    "failed health SERVER",
    (traces) => {
      traces[0].spans[0].tags.push({ key: "error", value: true });
    },
  ],
])
  test(`ACP clock source rejects ${name}`, () => {
    const traces = [healthTrace()];
    mutate(traces);
    assert.throws(() => inspectACPClock(receipt(), traces));
  });

test("ACP stream time cannot use another process or service clock", () => {
  const trace = healthTrace();
  const clock = inspectACPClock(receipt(), [trace]);
  trace.processes.p.tags[0].value = "restarted-acp:1";
  assert.throws(
    () => acpSpanEndInterval(clock, trace, trace.spans[0]),
    /instance/u,
  );
  trace.processes.p.tags[0].value = "original-acp:1";
  trace.processes.p.serviceName = "agent-ui";
  assert.throws(
    () => acpSpanEndInterval(clock, trace, trace.spans[0]),
    /service/u,
  );
});

test("health response completion does not acknowledge the SERVER finish callback", () => {
  const trace = healthTrace();
  trace.spans[0].duration = 10000;
  const clock = inspectACPClock(receipt(), [trace]);
  assert.equal(clock.offset_min_us, epoch - 3000);
  assert.equal(clock.offset_max_us, epoch + 3000);
});

test("one Trace with two health receivers is an ambiguous independent inventory", () => {
  const trace = healthTrace();
  const duplicate = structuredClone(trace.spans[0]);
  duplicate.spanID = "f".repeat(16);
  duplicate.references = [
    {
      refType: "CHILD_OF",
      traceID: trace.traceID,
      spanID: trace.spans[0].spanID,
    },
  ];
  trace.spans.push(duplicate);
  assert.throws(
    () => inspectACPClock(receipt(), [trace]),
    /health.*inventory/u,
  );
});

function businessWindows() {
  return Array.from({ length: 100 }, (_, index) => {
    const trace = healthTrace(),
      span = trace.spans[0];
    trace.traceID = (index + 10).toString(16).padStart(32, "0");
    span.traceID = trace.traceID;
    span.operationName = "ACP session/list";
    span.startTime = epoch + (201 + index * 10) * 1000;
    span.tags = [
      { key: "span.kind", value: "server" },
      { key: "rpc.service", value: "acp" },
      { key: "rpc.method", value: "session/list" },
    ];
    return {
      trace,
      span,
      started_at: 200 + index * 10,
      received_at: 203 + index * 10,
    };
  });
}

test("all 100 actual ACP list request clocks must share the observed calibration interval", () => {
  const initial = inspectACPClock(receipt(), [healthTrace()]);
  const checked = clockTools.tightenACPClock(initial, businessWindows());
  assert.equal(checked.offset_min_us, epoch - 2000);
  assert.equal(checked.offset_max_us, epoch + 2000);
  assert.equal(checked.business_samples.length, 100);
  assert.equal(
    initial.offset_min_us,
    epoch - 3000,
    "keep original independent probe evidence",
  );
});

for (const [name, mutate] of [
  [
    "clock step",
    (rows) => {
      rows[99].span.startTime += 6000;
    },
  ],
  [
    "different process",
    (rows) => {
      rows[50].trace.processes.p.tags[0].value = "replacement:1";
    },
  ],
  [
    "missing sample",
    (rows) => {
      rows.pop();
    },
  ],
  [
    "duplicate sample",
    (rows) => {
      rows[50] = rows[49];
    },
  ],
])
  test(`business clock consistency rejects ${name}`, () => {
    const rows = businessWindows();
    mutate(rows);
    const initial = inspectACPClock(receipt(), [healthTrace()]);
    assert.throws(
      () => clockTools.tightenACPClock(initial, rows),
      (error) => {
        assert.equal(error.code, "ERR_ASSERTION");
        return true;
      },
    );
  });

test("actual probe brackets complete /status body after child ready and joins child exit", async () => {
  let response, requestedResolve;
  const requested = new Promise((resolve) => {
    requestedResolve = resolve;
  });
  const server = createServer((request, reply) => {
    assert.equal(request.url, "/status");
    assert.equal(request.method, "GET");
    assert.equal(request.headers.traceparent, undefined);
    assert.equal(request.headers.authorization, undefined);
    response = reply;
    reply.writeHead(200, { Date: date, "Content-Type": "application/json" });
    reply.write('{"status":');
    requestedResolve();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const abort = new AbortController();
  let child,
    done = false;
  const run = probeACPClock({
    container,
    signal: abort.signal,
    spawnProcess: (command, args, options) => {
      assert.equal(command, "docker");
      assert.deepEqual(args.slice(0, 6), [
        "exec",
        "-i",
        container,
        "node",
        "--input-type=module",
        "-e",
      ]);
      child = spawn(process.execPath, args.slice(4), {
        ...options,
        env: {
          ...process.env,
          ANTNEST_ACP_CONTROL_LISTEN: `:${server.address().port}`,
        },
      });
      return child;
    },
  });
  run.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  try {
    await requested;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(done, false, "headers are not a completed probe");
    response.end('"ready"}');
    const result = await run;
    assert.equal(result.body_complete, true);
    assert.equal(result.body_sha256, hash('{"status":"ready"}'));
    assert.equal(result.server_date, date);
    assert.equal(child.exitCode, 0, "probe returned before child exit");
    assert(result.received_at >= result.started_at);
  } finally {
    abort.abort();
    response?.destroy();
    await run.catch(() => {});
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("probe interruption kills and joins the owned process group", async () => {
  const abort = new AbortController();
  let child;
  const run = probeACPClock({
    container,
    signal: abort.signal,
    spawnProcess: (_command, _args, options) => {
      child = spawn(
        process.execPath,
        ["-e", "setInterval(()=>{},1000)"],
        options,
      );
      child.once("spawn", () => abort.abort(new Error("test interrupt")));
      return child;
    },
  });
  await assert.rejects(() => run, /interrupted/u);
  assert.notEqual(
    child.signalCode,
    null,
    "interrupted probe child remains alive",
  );
});

test(
  "probe cancellation closes the in-container request and joins a cooperative remote exit",
  { timeout: 10000 },
  async () => {
    let response, requestedResolve;
    const requested = new Promise((resolve) => {
      requestedResolve = resolve;
    });
    const server = createServer((_request, reply) => {
      response = reply;
      reply.writeHead(200, { Date: date });
      reply.write('{"status":');
      requestedResolve();
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const abort = new AbortController();
    let child;
    const run = probeACPClock({
      container,
      signal: abort.signal,
      spawnProcess: (_command, args, options) => {
        child = spawn(process.execPath, args.slice(4), {
          ...options,
          env: {
            ...process.env,
            ANTNEST_ACP_CONTROL_LISTEN: `:${server.address().port}`,
          },
        });
        return child;
      },
    });
    const rejected = assert.rejects(() => run, /interrupted/u);
    try {
      await requested;
      abort.abort();
      await rejected;
      assert.equal(
        child.signalCode,
        null,
        "only killing the Docker CLI loses remote probe ownership",
      );
      assert.equal(
        child.exitCode,
        1,
        "remote probe must acknowledge cancellation and exit",
      );
    } finally {
      abort.abort();
      response?.destroy();
      await run.catch(() => {});
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);

for (const host of ["127.0.0.1", "::1"])
  test(
    `actual clock probe uses the explicit service bind ${host}`,
    { timeout: 10000 },
    async () => {
      const server = createServer((_request, response) => {
        response.writeHead(200, { Date: date });
        response.end('{"status":"ready"}');
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, host, resolve);
      });
      try {
        const listen = `${host.includes(":") ? `[${host}]` : host}:${server.address().port}`;
        const result = await probeACPClock({
          container,
          spawnProcess: (_command, args, options) =>
            spawn(process.execPath, args.slice(4), {
              ...options,
              env: { ...process.env, ANTNEST_ACP_CONTROL_LISTEN: listen },
            }),
        });
        assert.equal(result.status, 200);
        assert.equal(result.ready, true);
        assert.equal(result.body_sha256, hash('{"status":"ready"}'));
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    },
  );

test("probe target preserves the deployed control interface and only maps wildcard listeners", () => {
  for (const [listen, expected] of [
    ["10.241.0.34:8081", { hostname: "10.241.0.34", port: 8081 }],
    ["10.241.0.34: 8081", { hostname: "10.241.0.34", port: 8081 }],
    [": 8081", { hostname: "127.0.0.1", port: 8081 }],
    [" :8081 ", { hostname: "127.0.0.1", port: 8081 }],
    ["0.0.0.0:8081", { hostname: "127.0.0.1", port: 8081 }],
    ["[::]:8081", { hostname: "::1", port: 8081 }],
    ["[::1]:8081", { hostname: "::1", port: 8081 }],
    ["service-host:80", { hostname: "service-host", port: 80 }],
  ])
    assert.deepEqual(clockTools.acpControlEndpoint(listen), expected);
});

test("clock mapping requires the original span in the supplied raw Trace", () => {
  const trace = healthTrace();
  const clock = inspectACPClock(receipt(), [trace]);
  assert.throws(
    () => acpSpanEndInterval(clock, trace, { ...trace.spans[0] }),
    /actual Trace/u,
  );
});
