import assert from "node:assert/strict";

const MAX_LIMIT = 200;
const MAX_CURSOR = 4096;

function cursorValid(cursor) {
  if (cursor === null) return true;
  if (
    typeof cursor !== "string" ||
    cursor === "" ||
    Buffer.byteLength(cursor) > MAX_CURSOR
  ) {
    return false;
  }
  for (const char of cursor) {
    const code = char.codePointAt(0);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function checkPage(body, path) {
  assert.equal(
    typeof body === "object" && body !== null && !Array.isArray(body),
    true,
    `${path}: directory page must be an object`,
  );
  assert.deepEqual(
    Object.keys(body).sort(),
    ["items", "next_cursor"],
    `${path}: unexpected page keys`,
  );
  assert.equal(
    Array.isArray(body.items),
    true,
    `${path}: items must be an array`,
  );
  assert.equal(
    body.items.length <= MAX_LIMIT,
    true,
    `${path}: items exceed the page bound`,
  );
  assert.equal("next_cursor" in body, true, `${path}: next_cursor is required`);
  assert.equal(
    cursorValid(body.next_cursor),
    true,
    `${path}: next_cursor is invalid`,
  );
  assert.equal(
    !(body.items.length === 0 && body.next_cursor !== null),
    true,
    `${path}: an empty page must terminate the cursor`,
  );
}

async function readPages(request, path, seen) {
  const items = [];
  let cursor;
  for (;;) {
    const parameters = new URLSearchParams({ limit: String(MAX_LIMIT) });
    if (cursor !== undefined) parameters.set("cursor", cursor);
    const url = `${path}?${parameters.toString()}`;
    const body = await request(url);
    checkPage(body, url);
    items.push(...body.items);
    if (body.next_cursor === null) return items;
    assert.equal(
      seen.has(body.next_cursor),
      false,
      `${url}: directory cursor must not repeat`,
    );
    seen.add(body.next_cursor);
    cursor = body.next_cursor;
  }
}

export async function readDirectoryPages(request) {
  const users = await readPages(
    request,
    "/api/admin/directory/members",
    new Set(),
  );
  const groups = await readPages(
    request,
    "/api/admin/directory/groups",
    new Set(),
  );
  return { users, groups };
}
