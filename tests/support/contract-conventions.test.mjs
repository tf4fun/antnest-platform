import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  checkConventions,
  loadContracts,
} from "../../scripts/check-contract-conventions.mjs";

const dialect = "https://json-schema.org/draft/2020-12/schema";
const nullableCursor =
  "../common/pagination.schema.json#/$defs/nullable_cursor";

function paginationSchema() {
  return {
    $schema: dialect,
    $id: "https://schemas.antnest.dev/common/pagination.schema.json",
    $defs: {
      nullable_cursor: { type: ["string", "null"], maxLength: 4096 },
      cursor: { type: "string", maxLength: 4096 },
    },
  };
}

function listSchema(properties) {
  return {
    $schema: dialect,
    $id: "https://schemas.antnest.dev/demo/list.schema.json",
    type: "object",
    properties: {
      items: { type: "array", items: { type: "string" } },
      ...properties,
    },
  };
}

function camelSchema(path, properties) {
  return {
    $schema: dialect,
    $id: `https://schemas.antnest.dev/${path}`,
    type: "object",
    properties,
  };
}

function documents(entries) {
  return new Map([
    ["common/pagination.schema.json", paginationSchema()],
    ...Object.entries(entries),
  ]);
}

function demoDocuments(properties) {
  return documents({ "demo/list.schema.json": listSchema(properties) });
}

function camelAlias(overrides) {
  return {
    file: "demo/camel.schema.json",
    pointer: "/properties/nextCursor",
    field: "nextCursor",
    replacement: "next_cursor",
    reason: "legacy workspace payload kept for one release",
    kind: "deprecated_alias",
    remove_after: "2026-06-30",
    ...overrides,
  };
}

test("a canonical list schema passes", () => {
  const docs = demoDocuments({ next_cursor: { $ref: nullableCursor } });
  assert.deepEqual(checkConventions(docs), []);
});

test("the draft-07 dialect is rejected", () => {
  const docs = demoDocuments({ next_cursor: { $ref: nullableCursor } });
  docs.get("demo/list.schema.json").$schema =
    "http://json-schema.org/draft-07/schema#";
  const errors = checkConventions(docs);
  assert(errors.length > 0);
  assert(errors.every((error) => typeof error === "string"));
});

test("$id must be the canonical document URL and unique", () => {
  const missing = demoDocuments({ next_cursor: { $ref: nullableCursor } });
  delete missing.get("demo/list.schema.json").$id;
  assert(checkConventions(missing).length > 0);

  const wrong = demoDocuments({ next_cursor: { $ref: nullableCursor } });
  wrong.get("demo/list.schema.json").$id =
    "https://schemas.antnest.dev/demo/mismatch.schema.json";
  assert(checkConventions(wrong).length > 0);

  const duplicate = documents({
    "demo/list.schema.json": listSchema({
      next_cursor: { $ref: nullableCursor },
    }),
    "demo/twin.schema.json": listSchema({
      next_cursor: { $ref: nullableCursor },
    }),
  });
  assert(checkConventions(duplicate).length > 0);
});

test("$ref values must resolve to canonical local fragments", () => {
  for (const ref of [
    "https://antnest.local/common/pagination.schema.json#/$defs/nullable_cursor",
    "../common/missing.schema.json#/$defs/nullable_cursor",
    "../common/pagination.schema.json#/$defs/absent",
  ]) {
    const docs = demoDocuments({ next_cursor: { $ref: ref } });
    assert(checkConventions(docs).length > 0, ref);
  }
});

test("definitions is rejected in favour of $defs", () => {
  const schema = listSchema({ next_cursor: { $ref: nullableCursor } });
  schema.definitions = { extra: { type: "string" } };
  const docs = documents({ "demo/list.schema.json": schema });
  assert(checkConventions(docs).length > 0);
});

test("camelCase fields fail unless an exact alias covers them", () => {
  const docs = documents({
    "demo/camel.schema.json": camelSchema("demo/camel.schema.json", {
      nextCursor: { type: "string", maxLength: 4096 },
    }),
  });
  assert(checkConventions(docs).length > 0);
  assert.deepEqual(checkConventions(docs, [camelAlias()]), []);
  assert(
    checkConventions(docs, [camelAlias({ pointer: "/properties/otherCursor" })])
      .length > 0,
  );
  assert(
    checkConventions(docs, [camelAlias({ field: "otherCursor" })]).length > 0,
  );
});

test("a stale alias with no live occurrence is reported", () => {
  const docs = demoDocuments({ next_cursor: { $ref: nullableCursor } });
  assert(checkConventions(docs, [camelAlias()]).length > 0);
});

