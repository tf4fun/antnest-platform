export function callbackError(search: string): string {
  const code = new URLSearchParams(search).get("auth_error");
  return code === "oidc_login_failed"
    ? "Single sign-on could not be completed. Please try again or use your local account."
    : "";
}

export function authorizationDestination(raw: string): string {
  const destination = new URL(raw);
  if (!["http:", "https:"].includes(destination.protocol)) {
    throw new Error("The login provider returned an invalid authorization address.");
  }
  return destination.toString();
}
