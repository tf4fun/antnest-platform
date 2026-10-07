import { identityFixture } from "./identity-rpc.mjs";

// Fixture setup uses the owning service RPC, not SQL or new public APIs. Each
// directory command runs in a caller context for its target Organization.
const identity = identityFixture();
const owner = {
  email: "stage3-admin@example.com",
  password: "stage3-admin-password",
};
try {
  const sessionA = await identity.signIn({
    organization_slug: "stage3",
    ...owner,
  });
  const { organization } = await identity.admin(
    sessionA,
    "create-organization",
    {
      slug: "access-b",
      name: "Access B",
      owner_email: owner.email,
      owner_display_name: "Fixture owner",
    },
  );
  const sessionB = await identity.signIn({
    organization_slug: "access-b",
    ...owner,
  });
  const result = {};
  for (const [key, session] of [
    ["a", sessionA],
    ["b", sessionB],
  ]) {
    result[key] = await identity.admin(session, "create-local-user", {
      organization_id: session.principal.organization_id,
      email: "access-admin@example.com",
      display_name: `Organization ${key} admin`,
      password: `synthetic-access-password-${key}`,
      role: "admin",
    });
  }
  result.shared = (
    await identity.admin(sessionB, "add-organization-membership", {
      organization_id: organization.id,
      user_id: result.a.user.id,
      email: "shared-member@example.com",
      display_name: "Shared member",
      role: "member",
    })
  ).membership;
  process.stdout.write(JSON.stringify(result) + "\n");
} finally {
  await identity.close();
}