test("an alias suppresses only its own occurrence", () => {
  const docs = documents({
    "demo/camel.schema.json": camelSchema("demo/camel.schema.json", {
      nextCursor: { type: "string", maxLength: 4096 },
      otherCursor: { type: "string", maxLength: 4096 },
    }),
    "demo/twin.schema.json": camelSchema("demo/twin.schema.json", {
      nextCursor: { type: "string", maxLength: 4096 },
    }),
  });
  assert(checkConventions(docs, [camelAlias()]).length >= 2);
});

test("alias entries need a real reason, replacement, kind and remove_after", () => {
  const docs = documents({
    "demo/camel.schema.json": camelSchema("demo/camel.schema.json", {
      nextCursor: { type: "string", maxLength: 4096 },
    }),
  });
  for (const overrides of [
    { reason: "" },
    { replacement: "" },
    { kind: "retired" },
    { remove_after: "" },
    { kind: "protocol_exception" },
  ]) {
    assert(
      checkConventions(docs, [camelAlias(overrides)]).length > 0,
      JSON.stringify(overrides),
    );
  }
});

test("agent-ui camelCase needs an exact protocol_exception alias", () => {
  const docs = documents({
    "agent-ui/workspace.schema.json": camelSchema(
      "agent-ui/workspace.schema.json",
      { nextCursor: { type: "string", maxLength: 4096 } },
    ),
  });
  assert(checkConventions(docs).length > 0);
  const exception = camelAlias({
    file: "agent-ui/workspace.schema.json",
    kind: "protocol_exception",
    remove_after: "protocol",
  });
  assert.deepEqual(checkConventions(docs, [exception]), []);
  assert(
    checkConventions(docs, [
      camelAlias({ file: "agent-ui/workspace.schema.json" }),
    ]).length > 0,
  );
});

test("limit must be a positive integer with an explicit service maximum", () => {
  for (const [limit, ok] of [
    [{ type: "integer", minimum: 1, maximum: 100 }, true],
    [{ type: "integer", minimum: 0, maximum: 100 }, false],
    [{ type: "integer", minimum: 1, maximum: 500 }, true],
    [{ type: "integer", minimum: 1, maximum: 0 }, false],
    [{ type: "integer", minimum: 1 }, false],
    [{ type: "integer" }, false],
  ]) {
    const docs = demoDocuments({
      limit,
      next_cursor: { $ref: nullableCursor },
    });
    assert.equal(
      checkConventions(docs).length === 0,
      ok,
      JSON.stringify(limit),
    );
  }
});

test("cursors must be bounded at 4096 characters", () => {
  for (const [cursor, ok] of [
    [{ type: "string", maxLength: 4096 }, true],
    [{ $ref: "../common/pagination.schema.json#/$defs/cursor" }, true],
    [{ type: "string", maxLength: 8192 }, false],
    [{ type: "string" }, false],
  ]) {
    const docs = demoDocuments({
      cursor,
      next_cursor: { $ref: nullableCursor },
    });
    assert.equal(
      checkConventions(docs).length === 0,
      ok,
      JSON.stringify(cursor),
    );
  }
});

test("array item lists need next_cursor or a named sequence feed", () => {
  assert(checkConventions(demoDocuments({})).length > 0);
  const feeds = {
    next_sequence: { type: "string", maxLength: 4096 },
    after_sequence: { type: "integer", minimum: 0 },
  };
  for (const [field, schema] of Object.entries(feeds)) {
    const docs = demoDocuments({ [field]: schema });
    assert.deepEqual(checkConventions(docs), [], field);
  }
});

