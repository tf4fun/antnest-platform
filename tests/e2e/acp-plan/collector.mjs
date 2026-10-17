import assert from "node:assert/strict";
import { collectPrivateACPTrace } from "../identity-closeout/private-acp-trace.mjs";
import {
  privateACPDiagnosticInventory,
  privateACPStrictOutcome,
} from "../observability/private-acp-inventory.mjs";
import { inspectPrivatePlanRequestTrace } from "./requests.mjs";
import { inspectPlanTrace } from "./trace.mjs";

const ownedReasons = new Set([
  "plan-rejection",
  "completed-initialize-mcp-read-disconnect",
  "completed-runtime-tool-http-disconnect",
]);

export function privatePlanStrictOutcome(results) {
  return privateACPStrictOutcome(results, ownedReasons);
}

// The original SDK request selects the RPC, then its phase selects all actual
// model calls. A foreign Trace or missing stage cannot disappear in filtering.
export function collectPrivatePlanTrace(
  base,
  expected,
  { requests = [], secrets = [], ...options } = {},
) {
  assert.equal(expected.boundary, "private-acp");
  assert.equal(expected.transport, "websocket");
  assert(Array.isArray(requests));
  return collectPrivateACPTrace(base, expected, {
    ...options,
    secrets,
    inspect: (trace, bound) => {
      const result =
        expected.method === "session/prompt"
          ? inspectPlanTrace(
              trace,
              requests.filter((item) => item.phase === expected.phase),
              secrets,
              bound,
            )
          : inspectPrivatePlanRequestTrace(trace, bound, secrets);
      return {
        ...result,
        ...privateACPDiagnosticInventory(
          [trace, bound.connectionTrace],
          [result],
          ownedReasons,
        ),
      };
    },
  });
}
