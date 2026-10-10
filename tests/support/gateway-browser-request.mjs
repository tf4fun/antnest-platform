import { isIP } from "node:net";

// Chromium accepts Secure cookies on literal loopback HTTP. Playwright's
// APIRequestContext and cookies(httpURL) do not, so API probes must explicitly
// bridge the browser session without changing the cookies' Secure attributes.
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
    headers.set(
      "X-Antnest-CSRF-Token",
      cookies.find(({ name }) => name === "antnest_csrf")?.value ?? "",
    );
  return context.request.fetch(url, {
    ...options,
    headers: Object.fromEntries(headers),
    // Manually attached credentials must never follow a redirect elsewhere.
    maxRedirects: 0,
  });
}