test("repository contracts satisfy the conventions", async () => {
  const docs = await loadContracts(
    new URL("../../contracts/", import.meta.url),
  );
  assert(docs instanceof Map);
  assert(docs.has("agent-ui/workspace-api.schema.json"));
  assert(docs.has("agent-ui/workspace-api.json"));
  assert(!docs.has("agent-ui/workspace-api.md"));
  const rcApi = fileURLToPath(
    new URL("../../services/runtime-controller/api/", import.meta.url),
  );
  for (const name of readdirSync(rcApi)) {
    if (!name.endsWith(".schema.json")) continue;
    docs.set(
      `runtime-controller/${name}`,
      JSON.parse(readFileSync(join(rcApi, name), "utf8")),
    );
  }
  const aliases = JSON.parse(
    readFileSync(
      new URL(
        "../../contracts/common/convention-aliases.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.deepEqual(checkConventions(docs, aliases), []);
});

test("the conventions guide and common fragments exist", () => {
  assert(
    existsSync(new URL("../../contracts/CONVENTIONS.md", import.meta.url)),
  );
  for (const page of ["contracts/README.md", "CONTRIBUTING.md"]) {
    const text = readFileSync(
      new URL(`../../${page}`, import.meta.url),
      "utf8",
    );
    assert(text.includes("CONVENTIONS.md"), page);
  }
  for (const name of ["pagination", "precondition", "idempotency"]) {
    const url = new URL(
      `../../contracts/common/${name}.schema.json`,
      import.meta.url,
    );
    assert(existsSync(url), name);
    const fragment = JSON.parse(readFileSync(url, "utf8"));
    assert.equal(fragment.$schema, dialect);
    assert.equal(
      fragment.$id,
      `https://schemas.antnest.dev/common/${name}.schema.json`,
    );
  }
});

test("descriptor template fragments skip pointer resolution", () => {
  const docs = documents({
    "agent-controller/proposal.json": {
      schema_base: "control-api.schema.json",
      schema_definitions: {
        request: { properties: { id: { $ref: "#/$defs/id" } } },
      },
    },
  });
  assert.deepEqual(checkConventions(docs), []);
  docs.set("agent-controller/stale.json", {
    ref: { $ref: "https://antnest.local/contracts/common/error.schema.json" },
  });
  assert(checkConventions(docs).length > 0);
});

test("non-string cursors need an exact protocol exception", () => {
  const docs = documents({
    "demo/tuple.schema.json": camelSchema("demo/tuple.schema.json", {
      cursor: { oneOf: [{ type: "null" }, { type: "object" }] },
    }),
  });
  assert(checkConventions(docs).length > 0);
  const exception = camelAlias({
    file: "demo/tuple.schema.json",
    pointer: "/properties/cursor",
    field: "$cursor",
    kind: "protocol_exception",
    remove_after: "protocol",
  });
  assert.deepEqual(checkConventions(docs, [exception]), []);
});

test("malformed alias input produces diagnostics", () => {
  const docs = demoDocuments({ next_cursor: { $ref: nullableCursor } });
  assert(checkConventions(docs, { file: "x" }).length > 0);
  const camel = documents({
    "demo/camel.schema.json": camelSchema("demo/camel.schema.json", {
      nextCursor: { type: "string", maxLength: 4096 },
    }),
  });
  assert(checkConventions(camel, [camelAlias(), camelAlias()]).length > 0);
});

test("malformed percent-encoded refs produce diagnostics", () => {
  const docs = demoDocuments({ next_cursor: { $ref: nullableCursor } });
  docs.get("demo/list.schema.json").properties.next_cursor = {
    $ref: "../common/%ff.schema.json",
  };
  assert(checkConventions(docs).length > 0);
});

test("percent-encoded UTF-8 refs decode to document keys", () => {
  const docs = documents({
    "demo/ünit.schema.json": camelSchema("demo/ünit.schema.json", {
      next_cursor: { $ref: nullableCursor },
    }),
    "demo/link.schema.json": camelSchema("demo/link.schema.json", {
      schema: { $ref: "./%C3%BCnit.schema.json" },
    }),
  });
  assert.deepEqual(checkConventions(docs), []);
});

test("checkConventions does not mutate inputs", () => {
  const docs = demoDocuments({ next_cursor: { $ref: nullableCursor } });
  const before = JSON.stringify([...docs]);
  const first = checkConventions(docs, [camelAlias()]);
  const second = checkConventions(docs, [camelAlias()]);
  assert.equal(JSON.stringify([...docs]), before);
  assert.deepEqual(first, second);
});

test("pending_migration suppresses $pagination but not $cursor", () => {
  const pendingAlias = (file, pointer, field) => ({
    file,
    pointer,
    field,
    replacement: "next_cursor",
    reason: "pending service migration",
    kind: "pending_migration",
    remove_after: "next_release",
  });
  const docs = documents({
    "demo/page.schema.json": camelSchema("demo/page.schema.json", {
      items: { type: "array" },
    }),
    "demo/tuple.schema.json": camelSchema("demo/tuple.schema.json", {
      cursor: { oneOf: [{ type: "null" }, { type: "object" }] },
    }),
  });
  assert(
    checkConventions(docs, [
      pendingAlias("demo/page.schema.json", "", "$pagination"),
    ]).length === 1,
  );
  assert.deepEqual(
    checkConventions(docs, [
      pendingAlias("demo/page.schema.json", "", "$pagination"),
      pendingAlias("demo/tuple.schema.json", "/properties/cursor", "$cursor"),
    ]),
    [
      "demo/tuple.schema.json: /properties/cursor non-string cursor needs an exact protocol exception",
      "convention-aliases[1]: stale alias for demo/tuple.schema.json /properties/cursor $cursor",
    ],
  );
});

test("completed convention migrations leave only deprecated inputs or protocol exceptions", () => {
  const aliases = JSON.parse(
    readFileSync(
      new URL(
        "../../contracts/common/convention-aliases.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.deepEqual(
    aliases.filter(({ kind }) => kind === "pending_migration"),
    [],
  );
});
