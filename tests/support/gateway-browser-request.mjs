import { isIP } from "node:net";
import { gatewaySessionCookies } from "./gateway-session-cookies.mjs";

// Chromium accepts Secure cookies on literal loopback HTTP. Since 1.64
// (upstream fix for issue 43115) Playwright's APIRequestContext and
// cookies(httpURL) do too; older releases did not. Probes still bridge
// explicitly to pin the session cookies, derive the CSRF header and keep
// maxRedirects at zero without changing the cookies' Secure attributes.
export async function gatewayBrowserRequest(context, url, options = {}) {
  const selection = new URL(url);
  const loopback =
    (isIP(selection.hostname) === 4 && selection.hostname.startsWith("127.")) ||
    selection.hostname === "[::1]";
  if (selection.protocol === "http:" && loopback) selection.protocol = "https:";
  const cookies = await context.cookies(selection.href);
  const headers = new Headers(options.headers);
  if (!headers.has("Cookie"))
    headers.set(
      "Cookie",
      cookies.map(({ name, value }) => `${name}=${value}`).join("; "),
    );
  if (!headers.has("X-Antnest-CSRF-Token"))
    headers.set("X-Antnest-CSRF-Token", gatewaySessionCookies(cookies).csrf);
  return context.request.fetch(url, {
    ...options,
    headers: Object.fromEntries(headers),
    // Manually attached credentials must never follow a redirect elsewhere.
    maxRedirects: 0,
  });
}
