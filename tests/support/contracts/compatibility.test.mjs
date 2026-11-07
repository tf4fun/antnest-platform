import assert from "node:assert/strict";
import test from "node:test";
import {
  compatibilityProblems,
  schemaRevisionProblems,
} from "../../../scripts/check-contract-compatibility.mjs";

const clone = (value) => structuredClone(value);

function baseSchema() {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://schemas.antnest.dev/example/record.schema.json",
    title: "Record",
    type: "object",
    additionalProperties: false,
    required: ["schema_version", "name"],
    properties: {
      schema_version: { const: 1 },
      name: { type: "string", minLength: 1, maxLength: 128 },
      mode: { enum: ["alpha", "beta"] },
    },
  };
}

function compatible(before, after, label) {
  assert.deepEqual(compatibilityProblems(before, after, label), []);
}

function incompatible(before, after, label) {
  const problems = compatibilityProblems(before, after, label);
  assert.ok(Array.isArray(problems));
  assert.ok(problems.length > 0, "expected compatibility problems");
  assert.ok(problems.every((problem) => typeof problem === "string"));
  return problems;
}

test("identical schemas report no problems", () => {
  compatible(baseSchema(), baseSchema());
  compatible({ type: "string" }, { type: "string" });
});

test("object key order and required order do not matter", () => {
  const before = baseSchema();
  const after = {
    properties: {
      mode: { enum: ["alpha", "beta"] },
      name: { maxLength: 128, type: "string", minLength: 1 },
      schema_version: { const: 1 },
    },
    required: ["name", "schema_version"],
    additionalProperties: false,
    type: "object",
    title: "Record",
    $id: "https://schemas.antnest.dev/example/record.schema.json",
    $schema: "https://json-schema.org/draft/2020-12/schema",
  };
  compatible(before, after);
});

test("optional properties may be added, even inside closed objects", () => {
  const before = {
    type: "object",
    additionalProperties: false,
    required: ["meta"],
    properties: {
      meta: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: { id: { type: "string" } },
      },
    },
  };
  const after = clone(before);
  after.properties.note = { type: "string" };
  after.properties.meta.properties.extra = { type: "integer" };
  compatible(before, after);
});

test("deleted or renamed properties are rejected, including nested ones", () => {
  const before = baseSchema();
  const deleted = baseSchema();
  delete deleted.properties.name;
  const problems = incompatible(before, deleted);
  assert.ok(problems.some((problem) => problem.includes("name")));
  const renamed = baseSchema();
  renamed.properties.display_name = renamed.properties.name;
  delete renamed.properties.name;
  incompatible(before, renamed);
  const nested = {
    type: "object",
    properties: {
      meta: {
        type: "object",
        properties: { a: { type: "string" }, b: { type: "number" } },
      },
    },
  };
  const nestedAfter = clone(nested);
  delete nestedAfter.properties.meta.properties.b;
  incompatible(nested, nestedAfter);
});

test("required changes are rejected even for new properties", () => {
  const before = baseSchema();
  const newRequired = baseSchema();
  newRequired.properties.trace_id = { type: "string" };
  newRequired.required.push("trace_id");
  incompatible(before, newRequired);
  const promoted = baseSchema();
  promoted.required.push("mode");
  incompatible(before, promoted);
  const relaxed = baseSchema();
  relaxed.required = ["schema_version"];
  incompatible(before, relaxed);
  const noRequired = { type: "object", properties: { a: { type: "string" } } };
  const requiredAdded = clone(noRequired);
  requiredAdded.required = ["a"];
  incompatible(noRequired, requiredAdded);
});

test("existing validation keywords cannot change, appear, or disappear", () => {
  const before = baseSchema();
  for (const mutate of [
    (schema) => {
      schema.properties.name.type = "integer";
    },
    (schema) => {
      schema.properties.name.type = ["string", "null"];
    },
    (schema) => {
      schema.properties.name.minLength = 2;
    },
    (schema) => {
      delete schema.properties.name.minLength;
    },
    (schema) => {
      schema.properties.name.pattern = "^[a-z]+$";
    },
    (schema) => {
      schema.properties.name.format = "uuid";
    },
    (schema) => {
      schema.properties.mode.enum = ["alpha"];
    },
    (schema) => {
      schema.properties.mode.enum = ["alpha", "beta", "gamma"];
    },
    (schema) => {
      schema.additionalProperties = true;
    },
    (schema) => {
      schema.additionalProperties = { type: "string" };
    },
    (schema) => {
      schema.properties.schema_version.const = 2;
    },
  ]) {
    const after = baseSchema();
    mutate(after);
    incompatible(before, after);
  }
});

