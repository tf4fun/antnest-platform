import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as evidence from "./runtime-tools-evidence.mjs";
import { tsImport } from "../../../services/agent-acp-service/node_modules/tsx/dist/esm/api/index.mjs";

const { normalizeAttributes } = await tsImport(
  "../../../services/agent-acp-service/src/telemetry/names.ts",
  import.meta.url,
);

const registry = JSON.parse(
  readFileSync(
    new URL(
      "../../../contracts/observability/attributes.yaml",
      import.meta.url,
    ),
    "utf8",
  ),
);

for (const [method, modes] of [
  ["list", ["success", "http-error", "caller-abort"]],
  ["call", ["success", "tool-error", "http-error", "caller-abort"]],
]) {
  for (const mode of modes) {
    test(`Runtime tool ${method}/${mode} expected attributes follow the published aliases`, () => {
      assert.equal(typeof evidence.expectedOwnerAttributes, "function");
      const receipt = Object.freeze({
        method,
        mode,
        executionId: "execution-test",
        deadlineAt: 12345,
      });
      const before = JSON.stringify(receipt);
      const expected = evidence.expectedOwnerAttributes(receipt);
      assert.deepEqual(
        expected,
        normalizeAttributes(expected),
        "probe oracle must include every actual producer alias",
      );
      const identities = {
        "antnest.runtime.execution.id": receipt.executionId,
        "antnest.outcome": expected["antnest.outcome"],
        ...(method === "call"
          ? {
              "antnest.run.id": "run-1",
              "antnest.organization.id": "organization-1",
            }
          : {}),
      };
      for (const [canonical, value] of Object.entries(identities)) {
        assert.equal(expected[canonical], value, canonical);
        const aliases = registry.attributes.filter(
          (entry) =>
            entry.kind === "span_attribute" &&
            entry.deprecated_alias_of === canonical,
        );
        assert(
          aliases.length > 0,
          `missing published aliases for ${canonical}`,
        );
        for (const alias of aliases)
          assert.equal(expected[alias.name], value, alias.name);
      }
      assert.equal(expected["organization.id"], "organization-1");
      assert.equal(expected["antnest.mcp.method"], `tools/${method}`);
      assert.equal(
        expected["antnest.outcome"],
        mode === "success"
          ? "ok"
          : mode === "tool-error"
            ? "tool_error"
            : "error",
      );
      assert.equal(
        expected["antnest.mcp.tool_result.outcome"],
        mode === "success"
          ? "success"
          : mode === "tool-error"
            ? "tool_error"
            : "not_received",
      );
      assert.equal(expected["antnest.mcp.connection.close.outcome"], "closed");
      if (method === "call") {
        assert.equal(expected["run.id"], "run-1");
        assert.equal(expected["antnest.deadline"], receipt.deadlineAt);
      } else {
        assert.equal(expected["antnest.run.id"], undefined);
        assert.equal(expected["antnest.organization.id"], undefined);
        assert.equal(expected["execution.revision"], "execution-1");
      }
      assert.equal(JSON.stringify(receipt), before);
    });
  }
}
test("runtimeExecutionAttributes mirrors every published runtime execution alias", () => {
  const registry = JSON.parse(
    readFileSync(
      new URL(
        "../../../contracts/observability/attributes.yaml",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const canonical = registry.attributes.find(
    (entry) => entry.name === "antnest.runtime.execution.id",
  );
  const aliases = registry.attributes
    .filter(
      (entry) =>
        entry.kind === "span_attribute" &&
        entry.deprecated_alias_of === "antnest.runtime.execution.id",
    )
    .map((entry) => entry.name);
  const expected = Object.fromEntries(
    [canonical.name, ...aliases].map((name) => [name, "execution-test"]),
  );
  assert.deepEqual(
    evidence.runtimeExecutionAttributes("execution-test"),
    expected,
  );
});

test("outcomeAttributes mirrors every published outcome alias", () => {
  assert.equal(typeof evidence.outcomeAttributes, "function");
  const names = registry.attributes
    .filter(
      (entry) =>
        entry.name === "antnest.outcome" ||
        entry.deprecated_alias_of === "antnest.outcome",
    )
    .map((entry) => entry.name);
  for (const outcome of [
    "ok",
    "error",
    "cancelled",
    "http_error",
    "rejected",
    "tool_error",
  ])
    assert.deepEqual(
      evidence.outcomeAttributes(outcome),
      Object.fromEntries(names.map((name) => [name, outcome])),
    );
});

test("span inspection findings remain available without stopping subsequent checks", () => {
  const finding = new Error("missing diagnostic span");
  const findings = [];
  assert.deepEqual(
    evidence.inspectDiagnostics(
      () => ({ spans: 3 }),
      findings.push.bind(findings),
    ),
    {
      diagnostics: "passed",
      spans: 3,
    },
  );
  assert.deepEqual(
    evidence.inspectDiagnostics(() => {
      throw finding;
    }, findings.push.bind(findings)),
    {
      diagnostics: "warning",
    },
  );
  assert.deepEqual(findings, [finding]);
  // Business and resource checks stay outside the diagnostic catch boundary.
  assert.throws(() => {
    evidence.inspectDiagnostics(
      () => {
        throw finding;
      },
      () => {},
    );
    throw new Error("business or cleanup failed");
  }, /business or cleanup failed/);
});

test("private diagnostic content is independently blocking before span inspection", () => {
  let inspected = false;
  assert.throws(() => {
    evidence.assertPublicEvidence("PRIVATE-SECRET-CANARY");
    evidence.inspectDiagnostics(() => {
      inspected = true;
    });
  }, /private content/);
  assert.equal(inspected, false);
  evidence.assertPublicEvidence("public diagnostics");
});
