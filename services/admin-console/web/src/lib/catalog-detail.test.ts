import assert from "node:assert/strict";
import test from "node:test";

import { loadImmutableCatalogDetail } from "./catalog-detail.ts";

test("revision-qualified detail reads only the immutable revision", async () => {
  let currentReads = 0;
  let revisionReads = 0;

  const result = await loadImmutableCatalogDetail({
    revision: "revision-2",
    readCurrent: async () => {
      currentReads += 1;
      throw new Error("current head unavailable");
    },
    readRevision: async (revision) => {
      revisionReads += 1;
      return { owner: "profile-1", revision };
    },
    assertOwner: (resource) => assert.equal(resource.owner, "profile-1"),
  });

  assert.deepEqual(result, {
    historical: true,
    resource: { owner: "profile-1", revision: "revision-2" },
  });
  assert.equal(currentReads, 0);
  assert.equal(revisionReads, 1);
});

test("current detail does not issue a revision read", async () => {
  let currentReads = 0;
  let revisionReads = 0;

  const result = await loadImmutableCatalogDetail({
    revision: undefined,
    readCurrent: async () => {
      currentReads += 1;
      return { owner: "template-1", revision: 3 };
    },
    readRevision: async () => {
      revisionReads += 1;
      throw new Error("unexpected revision read");
    },
    assertOwner: (resource) => assert.equal(resource.owner, "template-1"),
  });

  assert.deepEqual(result, {
    historical: false,
    resource: { owner: "template-1", revision: 3 },
  });
  assert.equal(currentReads, 1);
  assert.equal(revisionReads, 0);
});

test("detail ownership validation rejects a revision from another resource", async () => {
  await assert.rejects(
    loadImmutableCatalogDetail({
      revision: 4,
      readCurrent: async () => ({ owner: "template-1", revision: 5 }),
      readRevision: async (revision) => ({ owner: "template-2", revision }),
      assertOwner: (resource) => {
        if (resource.owner !== "template-1") {
          throw new Error("revision does not belong to this template");
        }
      },
    }),
    /revision does not belong to this template/,
  );
});
