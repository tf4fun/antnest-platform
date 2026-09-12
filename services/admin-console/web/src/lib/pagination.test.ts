import assert from "node:assert/strict";
import test from "node:test";
import {
  agentPagePath,
  catalogPagePath,
  mergeCatalogOptions,
  mergePage,
} from "./pagination.ts";

test("catalog pagination emits only an explicit bounded cursor and limit", () => {
  assert.equal(catalogPagePath("/api/admin/templates"), "/api/admin/templates");
  assert.equal(
    catalogPagePath("/api/admin/templates", { afterID: "template 9", limit: 25 }),
    "/api/admin/templates?after_id=template+9&limit=25",
  );
});

test("Agent pagination names the lifecycle view instead of exposing storage filters", () => {
  assert.equal(agentPagePath(), "/api/admin/agents");
  assert.equal(
    agentPagePath({ view: "deleted", cursor: "cursor/9", limit: 25 }),
    "/api/admin/agents?view=deleted&cursor=cursor%2F9&limit=25",
  );
});

test("page merging replaces stale rows and appends new rows without duplicates", () => {
  const merged = mergePage(
    [
      { id: "one", value: "old" },
      { id: "two", value: "stable" },
    ],
    [
      { id: "one", value: "new" },
      { id: "three", value: "added" },
      { id: "three", value: "latest" },
    ],
    (item) => item.id,
  );

  assert.deepEqual(merged, [
    { id: "one", value: "new" },
    { id: "two", value: "stable" },
    { id: "three", value: "latest" },
  ]);
});

test("catalog option pages retain only eligible rows and advance their opaque cursor", () => {
  const result = mergeCatalogOptions(
    [{ id: "one", enabled: true, label: "old" }],
    {
      items: [
        { id: "one", enabled: true, label: "new" },
        { id: "two", enabled: false, label: "disabled" },
        { id: "three", enabled: true, label: "added" },
      ],
      next_after_id: "next-page",
    },
    (item) => item.id,
    (item) => item.enabled,
  );

  assert.deepEqual(result, {
    items: [
      { id: "one", enabled: true, label: "new" },
      { id: "three", enabled: true, label: "added" },
    ],
    nextAfterID: "next-page",
  });
});

test("an ineligible update removes a previously selectable identity", () => {
  const result = mergeCatalogOptions(
    [{ id: "one", enabled: true }],
    { items: [{ id: "one", enabled: false }] },
    (item) => item.id,
    (item) => item.enabled,
  );
  assert.deepEqual(result.items, []);
});
