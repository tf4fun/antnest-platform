import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readDirectoryPages } from "../admin-directory-client.mjs";
import { createDirectoryFixture } from "../admin-directory-fixtures.mjs";
import { validateGolden } from "./golden.mjs";

const MEMBER_RESPONSE =
  "admin-console/admin-api.ids-v2.schema.json#/$defs/directory_members_response";
const GROUP_RESPONSE =
  "admin-console/admin-api.ids-v2.schema.json#/$defs/directory_groups_response";
const MEMBER_REQUEST =
  "identity/directory.ids-v2.schema.json#/$defs/list_members_request";
const GROUP_REQUEST =
  "identity/directory.ids-v2.schema.json#/$defs/list_groups_request";

const membersURL = (query = "") =>
  new URL(`http://localhost/api/admin/directory/members${query}`);
const groupsURL = (query = "") =>
  new URL(`http://localhost/api/admin/directory/groups${query}`);

const timestamp = "2026-11-01T00:00:00Z";

function rawMember(index, overrides = {}) {
  const id = String(index).padStart(3, "0");
  const base = {
    user: {
      id: `user-${id}`,
      system_role: "user",
      active: true,
      created_at: timestamp,
      updated_at: timestamp,
    },
    membership: {
      id: `membership-${id}`,
      organization_id: "org-1",
      user_id: `user-${id}`,
      email: `member${id}@example.com`,
      display_name: `Member ${index}`,
      role: "member",
      source: "local",
      active: true,
      created_at: timestamp,
      updated_at: timestamp,
    },
  };
  return {
    user: { ...base.user, ...overrides.user },
    membership: { ...base.membership, ...overrides.membership },
  };
}

test("canonical 201-member seed paginates 200 + 1 with a terminal null cursor", async () => {
  const users = Array.from({ length: 201 }, (_, index) => rawMember(index + 1));
  const fixture = createDirectoryFixture({ users, groups: [] });
  const first = await fixture(membersURL("?limit=200"));
  await validateGolden(MEMBER_RESPONSE, first);
  assert.equal(first.items.length, 200);
  assert.ok(typeof first.next_cursor === "string" && first.next_cursor !== "");
  const ids = first.items.map((item) => item.membership.id);
  assert.deepEqual(ids, [...ids].sort());
  assert.equal(new Set(ids).size, 200);
  const last = await fixture(
    membersURL(`?limit=200&cursor=${encodeURIComponent(first.next_cursor)}`),
  );
  await validateGolden(MEMBER_RESPONSE, last);
  assert.equal(last.items.length, 1);
  assert.equal(last.next_cursor, null);
  assert.equal(first.items[0].membership.id, "membership-001");
  assert.equal(last.items[0].membership.id, "membership-201");
  assert.equal("users" in first, false);
  assert.equal("groups" in first, false);
  assert.equal("after" in first, false);
});

test("default page is 50 and one call serves exactly one page", async () => {
  const users = Array.from({ length: 60 }, (_, index) => rawMember(index + 1));
  const fixture = createDirectoryFixture({ users, groups: [] });
  const page = await fixture(membersURL());
  await validateGolden(MEMBER_RESPONSE, page);
  assert.equal(page.items.length, 50);
  assert.ok(page.next_cursor !== null);
});

test("three same-name groups are preserved, not deduplicated by display_name", async () => {
  const groups = [0, 1, 2].map((index) => ({
    id: `group-${index}`,
    organization_id: "org-1",
    display_name: "Operators",
    source: "scim",
    active: true,
    created_at: timestamp,
    updated_at: timestamp,
    scim_external_id: `ext-${index}`,
  }));
  const fixture = createDirectoryFixture({ users: [], groups });
  const first = await fixture(groupsURL("?limit=2"));
  await validateGolden(GROUP_RESPONSE, first);
  assert.equal(first.items.length, 2);
  assert.ok(first.items.every((item) => item.display_name === "Operators"));
  const second = await fixture(
    groupsURL(`?limit=2&cursor=${encodeURIComponent(first.next_cursor)}`),
  );
  assert.equal(second.items.length, 1);
  assert.equal(second.next_cursor, null);
  for (const item of [...first.items, ...second.items]) {
    assert.deepEqual(Object.keys(item).sort(), [
      "active",
      "created_at",
      "display_name",
      "source",
      "updated_at",
    ]);
  }
});