test("$ref, combinator branches, and conditional keywords cannot change", () => {
  const before = {
    $defs: {
      id: { type: "string", pattern: "^[a-z]+$" },
      maybe_id: { anyOf: [{ $ref: "#/$defs/id" }, { type: "null" }] },
    },
    type: "object",
    properties: {
      ref: { $ref: "#/$defs/id" },
      pick: { oneOf: [{ type: "string" }, { type: "integer" }] },
      gate: {
        if: { properties: { flag: { const: true } } },
        then: { required: ["flag"] },
      },
    },
  };
  for (const mutate of [
    (schema) => {
      schema.properties.ref.$ref = "#/$defs/maybe_id";
    },
    (schema) => {
      schema.properties.pick.oneOf[0].type = "boolean";
    },
    (schema) => {
      schema.properties.pick.oneOf.push({ type: "number" });
    },
    (schema) => {
      schema.properties.pick.oneOf.pop();
    },
    (schema) => {
      schema.$defs.maybe_id.anyOf[1].type = "boolean";
    },
    (schema) => {
      schema.properties.gate.then.required = [];
    },
    (schema) => {
      schema.properties.gate.not = { type: "null" };
    },
  ]) {
    const after = clone(before);
    mutate(after);
    incompatible(before, after);
  }
});

test("new $defs are allowed only when existing definitions persist unchanged", () => {
  const before = {
    $defs: {
      record_v1: {
        type: "object",
        additionalProperties: false,
        properties: { id: { type: "string" } },
      },
    },
    type: "object",
    properties: { item: { $ref: "#/$defs/record_v1" } },
  };
  const extended = clone(before);
  extended.$defs.record_v2 = clone(before.$defs.record_v1);
  extended.$defs.record_v2.properties.extra = { type: "integer" };
  compatible(before, extended);
  const dropped = clone(before);
  delete dropped.$defs.record_v1;
  incompatible(before, dropped);
  const renamed = clone(before);
  renamed.$defs.record_v1_alias = renamed.$defs.record_v1;
  delete renamed.$defs.record_v1;
  incompatible(before, renamed);
  const edited = clone(before);
  edited.$defs.record_v1.properties.id.minLength = 4;
  incompatible(before, edited);
});

test("a schema_version bump does not excuse an in-place breaking change", () => {
  const before = baseSchema();
  const after = baseSchema();
  after.properties.schema_version.const = 2;
  delete after.properties.name;
  const problems = incompatible(before, after);
  assert.ok(problems.some((problem) => problem.includes("name")));
});

test("annotation edits are allowed at the root and inside properties", () => {
  const before = baseSchema();
  const after = baseSchema();
  after.title = "Record documentation, second revision";
  after.description = "added later";
  after.$comment = "reviewed by contract owners";
  after.properties.name.title = "Name";
  after.properties.name.description = "updated wording";
  after.properties.name.default = "anonymous";
  after.properties.name.examples = ["alpha", "beta"];
  after.properties.name.deprecated = true;
  after.properties.mode.readOnly = true;
  after.properties.mode.writeOnly = false;
  after.properties.schema_version.examples = [1];
  compatible(before, after);
  const removed = baseSchema();
  delete removed.title;
  compatible(before, removed);
});

test("literal values compare as data and are not mistaken for schemas", () => {
  const before = {
    type: "object",
    properties: {
      kind: {
        const: { type: "object", properties: { a: { type: "string" } } },
      },
      tags: { const: ["a", "b"] },
      hint: { default: { type: "string", pattern: "x" } },
      sample: { examples: [{ type: "integer" }] },
    },
  };
  const reordered = clone(before);
  reordered.properties.kind.const = {
    properties: { a: { type: "string" } },
    type: "object",
  };
  compatible(before, reordered);
  const literalType = clone(before);
  literalType.properties.kind.const.properties.a.type = "integer";
  incompatible(before, literalType);
  const literalProperty = clone(before);
  literalProperty.properties.kind.const.properties.b = { type: "number" };
  incompatible(before, literalProperty);
  const literalArray = clone(before);
  literalArray.properties.tags.const = ["a", "b", "c"];
  incompatible(before, literalArray);
  const literalArrayOrder = clone(before);
  literalArrayOrder.properties.tags.const = ["b", "a"];
  incompatible(before, literalArrayOrder);
  const annotationLiteral = clone(before);
  annotationLiteral.properties.hint.default = { type: "integer" };
  compatible(before, annotationLiteral);
  const exampleLiteral = clone(before);
  exampleLiteral.properties.sample.examples = [{ type: "boolean" }, 7];
  compatible(before, exampleLiteral);
});

