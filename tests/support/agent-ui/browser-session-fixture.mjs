// Isolated browser metadata stands in for Gateway; fixture cookies are delivery
// hints and never authenticate a request to the real Node or Gateway services.
export function createBrowserSessionFixture(principal = {}) {
  const issuedAt = Date.now();
  const expiresAt = issuedAt + 43_200_000;
  let lastActivityAt = issuedAt;
  const publicPrincipal = {
    user_id: "user-1",
    organization_id: "org-1",
    membership_id: "membership-1",
    organization_slug: "engineering",
    organization_name: "Engineering",
    system_role: "user",
    organization_role: "member",
    active: true,
    ...principal,
  };
  const metadata = () => ({
    expires_at: new Date(expiresAt).toISOString(),
    idle_expires_at: new Date(
      Math.min(expiresAt, lastActivityAt + 1_800_000),
    ).toISOString(),
    activity_interval_ms: 30_000,
  });
  return {
    read: () => ({ principal: { ...publicPrincipal }, ...metadata() }),
    activity: () => {
      lastActivityAt = Date.now();
      return metadata();
    },
  };
}
