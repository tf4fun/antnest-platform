import assert from "node:assert/strict";

// These snapshots are credentials: keep them outside the copied evidence tree.
export function snapshotSession(client, principal) {
  assert.equal(principal.active, true);
  assert(client.accessToken && client.csrf, "browser session cookies required");
  return structuredClone({ principal, cookies: [...client.cookies] });
}

export async function resumeSession(client, session) {
  assert.equal(session.principal.active, true);
  client.cookies = new Map(session.cookies);
  assert(client.accessToken && client.csrf, "browser session cookies required");
  const { body } = await client.request("/api/session");
  const principal = body.principal;
  for (const key of [
    "user_id",
    "organization_id",
    "membership_id",
    "organization_role",
    "system_role",
    "active",
  ]) {
    assert.equal(
      principal[key],
      session.principal[key],
      `browser session changed ${key}`,
    );
  }
  // Ordinary GET/business traffic does not extend the real browser idle lease.
  // Never re-login or retry rejected commands if the original session expired.
  await client.request("/api/session/activity", { body: {} });
  return principal;
}