test("normalized q and role/source/effective-active filters select the right members", async () => {
  const fixture = createDirectoryFixture({
    users: [
      rawMember(1, {
        membership: {
          email: "alice@example.com",
          role: "admin",
          source: "local",
        },
      }),
      rawMember(2, {
        membership: {
          email: "albert@example.com",
          role: "member",
          source: "scim",
        },
      }),
      rawMember(3, {
        membership: {
          email: "bob@example.com",
          role: "member",
          source: "local",
        },
      }),
      rawMember(4, {
        membership: { email: "alina@example.com" },
        user: { active: false },
      }),
      rawMember(5, {
        membership: { email: "aldo@example.com", active: false },
      }),
    ],
    groups: [],
  });
  const queried = await fixture(membersURL("?q=  AL  "));
  assert.deepEqual((await fixture(membersURL("?q=%EF%BF%BD"))).items, []);
  assert.deepEqual(
    queried.items.map((item) => item.membership.email).sort(),
    [
      "albert@example.com",
      "aldo@example.com",
      "alice@example.com",
      "alina@example.com",
    ].sort(),
  );
  const admins = await fixture(membersURL("?role=admin"));
  assert.deepEqual(
    admins.items.map((item) => item.membership.email),
    ["alice@example.com"],
  );
  const scim = await fixture(membersURL("?source=scim"));
  assert.deepEqual(
    scim.items.map((item) => item.membership.email),
    ["albert@example.com"],
  );
  const inactive = await fixture(membersURL("?active=false"));
  assert.deepEqual(inactive.items.map((item) => item.membership.email).sort(), [
    "aldo@example.com",
    "alina@example.com",
  ]);
  const active = await fixture(membersURL("?active=true"));
  assert.equal(
    active.items.some((item) => item.membership.email === "alina@example.com"),
    false,
  );
  assert.equal(
    active.items.some((item) => item.membership.email === "aldo@example.com"),
    false,
  );
});

test("cursors reject other kind, changed filter, other dataset, bogus, and empty values", async () => {
  const users = Array.from({ length: 60 }, (_, index) => rawMember(index + 1));
  const memberFixture = createDirectoryFixture({ users, groups: [] });
  const groupFixture = createDirectoryFixture({
    users: [],
    groups: [
      {
        display_name: "Operators",
        source: "local",
        active: true,
        created_at: timestamp,
        updated_at: timestamp,
      },
    ],
  });
  const first = await memberFixture(membersURL());
  const cursor = first.next_cursor;
  assert.ok(cursor);
  await assert.rejects(() =>
    groupFixture(groupsURL(`?cursor=${encodeURIComponent(cursor)}`)),
  );
  await assert.rejects(() =>
    memberFixture(membersURL(`?cursor=${encodeURIComponent(cursor)}&q=bob`)),
  );
  await assert.rejects(() =>
    memberFixture(
      membersURL(`?cursor=${encodeURIComponent(cursor)}&role=admin`),
    ),
  );
  const other = createDirectoryFixture({ users: users.slice(1), groups: [] });
  await assert.rejects(() =>
    other(membersURL(`?cursor=${encodeURIComponent(cursor)}`)),
  );
  await assert.rejects(() => memberFixture(membersURL("?cursor=bogus")));
  await assert.rejects(() => memberFixture(membersURL("?cursor=")));
});

test("malformed parameters reject before producing a page", async () => {
  const fixture = createDirectoryFixture({ users: [rawMember(1)], groups: [] });
  for (const query of [
    "?limit=0",
    "?limit=201",
    "?limit=2.5",
    "?limit=10&limit=20",
    "?after=abc",
    "?after_id=abc",
    "?organization_id=org-2",
    "?actor_principal_id=user-9",
    "?active=1",
    "?active=yes",
    "?cursor=",
    "?role=",
    "?source=oidc",
    "?bogus=1",
    "?q=%ff",
  ]) {
    await assert.rejects(() => fixture(membersURL(query)), query);
  }
  await assert.rejects(() => fixture(groupsURL("?role=admin")));
});

