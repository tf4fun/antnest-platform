import { identityFixture } from "./identity-rpc.mjs";

// Only the owning Identity RPC prepares a second Organization. The same global
// User is a member in stage3 and the owner/admin here, so ID-only scope bugs fail.
const identity = identityFixture();
const creator = {
  email: "stage3-admin@example.com",
  password: "stage3-admin-password",
};
try {
  const stage3 = await identity.signIn({
    organization_slug: "stage3",
    ...creator,
  });
  const shared = await identity.admin(stage3, "create-local-user", {
    organization_id: stage3.principal.organization_id,
    email: "oidc-local@example.com",
    display_name: "Organization display member",
    password: "synthetic-oidc-local-password",
    role: "member",
  });
  const { organization } = await identity.admin(stage3, "create-organization", {
    slug: "organization-display-b",
    name: "研究室 B · Zürich 🚀",
    owner_email: creator.email,
    owner_display_name: "Fixture creator",
  });
  const second = await identity.signIn({
    organization_slug: "organization-display-b",
    ...creator,
  });
  await identity.admin(second, "add-organization-membership", {
    organization_id: organization.id,
    user_id: shared.user.id,
    email: "oidc-local@example.com",
    display_name: "Shared display fixture owner",
    role: "admin",
  });
  process.stdout.write(
    JSON.stringify({ organization, shared_user_id: shared.user.id }) + "\n",
  );
} finally {
  await identity.close();
}
