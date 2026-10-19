import assert from "node:assert/strict";
import test from "node:test";
import { c4InventoryFixture } from "./c4-inventory.fixture.mjs";

const url = new URL("./c4-inventory.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const inspect = (report) => {
  assert.equal(typeof implementation.assertC4ExecutionInventory, "function");
  return implementation.assertC4ExecutionInventory(report);
};

test("C4 admits all eleven native page Runs with fourteen Providers and two original Runtime bindings", () => {
  const report = c4InventoryFixture(),
    original = structuredClone(report),
    rows = inspect(report);
  assert.equal(rows.length, 11);
  assert.equal(
    rows.reduce((count, row) => count + row.requests.length, 0),
    14,
  );
  assert.equal(rows.filter((row) => row.toolName).length, 4);
  assert.equal(
    rows.filter(
      (row) => row.runtime.runtime_execution_id === "runtime-execution-1",
    ).length,
    9,
  );
  assert.equal(
    rows.filter(
      (row) => row.runtime.runtime_execution_id === "runtime-execution-2",
    ).length,
    2,
  );
  const audio = rows.find((row) => row.phase.endsWith("unsupported-audio"));
  assert.deepEqual(audio.requests, []);
  assert.equal(audio.traceID, report.prompt_receipts[3].traceID);
  assert.equal(audio.run.terminal_class, "failed");
  assert.deepEqual(report, original);
});
for (const [name, change] of [
  [
    "old four-Run subset",
    (r) => {
      r.execution.audits.all = r.execution.audits.all.filter((row) =>
        /-(write|read|attachments|mobile)$/u.test(row.run.input[0].text),
      );
    },
  ],
  ["missing audio Run", (r) => r.execution.audits.all.splice(3, 1)],
  [
    "extra Run",
    (r) =>
      r.execution.audits.all.push(structuredClone(r.execution.audits.all[0])),
  ],
  [
    "incomplete audit page",
    (r) => {
      r.execution.audits.page.next_cursor = "more";
    },
  ],
  [
    "incomplete events",
    (r) => {
      r.execution.audits.all[0].events.next_cursor = "more";
    },
  ],
  [
    "wrong event stream",
    (r) => {
      r.execution.audits.all[0].events.stream = "permissions";
    },
  ],
  ["missing audio page Trace", (r) => r.prompt_receipts.splice(3, 1)],
  [
    "Provider replay",
    (r) =>
      r.execution.model.requests.push(
        structuredClone(r.execution.model.requests[0]),
      ),
  ],
  [
    "audio reached Provider",
    (r) =>
      r.execution.model.requests.push({
        ...r.execution.model.requests[0],
        phase: "c4-browser-unsupported-audio",
      }),
  ],
  [
    "foreign Provider Trace",
    (r) => {
      r.execution.model.requests[0].trace_id = "f".repeat(32);
    },
  ],
  [
    "foreign owner",
    (r) => {
      r.execution.audits.all[0].run.principal_id = "other";
    },
  ],
  [
    "foreign Session",
    (r) => {
      r.execution.audits.all[0].run.session_id = "other";
    },
  ],
  [
    "audio accepted as success",
    (r) => {
      r.execution.audits.all[3].run.state = "completed";
    },
  ],
  [
    "changed attachment bytes",
    (r) => {
      r.execution.audits.all[2].run.input[1].resource.text = "changed";
    },
  ],
  [
    "changed original page Prompt",
    (r) => {
      r.prompt_receipts[0].request.body.prompt[0].text = "changed";
    },
  ],
  [
    "copied page Trace",
    (r) => {
      r.prompt_receipts[1].traceID = r.prompt_receipts[0].traceID;
    },
  ],
  [
    "wrong cancellation Run",
    (r) => {
      r.cancelled_run.runId = "other";
    },
  ],
  [
    "unobserved cancellation",
    (r) => {
      delete r.execution.model.requests.find((row) =>
        row.phase.endsWith("hold-cancel"),
      ).disconnected;
    },
  ],
  [
    "offline replayed as disconnect",
    (r) => {
      r.execution.model.requests.find((row) =>
        row.phase.endsWith("hold-offline"),
      ).disconnected = true;
    },
  ],
  [
    "old Runtime after Rebuild",
    (r) => {
      r.execution.audits.all[9].run.execution_snapshot.executionRevision =
        "execution-1";
    },
  ],
  [
    "invented Runtime binding",
    (r) => {
      r.runtime_bindings[1].binding.runtime_execution_id = "other";
    },
  ],
  [
    "same physical Runtime",
    (r) => {
      r.runtime_bindings[1].observed.container.Id =
        r.runtime_bindings[0].observed.container.Id;
    },
  ],
  [
    "lost workspace volume",
    (r) => {
      r.runtime_bindings[1].observed.volume = "replacement-volume";
    },
  ],
])
  test(`C4 refuses ${name} as complete browser coverage`, () => {
    const report = c4InventoryFixture();
    change(report);
    assert.equal(typeof implementation.assertC4ExecutionInventory, "function");
    assert.throws(() => inspect(report));
  });

test("partial C4 collection retains independent page traces even without the complete audit inventory", () => {
  const report = c4InventoryFixture();
  delete report.execution;
  assert.equal(typeof implementation.c4PromptExpectations, "function");
  const rows = implementation.c4PromptExpectations(report);
  assert.equal(rows.length, 11);
  assert(rows.every((row) => row.traceID && row.run === undefined));
  assert.equal(
    rows.find((row) => row.phase.endsWith("unsupported-audio")).requests.length,
    0,
  );
});

test("partial C4 collection keeps an unmatched Provider Trace for failure evidence without inventing a page receipt", () => {
  const report = c4InventoryFixture();
  report.prompt_receipts.shift();
  assert.equal(typeof implementation.c4PromptExpectations, "function");
  const rows = implementation.c4PromptExpectations(report);
  assert.equal(rows.length, 11);
  const fallback = rows.find((row) => row.phase.endsWith("write"));
  assert.equal(fallback.receipt, undefined);
  assert.equal(fallback.requests.length, 2);
  assert.throws(() => inspect(report));
});

test("partial C4 collection retains a newer independent Provider observation when the audit refresh is stale", () => {
  const report = c4InventoryFixture();
  report.execution.model.requests = [];
  report.prompt_receipts = [];
  const rows = implementation.c4PromptExpectations(report);
  assert.equal(rows.length, 10);
  assert.equal(
    rows.reduce((count, row) => count + row.requests.length, 0),
    14,
  );
  const write = rows.find((row) => row.phase === "c4-browser-write");
  assert.deepEqual(write.provider_observations.execution, []);
  assert.deepEqual(
    write.provider_observations.browser,
    report.model.requests.slice(0, 2),
  );
  assert.throws(() => inspect(report));
});

test("partial C4 collection preserves conflicting Provider observations for the same original identity", () => {
  const report = c4InventoryFixture(),
    original = structuredClone(report.execution.model.requests[0]);
  report.model.requests[0].phase = "unexpected-phase";
  const rows = implementation.c4PromptExpectations(report),
    write = rows.find((row) => row.phase === "c4-browser-write");
  assert.deepEqual(write.provider_observations.execution[0], original);
  assert.deepEqual(
    write.provider_observations.browser[0],
    report.model.requests[0],
  );
  assert.throws(() => inspect(report));
});