test("private upstream fields strip and missing required scalars reject", async () => {
  const dirty = rawMember(1);
  dirty.user.credential_ref = "secret";
  dirty.user.primary_email = "alice@private.example.com";
  dirty.membership.scim_external_id = "ext-1";
  const fixture = createDirectoryFixture({ users: [dirty], groups: [] });
  const page = await fixture(membersURL());
  await validateGolden(MEMBER_RESPONSE, page);
  assert.deepEqual(Object.keys(page.items[0].user).sort(), [
    "active",
    "created_at",
    "id",
    "system_role",
    "updated_at",
  ]);
  assert.deepEqual(Object.keys(page.items[0].membership).sort(), [
    "active",
    "created_at",
    "display_name",
    "email",
    "id",
    "role",
    "source",
    "updated_at",
    "user_id",
  ]);
  const missingTimestamp = rawMember(2);
  delete missingTimestamp.user.created_at;
  const badFixture = createDirectoryFixture({
    users: [missingTimestamp],
    groups: [],
  });
  await assert.rejects(() => badFixture(membersURL()));
  const wrongScalar = rawMember(3);
  wrongScalar.membership.email = 5;
  await assert.rejects(() =>
    createDirectoryFixture({ users: [wrongScalar], groups: [] })(membersURL()),
  );
});

test("every produced page validates against the published producer schema", async () => {
  const fixture = createDirectoryFixture({
    users: [rawMember(1)],
    groups: [
      {
        display_name: "Operators",
        source: "local",
        active: true,
        created_at: timestamp,
        updated_at: timestamp,
      },
    ],
  });
  const members = await fixture(membersURL());
  const groups = await fixture(groupsURL());
  assert.equal(await validateGolden(MEMBER_RESPONSE, members), true);
  assert.equal(await validateGolden(GROUP_RESPONSE, groups), true);
  await assert.rejects(() =>
    validateGolden(MEMBER_RESPONSE, { users: [rawMember(1)], groups: [] }),
  );
  await assert.rejects(() =>
    validateGolden(MEMBER_RESPONSE, { items: members.items }),
  );
  await assert.rejects(() =>
    validateGolden(GROUP_RESPONSE, { items: groups.items }),
  );
  assert.equal(
    await validateGolden(MEMBER_REQUEST, {
      actor_principal_id: "user-admin",
      organization_id: "org-1",
      limit: 50,
      cursor: "opaque",
      filter: {
        email_prefix: "a",
        role: "admin",
        active: true,
        source: "local",
      },
    }),
    true,
  );
  assert.equal(
    await validateGolden(GROUP_REQUEST, {
      actor_principal_id: "user-admin",
      organization_id: "org-1",
      limit: 50,
      filter: { display_name_prefix: "ops", active: true, source: "local" },
    }),
    true,
  );
  await assert.rejects(() =>
    validateGolden(MEMBER_REQUEST, {
      actor_principal_id: "user-admin",
      organization_id: "org-1",
      limit: 50,
      after: "abc",
    }),
  );
  await assert.rejects(() =>
    validateGolden(MEMBER_REQUEST, {
      actor_principal_id: "user-admin",
      organization_id: "org-1",
      limit: 50,
      unknown: true,
    }),
  );
});

