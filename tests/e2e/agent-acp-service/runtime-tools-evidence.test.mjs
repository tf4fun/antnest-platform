import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as evidence from "./runtime-tools-evidence.mjs";

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
      const identities = {
        "antnest.runtime.execution.id": receipt.executionId,
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
