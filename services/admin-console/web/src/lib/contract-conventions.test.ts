import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { catalogPagePath, mergeCatalogOptions } from "./pagination.ts";

describe("contract conventions", () => {
  it("catalogPagePath serializes the canonical cursor", () => {
    assert.equal(
      catalogPagePath("/api/admin/model-profiles", { cursor: "opaque-page", limit: 20 }),
      "/api/admin/model-profiles?cursor=opaque-page&limit=20",
    );
  });

  it("mergeCatalogOptions adopts canonical next_cursor", () => {
    const state = mergeCatalogOptions<{ id: string }>(
      [],
      { items: [{ id: "a" }], next_cursor: "cursor-2" },
      (item) => item.id,
      () => true,
    );
    assert.deepEqual(state, { items: [{ id: "a" }], nextAfterID: "cursor-2" });
  });

  it("mergeCatalogOptions still parses the legacy next_after_id page", () => {
    const state = mergeCatalogOptions<{ id: string }>(
      [],
      { items: [{ id: "a" }], next_after_id: "cursor-2" },
      (item) => item.id,
      () => true,
    );
    assert.equal(state.nextAfterID, "cursor-2");
  });

  it("mergeCatalogOptions clears continuation at end of page", () => {
    const state = mergeCatalogOptions<{ id: string }>(
      [],
      { items: [{ id: "a" }], next_cursor: null },
      (item) => item.id,
      () => true,
    );
    assert.equal(state.nextAfterID, undefined);
  });

  it("mergeCatalogOptions keeps eligibility filtering", () => {
    const state = mergeCatalogOptions<{ id: string }>(
      [],
      { items: [{ id: "keep" }, { id: "drop" }], next_cursor: "n" },
      (item) => item.id,
      (item) => item.id === "keep",
    );
    assert.deepEqual(state.items, [{ id: "keep" }]);
  });
});