test("readDirectoryPages aggregates bounded member and group pages in order", async () => {
  const users = Array.from({ length: 201 }, (_, index) => rawMember(index + 1));
  const groups = Array.from({ length: 203 }, (_, index) => ({
    id: `group-${index}`,
    organization_id: "org-1",
    display_name: `Group ${String(index).padStart(3, "0")}`,
    source: "local",
    active: true,
    created_at: timestamp,
    updated_at: timestamp,
  }));
  const fixture = createDirectoryFixture({ users, groups });
  const paths = [];
  const request = async (path) => {
    paths.push(path);
    const page = await fixture(new URL(path, "http://localhost"));
    if (path.startsWith("/api/admin/directory/members")) {
      await validateGolden(MEMBER_RESPONSE, page);
    } else {
      await validateGolden(GROUP_RESPONSE, page);
    }
    return page;
  };
  const directory = await readDirectoryPages(request);
  assert.equal(directory.users.length, 201);
  assert.equal(directory.groups.length, 203);
  assert.equal(paths.length, 4);
  assert.equal(paths[0], "/api/admin/directory/members?limit=200");
  assert.ok(paths[1].startsWith("/api/admin/directory/members?"));
  assert.ok(paths[1].includes("cursor="));
  assert.equal(paths[2], "/api/admin/directory/groups?limit=200");
  assert.ok(paths[3].startsWith("/api/admin/directory/groups?"));
  assert.ok(paths[3].includes("cursor="));
  assert.equal(
    paths.some((path) => path === "/api/admin/directory"),
    false,
  );
  assert.equal(
    directory.users.every((item) => item.membership.id),
    true,
  );
  assert.equal(
    directory.groups.every((item) => item.display_name),
    true,
  );
});

test("readDirectoryPages rejects retired wire shapes and malformed pages", async () => {
  const valid = await createDirectoryFixture({
    users: [rawMember(1)],
    groups: [],
  })(membersURL());
  const memberItem = valid.items[0];
  for (const pages of [
    [{ users: [], groups: [] }],
    [{ items: [] }],
    [{ items: null, next_cursor: null }],
    [{ items: new Array(201).fill({}), next_cursor: null }],
    [
      { items: [memberItem], next_cursor: "cursor-a" },
      { items: [memberItem], next_cursor: "cursor-a" },
    ],
    [{ items: [], next_cursor: "cursor-a" }],
    [{ items: [memberItem], next_cursor: "a\nb" }],
    [{ items: [memberItem], next_cursor: "" }],
    [{ items: [memberItem], next_cursor: "c".repeat(4097) }],
  ]) {
    const reads = [...pages];
    await assert.rejects(() => readDirectoryPages(async () => reads.shift()));
  }
  const identity = new Error("transport failed");
  await assert.rejects(
    async () => {
      await readDirectoryPages(async () => {
        throw identity;
      });
    },
    (error) => error === identity,
  );
});

test("component browser fixtures consume the paginated directory double", () => {
  const root = new URL("../../integration/admin-console/", import.meta.url);
  for (const file of [
    "runtime-recovery-browser.mjs",
    "agent-skill-lifecycle-preview.mjs",
    "agent-skill-preparation-preview.mjs",
    "oidc-linking-browser.mjs",
    "browser-sessions-browser.mjs",
  ]) {
    const source = readFileSync(fileURLToPath(new URL(file, root)), "utf8");
    assert.ok(
      source.includes("createDirectoryFixture"),
      `${file} must use createDirectoryFixture for bounded member/group pages`,
    );
    assert.ok(
      source.includes("/api/admin/directory/members") ||
        source.includes("/api/admin/directory/groups"),
      `${file} must serve the paginated directory paths`,
    );
    assert.equal(
      /["'`]\/api\/admin\/directory["'`]/.test(source),
      false,
      `${file} must not serve the retired unbounded directory mock`,
    );
  }
});

test("system directory data consumers use the bounded-page client", () => {
  const root = new URL("../../e2e/", import.meta.url);
  for (const file of [
    "stage3-base/identity.mjs",
    "skill-learning/propagation-flow.mjs",
    "edge-gateway/browser-sessions-flow.mjs",
    "edge-gateway/oidc-linking-flow.mjs",
    "edge-gateway/resolve-cache-recovery-flow.mjs",
    "identity-closeout/oidc-client.mjs",
    "identity-closeout/offboarding-scenarios.mjs",
    "identity-closeout/client.mjs",
    "identity-closeout/organization-display-client.mjs",
    "identity-closeout/access-client.mjs",
  ]) {
    const source = readFileSync(new URL(file, root), "utf8");
    assert.ok(source.includes("admin-directory-client.mjs"), file);
    assert.match(source, /\breadDirectoryPages\s*\(/, file);
  }
});
