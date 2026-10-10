// Select one mode from the actual names, including Secure cookies on HTTP
// loopback. Keep the jar untouched; aliases would hide incorrect wire names.
export function gatewaySessionCookies(cookies) {
  const entries = (
    typeof cookies === "string" ? cookies.split(";") : [...cookies]
  ).map((cookie) => {
    if (Array.isArray(cookie)) return cookie;
    if (typeof cookie !== "string") return [cookie.name, cookie.value];
    const pair = cookie.split(";", 1)[0];
    const split = pair.indexOf("=");
    return split < 0
      ? [pair.trim(), ""]
      : [pair.slice(0, split).trim(), pair.slice(split + 1)];
  });
  const prefix = entries.some(
    ([name]) =>
      name === "__Host-antnest_session" || name === "__Host-antnest_csrf",
  )
    ? "__Host-"
    : "";
  const sessionName = `${prefix}antnest_session`;
  const csrfName = `${prefix}antnest_csrf`;
  const read = (name) => {
    const matches = entries.filter(([key]) => key === name);
    return matches.length === 1 ? matches[0][1] : "";
  };
  return {
    sessionName,
    csrfName,
    accessToken: read(sessionName),
    csrf: read(csrfName),
  };
}
