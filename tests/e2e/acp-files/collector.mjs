import assert from "node:assert/strict";
import { collectPrivateACPTrace } from "../identity-closeout/private-acp-trace.mjs";
import {
  privateACPDiagnosticInventory,
  privateACPStrictOutcome,
} from "../observability/private-acp-inventory.mjs";
import { inspectPrivateFileRequestTrace } from "./requests.mjs";
import { inspectPrivateFileTrace } from "./private-trace.mjs";

const ownedReasons = new Set([
  "files-rejection",
  "files-deliberate-failed-edit",
  "completed-initialize-mcp-read-disconnect",
  "completed-runtime-tool-http-disconnect",
]);

export function privateFileStrictOutcome(results) {
  return privateACPStrictOutcome(results, ownedReasons);
}

// The original SDK request selects the RPC, then its phase selects all actual
// model calls. A foreign Trace or missing stage cannot disappear in filtering.
export function collectPrivateFileTrace(
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
          ? inspectPrivateFileTrace(
              trace,
              requests.filter((item) => item.phase === expected.phase),
              secrets,
              bound,
            )
          : inspectPrivateFileRequestTrace(trace, bound, secrets);
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
