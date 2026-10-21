import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { evidenceDirectory, writeEvidenceFile } from "./storage.mjs";

// Call only around observability work. Business checks and resource cleanup
// remain outside this boundary. Collectors must honor the supplied signal;
// await their exit instead of racing a still-running collector against a timer.
export function createTraceDiagnostics({
  directory,
  signal,
  budgetMs = 60_000,
}) {
  directory = evidenceDirectory(directory);
  assert(directory, "private Trace diagnostic directory required");
  assert(Number.isFinite(budgetMs) && budgetMs >= 0 && budgetMs <= 600_000);
  const prefix = `trace-diagnostics-${randomUUID()}`;
  const checks = [];
  let remainingMs = budgetMs;
  const summary = () => ({
    version: 1,
    role: "auxiliary",
    status:
      checks.length === 0
        ? "not_run"
        : checks.every(
              (row) => row.status === "passed" && !row.evidence_error_type,
            )
          ? "passed"
          : "warning",
    evidence: `${prefix}.json`,
    checks: structuredClone(checks),
  });
  const preserve = (row, error) => {
    try {
      if (error !== undefined) {
        row.failure_evidence = `${prefix}-${checks.length}.private.txt`;
        writeEvidenceFile(
          directory,
          row.failure_evidence,
          inspect(error, { depth: 8 }) + "\n",
        );
      }
      writeEvidenceFile(
        directory,
        `${prefix}.json`,
        JSON.stringify(summary(), null, 2) + "\n",
      );
    } catch (error) {
      // An unavailable observability archive is itself a diagnostic. Never
      // turn it into a successful collection or suppress later business work.
      row.evidence_error_type = error?.name ?? "Error";
    }
  };
  return {
    summary,
    async run(name, check) {
      assert(
        typeof name === "string" &&
          /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,179}$/u.test(name),
      );
      assert.equal(typeof check, "function");
      signal?.throwIfAborted();
      const row = { name, status: "not_collected" };
      checks.push(row);
      if (remainingMs <= 0) {
        row.reason = "diagnostic-budget-exhausted";
        preserve(row);
        return structuredClone(row);
      }
      const controller = new AbortController();
      const deadline = new Error("Trace diagnostic budget exhausted");
      const timer = setTimeout(() => controller.abort(deadline), remainingMs);
      const localSignal = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;
      const started = performance.now();
      let value;
      let failure;
      try {
        value = await check(localSignal);
        localSignal.throwIfAborted();
        row.status = "passed";
      } catch (error) {
        failure = error;
        row.status = controller.signal.aborted ? "unavailable" : "failed";
        row.error_type = error?.name ?? "Error";
      } finally {
        clearTimeout(timer);
        row.duration_ms = Math.max(0, performance.now() - started);
        remainingMs = controller.signal.aborted
          ? 0
          : Math.max(0, remainingMs - row.duration_ms);
      }
      preserve(row, failure);
      signal?.throwIfAborted();
      return row.status === "passed"
        ? { ...structuredClone(row), value }
        : structuredClone(row);
    },
  };
}
