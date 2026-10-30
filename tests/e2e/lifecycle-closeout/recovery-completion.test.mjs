import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { restorePrivateEvidenceFixture } from "./restore-private-evidence.fixture.mjs";
import { skillRestorePrivateEvidenceFixture } from "./skill-restore-private-evidence.fixture.mjs";
import { shutdownPrivateEvidenceFixture } from "./shutdown-private-evidence.fixture.mjs";
import { createTraceDiagnostics } from "../../support/trace-diagnostics.mjs";

const url = new URL("./recovery-completion.mjs", import.meta.url);
const { admitRecoveryBusiness } = await import(url).catch((error) => {
  if (error.code !== "ERR_MODULE_NOT_FOUND" || error.url !== url.href)
    throw error;
  return {};
});
for (const [profile, fixture, changes] of [
  [
    "restore",
    restorePrivateEvidenceFixture,
    [
      (r) => r.private_restore.histories[1].push({ sessionId: "foreign" }),
      (r) => (r.private_restore.preserved_runs[2].state = "cancelled"),
      (r) => (r.file_metadata_preserved = false),
      (r) => (r.private_restore.lifecycle_admissions[2].kind = "rebuild"),
    ],
  ],
  [
    "skill-restore",
    skillRestorePrivateEvidenceFixture,
    [
      (r) => (r.original_acp_ciphertext_read = false),
      (r) => (r.registry_offline_enable = false),
      (r) => r.private_skill_restore.skill_files.pop(),
      (r) => (r.private_skill_restore.lifecycle_admissions[2].kind = "rebuild"),
    ],
  ],
  [
    "shutdown",
    shutdownPrivateEvidenceFixture,
    [
      (r) => (r.same_session_recovered = false),
      (r) => (r.private_shutdown.remote_acp_close.localClose = true),
      (r) => (r.private_shutdown.workspace.after = "changed"),
      (r) => r.private_shutdown.deletion.resources.volumes.push("leak"),
      (r) => {
        r.private_shutdown.public_watches[0].closure.observedAt =
          r.private_shutdown.stop_window.end + 1;
      },
    ],
  ],
]) {
  function diagnostics(t) {
    const directory = mkdtempSync(
      resolve("artifacts/verification/recovery-completion-"),
    );
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    return createTraceDiagnostics({ directory });
  }
  test(`${profile}: missing Trace evidence is auxiliary after original business checks`, async (t) => {
    assert.equal(typeof admitRecoveryBusiness, "function");
    const result = await fixture(t);
    result.request_traces = [];
    result.traces = [];
    if (profile === "shutdown") result.watch_traces = [];
    const before = structuredClone(result);
    const outcome = await admitRecoveryBusiness(profile, result, {
      traceDiagnostics: diagnostics(t),
    });
    assert.equal(outcome.accepted_exit, 0);
    assert.equal(outcome.trace_diagnostics.status, "warning");
    assert.deepEqual(result, before);
  });
  test(`${profile}: raw request, persistence, lifecycle and cleanup failures still block with Trace unavailable`, async (t) => {
    assert.equal(typeof admitRecoveryBusiness, "function");
    const original = await fixture(t);
    for (const mutate of [
      ...changes,
      (r) => r.private_connections[0].raw_frames.pop(),
      (r) => (r.private_connections[0].evidence[0].outcome = "failed"),
      (r) => (r.private_cleanup_completed = false),
      (r) => r.private_collection_errors.push("business failure"),
    ]) {
      const result = structuredClone(original);
      result.request_traces = [];
      result.traces = [];
      result.watch_traces = [];
      mutate(result);
      await assert.rejects(() =>
        admitRecoveryBusiness(profile, result, {
          traceDiagnostics: diagnostics(t),
        }),
      );
    }
  });
}
