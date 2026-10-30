import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeEvidenceFile } from "../../support/storage.mjs";

// Exception messages, assertion values and Docker output can contain fixture
// credentials. Only known error kinds and source locations enter CI evidence.
export function installFailureSummary(stage, error) {
  assert(/^[a-z][a-z0-9-]{0,99}$/u.test(stage));
  const failures = [],
    seen = new Set();
  function visit(current) {
    if (!current || seen.has(current) || failures.length === 12) return;
    seen.add(current);
    const type = [
      "Error",
      "AssertionError",
      "AggregateError",
      "TypeError",
      "AbortError",
    ].includes(current.name)
      ? current.name
      : "Error";
    const locations = [
      ...String(current.stack ?? "").matchAll(
        /\bat [^\n]*?(tests\/e2e\/(?:skill-learning\/(?:owner-install-recovery|install-interruption\.test)|workspace-closeout\/c4-setup)\.mjs):(\d+):(\d+)\)?$/gmu,
      ),
    ]
      .slice(0, 5)
      .map(([, file, line, column]) => ({
        file,
        line: Number(line),
        column: Number(column),
      }));
    const operator = [
      "strictEqual",
      "deepStrictEqual",
      "match",
      "==",
      "!=",
      "===",
      "!==",
    ].includes(current.operator)
      ? current.operator
      : undefined;
    failures.push({ type, ...(operator ? { operator } : {}), locations });
    for (const child of Array.isArray(current.errors) ? current.errors : [])
      visit(child);
    visit(current.cause);
  }
  visit(error);
  return { stage, failures };
}

export function createInstallDiagnostics(directory, scenario) {
  assert(/^[a-z][a-z0-9-]{0,99}$/u.test(scenario));
  const name = `install-${scenario}-${randomUUID()}.json`;
  const record = {
    scenario,
    stage: "configuration",
    business: "not_completed",
    cleanup: "not_run",
  };
  const save = () =>
    writeEvidenceFile(directory, name, JSON.stringify(record, null, 2) + "\n");
  return {
    advance(stage) {
      assert(/^[a-z][a-z0-9-]{0,99}$/u.test(stage));
      record.stage = stage;
      save();
    },
    complete() {
      record.business = "passed";
      save();
    },
    fail(error) {
      record.business = "failed";
      Object.assign(record, installFailureSummary(record.stage, error));
      save();
    },
    cleanup(error) {
      record.cleanup = error ? "failed" : "passed";
      if (error)
        record.cleanup_failure = installFailureSummary("cleanup", error);
      save();
    },
  };
}
