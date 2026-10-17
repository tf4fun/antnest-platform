import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { verify, counterexamples } from "./runtime-tools-evidence.mjs";

// Replay only the first actual successful operation from a preserved probe log.
// This validates inspector rejection, never the complete historical Docker run.
const source = readFileSync(process.argv[2]);
const records = source
  .toString("utf8")
  .split("\n")
  .flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
const receipt = records.find(
  (row) =>
    row.event === "runtime_tools_peer_receipt" &&
    row.method === "list" &&
    row.mode === "success",
);
assert(receipt?.complete);
const bodies = records
  .filter((row) => row.event === "runtime_tools_otlp_raw")
  .map((row) => {
    const body = Buffer.from(row.body_base64, "base64");
    assert.equal(createHash("sha256").update(body).digest("hex"), row.sha256);
    return JSON.parse(body.toString("utf8"));
  });
const traceId = receipt.requests[0].traceId;
const filtered = bodies
  .map((body) => ({
    ...body,
    resourceSpans: body.resourceSpans
      .map((group) => ({
        ...group,
        scopeSpans: group.scopeSpans
          .map((scope) => ({
            ...scope,
            spans: scope.spans.filter((span) => span.traceId === traceId),
          }))
          .filter((scope) => scope.spans.length),
      }))
      .filter((group) => group.scopeSpans.length),
  }))
  .filter((body) => body.resourceSpans.length);
const identity = filtered[0].resourceSpans[0].resource.attributes.find(
  (item) => item.key === "service.instance.id",
).value.stringValue;
const receipts = [{ ...receipt, actual: receipt.outcome }];
const verified = verify(receipts, filtered, identity);
console.log(
  JSON.stringify({
    event: "runtime_tools_original_replay",
    source_sha256: createHash("sha256").update(source).digest("hex"),
    scope:
      "first successful list; complete original Docker admission remains failed",
    ...verified,
  }),
);
console.log(JSON.stringify(counterexamples(receipts, filtered, identity)));
