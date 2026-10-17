import assert from "node:assert/strict";
import test from "node:test";
import { hasDiagnosticError } from "./requests.mjs";

const sentinels = [
  ["error.type", ""],
  ["antnest.error.code", ""],
  ["antnest.error.class", "none"],
];
for (const location of ["tags", "event"])
  for (const [key, value] of sentinels) {
    const source = () =>
      location === "tags"
        ? { tags: [{ key, value }], logs: [] }
        : { tags: [], logs: [{ fields: [{ key, value }] }] };
    test(`raw diagnostics keep exact ${key} success sentinel neutral in ${location}`, () => {
      const span = source(),
        before = structuredClone(span);
      assert.equal(hasDiagnosticError(span), false);
      assert.deepEqual(span, before);
    });
    for (const diagnostic of [
      { key: "error", value: true },
      { key: "otel.status_code", value: 2 },
      { key: "antnest.outcome", value: "failed" },
      { key: "exception.type", value: "InternalFailure" },
    ])
      test(`neutral ${key} in ${location} does not hide ${diagnostic.key}`, () => {
        const span = source();
        span.logs.push({ fields: [diagnostic] });
        assert.equal(hasDiagnosticError(span), true);
      });
  }
for (const [key, value] of [
  ["antnest.error.code", "internal"],
  ["antnest.error.code", false],
  ["antnest.error.class", "None"],
  ["antnest.error.class", ""],
  ["exception.type", ""],
  ["error.code", ""],
])
  test(`raw diagnostics retain non-sentinel ${key}=${JSON.stringify(value)}`, () => {
    assert.equal(hasDiagnosticError({ tags: [{ key, value }] }), true);
  });

for (const [key, value] of sentinels)
  test(`raw diagnostics retain a second nonempty ${key} beside a neutral first field`, () => {
    assert.equal(
      hasDiagnosticError({
        tags: [
          { key, value },
          { key, value: "internal" },
        ],
      }),
      true,
    );
  });
