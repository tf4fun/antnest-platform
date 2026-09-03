import assert from "node:assert/strict";
import test from "node:test";
import { boundedSnapshot, overviewResourceSummary } from "./overview.ts";
import type { Overview } from "./types.ts";

test("bounded snapshot reports an exact count when the owner page is complete", () => {
  assert.deepEqual(boundedSnapshot(12, null), {
    count: 12,
    hasMore: false,
    display: 12,
  });
});

test("bounded snapshot marks a count as a lower bound when another page exists", () => {
  assert.deepEqual(boundedSnapshot(200, "next-page"), {
    count: 200,
    hasMore: true,
    display: "≥200",
  });
});

test("overview resource summary counts only active directory members", () => {
  const summary = overviewResourceSummary({
    directory: {
      status: "available",
      data: {
        users: [
          member("active", true, true),
          member("inactive-user", false, true),
          member("inactive-membership", true, false),
        ],
        groups: [],
      },
    },
    model_profiles: {
      status: "available",
      data: { items: [], next_after_id: null },
    },
    templates: {
      status: "available",
      data: { items: [], next_after_id: null },
    },
    agents: {
      status: "available",
      data: { items: [], next_cursor: null },
    },
    defaults: { runtime_image_ref: "" },
  });

  assert.deepEqual(summary.directory, {
    value: 1,
    detail: "2 inactive in directory",
  });
});

test("overview resource summary labels unavailable sections locally", () => {
  const unavailable = (message: string) => ({
    status: "unavailable" as const,
    error: { code: "dependency_unavailable", message },
  });
  const overview: Overview = {
    directory: unavailable("Directory could not be refreshed"),
    model_profiles: unavailable("Model providers could not be refreshed"),
    templates: unavailable("Agent templates could not be refreshed"),
    agents: {
      status: "available",
      data: { items: [], next_cursor: null },
    },
    defaults: { runtime_image_ref: "" },
  };

  assert.deepEqual(overviewResourceSummary(overview), {
    directory: { value: "—", detail: "Directory unavailable" },
    models: { value: "—", detail: "Model inventory unavailable" },
    templates: { value: "—", detail: "Template inventory unavailable" },
    degraded: [
      "Directory could not be refreshed",
      "Model providers could not be refreshed",
      "Agent templates could not be refreshed",
    ],
  });
});

function member(id: string, userActive: boolean, membershipActive: boolean) {
  return {
    user: {
      id: `user-${id}`,
      system_role: "member",
      active: userActive,
      created_at: "2026-09-03T00:00:00Z",
      updated_at: "2026-09-03T00:00:00Z",
    },
    membership: {
      id: `membership-${id}`,
      user_id: `user-${id}`,
      email: `${id}@example.com`,
      display_name: id,
      role: "member" as const,
      source: "local" as const,
      active: membershipActive,
      created_at: "2026-09-03T00:00:00Z",
      updated_at: "2026-09-03T00:00:00Z",
    },
  };
}
