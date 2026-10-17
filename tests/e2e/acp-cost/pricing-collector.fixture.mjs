import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { temporaryStorageRoot } from "../../support/storage.mjs";
import { consoleObservationFixture } from "../observability/console-observation-fixtures.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";

const catalog = readFileSync(
  new URL(
    "../../../services/agent-controller/internal/repository/postgres/catalog.go",
    import.meta.url,
  ),
  "utf8",
);
const sql = (operation) => {
  const matches = [...catalog.matchAll(/`([^`]+)`/gu)]
    .map((match) => match[1])
    .filter((text) =>
      text.trim().startsWith(operation + " agent_controller.model_profiles"),
    );
  assert.equal(matches.length, 1);
  return matches[0];
};

export function costPricingFixture(
  t,
  source = "shared-background",
  revision = false,
) {
  const f = consoleObservationFixture("template", source);
  const expected = {
    traceID: f.trace.traceID,
    route: revision
      ? "/internal/model-profiles/{model_profile_id}/revisions"
      : "/internal/provider-connections",
    publicRoute: revision
      ? "/api/admin/model-profiles/{model_profile_id}/revisions"
      : "/api/admin/provider-connections",
  };
  for (const trace of f.traces.values()) {
    trace.fixture_note = "原始响应";
    for (const span of trace.spans) span.logs = [];
  }
  const console = f.trace.spans.find((s) => s.spanID === "console");
  setTag(console, "http.route", expected.publicRoute);
  console.operationName = "HTTP POST " + expected.publicRoute;
  const controller = f.trace.spans.find(
    (s) => s.spanID === "controller-server",
  );
  setTag(controller, "http.route", expected.route);
  setTag(controller, "rpc.method", "POST " + expected.route);
  controller.operationName = "HTTP POST " + expected.route;
  const write = f.trace.spans.find((s) => s.spanID === "catalog-write");
  const operation = revision ? "UPDATE" : "INSERT";
  write.operationName = operation;
  setTag(write, "db.operation.name", operation);
  setTag(write, "db.query.text", sql(revision ? "UPDATE" : "INSERT INTO"));
  const directory = mkdtempSync(
    join(temporaryStorageRoot(), "antnest-cost-pricing-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = [],
    waits = [];
  const raw = (id) => Buffer.from(JSON.stringify({ data: [f.traces.get(id)] }));
  const options = {
    directory,
    secrets: ["PRIVATE-PRICING-SECRET"],
    resolveTTLMS: 10000,
    wait: async (ms) => {
      waits.push(ms);
    },
    request: async (url) => {
      const id = new URL(url).pathname.split("/").at(-1);
      calls.push(id);
      assert(f.traces.has(id));
      return new Response(raw(id));
    },
  };
  return {
    ...f,
    expected,
    directory,
    options,
    raw,
    calls,
    waits,
    controller,
    write,
  };
}
