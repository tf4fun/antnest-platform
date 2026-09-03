export type ProvisioningEndpoints = {
  oidcCallbackURL: string;
  scimBaseURL: string;
};

export function provisioningEndpoints(publicLocation: string): ProvisioningEndpoints {
  const origin = new URL(publicLocation).origin;
  return {
    oidcCallbackURL: new URL("/protocol/oidc/callback", origin).toString(),
    scimBaseURL: new URL("/scim/v2", origin).toString(),
  };
}
