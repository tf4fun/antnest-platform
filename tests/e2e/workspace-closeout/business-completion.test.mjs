import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspacePrivateEvidenceFixture } from "./private-evidence.fixture.mjs";
import { createTraceDiagnostics } from "../../support/trace-diagnostics.mjs";
const directory = mkdtempSync(join(tmpdir(), "workspace-admission-"));
after(() => rmSync(directory, { recursive: true, force: true }));
const implementation = await import("./business-completion.mjs").catch(
  (error) => {
    if (
      error.code !== "ERR_MODULE_NOT_FOUND" ||
      !error.message.includes("business-completion.mjs")
    )
      throw error;
    return {};
  },
);
async function fixture() {
  const result = await workspacePrivateEvidenceFixture();
  assert.deepEqual(result.workspaceErrors, []);
  result.private_resource_cleanup = {
    version: 1,
    status: "joined",
    connections: 5,
    watches: 2,
    state_receipts: result.private_state_receipts.length,
    authority_receipts: result.private_authority_receipts.length,
  };
  return result;
}
async function admit(result, options = {}) {
  assert.equal(typeof implementation.admitWorkspaceBusiness, "function");
  return implementation.admitWorkspaceBusiness(result, {
    directory,
    ...options,
  });
}
test("Workspace admission keeps raw strict failure auxiliary after independent business proof", async () => {
  const result = await fixture(),
    original = structuredClone(result);
  const receipt = await admit(result);
  assert.equal(receipt.status, "business_passed");
  assert.equal(receipt.accepted_exit, 0);
  assert.equal(receipt.strict_exit, 2);
  assert.equal(receipt.inventory.runs, 3);
  assert.equal(receipt.trace_diagnostics.role, "auxiliary");
  assert.equal(receipt.trace_diagnostics.status, "warning");
  assert.equal(receipt.raw_admission.strict_exit, 2);
  assert.deepEqual(result, original);
});
test("Workspace missing collector reports cannot block completed business", async () => {
  const result = await fixture();
  for (const key of [
    "request_traces",
    "watch_traces",
    "state_traces",
    "notification_traces",
    "authority_traces",
    "offboarding_traces",
    "traces",
  ])
    delete result[key];
  const receipt = await admit(result);
  assert.equal(receipt.status, "business_passed");
  assert.equal(receipt.accepted_exit, 0);
  assert.equal(receipt.trace_diagnostics.status, "warning");
  assert.equal(receipt.raw_admission, null);
});
for (const [name, mutate] of [
  [
    "surviving cancelled process",
    (r) =>
      (r.private_workspace.business.cancel.process_after =
        r.private_workspace.business.cancel.process_before),
  ],
  ["missing resource join", (r) => delete r.private_resource_cleanup],
  [
    "original business failure",
    (r) => r.workspaceErrors.push(new Error("original business failure")),
  ],
])
  test(
    "Workspace final admission blocks " +
      name +
      " despite exhausted Trace budget",
    async () => {
      const result = await fixture();
      mutate(result);
      await assert.rejects(
        admit(result, {
          diagnostics: createTraceDiagnostics({ directory, budgetMs: 0 }),
        }),
      );
    },
  );
test("Workspace final admission preserves parent cancellation", async () => {
  const result = await fixture(),
    controller = new AbortController(),
    reason = new Error("original caller abort");
  controller.abort(reason);
  await assert.rejects(
    admit(result, { signal: controller.signal }),
    (error) => error === reason,
  );
});
