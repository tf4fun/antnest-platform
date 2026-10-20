import assert from "node:assert/strict";
import { inspect } from "node:util";
import { collectRestoreTraces } from "../lifecycle-closeout/restore-private-session.mjs";

// The concrete runner supplies I/O. A failed business step must not suppress
// independent observations, source archives or the final owned-resource join.
export async function runC4Flow({ report, signal }, actions) {
  const errors = [];
  let config, fixture;
  const attempt = async (work) => {
    try {
      return await work();
    } catch (error) {
      errors.push(error);
      return undefined;
    }
  };
  const checkpoint = () => actions.checkpoint(report);
  try {
    signal?.throwIfAborted();
    config = await actions.configure((allocated) => {
      config = allocated;
    });
    assert(config, "C4 configuration required");
    report.project = config.project;
    signal?.throwIfAborted();
    await actions.deploy(config, report);
    signal?.throwIfAborted();
    fixture = await actions.setup(config, report);
    signal?.throwIfAborted();
    await actions.browser(config, fixture, report, checkpoint);
    signal?.throwIfAborted();
    report.business_completed = true;
  } catch (error) {
    errors.push(error);
  } finally {
    if (config) {
      try {
        const activeAttempt = (work) =>
          signal?.aborted ? undefined : attempt(work);
        if (fixture && !signal?.aborted) {
          for (const name of [
            "refreshModel",
            "refreshAudits",
            "refreshRevocation",
          ])
            await activeAttempt(() => actions[name](config, fixture, report));
        }
        await activeAttempt(checkpoint);
        await activeAttempt(() => actions.flush(config, report));
        const rows =
          (await activeAttempt(() => actions.inventory(report, config))) ?? [];
        if (!signal?.aborted)
          report.traces = await collectRestoreTraces(
            rows,
            (row) => actions.collect(row, config, report),
            (row, error) => actions.preserve(row, error, config, report),
            signal,
            errors,
          );
        await activeAttempt(async () => {
          const admission = await actions.admit(report, config);
          assert(
            admission && [0, 2].includes(admission.exitCode),
            "C4 admission verdict required",
          );
          assert(
            [0, 2].includes(admission.rawExitCode),
            "original C4 strict verdict required",
          );
          report.admission = admission;
        });
      } catch (error) {
        errors.push(error);
      } finally {
        if (errors.length || signal?.aborted)
          await attempt(() => actions.logs(config, report));
        try {
          await actions.cleanup(config, report);
          report.cleanup = "verified";
        } catch (error) {
          errors.push(error);
          report.cleanup = "failed";
        }
      }
    } else report.cleanup = "not-created";
  }
  const record = () => {
    if (signal?.aborted) errors.push(signal.reason);
    const unique = [...new Set(errors)];
    if (!Object.hasOwn(report, "c4Errors"))
      Object.defineProperty(report, "c4Errors", { value: [] });
    report.c4Errors.splice(0, report.c4Errors.length, ...unique);
    report.private_errors = unique.map((error) => inspect(error, { depth: 8 }));
    report.exit_code = unique.length ? 1 : (report.admission?.exitCode ?? 1);
    report.status =
      report.exit_code === 0
        ? "passed"
        : report.exit_code === 2
          ? "strict_findings"
          : "failed";
  };
  record();
  const errorsBeforeWrite = report.c4Errors.length;
  await attempt(checkpoint);
  record();
  if (report.c4Errors.length !== errorsBeforeWrite) {
    await attempt(checkpoint);
    record();
  }
  return report;
}

export function c4PublicResult(report) {
  return {
    status: report.status,
    project: report.project,
    checks: [...report.checks],
    trace_count: report.traces.length,
    strict_trace: report.admission?.strict_trace,
    raw_exit_code: report.admission?.rawExitCode,
    exit_code: report.exit_code,
    error_count: report.c4Errors.length,
    cleanup: report.cleanup,
    evidence: report.evidence,
  };
}
