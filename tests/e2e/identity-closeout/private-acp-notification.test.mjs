import assert from "node:assert/strict";
import test from "node:test";
import { notificationTraceFixture } from "./private-acp-notification.fixture.mjs";
import { privateBoundaryFixture } from "../acp-plan/private-boundary.fixture.mjs";
import { inspectPrivateACPConnection } from "../acp-plan/requests.mjs";

const url = new URL("./private-acp-notification.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
function api() {
  for (const name of [
    "inspectPrivateNotificationTrace",
    "selectPrivateNotificationTrace",
  ])
    assert.equal(typeof implementation[name], "function", name);
  return implementation;
}

for (const version of [1, 2]) {
  test(`v${version}: original notification binds one INTERNAL root to its actual upgrade`, async (t) => {
    const {
      inspectPrivateNotificationTrace: inspect,
      selectPrivateNotificationTrace: select,
    } = api();
    const f = await notificationTraceFixture(t, version);
    const before = JSON.stringify([f.trace, f.connection]);
    const result = inspect(f.trace, f.receipt, f.connection);
    assert.strictEqual(result.notification, f.root);
    assert.strictEqual(result.connection.server, f.connection.spans[1]);
    assert.equal(select([f.trace], f.receipt, f.connection), f.trace.traceID);
    assert.equal(JSON.stringify([f.trace, f.connection]), before);
  });

  for (const [label, mutate] of [
    ["wrong Agent", (f) => f.field(f.root, "antnest.agent.id", "other")],
    ["wrong Session", (f) => f.field(f.root, "antnest.session.id", "other")],
    [
      "wrong protocol",
      (f) => f.field(f.root, "antnest.protocol.version", "v9"),
    ],
    ["wrong method", (f) => f.field(f.root, "rpc.method", "session/prompt")],
    [
      "wrong name",
      (f) => {
        f.root.operationName = "acp session/prompt";
      },
    ],
    [
      "SERVER pretending notification",
      (f) => f.field(f.root, "span.kind", "server"),
    ],
    ["request ID", (f) => f.field(f.root, "antnest.request.id", "7")],
    ["null request ID", (f) => f.field(f.root, "antnest.request.id", null)],
    [
      "duplicate identity tag",
      (f) => f.root.tags.push({ key: "antnest.agent.id", value: "other" }),
    ],
    [
      "other process",
      (f) => {
        f.trace.processes[f.root.processID].tags.find(
          ({ key }) => key === "process.pid",
        ).value++;
      },
    ],
    [
      "other upgrade",
      (f) => {
        f.root.references[0].spanID = "9".repeat(16);
      },
    ],
    [
      "CLIENT instead of SERVER Link",
      (f) => {
        f.root.references[0].spanID = f.receipt.clientSpanID;
      },
    ],
    [
      "other connection",
      (f) => {
        f.root.references[0].traceID = "9".repeat(32);
      },
    ],
    ["two Links", (f) => f.root.references.push({ ...f.root.references[0] })],
    [
      "synchronous parent",
      (f) => {
        f.root.references[0].refType = "CHILD_OF";
      },
    ],
    [
      "unknown reference",
      (f) =>
        f.root.references.push({
          refType: "UNKNOWN",
          traceID: f.connection.traceID,
          spanID: "9".repeat(16),
        }),
    ],
    [
      "second root",
      (f) =>
        f.trace.spans.push({ ...structuredClone(f.root), spanID: "extra" }),
    ],
    ["missing CLIENT", (f) => f.connection.spans.shift()],
    ["failed upgrade", (f) => f.field(f.connection.spans[1], "error", true)],
    [
      "other raw upgrade",
      (f) => {
        f.connection.traceID = "9".repeat(32);
      },
    ],
    [
      "payload capture",
      (f) => f.field(f.root, "rpc.request.params", "private"),
    ],
  ])
    test(`v${version}: rejects ${label}`, async (t) => {
      const { inspectPrivateNotificationTrace: inspect } = api();
      const f = await notificationTraceFixture(t, version);
      mutate(f);
      assert.throws(() => inspect(f.trace, f.receipt, f.connection));
    });

  test(`v${version}: candidate ambiguity includes malformed matching roots`, async (t) => {
    const { selectPrivateNotificationTrace: select } = api();
    const f = await notificationTraceFixture(t, version);
    const other = structuredClone(f.trace);
    other.traceID = "e".repeat(32);
    for (const span of other.spans) span.traceID = other.traceID;
    f.field(other.spans[0], "span.kind", "server");
    assert.throws(
      () => select([f.trace, other], f.receipt, f.connection),
      /ambiguous|duplicate/,
    );
    assert.throws(() => select([other], f.receipt, f.connection));
    assert.throws(
      () => select([f.trace, f.trace], f.receipt, f.connection),
      /ambiguous|duplicate/,
    );
    other.spans[0].references[0].spanID = "9".repeat(16);
    assert.equal(
      select([other, f.trace], f.receipt, f.connection),
      f.trace.traceID,
    );
    assert.equal(select([other], f.receipt, f.connection), undefined);
  });

  for (const key of [
    "antnest.agent.id",
    "antnest.session.id",
    "rpc.method",
    "antnest.protocol.version",
  ])
    test(`v${version}: duplicate ${key} cannot hide a competing actual-connection candidate`, async (t) => {
      const { selectPrivateNotificationTrace: select } = api();
      const f = await notificationTraceFixture(t, version);
      const other = structuredClone(f.trace);
      other.traceID = "e".repeat(32);
      for (const span of other.spans) span.traceID = other.traceID;
      other.spans[0].tags.unshift({ key, value: "other" });
      assert.throws(
        () => select([f.trace, other], f.receipt, f.connection),
        /duplicate|ambiguous/,
      );
    });

  test(`v${version}: raw selection rejects copied or invalidated local receipts`, async (t) => {
    const { selectPrivateNotificationTrace: select } = api();
    const f = await notificationTraceFixture(t, version);
    assert.throws(
      () => select([f.trace], structuredClone(f.receipt), f.connection),
      /original|receipt/,
    );
    await assert.rejects(f.client.notify("cancel", { sessionId: "late" }));
    assert.throws(
      () => select([f.trace], f.receipt, f.connection),
      /inventory|changed/,
    );
  });

  test(`v${version}: original warnings and errors remain unchanged`, async (t) => {
    const { inspectPrivateNotificationTrace: inspect } = api();
    const f = await notificationTraceFixture(t, version);
    f.root.warnings = ["original notification warning"];
    f.connection.spans[1].warnings = ["original upgrade warning"];
    f.field(f.root, "otel.status_code", 2);
    const before = JSON.stringify([f.trace, f.connection]);
    inspect(f.trace, f.receipt, f.connection);
    assert.equal(JSON.stringify([f.trace, f.connection]), before);
    assert.throws(() =>
      inspect(f.trace, f.receipt, f.connection, [
        "original notification warning",
      ]),
    );
  });
}

test("ordinary private requests still require their actual request ID", () => {
  const f = privateBoundaryFixture();
  delete f.expected.requestId;
  assert.throws(() => inspectPrivateACPConnection(f.expected));
});