test("boolean schemas must stay identical", () => {
  compatible(true, true);
  compatible(false, false);
  incompatible(true, false);
  incompatible(false, true);
  const before = { type: "object", properties: { open: true, locked: false } };
  const after = clone(before);
  after.properties.locked = true;
  incompatible(before, after);
});

test("array schema changes are rejected", () => {
  const before = {
    type: "object",
    properties: {
      list: { type: "array", items: { type: "string" }, minItems: 1 },
      pair: {
        type: "array",
        prefixItems: [{ type: "string" }, { type: "integer" }],
      },
    },
  };
  for (const mutate of [
    (schema) => {
      schema.properties.list.items.type = "integer";
    },
    (schema) => {
      schema.properties.list.minItems = 2;
    },
    (schema) => {
      schema.properties.list.items = true;
    },
    (schema) => {
      schema.properties.pair.prefixItems.push({ type: "null" });
    },
  ]) {
    const after = clone(before);
    mutate(after);
    incompatible(before, after);
  }
});

test("problem strings carry the caller-provided label", () => {
  const before = baseSchema();
  const after = baseSchema();
  delete after.properties.name;
  const problems = incompatible(before, after, "example/record.schema.json");
  assert.ok(
    problems.some((problem) => problem.includes("example/record.schema.json")),
  );
});

const ID =
  "https://schemas.antnest.dev/runtime-controller/control-api.schema.json";
const movedDoc = {
  $id: ID,
  type: "object",
  properties: { a: { type: "string" } },
};

test("identical same-id relocation from RC api directory is allowed", () => {
  const before = new Map([
    ["services/runtime-controller/api/control-api.schema.json", movedDoc],
  ]);
  const after = new Map([
    ["contracts/runtime-controller/control-api.schema.json", movedDoc],
  ]);
  assert.deepEqual(schemaRevisionProblems(before, after), []);
});

test("relocation requires destination, matching id and present id", () => {
  const oldPath = "services/runtime-controller/api/control-api.schema.json";
  for (const after of [
    new Map(),
    new Map([
      [
        "contracts/runtime-controller/control-api.schema.json",
        { ...movedDoc, $id: `${ID}#other` },
      ],
    ]),
    new Map([
      [
        "contracts/runtime-controller/control-api.schema.json",
        { ...movedDoc, $id: undefined },
      ],
    ]),
    new Map([["contracts/runtime-controller/other.schema.json", movedDoc]]),
  ]) {
    assert.notDeepEqual(
      schemaRevisionProblems(new Map([[oldPath, movedDoc]]), after),
      [],
    );
  }
  const noId = { ...movedDoc };
  delete noId.$id;
  assert.notDeepEqual(
    schemaRevisionProblems(
      new Map([[oldPath, noId]]),
      new Map([
        ["contracts/runtime-controller/control-api.schema.json", movedDoc],
      ]),
    ),
    [],
  );
});

test("tightening or unrelated removal still fails after relocation support", () => {
  const oldPath = "services/runtime-controller/api/control-api.schema.json";
  const tightened = {
    ...movedDoc,
    properties: { a: { type: "integer" } },
  };
  assert.notDeepEqual(
    schemaRevisionProblems(
      new Map([[oldPath, movedDoc]]),
      new Map([
        ["contracts/runtime-controller/control-api.schema.json", tightened],
      ]),
    ),
    [],
  );
  assert.notDeepEqual(
    schemaRevisionProblems(
      new Map([
        [oldPath, movedDoc],
        ["contracts/common/other.schema.json", movedDoc],
      ]),
      new Map([
        ["contracts/runtime-controller/control-api.schema.json", movedDoc],
      ]),
    ),
    [],
  );
});
